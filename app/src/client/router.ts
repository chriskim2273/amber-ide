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

  constructor(private readonly conn: ConnLike) {
    this.conn.on('frame', (f) => {
      if (f.type === 'data') {
        this.ports.get(f.session)?.postMessage({ data: f.bytes })
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
    this.conn.send({ type: 'control', msg: { kind: 'Attach', name: session } })
  }

  reattachAll(): void {
    for (const session of this.ports.keys()) {
      this.conn.send({ type: 'control', msg: { kind: 'Attach', name: session } })
    }
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
    this.conn.send({ type: 'control', msg: { kind: 'Detach', name: session } })
  }

  /** Live pane count. Daemon-state-free observable for the leak regression test. */
  attachedCount(): number {
    return this.ports.size
  }
}
