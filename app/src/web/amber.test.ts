import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  parseServerMsg, toDaemonEvent, ControlLink, PaneLink, createAmber,
  type SocketLike, type PortLike, type AmberDeps,
} from './amber'

class FakeSocket implements SocketLike {
  sent: (string | Uint8Array)[] = []
  closed = false
  readyState = 0 // CONNECTING, mirrors WebSocket.CONNECTING
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  send(data: string | Uint8Array): void { this.sent.push(data) }
  close(): void { this.closed = true; this.readyState = 3; this.onclose?.() }
  open(): void { this.readyState = 1; this.onopen?.() }
  emit(data: unknown): void { this.onmessage?.({ data }) }
}

class FakePort implements PortLike {
  posted: unknown[] = []
  closed = false
  onmessage: ((e: { data: unknown }) => void) | null = null
  postMessage(m: unknown): void { this.posted.push(m) }
  start(): void {}
  close(): void { this.closed = true }
  fromRenderer(data: unknown): void { this.onmessage?.({ data }) }
}

afterEach(() => vi.useRealTimers())

describe('parseServerMsg', () => {
  it('parses every known t', () => {
    expect(parseServerMsg('{"t":"sessions","sessions":[1]}')).toEqual({ t: 'sessions', sessions: [1] })
    expect(parseServerMsg('{"t":"exit","name":"s","code":7}')).toEqual({ t: 'exit', name: 's', code: 7 })
    expect(parseServerMsg('{"t":"error","msg":"boom"}')).toEqual({ t: 'error', msg: 'boom' })
    expect(parseServerMsg('{"t":"backlog","name":"s"}')).toEqual({ t: 'backlog', name: 's' })
    expect(parseServerMsg('{"t":"backlogReply","name":"s"}')).toEqual({ t: 'backlogReply', name: 's' })
    expect(parseServerMsg('{"t":"activity","name":"s"}')).toEqual({ t: 'activity', name: 's' })
    expect(parseServerMsg('{"t":"memory","name":"s","rss_kb":12,"growing":true}'))
      .toEqual({ t: 'memory', name: 's', rss_kb: 12, growing: true })
    expect(parseServerMsg('{"t":"memoryPressure","level":"critical","current_kb":7000000,"budget_kb":8000000,"blocked":false}'))
      .toEqual({ t: 'memoryPressure', level: 'critical', current_kb: 7000000, budget_kb: 8000000, blocked: false })
  })

  it('returns null for an unknown t or malformed JSON', () => {
    expect(parseServerMsg('{"t":"resize","name":"s","cols":1,"rows":1}')).toBeNull()
    expect(parseServerMsg('not json')).toBeNull()
    expect(parseServerMsg('{}')).toBeNull()
  })
})

describe('toDaemonEvent', () => {
  it('maps sessions/error/activity/memory to the frame shape main.tsx expects', () => {
    expect(toDaemonEvent({ t: 'sessions', sessions: [] }))
      .toEqual({ frame: { type: 'control', msg: { kind: 'Sessions', sessions: [] } } })
    expect(toDaemonEvent({ t: 'error', msg: 'x' }))
      .toEqual({ frame: { type: 'control', msg: { kind: 'Error', msg: 'x' } } })
    expect(toDaemonEvent({ t: 'activity', name: 's' }))
      .toEqual({ frame: { type: 'control', msg: { kind: 'Activity', name: 's' } } })
    expect(toDaemonEvent({ t: 'memory', name: 's', rss_kb: 5, growing: false }))
      .toEqual({ frame: { type: 'control', msg: { kind: 'MemoryStat', name: 's', rss_kb: 5, growing: false } } })
    expect(toDaemonEvent({ t: 'memoryPressure', level: 'warning', current_kb: 7, budget_kb: 10, blocked: true }))
      .toEqual({ frame: { type: 'control', msg: { kind: 'MemoryPressure', level: 'warning', current_kb: 7, budget_kb: 10, blocked: true } } })
  })
})

