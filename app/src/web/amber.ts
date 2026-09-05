// Web-build shim: builds `window.amber` (the exact contract `main.tsx`
// declares — see its `declare global` block) backed by `amber web`
// (crates/amber/src/web.rs) instead of the Electron preload bridge.
//
// Spec: docs/superpowers/specs/2026-08-01-amber-ide-as-a-webapp-design.md.
// This file is PURE — no `WebSocket`/`MessageChannel`/`window`/`navigator`
// reference of its own, only the `SocketLike`/`PortLike` interfaces below
// (mirroring `app/src/client/router.ts`'s injectable shape) — so it is
// testable under vitest's `node` environment with fakes, the way
// `router.test.ts` tests `Router` with `FakeConn`/`FakePort`. The real
// WebSocket/MessageChannel/`window.postMessage` wiring lives in `install.ts`,
// which this module never imports and no test imports.
//
// --- Two WebSockets, not one (spec §4a: "One WebSocket per pane") ----------
// `amber web`'s `Client.open` (web.rs) is a single `Option<String>` per
// connection, and a raw BINARY frame carries NO session id — it is implicitly
// "whatever THIS connection currently has open". So one pane = one dedicated
// `/ws` connection (`PaneLink`), and everything that ISN'T pane data (session
// lifecycle, the daemon event stream, one-shot backlog dumps) rides a single
// separate `/ws` connection that never opens anything (`ControlLink`). This
// also means only `ControlLink` ever calls `dispatch()` for `sessions`/
// `error`/`activity`/`memory` — those are broadcast to EVERY connection
// server-side, so if every `PaneLink` also dispatched them the app would see
// N duplicate copies of the same event (and worse: `main.tsx` CONSUMES an
// `Error` while a dump is pending — a second copy would both resolve the dump
// AND draw a spurious red banner). `PaneLink` only ever forwards `exit` (only
// ever delivered to the connection with that session `open`) and its own
// `backlog` replay tag.
//
// --- Resize (2026-08-01 decision reversing the earlier "never resize" rule) -
// The browser MAY now resize its own pty: `Pane.tsx`'s FitAddon path runs
// unmodified (same as Electron), and its `{resize:{cols,rows}}` port message
// is forwarded here as a `{t:'resize',...}` JSON send on the pane's own
// socket, debounced (`RESIZE_DEBOUNCE_MS`) so a divider drag doesn't fire one
// over the wire per animation frame — see `PaneLink`'s port handler.
// `crates/amber/src/web.rs`'s `map_browser_msg` is the actual trust boundary
// (session must be live, cols/rows within sane bounds); this file just
// forwards, it does not validate.

import type { LoadLayoutResult, SaveLayoutResult, LayoutVersion } from '../shared/layoutFile'
import { decodeProviderUsage } from '../shared/proto'
import type { WebStatus } from '../shared/webStatus'
import type { RouterSlot, RouterStatus } from '../shared/routerStatus'
import { parseRouterStatus } from '../shared/routerStatus'

