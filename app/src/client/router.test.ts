import { describe, it, expect } from 'vitest'
import { Router, type PortLike } from './router'
import type { Frame } from '../shared/proto'

class FakeConn {
  sent: Frame[] = []
  private cb: ((f: Frame) => void) | null = null
  send(f: Frame): void { this.sent.push(f) }
  on(_e: 'frame', cb: (f: Frame) => void): void { this.cb = cb }
  emit(f: Frame): void { this.cb?.(f) }
}

class FakePort implements PortLike {
  posted: unknown[] = []
  private cb: ((e: { data: unknown }) => void) | null = null
  postMessage(m: unknown): void { this.posted.push(m) }
  on(_e: 'message', cb: (e: { data: unknown }) => void): void { this.cb = cb }
  start(): void {}
  fromRenderer(data: unknown): void { this.cb?.({ data }) }
}

describe('Router', () => {
  it('sends Attach and routes that session\'s data to its port only', () => {
    const conn = new FakeConn()
    const router = new Router(conn)
    const portA = new FakePort()
    const portB = new FakePort()
    router.attach('sA', portA)
    router.attach('sB', portB)

    expect(conn.sent.filter((f) => f.type === 'control' && f.msg.kind === 'Attach')).toHaveLength(2)

    conn.emit({ type: 'data', session: 'sA', bytes: new Uint8Array([1, 2, 3]) })
    expect(portA.posted).toEqual([{ data: new Uint8Array([1, 2, 3]) }])
    expect(portB.posted).toEqual([])
  })

  it('forwards renderer keystrokes and resize as frames', () => {
    const conn = new FakeConn()
    const router = new Router(conn)
    const port = new FakePort()
    router.attach('s', port)
    conn.sent.length = 0

    port.fromRenderer({ data: new Uint8Array([97, 98]) })
    port.fromRenderer({ resize: { cols: 100, rows: 40 } })

    expect(conn.sent).toEqual([
      { type: 'data', session: 's', bytes: new Uint8Array([97, 98]) },
      { type: 'control', msg: { kind: 'Resize', name: 's', cols: 100, rows: 40 } },
    ])
  })
})
