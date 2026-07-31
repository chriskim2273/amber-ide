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
  closed = false
  private cb: ((e: { data: unknown }) => void) | null = null
  postMessage(m: unknown): void { this.posted.push(m) }
  on(_e: 'message', cb: (e: { data: unknown }) => void): void { this.cb = cb }
  start(): void {}
  close(): void { this.closed = true }
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

  it('reattachAll re-sends Attach for every attached session', () => {
    const conn = new FakeConn()
    const router = new Router(conn)
    router.attach('sA', new FakePort())
    router.attach('sB', new FakePort())
    conn.sent.length = 0
    router.reattachAll()
    const attaches = conn.sent.filter((f) => f.type === 'control' && f.msg.kind === 'Attach')
    expect(attaches).toHaveLength(2)
  })

  it('detach drops the session, closes its port and tells the daemon', () => {
    // `detach()` had NO callers, so every session ever opened stayed in the map
    // with a live MessagePortMain — an unbounded leak in a process that is meant
    // to outlive every pane.
    const conn = new FakeConn()
    const router = new Router(conn)
    const port = new FakePort()
    router.attach('s', port)
    conn.sent.length = 0

    router.detach('s')

    expect(port.closed).toBe(true)
    expect(conn.sent).toEqual([{ type: 'control', msg: { kind: 'Detach', name: 's' } }])
    expect(router.attachedCount()).toBe(0)
    // Data for a detached session must go nowhere, not to a dead port.
    conn.emit({ type: 'data', session: 's', bytes: new Uint8Array([1]) })
    expect(port.posted).toEqual([])
  })

  it('a detached session is not re-Attached on reconnect', () => {
    // reattachAll() fired for every name the router had ever seen. A closed
    // pane's name draws `Error: no such session` from the daemon, which the app
    // surfaces in its red error banner — so a reconnect after a long session
    // popped errors for panes the user closed hours earlier.
    const conn = new FakeConn()
    const router = new Router(conn)
    router.attach('gone', new FakePort())
    router.attach('live', new FakePort())
    router.detach('gone')
    conn.sent.length = 0

    router.reattachAll()

    expect(conn.sent).toEqual([{ type: 'control', msg: { kind: 'Attach', name: 'live' } }])
  })

  it('re-attaching a session closes the port it supersedes', () => {
    // Every re-acquire (client relaunch, workspace switch) brokers a fresh
    // MessageChannelMain. Overwriting the map entry without closing the old one
    // leaked a port per re-acquire.
    const conn = new FakeConn()
    const router = new Router(conn)
    const first = new FakePort()
    const second = new FakePort()
    router.attach('s', first)
    router.attach('s', second)

    expect(first.closed).toBe(true)
    expect(second.closed).toBe(false)
    expect(router.attachedCount()).toBe(1)
    conn.emit({ type: 'data', session: 's', bytes: new Uint8Array([7]) })
    expect(first.posted).toEqual([])
    expect(second.posted).toEqual([{ data: new Uint8Array([7]) }])
  })

  it('detaching an unknown session is a no-op', () => {
    const conn = new FakeConn()
    const router = new Router(conn)
    router.detach('never-attached')
    expect(conn.sent).toEqual([])
  })
})
