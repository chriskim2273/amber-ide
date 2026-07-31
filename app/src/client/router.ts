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

export class Router {
  private readonly ports = new Map<string, PortLike>()
  // Sessions whose next Data frame is an Attach backlog replay.
  //
  // The daemon replays the whole scrollback as ONE Data frame, before any live
  // output, in response to Attach — so "the first Data frame after an Attach"
  // identifies the replay exactly. The renderer needs that fact (a re-attach
  // replays history the terminal already shows, so it must clear first) and
  // cannot derive it: guessing "the next message after a reconnect" races the
  // frame itself, and getting it wrong wipes a live pane. We send the Attach, so
  // we are the one place that knows for certain.
  private readonly awaitingBacklog = new Set<string>()

  constructor(private readonly conn: ConnLike) {
    this.conn.on('frame', (f) => {
      if (f.type === 'data') {
        const port = this.ports.get(f.session)
        if (!port) return
        const backlog = this.awaitingBacklog.delete(f.session)
        port.postMessage(backlog ? { data: f.bytes, backlog: true } : { data: f.bytes })
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
    for (const session of this.ports.keys()) this.sendAttach(session)
  }

  /** Attach, and arm the backlog tag for the reply that follows. */
  private sendAttach(session: string): void {
    this.awaitingBacklog.add(session)
    this.conn.send({ type: 'control', msg: { kind: 'Attach', name: session } })
  }

  /**
   * Drop a pane: close its port, forget it, and release the daemon-side
   * subscription.
   *
   * This had no callers, which cost three ways in a process designed to outlive
   * every pane: the map grew unboundedly (session names are minted fresh and
   * never reused), each entry pinned a live MessagePortMain, and
   * `reattachAll()` re-`Attach`ed long-dead names on every reconnect — each one
   * drawing a daemon `Error: no such session` into the app's red error banner.
   * It also left the daemon streaming a closed pane's output into nothing.
   */
  detach(session: string): void {
    const port = this.ports.get(session)
    if (!port) return // unknown/already detached: no port to close, nothing to tell the daemon
    port.close()
    this.ports.delete(session)
    this.awaitingBacklog.delete(session)
    this.conn.send({ type: 'control', msg: { kind: 'Detach', name: session } })
  }

  /** Live pane count. Daemon-state-free observable for the leak regression test. */
  attachedCount(): number {
    return this.ports.size
  }
}