export interface SocketLike {
  send(data: string | Uint8Array): void
  close(): void
  readonly readyState: number
  onopen: (() => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
  onmessage: ((e: { data: unknown }) => void) | null
}
// Mirrors `WebSocket.OPEN` (a real `WebSocket`'s `readyState` numbering) so
// `install.ts`'s real sockets and this module's checks agree without either
// side importing the DOM lib's `WebSocket` type.
export const SOCKET_OPEN = 1

export interface PortLike {
  postMessage(m: unknown): void
  close(): void
  start(): void
  onmessage: ((e: { data: unknown }) => void) | null
}

const RECONNECT_MS = 1000 // ponytail: fixed retry, no backoff ladder — matches the spike; revisit if flapping in practice
// Matches main.tsx's layout-write debounce (see `PaneLink`'s doc comment) —
// same "only the settled size matters" policy, reused rather than a second number.
const RESIZE_DEBOUNCE_MS = 300

// ---- wire message shapes (pure parsing) ------------------------------------

export type ServerMsg =
  | { t: 'sessions'; sessions: unknown }
  | { t: 'exit'; name: string; code: number }
  | { t: 'error'; msg: string }
  | { t: 'backlog'; name: string }
  | { t: 'backlogReply'; name: string }
  | { t: 'activity'; name: string }
  | { t: 'memory'; name: string; rss_kb: number; growing: boolean }
  | { t: 'memoryPressure'; level: 'normal' | 'warning' | 'critical'; current_kb: number; budget_kb: number; blocked: boolean }
  | { t: 'resourcePressure'; level: 'normal' | 'critical'; causes: Array<'cpu' | 'io' | 'memory'>; blocked: boolean }
  | { t: 'titleSet'; name: string; title: string | null }
  | { t: 'created'; name: string }

/** Parse one JSON text frame from `amber web`. `null` for anything this
 * shim has no use for (malformed JSON, an unknown `t`). */
export function parseServerMsg(text: string): ServerMsg | null {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
  switch (raw['t']) {
    case 'sessions':
      return { t: 'sessions', sessions: raw['sessions'] ?? [] }
    case 'exit':
      return { t: 'exit', name: raw['name'] as string, code: raw['code'] as number }
    case 'error':
      return { t: 'error', msg: raw['msg'] as string }
    case 'backlog':
      return { t: 'backlog', name: raw['name'] as string }
    case 'backlogReply':
      return { t: 'backlogReply', name: raw['name'] as string }
    case 'activity':
      return { t: 'activity', name: raw['name'] as string }
    case 'memory':
      return {
        t: 'memory',
        name: raw['name'] as string,
        rss_kb: (raw['rss_kb'] as number) ?? 0,
        growing: (raw['growing'] as boolean) ?? false,
      }
    case 'memoryPressure': {
      const level = raw['level']
      if (level !== 'normal' && level !== 'warning' && level !== 'critical') return null
      return {
        t: 'memoryPressure',
        level,
        current_kb: (raw['current_kb'] as number) ?? 0,
        budget_kb: (raw['budget_kb'] as number) ?? 0,
        blocked: (raw['blocked'] as boolean) ?? false,
      }
    }
    case 'resourcePressure': {
      const level = raw['level']
      const causes = raw['causes']
      if ((level !== 'normal' && level !== 'critical')
        || !Array.isArray(causes)
        || !causes.every((cause) => cause === 'cpu' || cause === 'io' || cause === 'memory')) return null
      return { t: 'resourcePressure', level, causes: [...causes] as Array<'cpu' | 'io' | 'memory'>, blocked: (raw['blocked'] as boolean) ?? false }
    }
    case 'titleSet':
      if (typeof raw['name'] !== 'string' || (raw['title'] !== null && typeof raw['title'] !== 'string')) return null
      return { t: 'titleSet', name: raw['name'], title: raw['title'] as string | null }
    case 'created':
      return typeof raw['name'] === 'string' ? { t: 'created', name: raw['name'] } : null
    default:
      return null
  }
}

/** Map a broadcast-class `ServerMsg` to the `{frame:{type:'control',msg:{kind:...}}}`
 * shape `main.tsx`'s `toEvent` (and the Electron client's `daemon-event`)
 * expect. `exit`/`backlog`/`backlogReply` are excluded on purpose: `exit` is
 * handled by `PaneLink` (it needs no translation help, just a name/code
 * passthrough), and the backlog messages need the binary payload that
 * arrives in a separate frame — see `ControlLink`. Created/titleSet replies
 * are forwarded only when the web server correlates them to this operation. */
export function toDaemonEvent(
  m: Extract<ServerMsg, { t: 'sessions' | 'error' | 'activity' | 'memory' | 'memoryPressure' | 'resourcePressure' | 'titleSet' | 'created' }>,
): unknown {
  switch (m.t) {
    case 'sessions':
      return { frame: { type: 'control', msg: { kind: 'Sessions', sessions: m.sessions } } }
    case 'error':
      return { frame: { type: 'control', msg: { kind: 'Error', msg: m.msg } } }
    case 'activity':
      return { frame: { type: 'control', msg: { kind: 'Activity', name: m.name } } }
    case 'memory':
      return {
        frame: {
          type: 'control',
          msg: { kind: 'MemoryStat', name: m.name, rss_kb: m.rss_kb, growing: m.growing },
        },
      }
    case 'memoryPressure':
      return {
        frame: {
          type: 'control',
          msg: {
            kind: 'MemoryPressure',
            level: m.level,
            current_kb: m.current_kb,
            budget_kb: m.budget_kb,
            blocked: m.blocked,
          },
        },
      }
    case 'resourcePressure':
      return {
        frame: {
          type: 'control',
          msg: { kind: 'ResourcePressure', level: m.level, causes: m.causes, blocked: m.blocked },
        },
      }
    case 'titleSet':
      return { frame: { type: 'control', msg: { kind: 'TitleSet', name: m.name, title: m.title } } }
    case 'created':
      return { frame: { type: 'control', msg: { kind: 'Created', name: m.name } } }
  }
}

function toBytes(data: unknown): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBufferLike)
}

