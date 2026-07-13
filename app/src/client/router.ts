import type { Frame } from '../shared/proto'

export interface PortLike {
  postMessage(m: unknown): void
  on(e: 'message', cb: (e: { data: unknown }) => void): void
  start(): void
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

  detach(session: string): void {
    this.ports.delete(session)
    this.conn.send({ type: 'control', msg: { kind: 'Detach', name: session } })
  }
}
