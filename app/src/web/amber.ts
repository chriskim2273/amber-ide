// Web-build shim: installs `window.amber` backed by the `amber web` server
// (crates/amber/src/web.rs) instead of the Electron preload bridge.
//
// Spike per docs/superpowers/specs/2026-08-01-amber-ide-as-a-webapp-design.md
// §2.2/§8. Only the mount path + the pane MessageChannel path are real; every
// other method is a visible-throw stub (§3: "must reject visibly, never
// silently no-op") — this file intentionally does NOT build layout CAS,
// session lifecycle, editor/browser panes, or native dialogs. See the spike
// report (`.reports/spike.md`) for what's next.
//
// --- The one wire-protocol wrinkle that matters here -----------------------
// `amber web`'s `Client.open` (web.rs) is a single `Option<String>` per
// WebSocket connection, and a raw BINARY frame carries NO session id — it is
// implicitly "whatever this connection currently has open" (confirmed by
// reading `Hub::queue`/`Hub::on_frame` in web.rs and the mobile `app.js`,
// which only ever has one pane open at a time for exactly this reason).
// `openPane` calls therefore all share ONE WebSocket and ONE "currently open"
// slot: opening a second pane while a first is open causes the server to
// Detach the first (see `map_browser_msg`'s `BrowserMsg::Open` arm). That's
// fine for this spike (one pane, proving the MessageChannel claim) but is NOT
// yet a multi-pane transport — widening `Client.open` to a set (spec §4) is
// required before this shim can hold more than one live pane at a time.

type DaemonEventCb = (d: unknown) => void

function throwNotImplemented(name: string): () => never {
  return () => {
    throw new Error(`window.amber.${name}: not implemented in the web-build spike`)
  }
}

let ws!: WebSocket
let onEvent: DaemonEventCb | null = null
// `connect()` runs at module load, before React has mounted and called
// `onDaemonEvent` — and the server pushes an initial `sessions` message the
// instant the WS connects (`Hub::add_client`), which can easily win that race
// on localhost. Buffer until a real listener registers so that first push (the
// one `sawSessions` depends on) is never silently dropped.
const pending: unknown[] = []
function dispatch(ev: unknown): void {
  if (onEvent) onEvent(ev)
  else pending.push(ev)
}
// The one session this connection has open, and the port wired to it. See the
// file-header note: the server has exactly one "open" slot per connection.
let openSession: string | null = null
let openPort: MessagePort | null = null
// Set right after sending `{t:'open'}` (fresh or reconnect re-attach); cleared
// on the very next BINARY frame. Per-session Attach ordering on one pipe
// guarantees that next frame IS the backlog reply — same guarantee the
// Electron client's `router.ts` `awaitingBacklog` relies on. This is NOT the
// "first frame after a reconnect" heuristic CLAUDE.md records as having
// blanked a live pane (that one guessed from wall-clock proximity, racing the
// frame itself); this one is keyed by the specific `open` we just sent, so it
// cannot land on the wrong frame. Pane.tsx reads `m.backlog` to reset() before
// a re-attach replay and to clear stale mouse-tracking modes after any replay
// — without tagging it, every reconnect would duplicate history forever and
// leave dead mouse-reporting on (see Pane.tsx's `attachedOnceRef`/`MOUSE_RESET`).
let awaitingBacklog = false
const sendQueue: string[] = []
// True once the WS has connected at least once. `openPane`'s own
// `sendControl` already queues (and will flush) the FIRST `{t:'open'}` for a
// newly-opened pane, so `onopen` must not resend it a second time on that
// first connection — found live: a fresh pane opened before the socket
// finished connecting got Attached TWICE (the queued send + onopen's
// unconditional resend), doubling its backlog. `onopen` only needs to
// resend on a REAL reconnect, when nothing is queued for it anymore.
let everConnected = false

function sendControl(msg: unknown): void {
  const text = JSON.stringify(msg)
  if (ws.readyState === WebSocket.OPEN) ws.send(text)
  else sendQueue.push(text)
}