// ---- ControlLink: session lifecycle + the daemon event stream -------------

/** The one non-pane WebSocket: session lifecycle commands (create/kill/
 * rename/suspend/resume/dumpBacklog) out, and the `onDaemonEvent` stream in.
 * Never sends `{t:'open'}` — it has nothing to Attach, so it never receives
 * pty `Data`/`backlog` either. */
export class ControlLink {
  private socket: SocketLike
  private readonly sendQueue: string[] = []
  /** Names awaiting a `DumpBacklog` payload, FIFO. The hub processes one
   * client's queue strictly in order (`Client.tx` is a single bounded
   * channel), so a `backlogReply` marker and the binary that follows it are
   * always adjacent even with two dumps in flight for different sessions —
   * shifting the oldest pending name off this queue when the binary arrives
   * pairs them correctly without needing the marker to repeat the name past
   * matching a set of one. */
  private readonly dumpPending: string[] = []

  constructor(
    private readonly connectSocket: () => SocketLike,
    private readonly dispatch: (ev: unknown) => void,
  ) {
    this.socket = connectSocket()
    this.wire()
  }

  private wire(): void {
    const s = this.socket
    s.onopen = (): void => {
      this.dispatch({ status: 'connected' })
      for (const m of this.sendQueue.splice(0)) s.send(m)
    }
    s.onclose = (): void => {
      this.dispatch({ status: 'disconnected' })
      setTimeout(() => {
        this.socket = this.connectSocket()
        this.wire()
      }, RECONNECT_MS)
    }
    s.onerror = (): void => {
      try {
        s.close()
      } catch {
        /* onclose handles the retry */
      }
    }
    s.onmessage = (e: { data: unknown }): void => {
      if (typeof e.data !== 'string') {
        const name = this.dumpPending.shift()
        if (name !== undefined) {
          this.dispatch({
            frame: { type: 'control', msg: { kind: 'Backlog', name, data: toBytes(e.data) } },
          })
        }
        return
      }
      const msg = parseServerMsg(e.data)
      if (!msg) return
      if (msg.t === 'backlogReply') {
        this.dumpPending.push(msg.name)
        return
      }
      // `backlog` (the Attach-replay tag) and `exit` never reach this
      // connection — it never opens anything — but ignore rather than
      // assume, matching the "unknown t is ignored" discipline `app.js` and
      // `parse_browser_msg` already use.
      if (msg.t === 'backlog' || msg.t === 'exit') return
      this.dispatch(toDaemonEvent(msg))
    }
  }

  send(msg: unknown): void {
    const text = JSON.stringify(msg)
    if (this.socket.readyState === SOCKET_OPEN) this.socket.send(text)
    else this.sendQueue.push(text)
  }
}

// ---- PaneLink: one dedicated connection per open pane ----------------------

/** One pane's dedicated `/ws` connection + the `MessageChannel` port bridged
 * to it (spec §2.2/§4a). Reproduces the preload's `pane-port` contract
 * exactly: raw pty bytes flow to `port.postMessage`, keystrokes flow back as
 * binary sends — `Pane.tsx` needs no changes to consume either end. */
