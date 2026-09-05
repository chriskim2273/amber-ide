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
    // First frame after an Attach is the daemon's scrollback replay, so it
    // carries the backlog tag (see the dedicated tests below).
    expect(portA.posted).toEqual([{ data: new Uint8Array([1, 2, 3]), backlog: true }])
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

  it('detachAll drains every pane subscription while leaving the control client usable', () => {
    const conn = new FakeConn()
    const router = new Router(conn)
    const a = new FakePort(); const b = new FakePort()
    router.attach('a', a); router.attach('b', b); conn.sent.length = 0
    router.detachAll()
    expect(a.closed).toBe(true); expect(b.closed).toBe(true)
    expect(conn.sent).toEqual([
      { type: 'control', msg: { kind: 'Detach', name: 'a' } },
      { type: 'control', msg: { kind: 'Detach', name: 'b' } },
    ])
    expect(router.attachedCount()).toBe(0)
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

    expect(conn.sent).toEqual([{
      type: 'control',
      msg: { kind: 'Attach', name: 'live', resume: { epoch: '0', offset: 0 } },
    }])
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
    expect(second.posted).toEqual([{ data: new Uint8Array([7]), backlog: true }])
  })

  it('tags only the first data frame after an Attach as the backlog', () => {
    // The daemon replays the whole scrollback as ONE Data frame in reply to
    // Attach, before any live output. The renderer must clear before a RE-attach
    // replay (or history duplicates) but must never clear on live output (that
    // wipes the pane — observed live when the renderer tried to infer it).
    const conn = new FakeConn()
    const router = new Router(conn)
    const port = new FakePort()
    router.attach('s', port)

    conn.emit({ type: 'data', session: 's', bytes: new Uint8Array([1]) })
    conn.emit({ type: 'data', session: 's', bytes: new Uint8Array([2]) })
    expect(port.posted).toEqual([
      { data: new Uint8Array([1]), backlog: true },
      { data: new Uint8Array([2]) },
    ])
  })

  it('re-arms the backlog tag on every reattachAll', () => {
    // A reconnect re-Attaches, so a fresh replay follows and must be tagged
    // again — this is the path where a missed tag duplicated history.
    const conn = new FakeConn()
    const router = new Router(conn)
    const port = new FakePort()
    router.attach('s', port)
    conn.emit({ type: 'data', session: 's', bytes: new Uint8Array([1]) })
    conn.emit({ type: 'data', session: 's', bytes: new Uint8Array([2]) })
    port.posted.length = 0

    router.reattachAll()
    conn.emit({ type: 'data', session: 's', bytes: new Uint8Array([3]) })
    conn.emit({ type: 'data', session: 's', bytes: new Uint8Array([4]) })
    expect(port.posted).toEqual([
      { data: new Uint8Array([3]), backlog: true },
      { data: new Uint8Array([4]) },
    ])
  })

  it('detaching an unknown session is a no-op', () => {
    const conn = new FakeConn()
    const router = new Router(conn)
    router.detach('never-attached')
    expect(conn.sent).toEqual([])
  })

  it('an acked full replay is tagged; a delta replay is appended without a reset', () => {
    // The whole point of the watermark: a surviving terminal (reconnect) must
    // NOT be reset-and-replayed — only the missing tail arrives, untagged.
    const conn = new FakeConn()
    const router = new Router(conn)
    const port = new FakePort()
    router.attach('s', port)

    // The attach opted in via {epoch:'0'}; the daemon announces a FULL replay.
    conn.emit({
      type: 'control',
      msg: { kind: 'AttachBacklog', name: 's', epoch: '7', end_offset: 100, full: true },
    })
    conn.emit({ type: 'data', session: 's', bytes: new Uint8Array([1]) })
    expect(port.posted).toEqual([{ data: new Uint8Array([1]), backlog: true }])

    // Detach + reconnect with the tracked watermark.
    router.detach('s')
    const port2 = new FakePort()
    router.attach('s', port2) // fresh mount: epoch '0' again
    conn.sent.length = 0
    conn.emit({
      type: 'control',
      msg: { kind: 'AttachBacklog', name: 's', epoch: '7', end_offset: 150, full: false },
    })
    conn.emit({ type: 'data', session: 's', bytes: new Uint8Array([2]) })
    // Delta: NO backlog tag — the renderer must append, never reset here.
    expect(port2.posted).toEqual([{ data: new Uint8Array([2]) }])
  })

  it('reattachAll presents the tracked watermark so a healthy daemon answers with a delta', () => {
    const conn = new FakeConn()
    const router = new Router(conn)
    const port = new FakePort()
    router.attach('s', port)
    // The ack'd replay is covered by end_offset (100)...
    conn.emit({
      type: 'control',
      msg: { kind: 'AttachBacklog', name: 's', epoch: '7', end_offset: 100, full: true },
    })
    conn.emit({ type: 'data', session: 's', bytes: new Uint8Array([1]) })
    // ...and the live tail after it advances the watermark to 130.
    conn.emit({ type: 'data', session: 's', bytes: new Uint8Array(30) })
    port.posted.length = 0
    conn.sent.length = 0

    router.reattachAll()
    expect(conn.sent).toEqual([{
      type: 'control',
      msg: { kind: 'Attach', name: 's', resume: { epoch: '7', offset: 130 } },
    }])
  })

  it('a data frame in the awaiting window is treated as an old daemon legacy replay', () => {
    // An old daemon ignores `resume` and never announces; its untagged one-frame
    // replay must still be tagged for the renderer (reset), and no watermark may
    // survive it (nothing on that wire maintains one).
    const conn = new FakeConn()
    const router = new Router(conn)
    const port = new FakePort()
    router.attach('s', port)

    // No AttachBacklog ever comes...
    conn.emit({ type: 'data', session: 's', bytes: new Uint8Array([9]) })
    expect(port.posted).toEqual([{ data: new Uint8Array([9]), backlog: true }])

    // ...so the next reconnect goes out without credentials again.
    conn.sent.length = 0
    router.reattachAll()
    expect(conn.sent).toEqual([{
      type: 'control',
      msg: { kind: 'Attach', name: 's', resume: { epoch: '0', offset: 0 } },
    }])
  })
})