describe('PaneLink', () => {
  it('sends {t:"open"} on connect and tags only the first Data frame after a backlog marker', () => {
    const socket = new FakeSocket()
    const port = new FakePort()
    new PaneLink('s1', () => socket, port, () => {})
    socket.open()
    expect(socket.sent).toEqual([JSON.stringify({ t: 'open', name: 's1' })])

    socket.emit(JSON.stringify({ t: 'backlog', name: 's1' }))
    socket.emit(new Uint8Array([1, 2, 3]))
    socket.emit(new Uint8Array([4, 5]))
    expect(port.posted).toEqual([
      { data: new Uint8Array([1, 2, 3]), backlog: true },
      { data: new Uint8Array([4, 5]) },
    ])
  })

  it('routes a keystroke from the port to a binary send on THIS pane\'s own socket only', () => {
    const socket = new FakeSocket()
    socket.open()
    const port = new FakePort()
    new PaneLink('s1', () => socket, port, () => {})
    socket.sent.length = 0

    port.fromRenderer({ data: new Uint8Array([97, 98]) })
    expect(socket.sent).toEqual([new Uint8Array([97, 98])])
  })

  it('forwards a resize from the port as {t:"resize"} on this pane\'s own socket, debounced', () => {
    vi.useFakeTimers()
    const socket = new FakeSocket()
    socket.open()
    const port = new FakePort()
    new PaneLink('s1', () => socket, port, () => {})
    socket.sent.length = 0

    port.fromRenderer({ resize: { cols: 100, rows: 40 } })
    expect(socket.sent).toEqual([]) // not yet — debounced
    vi.advanceTimersByTime(300)
    expect(socket.sent).toEqual([JSON.stringify({ t: 'resize', name: 's1', cols: 100, rows: 40 })])
  })

  it('collapses a burst of resizes (a divider drag) into one send of the SETTLED size', () => {
    vi.useFakeTimers()
    const socket = new FakeSocket()
    socket.open()
    const port = new FakePort()
    new PaneLink('s1', () => socket, port, () => {})
    socket.sent.length = 0

    port.fromRenderer({ resize: { cols: 90, rows: 30 } })
    vi.advanceTimersByTime(100)
    port.fromRenderer({ resize: { cols: 95, rows: 32 } })
    vi.advanceTimersByTime(100)
    port.fromRenderer({ resize: { cols: 100, rows: 40 } })
    vi.advanceTimersByTime(300)
    expect(socket.sent).toEqual([JSON.stringify({ t: 'resize', name: 's1', cols: 100, rows: 40 })])
  })

  it('a pending debounced resize is dropped, not sent late, once close() tears the pane down', () => {
    vi.useFakeTimers()
    const socket = new FakeSocket()
    socket.open()
    const port = new FakePort()
    const link = new PaneLink('s1', () => socket, port, () => {})
    socket.sent.length = 0

    port.fromRenderer({ resize: { cols: 100, rows: 40 } })
    link.close()
    vi.advanceTimersByTime(300)
    expect(socket.sent).toEqual([])
  })

  it('delivers exit to the onExit callback', () => {
    const socket = new FakeSocket()
    socket.open()
    const exits: [string, number][] = []
    new PaneLink('s1', () => socket, new FakePort(), (n, c) => exits.push([n, c]))

    socket.emit(JSON.stringify({ t: 'exit', name: 's1', code: 7 }))
    expect(exits).toEqual([['s1', 7]])
  })

  it('ignores broadcast-class messages — those are ControlLink\'s job, not a pane\'s', () => {
    const socket = new FakeSocket()
    socket.open()
    const port = new FakePort()
    new PaneLink('s1', () => socket, port, () => {})

    socket.emit(JSON.stringify({ t: 'sessions', sessions: [] }))
    socket.emit(JSON.stringify({ t: 'error', msg: 'x' }))
    socket.emit(JSON.stringify({ t: 'activity', name: 's1' }))
    expect(port.posted).toEqual([])
  })

  it('close() closes the port and socket and sends no control message', () => {
    const socket = new FakeSocket()
    socket.open()
    const port = new FakePort()
    const link = new PaneLink('s1', () => socket, port, () => {})
    socket.sent.length = 0

    link.close()
    expect(port.closed).toBe(true)
    expect(socket.closed).toBe(true)
    expect(socket.sent).toEqual([])
  })

  it('a deliberate close() does not reconnect (no leaked socket)', () => {
    vi.useFakeTimers()
    let calls = 0
    const sockets = [new FakeSocket(), new FakeSocket()]
    const link = new PaneLink('s1', () => sockets[calls++] as FakeSocket, new FakePort(), () => {})
    sockets[0]!.open()

    link.close()
    vi.advanceTimersByTime(5000)
    expect(calls).toBe(1) // the factory was never called a second time
  })

  it('reconnects after an unexpected drop and re-opens on the fresh socket', () => {
    vi.useFakeTimers()
    let calls = 0
    const sockets = [new FakeSocket(), new FakeSocket()]
    new PaneLink('s1', () => sockets[calls++] as FakeSocket, new FakePort(), () => {})
    sockets[0]!.open()
    sockets[0]!.sent.length = 0

    sockets[0]!.close() // simulate the connection dropping, NOT a deliberate close()
    vi.advanceTimersByTime(5000)
    expect(calls).toBe(2)
    sockets[1]!.open()
    expect(sockets[1]!.sent).toEqual([JSON.stringify({ t: 'open', name: 's1' })])
  })

  it('re-opening a session closes the socket+port it supersedes (via createAmber\'s openPane guard)', () => {
    // index 0 is consumed by createAmber's own ControlLink construction.
    const sockets = [new FakeSocket(), new FakeSocket(), new FakeSocket()]
    let calls = 0
    const posted: { session: string; port2: unknown }[] = []
    const deps: AmberDeps = {
      connectSocket: () => sockets[calls++] as FakeSocket,
      newChannel: () => ({ port1: new FakePort(), port2: {} }),
      postPanePort: (session, port2) => posted.push({ session, port2 }),
      clipboard: { writeText: () => Promise.resolve(), readText: () => Promise.resolve('') },
      home: '/home/x',
      softwareGl: false,
      layoutGet: () => Promise.resolve({ text: null, version: null }),
      layoutSave: () => Promise.resolve({ ok: true, version: null }),
    }
    const amber = createAmber(deps)
    amber.openPane('s1')
    const firstPaneSocket = sockets[1]!
    amber.openPane('s1') // remount before the first close() lands
    expect(firstPaneSocket.closed).toBe(true)
    expect(calls).toBe(3)
  })
})