export class PaneLink {
  private socket: SocketLike
  private awaitingBacklog = false
  // Debounces the pane's own `{resize:{cols,rows}}` port message (below) —
  // cleared and restarted on every one, so only the size the drag SETTLES on
  // reaches the wire. Mirrors main.tsx's 300 ms "no write mid-drag" layout
  // debounce (same policy: only the settled value matters), reused rather
  // than inventing a second number.
  private resizeTimer: ReturnType<typeof setTimeout> | null = null
  // Set by our own `close()`. Without this, `close()`'s own `socket.close()`
  // fires `onclose` like any other drop and schedules a reconnect — a pane
  // deliberately closed (unmount/workspace-switch) would resurrect a zombie
  // socket a second later, the exact leak task 2 warns about.
  private closed = false

  constructor(
    private readonly session: string,
    private readonly connectSocket: () => SocketLike,
    private readonly port: PortLike,
    private readonly onExit: (name: string, code: number) => void,
  ) {
    this.socket = connectSocket()
    this.wire()
    this.port.onmessage = (e: { data: unknown }): void => {
      const m = e.data as { data?: Uint8Array; resize?: { cols: number; rows: number } }
      if (m.data && this.socket.readyState === SOCKET_OPEN) {
        this.socket.send(m.data instanceof Uint8Array ? m.data : new Uint8Array(m.data))
      }
      // The browser may now resize its own pty (2026-08-01 decision reversing
      // the earlier "never resize" rule — see the file header). Debounced:
      // `crates/amber/src/web.rs`'s `map_browser_msg` is the actual bounds/
      // liveness check, this just paces the wire.
      if (m.resize) {
        const { cols, rows } = m.resize
        if (this.resizeTimer !== null) clearTimeout(this.resizeTimer)
        this.resizeTimer = setTimeout(() => {
          this.resizeTimer = null
          if (this.socket.readyState === SOCKET_OPEN) {
            this.socket.send(JSON.stringify({ t: 'resize', name: this.session, cols, rows }))
          }
        }, RESIZE_DEBOUNCE_MS)
      }
    }
    this.port.start()
  }

  private wire(): void {
    const s = this.socket
    const session = this.session
    s.onopen = (): void => {
      // Sent on EVERY (re)connect, first one included — there is no separate
      // "queued open at construction time" path competing with it, which is
      // what let the spike's `everConnected` guard exist to fix a double-
      // Attach in the first place. One trigger, one send.
      s.send(JSON.stringify({ t: 'open', name: session }))
    }
    s.onclose = (): void => {
      if (this.closed) return
      setTimeout(() => {
        this.socket = this.connectSocket()
        this.wire()
      }, RECONNECT_MS)
    }
    s.onerror = (): void => {
      try {
        s.close()
      } catch {
        /* onclose handles the retry */
      }
    }
    s.onmessage = (e: { data: unknown }): void => {
      if (typeof e.data !== 'string') {
        const backlog = this.awaitingBacklog
        this.awaitingBacklog = false
        this.port.postMessage(backlog ? { data: toBytes(e.data), backlog: true } : { data: toBytes(e.data) })
        return
      }
      const msg = parseServerMsg(e.data)
      if (!msg) return
      if (msg.t === 'backlog') {
        this.awaitingBacklog = true
        return
      }
      if (msg.t === 'exit') {
        this.onExit(msg.name, msg.code)
        return
      }
      // sessions/error/activity/memory/backlogReply: `ControlLink`'s job, not
      // this connection's — see the file header.
    }
  }