function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  ws = new WebSocket(`${proto}//${location.host}/ws`)
  ws.binaryType = 'arraybuffer'

  ws.onopen = (): void => {
    dispatch({ status: 'connected' })
    for (const m of sendQueue.splice(0)) ws.send(m)
    // Reconnect (not the first connect — see `everConnected`) while a pane is
    // open: re-attach it (mirrors app.js's `open` re-send) — this re-attach
    // gets a fresh backlog reply too.
    if (everConnected && openSession) {
      sendControl({ t: 'open', name: openSession })
      awaitingBacklog = true
    }
    everConnected = true
  }
  ws.onclose = (): void => {
    dispatch({ status: 'disconnected' })
    setTimeout(connect, 1000) // ponytail: fixed 1s retry, no backoff ladder — fine for a spike
  }
  ws.onerror = (): void => { try { ws.close() } catch { /* onclose handles retry */ } }

  ws.onmessage = (ev: MessageEvent<string | ArrayBuffer>): void => {
    if (typeof ev.data !== 'string') {
      // Raw pty output for the ONE currently-open session (no session id rides
      // the frame — see the file header). Shape matches what Pane.tsx's port
      // handler expects: `{data, backlog?}` — see `awaitingBacklog` above.
      const backlog = awaitingBacklog
      awaitingBacklog = false
      const data = new Uint8Array(ev.data)
      openPort?.postMessage(backlog ? { data, backlog: true } : { data })
      return
    }
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(ev.data) as Record<string, unknown>
    } catch {
      return
    }
    // Translate web.rs's `{t:...}` shape into the `{frame:{type:'control',
    // msg:{kind:...}}}` shape `main.tsx`'s `toEvent` expects (mirrors the
    // Electron client's daemon-event payload, which forwards amber-core's
    // ControlMsg verbatim).
    if (msg['t'] === 'sessions') {
      dispatch({ frame: { type: 'control', msg: { kind: 'Sessions', sessions: msg['sessions'] ?? [] } } })
    } else if (msg['t'] === 'exit') {
      dispatch({ frame: { type: 'control', msg: { kind: 'Exit', name: msg['name'], code: msg['code'] } } })
    } else if (msg['t'] === 'error') {
      dispatch({ frame: { type: 'control', msg: { kind: 'Error', msg: msg['msg'] } } })
    }
    // 'sessions' is also the daemon's "connected" heartbeat for this spike —
    // no separate ack needed.
  }
}
connect()

window.amber = {
  // Headless/CDP-safe default: skip xterm's WebGL addon. A real build would
  // probe GPU support the way the Electron main process does; out of scope here.
  softwareGl: true,
  homeDir: '/tmp',
  onDaemonEvent: (cb): void => {
    onEvent = cb
    for (const ev of pending.splice(0)) cb(ev)
  },

  // --- §2.2: the load-bearing MessageChannel path -------------------------
  openPane: (session: string): void => {
    const channel = new MessageChannel()
    openPort?.close()
    openSession = session
    openPort = channel.port1
    openPort.onmessage = (e: MessageEvent): void => {
      const m = e.data as { data?: Uint8Array; resize?: unknown }
      // `resize` MUST stay unreachable (spec §4 — a pty's winsize is shared
      // with the desktop app); only keystroke bytes are forwarded.
      if (m.data && ws.readyState === WebSocket.OPEN) {
        ws.send(m.data instanceof Uint8Array ? m.data : new Uint8Array(m.data))
      }
    }
    channel.port1.start()
    window.postMessage({ amberPanePort: true, session }, '*', [channel.port2])
    sendControl({ t: 'open', name: session })
    awaitingBacklog = true
  },
  closePane: (session: string): void => {
    sendControl({ t: 'close', name: session })
    if (openSession === session) {
      openPort?.close()
      openPort = null
      openSession = null
      awaitingBacklog = false
    }
  },

  // --- native browser API, not a stub (spec §3: "Clipboard" row) ---------
  clipboardWrite: (text: string): void => { void navigator.clipboard.writeText(text) },
  clipboardRead: (): Promise<string> => navigator.clipboard.readText(),

  // --- §6 (layout CAS) not built — benign no-op so the mount effect (which
  // calls loadLayout/saveLayout unconditionally) doesn't throw on startup.
  loadLayout: (): Promise<string | null> => Promise.resolve(null),
  saveLayout: (): Promise<void> => Promise.resolve(),

  // --- everything else: out of scope for this spike, visible-throw -------
  createSession: throwNotImplemented('createSession'),
  killSession: throwNotImplemented('killSession'),
  renameSession: throwNotImplemented('renameSession'),
  suspendSession: throwNotImplemented('suspendSession'),
  resumeSession: throwNotImplemented('resumeSession'),
  dumpBacklog: throwNotImplemented('dumpBacklog'),
  saveWorkspaceFile: throwNotImplemented('saveWorkspaceFile'),
  openWorkspaceFile: throwNotImplemented('openWorkspaceFile'),
  pickFolder: throwNotImplemented('pickFolder'),
  resolvePath: throwNotImplemented('resolvePath'),
  revealPath: throwNotImplemented('revealPath'),
  editorOpenDialog: throwNotImplemented('editorOpenDialog'),
  editorRead: throwNotImplemented('editorRead'),
  editorSave: throwNotImplemented('editorSave'),
  editorSaveDialog: throwNotImplemented('editorSaveDialog'),
  editorDraftWrite: throwNotImplemented('editorDraftWrite'),
  editorDraftRead: throwNotImplemented('editorDraftRead'),
  editorDraftClear: throwNotImplemented('editorDraftClear'),
  editorInlineImages: throwNotImplemented('editorInlineImages'),
  claudeNames: throwNotImplemented('claudeNames'),
}

export {} // force module scope (this file has no imports of its own)
