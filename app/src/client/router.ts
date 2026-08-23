import type { Frame } from '../shared/proto'

export interface PortLike {
  postMessage(m: unknown): void
  on(e: 'message', cb: (e: { data: unknown }) => void): void
  start(): void
  close(): void
}

interface ConnLike {
  send(f: Frame): void
  on(e: 'frame', cb: (f: Frame) => void): void
}

// Renderer -> utility messages over a pane port.
type Outbound = { data: Uint8Array } | { resize: { cols: number; rows: number } }

/** The client's delta-replay watermark: ring epoch + absolute byte position. */
export interface Watermark {
  epoch: string
  offset: number
}

/**
 * What replay we expect next for a session. `awaiting-ack` covers the window
 * between sending Attach and the daemon's AttachBacklog announcement; if a
 * Data frame lands in that window the peer is an OLD daemon that never
 * announces — that frame is then the untagged legacy full replay.
 */
type PendingReplay = 'awaiting-ack' | 'full' | 'delta'

export class Router {
  private readonly ports = new Map<string, PortLike>()
  // Per-session delta-replay watermarks, set by every AttachBacklog ack.
  // Consulted ONLY by reattachAll() — whose terminals are ALIVE and already
  // hold their history, so they want just the missing tail. A fresh mount
  // (attach()) sends `{epoch:'0'}` instead: its new xterm is empty and must
  // take the full replay anyway, but the opt-in key still buys the ack that
  // establishes this watermark for the next reconnect. Entries for closed
  // panes linger (names are never reused) but are two small values — bounded
  // by panes-ever-opened per utilityProcess, no ports pinned.
  private readonly watermarks = new Map<string, Watermark>()
  private readonly pendingReplay = new Map<string, PendingReplay>()

  constructor(private readonly conn: ConnLike) {
    this.conn.on('frame', (f) => {
      if (f.type === 'control' && f.msg.kind === 'AttachBacklog') {
        const { name, epoch, end_offset, full } = f.msg
        this.watermarks.set(name, { epoch, offset: end_offset })
        this.pendingReplay.set(name, full ? 'full' : 'delta')
        return
      }
      if (f.type === 'data') {
        const port = this.ports.get(f.session)
        const pending = this.pendingReplay.get(f.session)
        if (pending !== undefined) {
          this.pendingReplay.delete(f.session)
          if (pending === 'awaiting-ack') {
            // Old daemon: no announcement exists on its wire, so this Data IS
            // the legacy replay. Tag it so the renderer resets — and drop any
            // watermark, which nothing on that wire maintains.
            this.watermarks.delete(f.session)
            port?.postMessage({ data: f.bytes, backlog: true })
            return
          }
          // Ack'd replay: 'full' resets the terminal first; 'delta' appends to
          // what the surviving terminal already shows. The replay bytes are
          // covered by the ack's end_offset — not re-counted below.
          port?.postMessage(pending === 'full' ? { data: f.bytes, backlog: true } : { data: f.bytes })
          return
        }
        // Live output after the replay.
        port?.postMessage({ data: f.bytes })
        const wm = this.watermarks.get(f.session)
        if (wm) wm.offset += f.bytes.length
      }
    })
  }

  attach(session: string, port: PortLike): void {
    // Every re-acquire (client relaunch, workspace switch) brokers a NEW
    // MessageChannelMain, so overwriting the entry without closing the old port
    // leaked one per re-acquire. The superseded port has no reader left — the
    // renderer already dropped its end.
    this.ports.get(session)?.close()
    this.ports.set(session, port)
    port.on('message', (e) => {
      const msg = e.data as Outbound
      if ('data' in msg) {
        this.conn.send({ type: 'data', session, bytes: msg.data })
      } else if ('resize' in msg) {
        this.conn.send({ type: 'control', msg: { kind: 'Resize', name: session, cols: msg.resize.cols, rows: msg.resize.rows } })
      }
    })
    port.start()
    this.sendAttach(session)
  }

  reattachAll(): void {
    for (const [session] of this.ports) this.sendAttach(session)
  }

  /**
   * Attach with this session's delta credentials: a tracked watermark when we
   * have one (reconnect path), else `{epoch:'0'}` — "new-style client, no
   * watermark yet" — which still opts the connection into the AttachBacklog
   * ack. Arms which reply shape we expect.
   */
  private sendAttach(session: string): void {
    const watermark = this.watermarks.get(session)
    this.pendingReplay.set(session, 'awaiting-ack')
    this.conn.send({
      type: 'control',
      msg: { kind: 'Attach', name: session, resume: watermark ?? { epoch: '0', offset: 0 } },
    })
  }

  /**
   * Drop a pane: close its port, forget it, and release the daemon-side
   * subscription.
   *
   * This had no callers, which cost three ways in a process designed to outlive
   * every pane: the map grew unboundedly (session names are minted fresh and
   * never reused), each entry pinned a live `MessagePortMain`, and
   * `reattachAll()` re-`Attach`ed long-dead names on every reconnect — each one
   * drawing a daemon `Error: no such session` into the app's red error banner.
   * It also left the daemon streaming a closed pane's output into nothing.
   */
  detach(session: string): void {
    const port = this.ports.get(session)
    if (!port) return // unknown/already detached: no port to close, nothing to tell the daemon
    port.close()
    this.ports.delete(session)
    this.pendingReplay.delete(session)
    this.conn.send({ type: 'control', msg: { kind: 'Detach', name: session } })
  }

  /** Live pane count. Daemon-state-free observable for the leak regression test. */
  attachedCount(): number {
    return this.ports.size
  }
}