  /** Tear down this pane: close the port, then the socket. No `{t:'close'}`
   * send — simply closing the connection makes the server's own
   * `remove_client` -> `detach_if_unwanted` do the identical Detach, and a
   * `{t:'close'}` after the daemon has already forgotten the session (or
   * before the very first `open` lands) would just draw a spurious
   * "no such session" error back at nobody. */
  /**
   * Hand back a borrowed pty grid (spec §2.3) without closing the pane.
   *
   * The server releases on socket death anyway — that is what covers a phone
   * that walks out of Wi-Fi range — but waiting for a TCP timeout would leave
   * the desktop squeezed for as long as it takes. This is the fast path for
   * the common case: the user un-zoomed, backgrounded the tab, or closed it.
   */
  release(): void {
    // A fit posted just before the user leaves desktop/focus mode is still
    // sitting in this debounce window. Cancel it before releasing the borrowed
    // grid or that stale resize can arrive afterward and immediately re-borrow
    // the geometry we just handed back.
    if (this.resizeTimer !== null) {
      clearTimeout(this.resizeTimer)
      this.resizeTimer = null
    }
    if (this.closed || this.socket.readyState !== SOCKET_OPEN) return
    this.socket.send(JSON.stringify({ t: 'release' }))
  }

  close(): void {
    this.closed = true
    if (this.resizeTimer !== null) clearTimeout(this.resizeTimer)
    // Ask for the grid back before the socket goes; the server-side release on
    // close is the backstop, not the primary path.
    this.release()
    this.port.close()
    this.socket.close()
  }
}

// ---- window.amber -----------------------------------------------------------

export interface AmberDeps {
  connectSocket: () => SocketLike
  newChannel: () => { port1: PortLike; port2: unknown }
  postPanePort: (session: string, port2: unknown) => void
  clipboard: { writeText: (text: string) => Promise<void>; readText: () => Promise<string> }
  home: string
  machineName: string
  softwareGl: boolean
  // Layout CAS (spec 2026-08-01 §6), injected so this file stays fetch-free
  // and testable with fakes (the rest of the file's discipline). The real
  // implementations (install.ts) round-trip `/api/layout` on `amber web`
  // (crates/amber/src/web.rs), behind the same cookie boundary as
  // `/api/sessions`.
  layoutGet: () => Promise<LoadLayoutResult>
  layoutSave: (text: string, version: LayoutVersion) => Promise<SaveLayoutResult>
  // Cookie-gated `/api/router/*` on `amber web`. Injected so this file stays
  // fetch-free; `install.ts` supplies the real wrappers.
  routerApi: RouterApi
  // Cookie-gated `GET /api/usage`. Returns the raw body; the shim decodes it
  // with the same tolerant decoder the control wire uses.
  usageApi: (refresh?: boolean) => Promise<unknown>
}

export interface RouterApi {
  status: () => Promise<string>
  action: (action: string) => Promise<{ ok: boolean; error?: string }>
  slots: () => Promise<{ ok: boolean; error?: string; slots: RouterSlot[] }>
  saveSlots: (slots: unknown[]) => Promise<{ ok: boolean; error?: string }>
  revealKey: (name: string) => Promise<string>
  logTail: () => Promise<string>
}

function notImplemented(name: string): () => never {
  return () => {
    throw new Error(`window.amber.${name}: not available in the web build`)
  }
}

/** Build the full `window.amber` contract (the exact shape `main.tsx`
 * declares globally) over `deps`. Kept separate from `install.ts` so this
 * whole file stays free of `WebSocket`/`MessageChannel`/`window` and is
 * importable under vitest's `node` environment. */
/**
 * Web-only extension to the `window.amber` surface.
 *
 * NOT added to the renderer's `Window['amber']` declaration on purpose: the
 * renderer must never learn a host-specific method (spec §0.1). Only
 * `install.ts` — which is web-only by definition — sees this type.
 */
export type WebAmber = Window['amber'] & {
  /**
   * Hand back every borrowed pty grid without tearing panes down (spec §2.3).
   * Called on `visibilitychange:hidden` and `pagehide`: a phone in a pocket
   * must not keep the desktop squeezed to phone width.
   */
  releaseGrids: () => void
}