describe('ControlLink', () => {
  it('queues sends until open, then flushes them in order', () => {
    const socket = new FakeSocket()
    const link = new ControlLink(() => socket, () => {})
    link.send({ t: 'kill', name: 's' })
    link.send({ t: 'suspend', name: 's' })
    expect(socket.sent).toEqual([])

    socket.open()
    expect(socket.sent).toEqual([
      JSON.stringify({ t: 'kill', name: 's' }),
      JSON.stringify({ t: 'suspend', name: 's' }),
    ])
  })

  it('dispatches sessions/error/activity/memory/pressure as onDaemonEvent frames', () => {
    const events: unknown[] = []
    const socket = new FakeSocket()
    new ControlLink(() => socket, (ev) => events.push(ev))
    socket.open()
    events.length = 0 // drop the 'connected' status event

    socket.emit(JSON.stringify({ t: 'sessions', sessions: [{ name: 's' }] }))
    socket.emit(JSON.stringify({ t: 'error', msg: 'oops' }))
    socket.emit(JSON.stringify({ t: 'activity', name: 's' }))
    socket.emit(JSON.stringify({ t: 'memory', name: 's', rss_kb: 9, growing: true }))
    socket.emit(JSON.stringify({ t: 'memoryPressure', level: 'critical', current_kb: 7, budget_kb: 8, blocked: false }))

    expect(events).toEqual([
      { frame: { type: 'control', msg: { kind: 'Sessions', sessions: [{ name: 's' }] } } },
      { frame: { type: 'control', msg: { kind: 'Error', msg: 'oops' } } },
      { frame: { type: 'control', msg: { kind: 'Activity', name: 's' } } },
      { frame: { type: 'control', msg: { kind: 'MemoryStat', name: 's', rss_kb: 9, growing: true } } },
      { frame: { type: 'control', msg: { kind: 'MemoryPressure', level: 'critical', current_kb: 7, budget_kb: 8, blocked: false } } },
    ])
  })

  it('never dispatches on exit or backlog (pane-only, never delivered here anyway)', () => {
    const events: unknown[] = []
    const socket = new FakeSocket()
    new ControlLink(() => socket, (ev) => events.push(ev))
    socket.open()
    events.length = 0

    socket.emit(JSON.stringify({ t: 'exit', name: 's', code: 0 }))
    socket.emit(JSON.stringify({ t: 'backlog', name: 's' }))
    expect(events).toEqual([])
  })

  it('pairs a dumpBacklog reply\'s marker + binary into a Backlog event, FIFO across concurrent dumps', () => {
    const events: unknown[] = []
    const socket = new FakeSocket()
    const link = new ControlLink(() => socket, (ev) => events.push(ev))
    socket.open()
    events.length = 0

    link.send({ t: 'dumpBacklog', name: 'a' })
    link.send({ t: 'dumpBacklog', name: 'b' })
    socket.emit(JSON.stringify({ t: 'backlogReply', name: 'a' }))
    socket.emit(new Uint8Array([1]))
    socket.emit(JSON.stringify({ t: 'backlogReply', name: 'b' }))
    socket.emit(new Uint8Array([2]))

    expect(events).toEqual([
      { frame: { type: 'control', msg: { kind: 'Backlog', name: 'a', data: new Uint8Array([1]) } } },
      { frame: { type: 'control', msg: { kind: 'Backlog', name: 'b', data: new Uint8Array([2]) } } },
    ])
  })
})