export function createAmber(deps: AmberDeps): WebAmber {
  let onEvent: ((d: unknown) => void) | null = null
  const pending: unknown[] = []
  const dispatch = (ev: unknown): void => {
    if (onEvent) onEvent(ev)
    else pending.push(ev)
  }

  const control = new ControlLink(deps.connectSocket, dispatch)
  const panes = new Map<string, PaneLink>()

  const api: Window['amber'] = {
    softwareGl: deps.softwareGl,
    homeDir: deps.home,
    machineName: deps.machineName,
    // The browser build is never an ssh mirror; it IS the remote surface.
    remoteHost: '',
    connectHost: notImplemented('connectHost'),
    onConnectHostPrompt: (): void => {},

    onDaemonEvent: (cb): void => {
      onEvent = cb
      for (const ev of pending.splice(0)) cb(ev)
    },

    // --- §2.2/§4a: the pane MessageChannel path, one socket per pane -------
    openPane: (session): void => {
      // A remount (workspace switch) before the old pane's close lands must
      // not leak a second socket+port for the same name — mirrors the
      // Electron client's `router.ts::attach`.
      panes.get(session)?.close()
      const channel = deps.newChannel()
      const link = new PaneLink(session, deps.connectSocket, channel.port1, (name, code) =>
        dispatch({ frame: { type: 'control', msg: { kind: 'Exit', name, code } } }),
      )
      panes.set(session, link)
      deps.postPanePort(session, channel.port2)
    },
    closePane: (session): void => {
      panes.get(session)?.close()
      panes.delete(session)
    },

    // --- session lifecycle: existing browser whitelist ----------------------
    createSession: (name, cwd, sessionKind, title): void => control.send({ t: 'create', name, cwd, kind: sessionKind, ...(title === undefined ? {} : { title }) }),
    killSession: (name): void => control.send({ t: 'kill', name }),
    setSessionTitle: (name, title): void => control.send({ t: 'set-title', name, title }),
    renameSession: (from, to): void => control.send({ t: 'move', from, to }),
    suspendSession: (name): void => control.send({ t: 'suspend', name }),
    resumeSession: (name): void => control.send({ t: 'resume', name }),
    focusSession: (name): void => control.send({ t: 'focus', name }),
    dumpBacklog: (name): void => control.send({ t: 'dumpBacklog', name }),
    // A hosted Pocket/web client never owns a local Electron WebContentsView.
    setBrowserContext: async (): Promise<unknown> => ({ ok: true }),
    browserCommand: async (): Promise<unknown> => ({ ok: false, error: 'BROWSER_HOST_UNAVAILABLE' }),
    importWorkspaceBrowsers: async (): Promise<unknown> => ({ ok: false, error: 'BROWSER_HOST_UNAVAILABLE' }),
    snapshotWorkspaceBrowsers: async (): Promise<unknown> => ({ ok: true, result: {} }),
    browserRecovery: async (): Promise<unknown> => ({ ok: false, error: 'BROWSER_HOST_UNAVAILABLE' }),
    onTabBrowserEvent: (): (() => void) => () => {},
    onBrowserAssociation: (): void => {},

    // --- native browser API, not a stub (spec §3 "Clipboard" row) ----------
    clipboardWrite: (text): void => {
      void deps.clipboard.writeText(text)
    },
    clipboardRead: (): Promise<string> => deps.clipboard.readText(),

    // --- layout CAS (spec §6): thin passthrough to the injected HTTP hooks.
    // `main.tsx`'s persist effect is what actually implements the CAS retry/
    // merge (mergeLayout) — this file only needs to round-trip the wire
    // shape, exactly like every other method here.
    loadLayout: (): Promise<LoadLayoutResult> => deps.layoutGet(),
    saveLayout: (text, version): Promise<SaveLayoutResult> => deps.layoutSave(text, version),

    // --- §7 cuts + native dialogs: visible-throw stubs, never a silent no-op
    saveWorkspaceFile: notImplemented('saveWorkspaceFile'),
    openWorkspaceFile: notImplemented('openWorkspaceFile'),
    pickFolder: notImplemented('pickFolder'),
    // Path resolution is desktop-only (main-process fs.stat) — but unlike the
    // stubs above this sits on a hot interaction path (every selection change
    // in Pane.tsx calls it), so a synchronous throw here was an uncaught
    // exception on every mouse selection in the web build. `null` is the
    // documented "cannot resolve" result (see main.tsx's declared
    // `Promise<string | null>` contract and Pane.tsx's `abs ? ... : null`
    // handling) — decline gracefully instead of throwing.
    resolvePath: (): Promise<string | null> => Promise.resolve(null),
    revealPath: notImplemented('revealPath'),
    editorOpenDialog: notImplemented('editorOpenDialog'),
    editorRead: notImplemented('editorRead'),
    editorSave: notImplemented('editorSave'),
    editorSaveDialog: notImplemented('editorSaveDialog'),
    editorDraftWrite: notImplemented('editorDraftWrite'),
    editorDraftRead: notImplemented('editorDraftRead'),
    editorDraftClear: notImplemented('editorDraftClear'),
    editorInlineImages: notImplemented('editorInlineImages'),
    claudeNames: notImplemented('claudeNames'),
    // Desktop-only: the daemon-side budget control messages are not on the
    // browser whitelist, so there is nothing honest to send.
    getMemoryBudget: notImplemented('getMemoryBudget'),
    setMemoryBudget: notImplemented('setMemoryBudget'),

    // Agent plan quota (design 2026-09-01 §3). Rides an authenticated HTTP
    // route rather than the pane socket — the browser control whitelist is
    // deliberately not widened — and the reply is pushed into the SAME daemon
    // event stream the desktop uses, so the renderer needs no host branch.
    getUsage: (refresh = false): void => {
      void deps
        .usageApi(refresh)
        .then((body) => {
          const raw = (body as { providers?: unknown } | null)?.providers
          const providers = Array.isArray(raw) ? raw.map(decodeProviderUsage) : []
          dispatch({ frame: { type: 'control', msg: { kind: 'Usage', providers } } })
        })
        .catch(() => {
          // A failed poll leaves the last snapshot in place; the next tick
          // retries. Never dispatch an empty list on failure — that would read
          // as "no quota" rather than "not fetched".
        })
    },

    // --- remote access (spec 2026-08-22 §9) --------------------------------
    // The browser IS the remote client; it has no service to manage and no
    // business reading the host's token. These report their own absence
    // rather than throwing, because `main.tsx` calls `webStatus` on mount and
    // an uncaught throw there would take the whole toolbar down.
    webStatus: (): Promise<WebStatus> =>
      Promise.resolve({
        // A page served BY `amber web` cannot manage the service serving it.
        // `main.tsx` hides the pill on this flag rather than painting a
        // permanent red error badge on every phone.
        managed: false,
        unit: 'unknown',
        port: 0,
        url: '',
        tailscale: 'not-installed',
        host: '',
        hasToken: false,
        clients: [],
        sessions: null,
        uptimeSecs: null,
        error: 'remote access is managed from the desktop app',
      }),
    webAction: (): Promise<{ ok: boolean; error?: string }> =>
      Promise.resolve({ ok: false, error: 'not available in the browser' }),
    webUrl: (): Promise<string> => Promise.resolve(''),
    webLogTail: (): Promise<string> => Promise.resolve(''),
    webOpenLocal: (): Promise<void> => Promise.resolve(),

    // --- local router (design 2026-09-01, hosted desktop view 2026-09-01) --
    // Same cookie boundary as `/api/sessions`. The shim never holds the
    // router's bearer token; `amber web` loads it server-side. Keys arrive
    // only from `revealKey`, on a deliberate press.
    routerStatus: async (): Promise<RouterStatus> =>
      parseRouterStatus(await deps.routerApi.status()),
    routerAction: (action: string): Promise<{ ok: boolean; error?: string }> =>
      deps.routerApi.action(action),
    routerSlots: (): Promise<{ ok: boolean; error?: string; slots: RouterSlot[] }> =>
      deps.routerApi.slots(),
    routerSaveSlots: (slots: RouterSlot[]): Promise<{ ok: boolean; error?: string }> =>
      deps.routerApi.saveSlots(slots),
    routerRevealKey: (name: string): Promise<string> => deps.routerApi.revealKey(name),
    routerLogTail: (): Promise<string> => deps.routerApi.logTail(),
  }
  return {
    ...api,
    releaseGrids: (): void => {
      for (const link of panes.values()) link.release()
    },
  }
}