describe('createAmber', () => {
  function deps(overrides: Partial<AmberDeps> = {}): AmberDeps {
    return {
      connectSocket: () => new FakeSocket(),
      newChannel: () => ({ port1: new FakePort(), port2: {} }),
      postPanePort: () => {},
      clipboard: { writeText: () => Promise.resolve(), readText: () => Promise.resolve('clip') },
      home: '/home/x',
      softwareGl: false,
      layoutGet: () => Promise.resolve({ text: null, version: null }),
      layoutSave: () => Promise.resolve({ ok: true, version: null }),
      ...overrides,
    }
  }

  it('exposes homeDir/softwareGl straight from deps', () => {
    const amber = createAmber(deps({ home: '/home/y', softwareGl: true }))
    expect(amber.homeDir).toBe('/home/y')
    expect(amber.softwareGl).toBe(true)
  })

  it('openPane wires a real port through postPanePort and routes each pane to its own socket', () => {
    const sockets: FakeSocket[] = []
    const posted: { session: string; port2: unknown }[] = []
    const amber = createAmber(deps({
      connectSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
      postPanePort: (session, port2) => posted.push({ session, port2 }),
    }))
    amber.openPane('a')
    amber.openPane('b')
    expect(posted.map((p) => p.session)).toEqual(['a', 'b'])
    // index 0 is createAmber's own ControlLink socket, not a pane's.
    sockets[1]!.open()
    sockets[2]!.open()
    expect(sockets[1]!.sent).toEqual([JSON.stringify({ t: 'open', name: 'a' })])
    expect(sockets[2]!.sent).toEqual([JSON.stringify({ t: 'open', name: 'b' })])
  })

  it('focusSession emits the explicit focus shape exactly once', () => {
    const socket = new FakeSocket()
    const amber = createAmber(deps({ connectSocket: () => socket }))
    socket.open()
    socket.sent.length = 0
    amber.focusSession('live')
    expect(socket.sent).toEqual([JSON.stringify({ t: 'focus', name: 'live' })])
  })

  it('createSession/killSession/renameSession/suspendSession/resumeSession/dumpBacklog send the whitelist shapes', () => {
    const socket = new FakeSocket()
    const amber = createAmber(deps({ connectSocket: () => socket }))
    socket.open()
    socket.sent.length = 0

    amber.createSession('n', '/cwd', 'shell')
    amber.killSession('n')
    amber.renameSession('n', 'm')
    amber.suspendSession('n')
    amber.resumeSession('n')
    amber.dumpBacklog('n')

    expect(socket.sent).toEqual([
      JSON.stringify({ t: 'create', name: 'n', cwd: '/cwd', kind: 'shell' }),
      JSON.stringify({ t: 'kill', name: 'n' }),
      JSON.stringify({ t: 'move', from: 'n', to: 'm' }),
      JSON.stringify({ t: 'suspend', name: 'n' }),
      JSON.stringify({ t: 'resume', name: 'n' }),
      JSON.stringify({ t: 'dumpBacklog', name: 'n' }),
    ])
    // None of the whitelist ever includes a resize — the daemon-facing gate
    // (`map_browser_msg`) is Rust-side tested; this locks the shim never even
    // tries.
    for (const raw of socket.sent) {
      expect(JSON.parse(raw as string).t).not.toBe('resize')
    }
  })

  it('clipboardWrite/clipboardRead delegate to the injected clipboard, no server round trip', async () => {
    const writes: string[] = []
    const amber = createAmber(deps({
      clipboard: { writeText: (t) => { writes.push(t); return Promise.resolve() }, readText: () => Promise.resolve('hi') },
    }))
    amber.clipboardWrite('hello')
    await Promise.resolve()
    expect(writes).toEqual(['hello'])
    await expect(amber.clipboardRead()).resolves.toBe('hi')
  })

  it('loadLayout/saveLayout are a thin passthrough to the injected HTTP hooks', async () => {
    const layoutGet = vi.fn(() => Promise.resolve({ text: '{"a":1}', version: 'v1' }))
    const layoutSave = vi.fn((text: string, version: string | null) =>
      Promise.resolve({ ok: true as const, version: text + version }))
    const amber = createAmber(deps({ layoutGet, layoutSave }))

    await expect(amber.loadLayout()).resolves.toEqual({ text: '{"a":1}', version: 'v1' })
    await expect(amber.saveLayout('{"b":2}', 'v1')).resolves.toEqual({ ok: true, version: '{"b":2}v1' })
    expect(layoutSave).toHaveBeenCalledWith('{"b":2}', 'v1')
  })

  it('surfaces a saveLayout conflict verbatim (the caller merges, not this file)', async () => {
    const layoutSave = vi.fn(() =>
      Promise.resolve({ conflict: true as const, text: 'on-disk', version: 'v2' }))
    const amber = createAmber(deps({ layoutSave }))
    await expect(amber.saveLayout('mine', 'v1')).resolves.toEqual({ conflict: true, text: 'on-disk', version: 'v2' })
  })

  it('every §7/native-dialog stub rejects visibly instead of silently resolving', () => {
    const amber = createAmber(deps())
    const stubs: Array<() => unknown> = [
      () => amber.saveWorkspaceFile('{}', 'x.amberws'),
      () => amber.openWorkspaceFile(),
      () => amber.pickFolder(),
      () => amber.revealPath('/x'),
      () => amber.editorOpenDialog(),
      () => amber.editorRead('/x'),
      () => amber.editorSave('/x', 't', null),
      () => amber.editorSaveDialog('x', 't'),
      () => amber.editorDraftWrite('p', 't'),
      () => amber.editorDraftRead('p'),
      () => amber.editorDraftClear('p'),
      () => amber.editorInlineImages('/x', '<p></p>'),
      () => amber.claudeNames([]),
    ]
    for (const call of stubs) {
      expect(call, `${call.toString()} did not throw`).toThrow('not available in the web build')
    }
  })

  it('resolvePath declines to null instead of throwing (hot path: every mouse selection)', async () => {
    const amber = createAmber(deps())
    await expect(amber.resolvePath('/', 'x')).resolves.toBeNull()
  })
})
