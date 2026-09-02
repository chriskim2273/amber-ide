import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SplitView, fmtMem, type PaneMeta, type PaneKind } from './SplitView'
import { BrowserRail } from './BrowserRail'
import { Icon } from './Icon'
import { PANE_KIND_OPTIONS, continuityView, machineWindowTitle, type SnapshotState } from './uiModel'
import type { EditorApi } from './Editor'
import { initialState, reduce, groupSessions, mergeBrowserRailTabs, mergeEditors, tabDot, hasActivity, isAgentKind, type DaemonEvent } from './store'
import { ResourcePressureBanner } from './PressureBanners'
import type { ControlMsg } from '../shared/proto'
import { sessionRows } from './sessionRows'
import { commandCenterModel, type CommandCenterItem } from './commandCenter'
import { DesktopAttention, attentionNames } from './DesktopAttention'
import { PocketCommandCenter, PocketFocusHeader, PocketNav, pocketSessionTitle } from './PocketCommandCenter'
import { PocketNewSessionSheet, PocketSessionSheet, type PocketSessionKind } from './PocketSheets'
import { deriveTab, shortCwd } from './tabView'
import { RemoteAccess } from './RemoteAccess'
import { RouterPanel } from './RouterPanel'
import { Drawer } from './Drawer'
import { applyViewportMode, desktopControlSize, isMobileMode, useMobile, type MobileViewMode } from './mobile'
import type { WebStatus } from '../shared/webStatus'
import type { RouterSlot, RouterStatus } from '../shared/routerStatus'
import { routerDot } from '../shared/routerStatus'
import {
  emptyProductivity, parseProductivity, serializeProductivity, mutateProductivity, replayProductivity,
  type LoadProductivityResult, type SaveProductivityResult, type ProductivityFile,
  type WorkspaceTemplate, type SessionBookmark, type PresetInputSlot,
} from '../shared/productivity'
import { serializeCheckpoint, parseCheckpoint, type CheckpointSummary } from '../shared/checkpoint'
import type { ProjectProfile } from '../shared/projectProfile'
import { serializeHandoff } from '../shared/handoff'
import { formatName, makeId, parseName, retargetPane } from '../shared/names'
import { formatEditorName, isEditorName, parseEditorName } from '../shared/editorName'
import { splitLeaf, setRatio, reconcile, leaves, moveLeaf, type Node } from './layout'
import {
  emptyLayout, parseLayout, serializeLayout, orderTabs, moveTab, mergeLayout,
  type LayoutFile, type TabLayout, type LoadLayoutResult, type SaveLayoutResult,
} from '../shared/layoutFile'
import {
  parseWorkspaceFile, serializeWorkspaceFile, assembleSave, requireWorkspaceBrowserSnapshots,
  type WorkspaceDoc, type SaveWorkspace, type LoadPlan,
} from '../shared/workspaceFile'
import { collectDumps, matchDumpError } from './dumps'
import { stageReplay } from './replay'
import { formatKb, parseBudgetInput, type BudgetView } from '../shared/budget'
import { appChord, chordLabel, modLabel, CHORD_TABLE } from './keys'
import { type PaletteEntry } from './commandPalette'
import { activitySummary, bookmarkNeedle, makeBookmark, searchScopeNames, shouldNotify, type SearchScope } from './productivityModels'
import {
  CommandPalette, GlobalSearchDialog, RecoveryCenter, TemplatesDialog,
  BookmarksDialog, PresetInputsDialog, CheckpointsDialog, ProjectProfileDialog,
} from './ProductivityDialogs'
import './theme.css'
import './BrowserRail.css'

declare global {
  interface Window {
    amber: {
      softwareGl: boolean
      onDaemonEvent: (cb: (d: unknown) => void) => void
      openPane: (session: string) => void
      closePane: (session: string) => void
      createSession: (name: string, cwd: string, sessionKind: string) => void
      killSession: (name: string) => void
      renameSession: (from: string, to: string) => void
      suspendSession: (name: string) => void
      resumeSession: (name: string) => void
      focusSession: (name: string) => void
      dumpBacklog: (name: string) => void
      // Desktop-only; amber-web intentionally does not widen its control whitelist.
      searchScrollback?: (requestId: number, query: string, names: string[], limit: number) => void
      listRecoveryEvents?: (limit: number) => void
      clearRecoveryEvents?: () => void
      // Memory budget view/change; the BudgetApplied reply arrives via
      // onDaemonEvent. mb is MiB, 0 = auto.
      getMemoryBudget: () => void
      setMemoryBudget: (mb: number) => void
      // Desktop-only capability. The browser client's security whitelist does
      // not expose Snapshot, so its bridge intentionally omits this method.
      snapshotNow?: () => void
      // CAS (spec 2026-08-01 §6): `saveLayout` must be given the version
      // `loadLayout`/the previous `saveLayout` returned, so a concurrent
      // writer (the browser, or another desktop instance) is detected rather
      // than silently overwritten. See the persist effect below.
      loadLayout: () => Promise<LoadLayoutResult>
      saveLayout: (text: string, version: string | null) => Promise<SaveLayoutResult>
      setBrowserContext?: (context: unknown) => Promise<unknown>
      browserCommand: (command: unknown) => Promise<unknown>
      importWorkspaceBrowsers?: (entries: unknown) => Promise<unknown>
      snapshotWorkspaceBrowsers?: () => Promise<unknown>
      browserRecovery?: (command: unknown) => Promise<unknown>
      onTabBrowserEvent?: (cb: (event: unknown) => void) => (() => void)
      onBrowserAssociation: (cb: (association: unknown) => void) => void
      loadProductivity?: () => Promise<LoadProductivityResult>
      saveProductivity?: (text: string, version: string | null) => Promise<SaveProductivityResult>
      readProjectProfile?: (root: string) => Promise<{ profile: ProjectProfile; root: string; resolvedCwds: string[] } | { error: string }>
      listCheckpoints?: () => Promise<CheckpointSummary[]>
      writeCheckpoint?: (id: string, text: string) => Promise<void>
      readCheckpoint?: (id: string) => Promise<string>
      deleteCheckpoint?: (id: string) => Promise<void>
      saveHandoffFile?: (text: string, suggested: string) => Promise<boolean>
      notify?: (payload: { title: string; body: string; session?: string }) => void
      onNotificationActivate?: (cb: (session: string) => void) => void
      saveWorkspaceFile: (json: string, suggestedName: string) => Promise<boolean>
      openWorkspaceFile: () => Promise<string | null>
      homeDir: string
      /** Human-readable machine identity supplied by the host bridge. */
      machineName: string
      /** `user@host` when this window mirrors a remote machine's amber. */
      remoteHost?: string
      connectHost?: (host: string) => Promise<void>
      onConnectHostPrompt?: (cb: () => void) => void
      pickFolder: () => Promise<string | null>
      resolvePath: (cwd: string, raw: string) => Promise<string | null>
      revealPath: (abs: string) => void
      clipboardWrite: (text: string) => void
      clipboardRead: () => Promise<string>
      // Editor pane file IO (spec 2026-07-19 §4) — all disk access lives in main.
      editorOpenDialog: () => Promise<
        { path: string; text: string; mtimeMs: number } | { path: string; error: string } | null>
      editorRead: (path: string) => Promise<{ text: string; mtimeMs: number } | { error: string }>
      editorSave: (path: string, text: string, expectedMtimeMs: number | null) =>
        Promise<{ mtimeMs: number } | { conflict: true; mtimeMs: number } | { error: string }>
      editorSaveDialog: (suggestedName: string, text: string) =>
        Promise<{ path: string; mtimeMs: number } | { path: string; error: string } | null>
      editorDraftWrite: (paneId: string, text: string) => Promise<void>
      editorDraftRead: (paneId: string) => Promise<string | null>
      editorDraftClear: (paneId: string) => Promise<void>
      editorInlineImages: (mdDir: string, html: string) => Promise<{ html: string }>
      // Session-cleanup dialog: conversation labels for claude session ids.
      claudeNames: (entries: { id: string; cwd: string }[]) => Promise<Record<string, string>>
      // Remote access (spec 2026-08-22 §9). `webUrl` returns the TOKENISED
      // login url and is called on demand only — never on the status poll.
      webStatus: () => Promise<WebStatus>
      webAction: (action: string) => Promise<{ ok: boolean; error?: string }>
      webUrl: () => Promise<string>
      webLogTail: () => Promise<string>
      webOpenLocal: () => Promise<void>
      // Local router (design 2026-09-01). `routerRevealKey` returns a
      // plaintext provider key and is called on a deliberate gesture only —
      // never on the status poll.
      routerStatus: () => Promise<RouterStatus>
      routerAction: (action: string) => Promise<{ ok: boolean; error?: string }>
      routerSlots: () => Promise<{ ok: boolean; error?: string; slots: RouterSlot[] }>
      routerSaveSlots: (
        slots: RouterSlot[],
      ) => Promise<{ ok: boolean; error?: string }>
      routerRevealKey: (name: string) => Promise<string>
      routerLogTail: () => Promise<string>
    }
  }
}

function toEvent(d: unknown): DaemonEvent | null {
  const f = (d as { frame?: { type: string; msg?: Record<string, unknown> } }).frame
  if (f?.type !== 'control' || !f.msg) return null
  const m = f.msg as ControlMsg
  if (m.kind === 'Sessions') return { kind: 'Sessions', sessions: m['sessions'] as never }
  if (m.kind === 'SessionsChanged') return { kind: 'SessionsChanged', added: m['added'] as never, removed: m['removed'] as never }
  if (m.kind === 'Activity') return { kind: 'Activity', name: m['name'] as string }
  if (m.kind === 'MemoryStat') return { kind: 'Memory', name: m['name'] as string, rssKb: (m['rss_kb'] as number) ?? 0, growing: (m['growing'] as boolean) ?? false }
  if (m.kind === 'MemoryPressure') return {
    kind: 'MemoryPressure', level: m.level, currentKb: m.current_kb,
    budgetKb: m.budget_kb, blocked: m.blocked,
  }
  if (m.kind === 'ResourcePressure') return {
    kind: 'ResourcePressure', level: m.level, causes: m.causes,
    blocked: m.blocked,
  }
  if (m.kind === 'Exit') return { kind: 'Exit', name: m['name'] as string, code: m['code'] as number }
  if (m.kind === 'Error') return { kind: 'Error', msg: m['msg'] as string }
  return null
}


const DEFAULT_FONT_SIZE = 13
/** Phone default — see `.reports/mobile-agent-cols.md`. */
const MOBILE_FONT_SIZE = 14
// Stable empty frozen map so `layout.frozen ?? EMPTY_FROZEN` doesn't mint a new
// object every render (keeps SplitView's `frozen` prop referentially stable).
const EMPTY_FROZEN: Record<string, { note?: string }> = {}
// Stable empty editors map — same reason as EMPTY_FROZEN: a fresh {} every
// render would defeat SplitView's memoized children.
const EMPTY_EDITORS: NonNullable<LayoutFile['editors']> = {}
// App-wide terminal font size, clamped to a sane range (integer px).
function clampFont(n: number): number {
  return Math.max(8, Math.min(32, Math.round(n)))
}

// Inline rename field for workspace pills / tabs. Enter commits, Escape cancels,
// blur commits — Enter/Escape just blur (with a cancel flag) so the single commit
// path lives in onBlur. stopPropagation keeps typing away from the global chords
// and the parent's click-to-switch / double-click handlers.
function RenameInput({ initial, onCommit, onCancel }:
  { initial: string; onCommit: (v: string) => void; onCancel: () => void }): JSX.Element {
  const cancel = useRef(false)
  return (
    <input
      className="rename-input"
      defaultValue={initial}
      autoFocus
      aria-label="rename"
      spellCheck={false}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') { cancel.current = false; e.currentTarget.blur() }
        else if (e.key === 'Escape') { cancel.current = true; e.currentTarget.blur() }
      }}
      onBlur={(e) => { if (cancel.current) onCancel(); else onCommit(e.currentTarget.value) }}
    />
  )
}

function App(): JSX.Element {
  const bridgeReady = typeof window.amber?.onDaemonEvent === 'function'
  const [state, dispatch] = useReducer(reduce, undefined, initialState)
  const [layout, setLayout] = useState<LayoutFile>(emptyLayout)
  const [activeTab, setActiveTab] = useState(1)
  const [activeWs, setActiveWs] = useState(1)
  // Which label is being inline-renamed (workspace pill or tab), if any.
  const [editing, setEditing] = useState<{ kind: 'ws' | 'tab'; id: number } | null>(null)
  // Tab id currently being dragged for reorder (HTML5 drag; ref, not state, so
  // the drag gesture never re-renders the terminals).
  const dragTab = useRef<number | null>(null)
  const [kind, setKind] = useState<PaneKind>('shell')
  // Desktop command surfaces. Only one may be open at a time; each is a small
  // popover rather than another permanent toolbar cluster.
  const [toolbarMenu, setToolbarMenu] = useState<'pane-kind' | 'tools' | 'continuity' | 'attention' | null>(null)
  const [routerStatus, setRouterStatus] = useState<RouterStatus | null>(null)
  const [routerOpen, setRouterOpen] = useState(false)
  // Presentation state for the existing daemon Snapshot/SnapshotOk exchange.
  // A timestamp is shown only after the daemon explicitly confirms the write.
  const [snapshotState, setSnapshotState] = useState<SnapshotState>({ kind: 'idle' })
  // Absolute working directory for newly created panes (default $HOME). Sent
  // verbatim so a session restores in the SAME folder — a relative '.' would
  // drift to the daemon's cwd ($HOME under systemd) on restart.
  const [cwd, setCwd] = useState<string>(() => window.amber?.homeDir ?? '/')
  // Remote access (spec 2026-08-22 §9). The status payload carries NO token —
  // the tokenised url is fetched on demand by the dialog.
  const [webStatus, setWebStatus] = useState<WebStatus | null>(null)
  const [remoteOpen, setRemoteOpen] = useState(false)
  // Phone chrome (spec §6): the workspace pill row and tab row do not fit at
  // 390px, so they collapse into one bar plus this drawer. A user can opt into
  // the original desktop renderer; that mode asks the browser for a desktop-
  // sized layout viewport and bypasses Pocket until they explicitly return.
  const mobileViewport = useMobile()
  const [mobileViewMode, setMobileViewMode] = useState<MobileViewMode>('auto')
  const desktopView = mobileViewMode === 'desktop'
  const mobile = isMobileMode(mobileViewport, mobileViewMode)
  const [desktopScale, setDesktopScale] = useState(1)
  useEffect(() => {
    if (!desktopView) return
    const viewport = window.visualViewport
    const update = (): void => setDesktopScale(viewport?.scale ?? 1)
    update()
    const frame = requestAnimationFrame(update)
    viewport?.addEventListener('resize', update)
    return () => {
      cancelAnimationFrame(frame)
      viewport?.removeEventListener('resize', update)
    }
  }, [desktopView])
  const [drawerOpen, setDrawerOpen] = useState(false)
  // Amber Pocket is a mobile composition over the same daemon truth and pane
  // lifecycle. The phone lands in Sessions; Mosaic exposes the existing split
  // tree. Focus remains the existing per-tab zoom state, never a second pane.
  const [pocketView, setPocketView] = useState<'sessions' | 'mosaic'>('sessions')
  const [pocketWorkspace, setPocketWorkspace] = useState<number | null>(null)
  const [pocketAction, setPocketAction] = useState<CommandCenterItem | null>(null)
  const [pocketNewOpen, setPocketNewOpen] = useState(false)
  const showDesktopView = (): void => {
    setDrawerOpen(false)
    applyViewportMode(document, true)
    setMobileViewMode('desktop')
  }
  const showPocketView = (): void => {
    // Commit scale mode first. The effect below releases the desktop borrow and
    // restores device-width only after every Pane has rendered with fitMode=scale;
    // otherwise the meta-tag resize can race through a stale fit-mode ref and
    // immediately resize the PTY again after release.
    setMobileViewMode('pocket')
    setPocketView('sessions')
  }
  useEffect(() => {
    if (mobileViewMode !== 'pocket') return
    // Desktop fit mode may have borrowed a desktop-sized grid for every visible
    // pane. PaneLink.release also cancels any resize still being debounced.
    ;(window.amber as unknown as { releaseGrids?: () => void }).releaseGrids?.()
    applyViewportMode(document, false)
  }, [mobileViewMode])
  useEffect(() => () => { applyViewportMode(document, false) }, [])
  // SSH remote window (spec 2026-08-23): this window mirrors another machine's
  // arrangement and never writes its sidecar. Read once — a window is local or
  // remote for its whole life.
  const [remoteHost] = useState<string>(() => window.amber?.remoteHost ?? '')
  useEffect(() => {
    document.title = machineWindowTitle(window.amber?.machineName ?? '', remoteHost)
  }, [remoteHost])
  // "Connect to host…" (menu) asks the RENDERER for the destination: Electron
  // has no window.prompt, so main sends this and we show a real dialog.
  const [connectOpen, setConnectOpen] = useState(false)
  useEffect(() => {
    window.amber?.onConnectHostPrompt?.(() => setConnectOpen(true))
  }, [])
  const [connected, setConnected] = useState(true)
  const [showHelp, setShowHelp] = useState(false)
  // Workspace save/load UI. `saveScopeOpen` shows the one-vs-all scope dialog;
  // `loadDoc` (a parsed file) shows the new-vs-replace mode dialog; `notice` is a
  // local, dismissible info banner (parse errors, dump-timeout stragglers) kept
  // SEPARATE from the daemon-error banner (state.error) so neither hijacks the other.
  const [saveScopeOpen, setSaveScopeOpen] = useState(false)
  const [loadDoc, setLoadDoc] = useState<WorkspaceDoc | null>(null)
  const workspaceSourceTexts = useRef(new WeakMap<WorkspaceDoc, string>())
  const [notice, setNotice] = useState<string | null>(null)
  const [browserRecoveryOpen, setBrowserRecoveryOpen] = useState(false)
  const [browserRecovery, setBrowserRecovery] = useState<Array<{ index: number; workspace: number; tab: number; safeRestoreUrl: string }>>([])
  useEffect(() => window.amber.onTabBrowserEvent?.((value) => {
    const event = value as { type?: unknown; waiting?: unknown; browserId?: unknown; workspace?: unknown; tab?: unknown; browser?: unknown }
    if (event.type === 'capacity-wait' && event.waiting === true) setNotice('Waiting for browser capacity…')
    else if (event.type === 'capacity-wait' && event.waiting === false) setNotice((current) => current === 'Waiting for browser capacity…' ? null : current)
    else if (event.type === 'approval-reveal' && typeof event.browserId === 'string' && typeof event.workspace === 'number' && typeof event.tab === 'number' && event.browser && typeof event.browser === 'object') {
      const browser = event.browser as NonNullable<LayoutFile['workspaces'][string]['tabs'][string]['browser']>
      if (browser.id !== event.browserId) return
      setLayout((current) => {
        const workspace = current.workspaces[String(event.workspace)] ?? { activeTab: event.tab as number, tabs: {} }
        const previous = workspace.tabs[String(event.tab)] ?? { tree: null }
        return { ...current, activeWorkspace: event.workspace as number, version: 2, browserRevision: (current.browserRevision ?? 0) + 1,
          workspaces: { ...current.workspaces, [String(event.workspace)]: { ...workspace, activeTab: event.tab as number, tabs: { ...workspace.tabs, [String(event.tab)]: { ...previous, browser } } } } }
      })
      setActiveWs(event.workspace); setActiveTab(event.tab)
    }
  }), [])
  type ProductivityOverlay = 'palette' | 'search' | 'recovery' | 'templates' | 'bookmarks' | 'presets' | 'checkpoints' | 'project'
  const [productivityOverlay, setProductivityOverlay] = useState<ProductivityOverlay | null>(null)
  const [productivity, setProductivity] = useState<ProductivityFile>(emptyProductivity)
  const productivityRef = useRef(productivity)
  productivityRef.current = productivity
  const productivityVersion = useRef<string | null>(null)
  const productivityPersisted = useRef<ProductivityFile>(emptyProductivity())
  const productivityPending = useRef<Array<(file: ProductivityFile) => ProductivityFile>>([])
  const productivitySaveChain = useRef<Promise<void>>(Promise.resolve())
  const [searchResults, setSearchResults] = useState<import('../shared/proto').SearchResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const searchRequest = useRef(0)
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [recoveryEvents, setRecoveryEvents] = useState<import('../shared/proto').RecoveryEvent[]>([])
  const [recoveryLoading, setRecoveryLoading] = useState(false)
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  const recoveryTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[]>([])
  const [projectProfile, setProjectProfile] = useState<{ profile: ProjectProfile; root: string; resolvedCwds: string[] } | null>(null)
  const [projectError, setProjectError] = useState<string | null>(null)
  const [findRequest, setFindRequest] = useState<{ paneId: string; query: string; seq: number } | undefined>(undefined)
  const [paneActionRequest, setPaneActionRequest] = useState<{ action: 'bookmark' | 'handoff'; seq: number } | undefined>(undefined)
  const [presetTarget, setPresetTarget] = useState<string | null>(null)
  const [insertPresetRequest, setInsertPresetRequest] = useState<{ paneId: string; text: string; seq: number } | undefined>(undefined)
  const navigationSeq = useRef(0)
  const notificationDedup = useRef(new Map<string, number>())
  const navigateRef = useRef<(session: string, query?: string) => void>(() => {})
  useEffect(() => window.amber.onNotificationActivate?.((session) => navigateRef.current(session)), [])
  // A close blocked on unsaved work (spec §3.3): the pane stays until the user
  // picks save / discard / cancel. Cancel ABORTS the close.
  const [closeAsk, setCloseAsk] = useState<string | null>(null)
  // A close of a TERMINAL pane, awaiting confirmation. Closing a pane kills its
  // daemon session — the pty, the shell, and anything running in it — and that
  // is not undoable, so it is asked rather than assumed.
  const [killAsk, setKillAsk] = useState<string[] | null>(null)
  // Session-cleanup dialog: open flag + the claude conversation labels fetched
  // for it (main reads the transcripts; see claudeNames.ts).
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [sessionView, setSessionView] = useState<'all' | 'attention'>('all')
  const [activityQuery, setActivityQuery] = useState('')
  const [activityState, setActivityState] = useState<'all' | 'live' | 'exited' | 'agents' | 'retrying' | 'fallback' | 'suspended'>('all')
  const [activitySort, setActivitySort] = useState<'slot' | 'name' | 'memory' | 'activity'>('slot')
  const [claudeNames, setClaudeNames] = useState<Record<string, string>>({})
  const [picked, setPicked] = useState<Set<string>>(new Set())
  // Memory-budget dialog: the daemon's last BudgetApplied truth, the raw text
  // in the input, and a local parse error. The daemon owns the truth; this is
  // only a form over SetMemoryBudget/GetMemoryBudget.
  const [budgetOpen, setBudgetOpen] = useState(false)
  const [budget, setBudget] = useState<BudgetView | null>(null)
  const [budgetInput, setBudgetInput] = useState('')
  const [budgetError, setBudgetError] = useState<string | null>(null)
  // A load in flight: created sessions not yet all confirmed by the daemon. The
  // sidecar (trees/labels/frozen) + scrollback replay commit ONCE the daemon
  // confirms every created session AND (replace mode) the killed old panes are
  // gone — the load equivalent of the split `pending` placement pattern.
  const [pendingLoad, setPendingLoad] = useState<
    { plan: LoadPlan; createNames: string[]; killed: string[] } | null>(null)
  // Backlog-reply resolvers, keyed by session name (correlates DumpBacklog
  // requests to their async `Backlog` frames). A ref — mutating it must never
  // re-render. Consumed + cleared by collectDumps via register/unregister.
  const dumpResolvers = useRef<Map<string, (d: Uint8Array) => void>>(new Map())
  // Live OSC-2 pane titles, keyed by session name. Grows with distinct sessions
  // seen (bounded, harmless — paneMeta only reads titles for live panes).
  const [titles, setTitles] = useState<Record<string, string>>({})
  // Gate ALL layout persistence until the sidecar has loaded. Otherwise a
  // Sessions event arriving before loadLayout resolves would reconcile against
  // an empty layout (equal-columns 'h' fallback) and overwrite the real,
  // possibly-vertical saved tree before we ever read it.
  const [loaded, setLoaded] = useState(false)
  // Whether the daemon has delivered its first `Sessions` snapshot. Distinct
  // from `loaded` (the layout sidecar): a fresh daemon with zero sessions still
  // emits `Sessions{[]}` on WatchSessions, so this reliably flips true. Until
  // both are true the stage shows a loading placeholder — never the empty CTA,
  // which would flash before the real session list arrives.
  const [sawSessions, setSawSessions] = useState(false)
  // Bumped on each daemon reconnect (disconnected -> connected edge) so panes
  // can re-run their attach fixups (mouse-mode reset, TUI repaint nudge).
  const [reconnectEpoch, setReconnectEpoch] = useState(0)
  // Bumped when the main process relaunches the client utilityProcess. Distinct
  // from reconnectEpoch: a daemon blip keeps the pane MessagePorts alive (only a
  // repaint nudge is needed), but a client relaunch kills every port, so panes
  // must RE-REQUEST a fresh port from the new child. Both edges look identical
  // from the renderer's connection status, so main signals the restart explicitly.
  const [childEpoch, setChildEpoch] = useState(0)
  const prevConnected = useRef(true)
  // Splits whose session was requested but hasn't materialized yet. Held out of
  // reconcile so it can't prune/re-append them as columns; placed with the
  // requested direction once the daemon confirms the session exists.
  const [pending, setPending] = useState<Record<string, { paneId: string; dir: 'h' | 'v' }>>({})
  // Transient pane zoom, keyed by composite `${wsKey}:${tabKey}` -> zoomed
  // paneId (see zoomKey below — bare tabKey would clobber across workspaces).
  // Renderer-only — never
  // written to the layout sidecar. Cleared when the tab's pane set changes
  // structurally (split/close/move), so it can't outlive its pane.
  const [zoom, setZoom] = useState<Record<string, string>>({})
  const [focusRequest, setFocusRequest] = useState<{ paneId: string; seq: number } | null>(null)
  const focusRequestSeq = useRef(0)
  const layoutRef = useRef(layout)
  const browserContextReady = useRef<Promise<unknown>>(Promise.resolve())
  layoutRef.current = layout
  // CAS state (spec 2026-08-01 §6) — see the persist effect below for how
  // these are used together. Refs because updating them must never itself
  // trigger a render (that's what `layout` state is for).
  const baseRef = useRef<LayoutFile>(emptyLayout()) // the tree this chain believes is on disk
  const versionRef = useRef<string | null>(null) // the token that proves it
  const saveChainRef = useRef<Promise<void>>(Promise.resolve()) // serializes overlapping debounced saves
  // App-wide terminal font size lives in the layout sidecar (single source of
  // truth → auto-persists via the debounced save, no separate state to sync).
  // Phone default: 14px ≈ 46 columns at 390 CSS px. Measured, not guessed —
  // `.reports/mobile-agent-cols.md` renders claude/codex/grok through a real
  // VT emulator at 40/46/54/80 and finds 40 the floor where all three still
  // reflow correctly, so 46 leaves headroom while giving bigger glyphs than
  // the desktop's 13px. FALLBACK ONLY: an explicit sidecar `fontSize` still
  // wins, so pinch-to-resize and the desktop font chords keep working.
  const fontSize = clampFont(layout.fontSize ?? (mobile ? MOBILE_FONT_SIZE : DEFAULT_FONT_SIZE))
  // Parked panes (display-only, keyed by session name). Kept referentially stable
  // when absent so SplitView's memo'd children don't churn.
  const frozen = layout.frozen ?? EMPTY_FROZEN
  const frozenSet = new Set(Object.keys(frozen))

  // Stable dispatcher for OSC pane titles (referential stability keeps Pane's
  // memo effective — SplitView caches a per-pane wrapper around this). Caps the
  // stored title and no-ops identical values to avoid pointless re-renders.
  const onPaneTitle = useCallback((session: string, title: string): void => {
    const t = title.slice(0, 120)
    setTitles((prev) => (prev[session] === t ? prev : { ...prev, [session]: t }))
  }, [])

  const onPaneFocus = useCallback((name: string): void => {
    if (isEditorName(name)) return
    window.amber.focusSession(name)
  }, [])

  // Prune titles whose session the daemon removed (state.sessions is the
  // authoritative live set) — without this the map grows without bound in a
  // long-lived renderer as sessions come and go.
  const sessions = state.sessions
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const locationRef = useRef({ ws: activeWs, tab: activeTab })
  locationRef.current = { ws: activeWs, tab: activeTab }
  const deliverNotification = (kind: 'activity' | 'exit' | 'retry' | 'fallback' | 'pressure', session: string | undefined, title: string, body: string): void => {
    const parsed = session ? parseName(session) : null
    const candidate = { kind, ...(session ? { session } : {}), ...(parsed ? { ws: parsed.ws } : {}), title, body }
    if (shouldNotify(candidate, productivityRef.current.notifications, {
      focused: document.hasFocus(), ws: locationRef.current.ws, tab: locationRef.current.tab,
    }, Date.now(), notificationDedup.current)) window.amber.notify?.({ title, body, ...(session ? { session } : {}) })
  }
  useEffect(() => {
    setTitles((prev) => {
      const live = new Set(sessions.map((s) => s.name))
      // Editor panes are never in the daemon's session list, so they must be
      // exempt — otherwise the next Sessions event deletes their file title and
      // the header falls back to the cwd. Their own close path prunes them.
      const stale = Object.keys(prev).filter((n) =>
        !live.has(n) && !isEditorName(n))
      if (stale.length === 0) return prev
      const next = { ...prev }
      for (const n of stale) delete next[n]
      return next
    })
  }, [sessions])

  // Coalescing buffer for the two HIGH-FREQUENCY daemon events.
  //
  // `Activity` fires up to 2/s per session and `MemoryStat` every 3 s per
  // session; each was dispatched on its own IPC task, so each forced a full App
  // render — which rebuilds groupSessions/mergeEditors and calls
  // deriveTab once PER KEEP-ALIVE LAYER, not just the visible tab. At the box's
  // 19 sessions that is ~45 full-tree renders per second while completely idle.
  // `Pane` is memoized so terminals are not reconciled, but everything else in
  // that path is garbage.
  //
  // Both events only drive a tab-bar dot and a header MB label — nothing that
  // needs sub-second latency. Buffer them and flush on a timer: React 18 batches
  // the dispatches inside the timeout into ONE render, so N events cost one
  // pass. Session lifecycle, Exit and Error stay IMMEDIATE — those are low-rate
  // and user-visible.
  const evBuf = useRef<DaemonEvent[]>([])
  const evTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (evTimer.current) clearTimeout(evTimer.current) }, [])

  useEffect(() => {
    if (!bridgeReady) return
    const COALESCE_MS = 250
    const flush = (): void => {
      evTimer.current = null
      const evs = evBuf.current
      evBuf.current = []
      for (const e of evs) dispatch(e)
    }
    const dispatchEvent = (ev: DaemonEvent): void => {
      if (ev.kind !== 'Activity' && ev.kind !== 'Memory') { dispatch(ev); return }
      evBuf.current.push(ev)
      if (evTimer.current === null) evTimer.current = setTimeout(flush, COALESCE_MS)
    }
    window.amber.onDaemonEvent((d) => {
      // Backlog replies are routed to the pending dump resolver by name (not
      // through the store reducer) — a save is waiting on collectDumps for them.
      const bf = (d as { frame?: { type?: string; msg?: { kind?: string; name?: string; msg?: string; data?: Uint8Array } } }).frame
      if (bf?.type === 'control' && bf.msg?.kind === 'Backlog' && typeof bf.msg.name === 'string') {
        const cb = dumpResolvers.current.get(bf.msg.name)
        if (cb) { dumpResolvers.current.delete(bf.msg.name); cb(bf.msg.data ?? new Uint8Array()) }
        return
      }
      if (bf?.type === 'control' && bf.msg?.kind === 'SearchResults') {
        const m = bf.msg as ControlMsg & { kind: 'SearchResults' }
        if (m.request_id === searchRequest.current) {
          if (searchTimeout.current) clearTimeout(searchTimeout.current)
          setSearchLoading(false); setSearchError(null); setSearchResults(m.results)
        }
        return
      }
      if (bf?.type === 'control' && bf.msg?.kind === 'RecoveryEvents') {
        if (recoveryTimeout.current) clearTimeout(recoveryTimeout.current)
        const m = bf.msg as ControlMsg & { kind: 'RecoveryEvents' }
        setRecoveryLoading(false); setRecoveryError(null); setRecoveryEvents(m.events)
        return
      }
      if (bf?.type === 'control' && bf.msg?.kind === 'RecoveryEventsCleared') {
        if (recoveryTimeout.current) clearTimeout(recoveryTimeout.current)
        setRecoveryLoading(false); setRecoveryEvents([])
        return
      }
      if (bf?.type === 'control' && bf.msg?.kind === 'Activity' && typeof bf.msg.name === 'string') {
        deliverNotification('activity', bf.msg.name, 'Background terminal activity', 'A background Amber pane produced output.')
      }
      if (bf?.type === 'control' && bf.msg?.kind === 'Exit' && typeof bf.msg.name === 'string') {
        deliverNotification('exit', bf.msg.name, 'Amber session exited', 'A persistent terminal session ended. Open Amber to inspect it.')
      }
      if (bf?.type === 'control' && bf.msg?.kind === 'SessionsChanged') {
        const previous = new Map(sessionsRef.current.map((session) => [session.name, session]))
        for (const next of (bf.msg as ControlMsg & { kind: 'SessionsChanged' }).added) {
          const before = previous.get(next.name)?.run_state
          if (next.run_state === 'claude-retrying' && before !== next.run_state) {
            deliverNotification('retry', next.name, `${next.kind} is retrying`, 'The supervised agent exited and Amber is attempting an exact resume.')
          } else if (next.run_state === 'shell-fallback' && before !== next.run_state) {
            deliverNotification('fallback', next.name, `${next.kind} needs attention`, 'The agent stopped and this pane fell back to a shell.')
          }
        }
      }
      if (bf?.type === 'control' && (bf.msg?.kind === 'MemoryPressure' || bf.msg?.kind === 'ResourcePressure') && (bf.msg as { level?: string }).level === 'critical') {
        deliverNotification('pressure', undefined, 'Amber resource pressure', 'Amber may park idle agent panes to protect the system.')
      }
      // Snapshot success is explicit daemon truth. Never infer it from a timer,
      // layout save, connection health, or the periodic-snapshot guarantee.
      if (bf?.type === 'control' && bf.msg?.kind === 'SnapshotOk') {
        setSnapshotState({ kind: 'confirmed', at: Date.now() })
        return
      }
      // Budget replies feed the memory dialog directly (local state — not
      // store truth; the daemon remains the only authority).
      if (bf?.type === 'control' && bf.msg?.kind === 'BudgetApplied') {
        const m = bf.msg as ControlMsg & { kind: 'BudgetApplied' }
        setBudget({
          configuredMb: m.mb > 0 ? m.mb : null,
          effectiveKb: m.effective_budget_kb,
          cgroupLimitKb: m.cgroup_limit_kb,
          sessionHighKb: m.session_high_kb,
        })
        return
      }
      // A pane that died mid-save makes its in-flight DumpBacklog reply come back
      // as an Error ("no such session: <name>"). While dumps are pending, resolve
      // the matching name as empty scrollback and swallow the Error so it doesn't
      // ALSO land in the store as a red daemon-error banner (double-surface). Only
      // while dumps pending, only a name currently awaiting a dump.
      if (bf?.type === 'control' && bf.msg?.kind === 'Error' && typeof bf.msg.msg === 'string' && dumpResolvers.current.size > 0) {
        const hit = matchDumpError(bf.msg.msg, dumpResolvers.current.keys())
        if (hit !== null) {
          const cb = dumpResolvers.current.get(hit)
          dumpResolvers.current.delete(hit)
          cb?.(new Uint8Array())
          return
        }
      }
      const st = (d as { status?: string }).status
      if (st === 'connected') setConnected(true)
      else if (st === 'disconnected') {
        setSnapshotState({ kind: 'error' })
        // A reconnect to an older daemon may never send either pressure event,
        // so stale host and aggregate-memory warnings cannot cross the socket
        // boundary.
        dispatch({ kind: 'ClearPressure' })
        setConnected(false)
      }
      // The client utilityProcess was relaunched: its old pane ports are dead,
      // so ask every Pane to re-acquire from the new child.
      if ((d as { childRestart?: boolean }).childRestart) setChildEpoch((e) => e + 1)
      const ev = toEvent(d); if (ev) dispatchEvent(ev)
      if (ev?.kind === 'Sessions') setSawSessions(true)
    })
    window.amber.onBrowserAssociation((value) => {
      if (typeof value !== 'object' || value === null) return
      const association = value as { ws?: unknown; tab?: unknown; browser?: unknown }
      if (typeof association.ws !== 'number' || typeof association.tab !== 'number') return
      const rawBrowser = association.browser
      if (rawBrowser !== undefined && (typeof rawBrowser !== 'object' || rawBrowser === null)) return
      const browser = rawBrowser as { id?: unknown; width?: unknown; collapsed?: unknown; designatedPi?: unknown; sharedWithPi?: unknown } | undefined
      if (browser && (typeof browser.id !== 'string' || typeof browser.width !== 'number' || typeof browser.collapsed !== 'boolean')) return
      const browserLayout = browser ? { id: browser.id as string, width: browser.width as number, collapsed: browser.collapsed as boolean,
        ...(typeof browser.designatedPi === 'string' ? { designatedPi: browser.designatedPi } : {}), ...(typeof browser.sharedWithPi === 'boolean' ? { sharedWithPi: browser.sharedWithPi } : {}) } : undefined
      setLayout((current) => {
        const workspace = current.workspaces[String(association.ws)] ?? { activeTab: association.tab as number, tabs: {} }
        const previous = workspace.tabs[String(association.tab)] ?? { tree: null }
        const nextTab = { ...previous, ...(browserLayout ? { browser: browserLayout } : {}) }
        if (!browserLayout) delete nextTab.browser
        return { ...current, version: 2, browserRevision: (current.browserRevision ?? 0) + 1,
          workspaces: { ...current.workspaces, [String(association.ws)]: { ...workspace, activeTab: association.tab as number,
            tabs: { ...workspace.tabs, [String(association.tab)]: nextTab } } } }
      })
      setActiveWs(association.ws); setActiveTab(association.tab)
    })
    void window.amber.loadLayout().then(({ text, version }) => {
      const l = text ? parseLayout(text) : emptyLayout()
      if (text) setLayout(l)
      // CAS anchor: `baseRef` is the tree this save-chain believes is on disk
      // right now; `versionRef` is the token that proves it. Both are updated
      // together, only ever from a successful load or save — see persist().
      baseRef.current = l
      versionRef.current = version
      setLoaded(true)
    })
    void window.amber.loadProductivity?.().then(({ text, version }) => {
      const next = text ? parseProductivity(text) : emptyProductivity()
      productivityVersion.current = version
      productivityPersisted.current = next
      setProductivity(next)
    })
  }, [bridgeReady])

  // Detect the disconnected -> connected edge and bump the reconnect epoch.
  useEffect(() => {
    if (connected && !prevConnected.current) {
      setReconnectEpoch((e) => e + 1)
      setSnapshotState({ kind: 'idle' })
    }
    prevConnected.current = connected
  }, [connected])

  // “Just now” is truthful only briefly. Fall back to the daemon-managed
  // automatic-snapshot statement rather than letting a stale success linger.
  useEffect(() => {
    if (snapshotState.kind === 'confirmed') {
      const timer = setTimeout(() => setSnapshotState({ kind: 'idle' }), 60_000)
      return () => clearTimeout(timer)
    }
    if (snapshotState.kind === 'pending') {
      const timer = setTimeout(() => setSnapshotState({ kind: 'error' }), 8_000)
      return () => clearTimeout(timer)
    }
  }, [snapshotState])

  // One shared dismissal contract for all toolbar popovers.
  useEffect(() => {
    if (toolbarMenu === null) return
    const onPointer = (event: PointerEvent): void => {
      if (!(event.target instanceof Element) || !event.target.closest('.toolbar-popover-wrap')) setToolbarMenu(null)
    }
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setToolbarMenu(null) }
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onKey)
    }
  }, [toolbarMenu])

  // CAS persist (spec 2026-08-01 §6). `local` is a snapshot of the tree at
  // the moment the write starts; the round trip to disk is async, so by the
  // time it resolves either side (or both) may have moved on:
  //   - the DISK may have moved (another writer landed a change) -> `conflict`.
  //   - the LOCAL tree may have moved (the user kept editing mid-flight).
  // A conflict is handled by re-reading the fresh disk tree and re-running
  // the merge against it — "re-applying the mutation" means recomputing
  // against `base`/`local`/`remote` (a real 3-way merge), never just
  // re-sending the stale `local` object verbatim. The retry's result is then
  // folded back into React state with a SECOND merge if needed, using
  // `setLayout`'s functional form so a local edit made during the two awaits
  // is never silently discarded (only writing `cur === local` — i.e.
  // "nothing changed" — lets the disk's merged tree replace state outright).
  // A second conflict surfaces to the user (the `notice` banner) instead of
  // silently dropping either writer's change.
  const persistLayout = useCallback(async (): Promise<void> => {
    try {
      const local = layoutRef.current
      if (local.readOnly) {
        setNotice('This layout was written by a newer Amber version and is read-only here.')
        return
      }
      const text = serializeLayout(local)
      const result = await window.amber.saveLayout(text, versionRef.current)
      if ('ok' in result) {
        versionRef.current = result.version
        baseRef.current = local
        return
      }
      if ('conflict' in result) {
        const remote = result.text ? parseLayout(result.text) : emptyLayout()
        if (remote.readOnly) {
          setNotice('Layout changes were not saved because a newer Amber version owns this file.')
          return
        }
        const merged = mergeLayout(baseRef.current, local, remote)
        const retry = await window.amber.saveLayout(serializeLayout(merged), result.version)
        if ('ok' in retry) {
          versionRef.current = retry.version
          baseRef.current = merged
          setLayout((cur) => (cur === local ? merged : mergeLayout(local, cur, merged)))
          return
        }
        setNotice('Layout changes could not be saved — another device is editing at the same time. Reload to see the latest layout.')
        return
      }
      // 'error' (disk failure): leave state as-is; the next edit's debounce retries naturally.
    } catch (e) {
      console.error('layout save failed', e)
    }
  }, [])

  // Debounced persist whenever the layout changes — only after the sidecar
  // loaded. Divider drags call `onSetRatio` (-> `setLayout`) on every
  // mousemove, so this effect re-fires and restarts the timer continuously
  // during a drag; a write only actually happens ~300 ms after the drag
  // settles, matching "no write mid-drag" without any drag-specific code.
  // Saves are chained (not fired independently) so an overlapping debounce
  // can never read `versionRef`/`baseRef` while a previous save is still
  // resolving them.
  useEffect(() => {
    if (!bridgeReady || !loaded) return
    const id = setTimeout(() => {
      const prev = saveChainRef.current
      saveChainRef.current = prev.then(persistLayout, persistLayout)
    }, 300)
    return () => clearTimeout(id)
  }, [layout, bridgeReady, loaded, persistLayout])

  const updateProductivity = (mutation: (file: ProductivityFile) => ProductivityFile): void => {
    if (!window.amber.saveProductivity || remoteHost) return
    productivityPending.current.push(mutation)
    setProductivity((previous) => mutateProductivity(previous, mutation))
    productivitySaveChain.current = productivitySaveChain.current.then(async () => {
      const save = window.amber.saveProductivity
      if (!save || productivityPending.current.length === 0) return
      // Replay every not-yet-persisted operation over the last confirmed disk
      // value. On CAS conflict replay the same operations over the fresh remote;
      // never write a stale optimistic snapshot that can erase another window.
      const pending = [...productivityPending.current]
      const replay = (base: ProductivityFile): ProductivityFile => replayProductivity(base, pending)
      let next = replay(productivityPersisted.current)
      let result = await save(serializeProductivity(next), productivityVersion.current)
      if ('conflict' in result) {
        const remote = result.text ? parseProductivity(result.text) : emptyProductivity()
        next = replay(remote)
        result = await save(serializeProductivity(next), result.version)
      }
      if ('ok' in result) {
        productivityVersion.current = result.version
        productivityPersisted.current = next
        productivityPending.current.splice(0, pending.length)
        setProductivity(replayProductivity(next, productivityPending.current))
      } else if ('error' in result) setNotice(`Productivity data could not be saved — ${result.error}`)
      else setNotice('Productivity data changed in another window; try again.')
    })
  }

  const workspaces = mergeBrowserRailTabs(mergeEditors(groupSessions(state), layout.editors ?? {}), layout.workspaces)
  const pocketAll = commandCenterModel({ workspaces, state, frozen: frozenSet })
  const needsAttention = pocketAll.groups.find((group) => group.id === 'needs-you')?.items ?? []
  const pocketModel = commandCenterModel({
    workspaces,
    state,
    frozen: frozenSet,
    ...(pocketWorkspace === null ? {} : { workspace: pocketWorkspace }),
  })
  const ws = workspaces.find((w) => w.ws === activeWs) ?? workspaces[0]
  const tabs = ws?.tabs ?? []
  const tab = tabs.find((t) => t.tab === activeTab) ?? tabs[0]
  const home = window.amber?.homeDir ?? ''
  const wsKey = String(ws?.ws ?? activeWs)
  const tabKey = String(tab?.tab ?? activeTab)
  const tabBrowser = layout.workspaces[wsKey]?.tabs[tabKey]?.browser
  useEffect(() => {
    browserContextReady.current = window.amber.setBrowserContext?.({ workspace: Number(wsKey), tab: Number(tabKey) }) ?? Promise.resolve({ ok: true })
  }, [wsKey, tabKey, tabBrowser?.id])
  const storedTree = layout.workspaces[wsKey]?.tabs[tabKey]?.tree ?? null
  // Active-tab render inputs, via the shared deriveTab (same path the keep-alive
  // layer map uses below — no drift). allLive is the UNFILTERED name set (keeps
  // the pending-split placement effect's `liveKey`).
  const allLive = tab?.panes.map((p) => p.name) ?? []
  const { tree, paneMeta, deadCodes, liveIds } = deriveTab(tab?.panes ?? [], storedTree, pending, titles, home, state.mem)

  // Zoom (transient, per tab). Tab numbering restarts per workspace (every ws
  // has a tab 1), so the zoom map and the structural-clear ref are keyed by the
  // COMPOSITE ws:tab — bare tabKey would make ws2/tab1 clobber ws1/tab1's zoom,
  // and a plain workspace switch would trip the safety-net clear.
  const zoomKey = `${wsKey}:${tabKey}`
  const zoomedPane = zoom[zoomKey] && liveIds.includes(zoom[zoomKey]!) ? zoom[zoomKey]! : null
  const pocketFocused = mobile && zoomedPane !== null
  const pocketCommandActive = mobile && pocketView === 'sessions' && !pocketFocused
  const pocketMosaicActive = mobile && pocketView === 'mosaic' && !pocketFocused
  const openPocketItem = (item: CommandCenterItem): void => {
    setActiveWs(item.ws)
    setActiveTab(item.tab)
    setZoom((current) => ({ ...current, [`${item.ws}:${item.tab}`]: item.pane.name }))
  }
  const showDesktopItem = (item: CommandCenterItem): void => {
    const destination = `${item.ws}:${item.tab}`
    setToolbarMenu(null)
    setSessionsOpen(false)
    setActiveWs(item.ws)
    setActiveTab(item.tab)
    // Desktop reveal preserves the mosaic. An old per-tab zoom must not hide the
    // requested pane; the explicit focus request runs once its tab is active.
    setZoom((current) => {
      if (!(destination in current)) return current
      const next = { ...current }
      delete next[destination]
      return next
    })
    setFocusRequest({ paneId: item.pane.name, seq: ++focusRequestSeq.current })
  }
  const openSessionList = (view: 'all' | 'attention'): void => {
    setToolbarMenu(null)
    setPicked(new Set())
    setSessionView(view)
    setSessionsOpen(true)
  }
  // A focus request is an edge, not remembered navigation state. Clear it only
  // after child effects had one frame to focus the newly active SplitView.
  useEffect(() => {
    if (!focusRequest) return
    const seq = focusRequest.seq
    const frame = requestAnimationFrame(() => {
      setFocusRequest((current) => current?.seq === seq ? null : current)
    })
    return () => cancelAnimationFrame(frame)
  }, [focusRequest])
  const toggleZoom = (paneId: string): void => setZoom((z) => {
    if (z[zoomKey] === paneId) { const c = { ...z }; delete c[zoomKey]; return c }
    return { ...z, [zoomKey]: paneId }
  })
  const clearZoom = (): void => setZoom((z) => {
    if (!(zoomKey in z)) return z
    const c = { ...z }; delete c[zoomKey]; return c
  })
  // Leaving a full-screen pane hands back any borrowed pty grid immediately
  // (spec §2.3). Capability-shaped, not host-shaped: the desktop has no
  // borrow to release, so `releaseGrids` simply is not there and this is a
  // no-op — the renderer never asks which host it is on.
  useEffect(() => {
    if (zoomedPane !== null) return
    ;(window.amber as unknown as { releaseGrids?: () => void }).releaseGrids?.()
  }, [zoomedPane])
  // Zooming pushes a history entry so the platform BACK gesture un-zooms — the
  // way a phone user expects to leave a full-screen view. Guarded so popping
  // the last entry never navigates away from the app: we only ever push while
  // zoomed, and only pop our own entry.
  const zoomHistoryRef = useRef(false)
  useEffect(() => {
    if (zoomedPane !== null && !zoomHistoryRef.current) {
      zoomHistoryRef.current = true
      history.pushState({ amberZoom: true }, '')
    } else if (zoomedPane === null && zoomHistoryRef.current) {
      zoomHistoryRef.current = false
    }
  }, [zoomedPane])
  useEffect(() => {
    const onPop = (event: PopStateEvent): void => {
      // A sheet can sit above a focused pane in history. Popping only that sheet
      // lands on a state that still carries amberZoom and must NOT also unzoom.
      if (zoomHistoryRef.current && !(event.state as { amberZoom?: boolean } | null)?.amberZoom) {
        zoomHistoryRef.current = false
        clearZoom()
      }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
    // `clearZoom` closes over the current zoomKey; re-binding per key keeps the
    // handler clearing the tab the user is actually looking at.
  }, [zoomKey])

  // Pocket sheets get their own history layer. Platform back dismisses the
  // sheet first; when a sheet sits over Focus, the tagged zoom entry remains.
  const pocketSheetHistoryRef = useRef(false)
  const pocketSheetAfterRef = useRef<(() => void) | null>(null)
  const pocketSheetOpen = pocketAction !== null || pocketNewOpen
  useEffect(() => {
    if (pocketSheetOpen && !pocketSheetHistoryRef.current) {
      pocketSheetHistoryRef.current = true
      history.pushState({ ...(history.state as object | null), amberPocketSheet: true }, '')
    }
  }, [pocketSheetOpen])
  useEffect(() => {
    const onPop = (event: PopStateEvent): void => {
      if (!pocketSheetHistoryRef.current
        || (event.state as { amberPocketSheet?: boolean } | null)?.amberPocketSheet) return
      pocketSheetHistoryRef.current = false
      setPocketAction(null)
      setPocketNewOpen(false)
      const after = pocketSheetAfterRef.current
      pocketSheetAfterRef.current = null
      after?.()
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const closePocketSheet = (after?: () => void): void => {
    if (pocketSheetHistoryRef.current) {
      pocketSheetAfterRef.current = after ?? null
      history.back()
      return
    }
    setPocketAction(null)
    setPocketNewOpen(false)
    after?.()
  }
  // Structural-change guard: when the visible tab's live pane set changes (a
  // split lands, a pane is closed/reaped — via our gesture OR the daemon), drop
  // that tab's zoom. Moves don't change the set, so those gestures clear zoom
  // explicitly below. Per-ws:tab tracking so a plain tab/ws switch never clears.
  const liveSetKey = [...liveIds].sort().join(',')
  const prevTabLive = useRef<Record<string, string>>({})
  useEffect(() => {
    const prev = prevTabLive.current[zoomKey]
    prevTabLive.current[zoomKey] = liveSetKey
    if (prev !== undefined && prev !== liveSetKey) {
      setZoom((z) => { if (!(zoomKey in z)) return z; const c = { ...z }; delete c[zoomKey]; return c })
    }
  }, [zoomKey, liveSetKey])

  // Visual tab order: sidecar `tabOrder` first, unlisted append numerically.
  const orderedTabs = orderTabs(tabs.map((t) => t.tab), layout.workspaces[wsKey]?.tabOrder)
    .map((id) => tabs.find((t) => t.tab === id))
    .filter((t): t is (typeof tabs)[number] => t !== undefined)

  const updateTabBrowser = useCallback((browser: NonNullable<LayoutFile['workspaces'][string]['tabs'][string]['browser']> | undefined) => {
    setLayout((current) => {
      const workspace = current.workspaces[wsKey] ?? { activeTab, tabs: {} }
      const previous = workspace.tabs[tabKey] ?? { tree: null }
      const nextTab = { ...previous, ...(browser ? { browser } : {}) }
      if (!browser) delete nextTab.browser
      return { ...current, version: 2, browserRevision: (current.browserRevision ?? 0) + 1, workspaces: { ...current.workspaces, [wsKey]: { ...workspace, tabs: { ...workspace.tabs, [tabKey]: nextTab } } } }
    })
  }, [wsKey, tabKey, activeTab])

  const refreshBrowserRecovery = useCallback(async (): Promise<void> => {
    const reply = await window.amber.browserRecovery?.({ action: 'list' }) as { ok?: boolean; result?: Array<{ index: number; workspace: number; tab: number; safeRestoreUrl: string }>; error?: string } | undefined
    if (!reply?.ok) { setNotice(reply?.error ?? 'Browser recovery unavailable'); return }
    setBrowserRecovery(reply.result ?? []); setBrowserRecoveryOpen(true)
  }, [])

  const ensureBrowserContext = useCallback(async (): Promise<void> => {
    await browserContextReady.current.catch(() => {})
    const pending = window.amber.setBrowserContext?.({ workspace: Number(wsKey), tab: Number(tabKey) }) ?? Promise.resolve({ ok: true })
    browserContextReady.current = pending
    const reply = await pending as { ok?: boolean; error?: string }
    if (!reply?.ok) throw new Error(reply?.error ?? 'STALE_BROWSER_CONTEXT')
  }, [wsKey, tabKey])

  const openTabBrowser = useCallback(async (): Promise<void> => {
    try { await ensureBrowserContext() } catch (error) { setNotice(error instanceof Error ? error.message : 'STALE_BROWSER_CONTEXT'); return }
    const reply = await window.amber.browserCommand({ type: 'open' }) as { ok: boolean; error?: string }
    if (!reply.ok) setNotice(reply.error ?? 'Browser host unavailable')
  }, [ensureBrowserContext])

  const closeTabBrowser = useCallback(async (): Promise<void> => {
    if (!tabBrowser) return
    try { await ensureBrowserContext() } catch (error) { setNotice(error instanceof Error ? error.message : 'STALE_BROWSER_CONTEXT'); return }
    const reply = await window.amber.browserCommand({ type: 'close' }) as { ok: boolean; error?: string }
    if (!reply.ok) setNotice(reply.error ?? 'Could not close tab browser')
  }, [tabBrowser, ensureBrowserContext])

  const putTree = useCallback((next: Node | null) => {
    setLayout((l) => {
      const w = l.workspaces[wsKey] ?? { activeTab, tabs: {} }
      // Preserve any existing tab-level fields (e.g. `label`) — only the tree changes.
      const prev = w.tabs[tabKey]
      return { ...l, workspaces: { ...l.workspaces, [wsKey]: { ...w, tabs: { ...w.tabs, [tabKey]: { ...prev, tree: next } } } } }
    })
  }, [wsKey, tabKey, activeTab])

  // Sidecar label edits — app-owned display metadata; daemon state untouched. An
  // empty/whitespace value clears the label (drops the key → numeric default;
  // omitting rather than setting `undefined` satisfies exactOptionalPropertyTypes).
  const setWsLabel = useCallback((wsId: number, value: string): void => setLayout((l) => {
    const key = String(wsId)
    const { label: _drop, ...w } = l.workspaces[key] ?? { activeTab: 1, tabs: {} }
    const t = value.trim()
    return { ...l, workspaces: { ...l.workspaces, [key]: t ? { ...w, label: t } : w } }
  }), [])
  const setTabLabel = useCallback((tabId: number, value: string): void => setLayout((l) => {
    const w = l.workspaces[wsKey] ?? { activeTab, tabs: {} }
    const tKey = String(tabId)
    const { label: _drop, ...prev } = w.tabs[tKey] ?? { tree: null }
    const t = value.trim()
    const nextTab = t ? { ...prev, label: t } : prev
    return { ...l, workspaces: { ...l.workspaces, [wsKey]: { ...w, tabs: { ...w.tabs, [tKey]: nextTab } } } }
  }), [wsKey, activeTab])
  // Persist a drag-reorder as `tabOrder` (pure `moveTab` on the current order).
  const reorderTab = useCallback((from: number, to: number): void => setLayout((l) => {
    const w = l.workspaces[wsKey] ?? { activeTab, tabs: {} }
    const current = orderTabs(tabs.map((t) => t.tab), w.tabOrder)
    const next = moveTab(current, from, to)
    if (next === current) return l
    return { ...l, workspaces: { ...l.workspaces, [wsKey]: { ...w, tabOrder: next } } }
  }), [wsKey, activeTab, tabs])

  // Slice 3: the set of sessions currently suspended (child killed). Refs so
  // tracking never re-renders. `sessionsRef` gives freezePane the live kind
  // without a dep on state.sessions.
  const suspendedRef = useRef<Set<string>>(new Set())

  // Freeze/unfreeze a pane. The sidecar `frozen` map is display-only (rule #1/#3).
  // For a CLAUDE pane, freezing ALSO suspends it on the daemon immediately: the
  // daemon kills claude (frees RAM) and the supervisor `--resume`s the same
  // conversation on unfreeze.
  // An empty note is stored as `{}` (exactOptionalPropertyTypes) to keep it clean.
  const freezePane = useCallback((name: string, note: string): void => {
    setLayout((l) => {
      const n = note.trim()
      const next = { ...(l.frozen ?? {}), [name]: n ? { note: n } : {} }
      return { ...l, frozen: next }
    })
    const isAgent = isAgentKind(sessionsRef.current.find((s) => s.name === name)?.kind ?? '')
    if (isAgent && !suspendedRef.current.has(name)) {
      window.amber.suspendSession(name)
      suspendedRef.current.add(name)
    }
  }, [])
  const unfreezePane = useCallback((name: string): void => {
    setLayout((l) => {
      if (!l.frozen || !(name in l.frozen)) return l
      const next = { ...l.frozen }
      delete next[name]
      return { ...l, frozen: next }
    })
    // The ref only knows about suspends THIS app process issued; after a restart
    // the sidecar still says frozen but the ref is empty, so trust the daemon's
    // run_state too (rule #1) or the pane would never come back.
    const parked = sessionsRef.current.find((s) => s.name === name)?.run_state === 'suspended'
    if (suspendedRef.current.has(name) || parked) {
      window.amber.resumeSession(name)
      suspendedRef.current.delete(name)
    }
  }, [])

  // Prune frozen entries whose session no longer exists — against the FULL live
  // set (sessions in other workspaces are still live; only drop truly-gone
  // names). Gated on the first Sessions snapshot so we never prune before the
  // daemon's real list has arrived.
  useEffect(() => {
    if (!loaded || !sawSessions) return
    setLayout((l) => {
      if (!l.frozen) return l
      const live = new Set(sessions.map((s) => s.name))
      const stale = Object.keys(l.frozen).filter((n) => !live.has(n))
      if (stale.length === 0) return l
      const next = { ...l.frozen }
      for (const n of stale) delete next[n]
      return { ...l, frozen: next }
    })
  }, [sessions, loaded, sawSessions])

  useEffect(() => {
    if (!loaded) return
    if (tree && JSON.stringify(tree) !== JSON.stringify(storedTree)) putTree(tree)
  }, [tree, storedTree, putTree, loaded])

  // Mark the visible tab's panes as seen whenever it becomes visible (active
  // tab/ws change) or any activity arrives while it's visible (state.seq bump).
  // This clears/keeps-clear the active tab's dot; background tabs keep theirs.
  // MarkSeen never bumps seq, so this cannot loop.
  const visibleNames = tab?.panes.map((p) => p.name) ?? []
  const visibleKey = visibleNames.join(',')
  useEffect(() => {
    // The command center is a scan surface, not the terminal itself. Merely
    // listing a row must not consume its unseen-output signal; opening Focus or
    // viewing Mosaic does, because the terminal pixels are then actually shown.
    if (pocketCommandActive) return
    if (visibleNames.length > 0) dispatch({ kind: 'MarkSeen', names: visibleNames })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey, state.seq, pocketCommandActive])

  // Place pending splits once their session exists, preserving H/V direction.
  const liveKey = allLive.join(',')
  useEffect(() => {
    if (!loaded) return
    const ready = Object.entries(pending).filter(([name]) => allLive.includes(name))
    if (ready.length === 0) return
    let next = reconcile(storedTree, liveIds)
    for (const [name, { paneId, dir }] of ready) {
      next = next ? splitLeaf(next, paneId, dir, name) : { kind: 'leaf', paneId: name }
    }
    putTree(next)
    setPending((p) => { const c = { ...p }; for (const [n] of ready) delete c[n]; return c })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, liveKey, storedTree, putTree, loaded])

  // Commit a confirmed (or force-committed) load: stage scrollback for replay,
  // merge the plan's sidecar (trees/labels/tabOrder/frozen) into the layout, and
  // switch to the first loaded workspace. `liveForFix` is null on the clean path
  // (every session confirmed, tree leaves already all live) and a live-set on the
  // timeout backstop, where each non-null tree is reconciled down to its live
  // leaves so a dead pane never persists as a dangling leaf.
  const commitLoad = useCallback((pl: { plan: LoadPlan }, liveForFix: Set<string> | null): void => {
    const plan = pl.plan
    setLayout((l) => {
      let wsEntries = plan.workspaces
      if (liveForFix) {
        wsEntries = {}
        for (const [wsKey, wl] of Object.entries(plan.workspaces)) {
          const tabs: Record<string, TabLayout> = {}
          for (const [tabKey, tl] of Object.entries(wl.tabs)) {
            // Editor leaves are app-local and must survive the daemon-live filter.
            tabs[tabKey] = tl.tree
              ? { ...tl, tree: reconcile(tl.tree, leaves(tl.tree).filter((n) => liveForFix.has(n) || isEditorName(n))) }
              : tl
          }
          wsEntries[wsKey] = { ...wl, tabs }
        }
      }
      const next: LayoutFile = { ...l, workspaces: { ...l.workspaces, ...wsEntries } }
      if (Object.keys(plan.frozen).length) next.frozen = { ...(l.frozen ?? {}), ...plan.frozen }
      if (Object.keys(plan.editors ?? {}).length) next.editors = { ...(l.editors ?? {}), ...(plan.editors ?? {}) }
      return next
    })
    const first = plan.targetWorkspaces[0]
    if (first !== undefined) {
      setActiveWs(first)
      const at = plan.workspaces[String(first)]?.activeTab
      if (at !== undefined) setActiveTab(at)
    }
    setPendingLoad(null)
  }, [])

  // Watch for a load's sessions to materialize. Commit when EVERY created session
  // is live AND (replace) every killed old pane is gone — otherwise reconcile
  // would append a stale dying leaf to the just-committed tree (self-heals on
  // reap, but the gate avoids the transient wrong persist). Backstop: force-commit
  // after a grace if the daemon never confirms (e.g. died mid-load).
  useEffect(() => {
    if (!pendingLoad) return
    const live = new Set(state.sessions.map((s) => s.name))
    const created = pendingLoad.createNames.every((n) => live.has(n))
    const oldGone = pendingLoad.killed.every((n) => !live.has(n))
    if (created && oldGone) { commitLoad(pendingLoad, null); return }
    const t = setTimeout(() => commitLoad(pendingLoad, new Set(state.sessions.map((s) => s.name))), 8000)
    return () => clearTimeout(t)
  }, [pendingLoad, state.sessions, commitLoad])

  // App-owned keyboard chords (new tab / new pane / switch tab). The 'close'
  // chord is handled in SplitView (it needs the focused-pane identity). This
  // effect registers once; the latest action closures live in a ref, refreshed
  // every render below, so the handler never goes stale without re-binding.
  const chordRef = useRef<(c: ReturnType<typeof appChord>) => void>(() => {})
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      const c = appChord(e)
      // These all need the focused-pane identity — SplitView owns them (and gates
      // them on its tab being active): close, zoom, freeze, skip-perms, copy, paste.
      if (!c || c.type === 'close' || c.type === 'zoom' || c.type === 'freeze'
        || c.type === 'insert-skip-perms' || c.type === 'copy' || c.type === 'paste') return
      e.preventDefault()
      chordRef.current(c)
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  // Esc closes the cheatsheet overlay (single-window app — no focus trap needed).
  useEffect(() => {
    if (!showHelp) return
    const h = (e: KeyboardEvent): void => { if (e.key === 'Escape') setShowHelp(false) }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [showHelp])

  // Esc dismisses the save-scope / load-mode / budget and Pocket sheets.
  useEffect(() => {
    if (!saveScopeOpen && !loadDoc && !closeAsk && !killAsk && !sessionsOpen && !budgetOpen
      && !pocketAction && !pocketNewOpen) return
    const h = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      setSaveScopeOpen(false); setLoadDoc(null); setCloseAsk(null)
      setKillAsk(null); setSessionsOpen(false); setBudgetOpen(false)
      if (pocketAction || pocketNewOpen) closePocketSheet()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [saveScopeOpen, loadDoc, closeAsk, killAsk, sessionsOpen, budgetOpen, pocketAction, pocketNewOpen])

  // Opening the budget dialog fetches the daemon's live truth; the reply (and
  // every later one) lands here and refreshes the dialog in place.
  useEffect(() => {
    if (budgetOpen) window.amber.getMemoryBudget()
  }, [budgetOpen])

  // Conversation labels for the cleanup dialog. Fetched when it opens (and on
  // the session list changing while it is open) rather than kept live: it is a
  // disk read per claude session, worth nothing until the dialog is on screen.
  useEffect(() => {
    if (!sessionsOpen) return
    const wanted = sessions.flatMap((s) => (s.claude_id ? [{ id: s.claude_id, cwd: s.cwd }] : []))
    if (!wanted.length) { setClaudeNames({}); return }
    let live = true
    void window.amber.claudeNames(wanted).then((n) => { if (live) setClaudeNames(n) })
    return () => { live = false }
  }, [sessionsOpen, sessions])

  if (!bridgeReady) return <p style={{ color: 'crimson', padding: 16 }}>preload bridge missing.</p>

  // Desktop-only suite capabilities are intentionally absent from the web bridge.
  const productivityAvailable = window.amber.loadProductivity !== undefined
  const nextOrd = (tab?.panes.reduce((m, p) => Math.max(m, p.ord), -1) ?? -1) + 1
  const nextTab = (tabs.reduce((m, t) => Math.max(m, t.tab), 0)) + 1
  // The workspace/tab actually on screen — NOT the raw activeWs/activeTab state,
  // which goes stale when the selected ws/tab is closed and `ws`/`tab` fall back
  // to workspaces[0]. Creating relative to the stale state would resurrect the
  // dead workspace. Always create relative to what's displayed.
  const currentWs = ws?.ws ?? activeWs
  const currentTab = tab?.tab ?? activeTab
  const navigateTo = (paneId: string, query?: string): void => {
    const parsed = parseName(paneId) ?? parseEditorName(paneId)
    if (!parsed) { setNotice('That session no longer maps to a pane.'); return }
    const seq = ++navigationSeq.current
    setActiveWs(parsed.ws); setActiveTab(parsed.tab)
    if (query !== undefined) setFindRequest({ paneId, query, seq })
    else setFocusRequest({ paneId, seq })
    setProductivityOverlay(null)
  }
  navigateRef.current = navigateTo
  // App-local editor pane: no daemon session; the sidecar entry is authoritative.
  const newEditor = (tabId: number, ord: number): string => {
    const name = formatEditorName({ ws: currentWs, tab: tabId, ord, id: makeId() })
    setLayout((l) => ({ ...l, editors: { ...(l.editors ?? {}), [name]: { ws: currentWs, tab: tabId, ord, path: null } } }))
    return name
  }
  const newPane = (tabId: number, ord: number, paneKind: PaneKind = kind): void => {
    if (paneKind === 'editor') { newEditor(tabId, ord); return }
    window.amber.createSession(formatName({ ws: currentWs, tab: tabId, ord, id: makeId() }), cwd, paneKind)
  }
  // Same shape for editor panes: the sidecar entry IS the pane (path + per-pane
  // view state). SplitView feeds these straight to <Editor>.
  const editorEntries = layout.editors ?? EMPTY_EDITORS
  // Close a pane: daemon panes go through Kill (the
  // reap broadcast prunes the leaf — one-way flow, no optimistic tree edit).
  // Live editor handles, keyed by paneId (same pattern as SplitView's searchApis):
  // the close guard needs a SYNCHRONOUS dirty read and an awaitable save.
  const editorApis = useRef<Map<string, EditorApi>>(new Map())
  const setEditorApi = useCallback((paneId: string, api: EditorApi | null): void => {
    if (api) editorApis.current.set(paneId, api)
    else editorApis.current.delete(paneId)
  }, [])
  // Dirty flags drive the pane header dot; kept separate from the API map so a
  // dirty toggle re-renders while handle registration does not.
  const [dirtyEditors, setDirtyEditors] = useState<Record<string, boolean>>({})
  const setEditorDirty = useCallback((paneId: string, dirty: boolean): void => {
    setDirtyEditors((d) => (!!d[paneId] === dirty ? d : { ...d, [paneId]: dirty }))
  }, [])

  // Force-close: the sidecar purge + draft clear, with no guard. Every guarded
  // path funnels here once the user has decided.
  const dropEditorPane = useCallback((paneId: string): void => {
    editorApis.current.delete(paneId)
    setTitles((t) => { if (!(paneId in t)) return t; const c = { ...t }; delete c[paneId]; return c })
    window.amber.editorDraftClear(paneId)
    setDirtyEditors((d) => { if (!(paneId in d)) return d; const c = { ...d }; delete c[paneId]; return c })
    setLayout((l) => {
      if (!l.editors?.[paneId]) return l
      const rest = { ...l.editors }
      delete rest[paneId]
      return { ...l, editors: rest }
    })
  }, [])

  const closePane = (paneId: string): void => {
    // Unsaved editor buffer: ask first. This covers ✕, the tab close button,
    // and workspace-replace, because they all route through closePane.
    if (isEditorName(paneId) && editorApis.current.get(paneId)?.isDirty()) {
      setCloseAsk(paneId)
      return
    }
    if (isEditorName(paneId)) {
      dropEditorPane(paneId)
    } else setKillAsk([paneId]) // terminal pane — killing its session is not undoable
  }

  // Close every pane of a tab. App-local panes go immediately (their own guards
  // still apply); the terminal panes are confirmed ONCE for the whole tab —
  // routing each through closePane would stack a dialog per pane.
  const closeTabPanes = (panes: { name: string }[]): void => {
    const terminals: string[] = []
    for (const p of panes) {
      if (isEditorName(p.name)) closePane(p.name)
      else terminals.push(p.name)
    }
    if (terminals.length) setKillAsk(terminals)
  }

  // An editor pane reports its own state changes (opened path, md view mode,
  // outline toggle, wrap) — the sidecar is the pane's only persistence, and it
  // is what restores the file after a restart. Also feeds the recent-files list.
  const setEditorState = useCallback((paneId: string, patch: { path?: string | null; view?: 'code' | 'split' | 'preview'; outline?: boolean; wrap?: boolean }): void => {
    setLayout((l) => {
      const prev = l.editors?.[paneId]
      if (!prev) return l
      const next = { ...prev, ...patch }
      const recents = patch.path
        ? [patch.path, ...(l.recentFiles ?? []).filter((f) => f !== patch.path)].slice(0, 20)
        : l.recentFiles
      return {
        ...l,
        editors: { ...(l.editors ?? {}), [paneId]: next },
        ...(recents ? { recentFiles: recents } : {}),
      }
    })
  }, [])

  const nextWs = (workspaces.reduce((m, w) => Math.max(m, w.ws), 0)) + 1

  // Cross-group move: a pane was dropped on a tab header or a workspace pill.
  // Grouping is name-encoded (rule #2), so a daemon pane moves by a real daemon
  // Rename and the leaf follows one-way via SessionsChanged -> groupSessions ->
  // reconcile (prunes the source-tab leaf, appends it in the target tab). Never
  // an optimistic local tree edit. Editor panes move by updating their sidecar entry.
  const moveTo = (paneId: string, target: { ws: number } | { tab: number }): void => {
    const destWs = 'ws' in target ? target.ws : currentWs
    const destTabs = workspaces.find((w) => w.ws === destWs)?.tabs ?? []
    const destTab = 'tab' in target ? target.tab : (destTabs[0]?.tab ?? 1)
    const destPanes = destTabs.find((t) => t.tab === destTab)?.panes ?? []
    if (destPanes.some((p) => p.name === paneId)) return // already there — no-op
    const ord = destPanes.reduce((m, p) => Math.max(m, p.ord), -1) + 1
    if (isEditorName(paneId)) {
      // Sidecar edit, id KEPT — the pane's unsaved draft is keyed by paneId, so
      // reminting the id here would strand a dirty buffer's draft file.
      setLayout((l) => {
        const prev = l.editors?.[paneId]
        if (!prev) return l
        return { ...l, editors: { ...(l.editors ?? {}), [paneId]: { ...prev, ws: destWs, tab: destTab, ord } } }
      })
    } else {
      const to = retargetPane(paneId, { ws: destWs, tab: destTab, ord })
      if (to && to !== paneId) window.amber.renameSession(paneId, to)
    }
    clearZoom()
  }

  const openTab = (): void => { newPane(nextTab, 0); setActiveTab(nextTab) }
  // Create a pane in the displayed tab, or — when nothing exists yet — the very
  // first session at tab 1, ord 0 in the shown workspace. The toolbar picker
  // passes a kind explicitly; shortcuts and new-tab/ws paths reuse the last pick.
  const startPane = (paneKind: PaneKind = kind): void => {
    if (tab) newPane(tab.tab, nextOrd, paneKind)
    else { newPane(1, 0, paneKind); setActiveTab(1) }
  }
  const createPocketPane = (selected: PocketSessionKind): void => {
    const tabId = tab?.tab ?? 1
    const ord = tab ? nextOrd : 0
    setKind(selected)
    window.amber.createSession(formatName({ ws: currentWs, tab: tabId, ord, id: makeId() }), cwd, selected)
    setActiveTab(tabId)
    setPocketNewOpen(false)
    setPocketView('sessions')
  }
  // Keyboard nav follows the VISUAL order (orderedTabs), so prev/next and the
  // 1–9 jump match what the user sees after a reorder.
  const stepTab = (d: number): void => {
    if (orderedTabs.length === 0) return
    const i = Math.max(0, orderedTabs.findIndex((t) => t.tab === (tab?.tab ?? -1)))
    setActiveTab(orderedTabs[(i + d + orderedTabs.length) % orderedTabs.length]!.tab)
  }
  // Font-size chords. Persist to the sidecar (top-level fontSize); the derived
  // `fontSize` above flows to every Pane. Clamp + no-op-guard so hitting the
  // range edge doesn't churn state/persistence.
  const bumpFont = (d: number): void => setLayout((l) => {
    const cur = clampFont(l.fontSize ?? DEFAULT_FONT_SIZE)
    const next = clampFont(cur + d)
    return next === cur ? l : { ...l, fontSize: next }
  })
  const resetFont = (): void => setLayout((l) =>
    clampFont(l.fontSize ?? DEFAULT_FONT_SIZE) === DEFAULT_FONT_SIZE ? l : { ...l, fontSize: DEFAULT_FONT_SIZE })

  const saveModel = (wsList: typeof workspaces, browserSnapshots: Record<string, { mode: 'preview' | 'browse'; safeRestoreUrl: string; viewport: { width: number; height: number } }>): SaveWorkspace[] => wsList.map((w) => ({
    ws: w.ws,
    tabs: w.tabs.map((t) => {
      const rail = layoutRef.current.workspaces[String(w.ws)]?.tabs[String(t.tab)]?.browser
      const snapshot = rail ? browserSnapshots[rail.id] : undefined
      return { tab: t.tab, panes: t.panes.map((p) => ({
      name: p.name, cwd: p.cwd, kind: p.kind, ord: p.ord,
      ...(p.kind === 'editor' ? { path: layoutRef.current.editors?.[p.name]?.path ?? null } : {}),
    })), ...(rail && snapshot ? { browser: { ...snapshot, width: rail.width, collapsed: rail.collapsed } } : {}) }
    }),
  }))
  const captureWorkspace = async (scope: 'one' | 'all', withScrollback: boolean): Promise<{ doc: WorkspaceDoc; stragglers: string[] }> => {
    const wsList = scope === 'one' ? workspaces.filter((w) => w.ws === currentWs) : workspaces
    const names = withScrollback
      ? wsList.flatMap((w) => w.tabs.flatMap((t) => t.panes.filter((p) => p.kind === 'shell' || isAgentKind(p.kind)).map((p) => p.name)))
      : []
    const captured = names.length === 0 ? { dumps: {}, stragglers: [] } : await collectDumps(
      names, (n) => window.amber.dumpBacklog(n),
      (n, cb) => { dumpResolvers.current.set(n, cb) },
      (n) => { dumpResolvers.current.delete(n) },
    )
    const expectedBrowserIds = wsList.flatMap((workspace) => workspace.tabs.flatMap((tab) => {
      const browser = layoutRef.current.workspaces[String(workspace.ws)]?.tabs[String(tab.tab)]?.browser
      return browser ? [browser.id] : []
    }))
    const hasBrowserRails = expectedBrowserIds.length > 0
    const snapshotReply = hasBrowserRails
      ? window.amber.snapshotWorkspaceBrowsers
        ? await window.amber.snapshotWorkspaceBrowsers() as { ok?: boolean; result?: Record<string, { mode: 'preview' | 'browse'; safeRestoreUrl: string; viewport: { width: number; height: number } }> }
        : { ok: false }
      : { ok: true, result: {} }
    const browserSnapshots = requireWorkspaceBrowserSnapshots(snapshotReply, expectedBrowserIds)
    return { doc: assembleSave(scope, saveModel(wsList, browserSnapshots), layoutRef.current, captured.dumps), stragglers: captured.stragglers }
  }

  // Save: dump each target pane's scrollback (name-correlated, per-pane timeout),
  // assemble the file from live grouping + sidecar + dumps, write via native dialog.
  const doSave = async (scope: 'one' | 'all'): Promise<void> => {
    setSaveScopeOpen(false)
    try {
      const { doc, stragglers } = await captureWorkspace(scope, true)
      const base = scope === 'one'
        ? (layoutRef.current.workspaces[String(currentWs)]?.label ?? `workspace-${currentWs}`)
        : 'workspaces'
      const ok = await window.amber.saveWorkspaceFile(serializeWorkspaceFile(doc), `${base}.amberws`)
      if (ok && stragglers.length > 0) setNotice(`Saved with empty history for ${stragglers.length} pane(s) whose capture timed out.`)
    } catch (error) { setNotice(`Workspace save cancelled — ${error instanceof Error ? error.message : String(error)}.`) }
  }

  // Load step 1: pick + read + parse the file. Parse errors surface in the notice
  // banner; a valid file opens the new-vs-replace mode dialog.
  const doLoad = async (): Promise<void> => {
    const text = await window.amber.openWorkspaceFile()
    if (text === null) return
    let doc: WorkspaceDoc
    try { doc = parseWorkspaceFile(text) } catch (e) {
      setNotice(`Could not load workspace — ${(e as Error).message}.`)
      return
    }
    if (doc.workspaces.length === 0) { setNotice('That workspace file has no workspaces.'); return }
    workspaceSourceTexts.current.set(doc, text)
    setLoadDoc(doc)
  }

  // Load step 2: chosen mode. Replace kills the current workspace's panes first
  // (one-way — removal lands via daemon events); createSession per planned pane;
  // the pendingLoad effect commits the sidecar + replay once the daemon confirms.
  const applyDocument = async (doc: WorkspaceDoc, mode: 'new' | 'replace'): Promise<void> => {
    const killed: string[] = []
    if (!window.amber.importWorkspaceBrowsers) { setNotice('This Amber build cannot restore workspaces.'); return }
    try { await ensureBrowserContext() } catch (error) { setNotice(error instanceof Error ? error.message : 'STALE_BROWSER_CONTEXT'); return }
    const imported = await window.amber.importWorkspaceBrowsers({ mode, text: workspaceSourceTexts.current.get(doc) ?? serializeWorkspaceFile(doc) }) as { ok?: boolean; error?: string; layout?: string; version?: string; plan?: LoadPlan }
    if (!imported.ok || !imported.layout) { setNotice(`Could not restore workspace — ${imported.error ?? 'unknown error'}.`); return }
    if (!imported.plan) { setNotice('Could not restore workspace — missing main-owned plan.'); return }
    const plan = imported.plan
    versionRef.current = imported.version ?? versionRef.current
    setLayout(parseLayout(imported.layout))
    if (plan.browserRecovery.length) setNotice(`${plan.browserRecovery.length} additional browser URL${plan.browserRecovery.length === 1 ? '' : 's'} saved for recovery.`)
    if (mode === 'replace') {
      const cur = workspaces.find((w) => w.ws === currentWs)
      for (const t of cur?.tabs ?? []) for (const p of t.panes) {
        if (isEditorName(p.name)) closePane(p.name)
        else { window.amber.killSession(p.name); killed.push(p.name) }
      }
    }
    // Stage scrollback NOW, before the panes can mount. In replace mode reconcile
    // appends the new live sessions to the current tab as they arrive (during the
    // pending-load window, before commitLoad runs), mounting each Pane — and a
    // Pane's mount effect (child) runs before App's commit effect (parent), so
    // takeReplay must find its bytes already staged or the replay is lost.
    stageReplay(plan.scrollback)
    for (const c of plan.creates) window.amber.createSession(c.name, c.cwd, c.kind)
    setPendingLoad({ plan, createNames: plan.creates.map((c) => c.name), killed })
  }
  const createCheckpoint = async (name: string, automatic = false, scope: 'one' | 'all' = 'one'): Promise<boolean> => {
    if (!window.amber.writeCheckpoint) return false
    try {
      const { doc, stragglers } = await captureWorkspace(scope, true)
      const id = `checkpoint-${makeId().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40)}`
      await window.amber.writeCheckpoint(id, serializeCheckpoint(doc, { id, name: name.slice(0, 80), createdAt: Date.now(), scope, automatic }))
      setCheckpoints(await window.amber.listCheckpoints?.() ?? [])
      if (stragglers.length) {
        setNotice(automatic
          ? `Protected action cancelled: the restore point has ${stragglers.length} incomplete scrollback capture(s).`
          : `Restore point created with ${stragglers.length} empty scrollback capture(s).`)
        if (automatic) return false
      }
      return true
    } catch (error) { setNotice(`Restore point failed — ${String(error)}`); return false }
  }
  const applyLoad = (mode: 'new' | 'replace'): void => {
    const doc = loadDoc
    setLoadDoc(null)
    if (!doc) return
    if (mode === 'replace') {
      void (async () => { if (await createCheckpoint('Before workspace replacement', true)) await applyDocument(doc, mode) })()
    } else void applyDocument(doc, mode)
  }

  const runGlobalSearch = (query: string, scope: SearchScope): void => {
    if (!window.amber.searchScrollback) { setSearchError('Global search requires the current desktop daemon.'); return }
    const requestId = (searchRequest.current + 1) >>> 0
    searchRequest.current = requestId; setSearchLoading(true); setSearchError(null); setSearchResults([])
    window.amber.searchScrollback(requestId, query, searchScopeNames(sessions, scope, currentWs, currentTab), 100)
    if (searchTimeout.current) clearTimeout(searchTimeout.current)
    searchTimeout.current = setTimeout(() => { if (searchRequest.current === requestId) { setSearchLoading(false); setSearchError('Search timed out — restart or update the Amber daemon.') } }, 8000)
  }
  const refreshRecovery = (): void => {
    if (!window.amber.listRecoveryEvents) { setRecoveryError('Recovery history requires the current desktop daemon.'); return }
    setRecoveryLoading(true); setRecoveryError(null); window.amber.listRecoveryEvents(200)
    if (recoveryTimeout.current) clearTimeout(recoveryTimeout.current)
    recoveryTimeout.current = setTimeout(() => { setRecoveryLoading(false); setRecoveryError('History request timed out — restart or update the daemon.') }, 8000)
  }
  const openProductivity = (overlay: ProductivityOverlay): void => {
    setToolbarMenu(null); setProductivityOverlay(overlay)
    if (overlay === 'recovery') refreshRecovery()
    if (overlay === 'checkpoints') void window.amber.listCheckpoints?.().then(setCheckpoints)
    if (overlay === 'project') { setProjectProfile(null); setProjectError(null) }
    if (overlay === 'presets') setPresetTarget(null)
  }
  const choosePresetForPane = (paneId: string): void => {
    setToolbarMenu(null); setPresetTarget(paneId); setProductivityOverlay('presets')
  }
  const captureTemplate = (name: string): void => {
    void captureWorkspace('one', false).then(({ doc }) => updateProductivity((file) => ({ ...file, templates: [
      ...file.templates, { id: `template-${makeId().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40)}`, name, createdAt: Date.now(), doc },
    ] })))
  }
  const addBookmark = (session: string, excerpt: string): void => {
    const bookmark = makeBookmark(`bookmark-${makeId().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40)}`, excerpt, Date.now())
    updateProductivity((file) => ({ ...file, bookmarks: { ...file.bookmarks, [session]: [...(file.bookmarks[session] ?? []), bookmark] } }))
    setNotice('Terminal position bookmarked.')
  }
  const exportHandoff = (session: string): void => {
    const info = sessions.find((entry) => entry.name === session)
    if (!info || !window.amber.saveHandoffFile) return
    void collectDumps([session], (name) => window.amber.dumpBacklog(name),
      (name, cb) => { dumpResolvers.current.set(name, cb) }, (name) => { dumpResolvers.current.delete(name) })
      .then(({ dumps }) => {
        const bytes = dumps[session] ?? new Uint8Array()
        let binary = ''; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        const text = serializeHandoff({ version: 1, exportedAt: Date.now(), session: {
          kind: info.kind, cwd: info.cwd, ...(info.slot ? { slot: info.slot } : {}),
          ...(titles[session] ? { title: titles[session] } : {}), ...(info.run_state ? { runState: info.run_state } : {}),
          ...(info.claude_id ? { conversationId: info.claude_id } : {}),
        }, scrollback: btoa(binary), bookmarks: productivity.bookmarks[session] ?? [] })
        return window.amber.saveHandoffFile?.(text, `amber-${info.slot ?? 'session'}.amberhandoff`)
      }).then((saved) => { if (saved) setNotice('Session handoff exported. It may contain sensitive terminal output.') })
  }
  const createProjectWorkspace = (): void => {
    if (!projectProfile) return
    const panes = projectProfile.profile.panes.map((pane, index) => ({ id: `p${index}`, kind: pane.kind, cwd: projectProfile.resolvedCwds[index]!, ord: index, scrollback: '' }))
    let profileTree: Node | null = panes[0] ? { kind: 'leaf', paneId: panes[0].id } : null
    for (let i = 1; profileTree && i < panes.length; i += 1) profileTree = splitLeaf(profileTree, panes[i - 1]!.id, projectProfile.profile.panes[i]!.direction, panes[i]!.id)
    const profileWorkspace = { tabs: [{ tab: 1, tree: profileTree, panes }], ...(projectProfile.profile.name ? { label: projectProfile.profile.name } : {}) }
    const doc: WorkspaceDoc = { version: 1, scope: 'one', workspaces: [profileWorkspace] }
    setProductivityOverlay(null); applyDocument(doc, 'new')
  }
  const paletteEntries: PaletteEntry[] = [
    ...workspaces.flatMap((workspace) => workspace.tabs.flatMap((paneTab) => paneTab.panes.map((pane) => ({
      id: `pane:${pane.name}`, label: `${pane.slot ? `#${pane.slot} ` : ''}${titles[pane.name] || shortCwd(pane.cwd, window.amber.homeDir) || pane.kind}`,
      detail: `ws ${workspace.ws} · tab ${paneTab.tab} · ${pane.kind} · ${pane.cwd}`, keywords: pane.name,
      run: () => navigateTo(pane.name),
    })))),
    ...workspaces.map((workspace) => ({
      id: `workspace:${workspace.ws}`, label: layout.workspaces[String(workspace.ws)]?.label ?? `Workspace ${workspace.ws}`,
      detail: `${workspace.tabs.length} tabs`, keywords: `ws ${workspace.ws}`, run: () => { setActiveWs(workspace.ws); setActiveTab(workspace.tabs[0]?.tab ?? 1) },
    })),
    ...orderedTabs.map((paneTab) => ({
      id: `tab:${currentWs}:${paneTab.tab}`, label: layout.workspaces[String(currentWs)]?.tabs[String(paneTab.tab)]?.label ?? `Tab ${paneTab.tab}`,
      detail: `Workspace ${currentWs} · ${paneTab.panes.length} panes`, keywords: `tab ${paneTab.tab}`, run: () => setActiveTab(paneTab.tab),
    })),
    ...(productivityAvailable ? [
      { id: 'action:search', label: 'Search all scrollback', detail: chordLabel('global-search'), keywords: 'find global', run: () => openProductivity('search') },
      { id: 'action:recovery', label: 'Recovery center', detail: 'Daemon lifecycle and restore history', keywords: 'errors crashes', run: () => openProductivity('recovery') },
      { id: 'action:templates', label: 'Workspace templates', detail: 'Capture or instantiate a layout recipe', keywords: 'recipe project', run: () => openProductivity('templates') },
      { id: 'action:checkpoints', label: 'Restore points', detail: 'Named structure and scrollback snapshots', keywords: 'checkpoint rollback', run: () => openProductivity('checkpoints') },
      { id: 'action:bookmark-current', label: 'Bookmark active pane position', detail: 'Capture selected text or nearby cursor lines', keywords: 'terminal anchor', run: () => setPaneActionRequest({ action: 'bookmark', seq: ++navigationSeq.current }) },
      { id: 'action:bookmarks', label: 'Browse bookmarks', detail: 'Terminal text anchors', keywords: 'saved positions', run: () => openProductivity('bookmarks') },
      { id: 'action:presets', label: 'Preset input slots', detail: 'Save reusable text for one-click pane input', keywords: 'snippet command prompt paste', run: () => openProductivity('presets') },
      { id: 'action:handoff', label: 'Export active pane handoff', detail: 'Metadata, scrollback, and bookmarks', keywords: 'transfer archive', run: () => setPaneActionRequest({ action: 'handoff', seq: ++navigationSeq.current }) },
      { id: 'action:project', label: 'Load project profile', detail: `${cwd}/.amber.toml`, keywords: 'local config', run: () => openProductivity('project') },
    ] : []),
    { id: 'action:sessions', label: 'Activity overview', detail: 'Sessions, memory, state, and cleanup', keywords: 'monitor sessions memory', run: () => setSessionsOpen(true) },
    { id: 'action:save', label: 'Save workspace…', detail: 'Structure and retained scrollback', keywords: 'export amberws', run: () => setSaveScopeOpen(true) },
    { id: 'action:load', label: 'Load workspace…', detail: 'Create or replace from .amberws', keywords: 'import restore', run: () => { void doLoad() } },
    { id: 'action:help', label: 'Keyboard shortcuts', detail: chordLabel('help'), keywords: 'help keys', run: () => setShowHelp(true) },
    { id: 'action:new-pane', label: 'New pane', detail: chordLabel('new-pane'), keywords: 'create terminal', run: () => startPane() },
    { id: 'action:new-tab', label: 'New tab', detail: chordLabel('new-tab'), keywords: 'create', run: openTab },
  ]

  // Refresh the keyboard-chord dispatcher with this render's live closures.
  chordRef.current = (c) => {
    if (c?.type === 'new-tab') openTab()
    else if (c?.type === 'new-pane') startPane()
    else if (c?.type === 'prev-tab') stepTab(-1)
    else if (c?.type === 'next-tab') stepTab(1)
    else if (c?.type === 'help') setShowHelp(true)
    else if (c?.type === 'command-palette') openProductivity('palette')
    else if (c?.type === 'global-search' && productivityAvailable) openProductivity('search')
    else if (c?.type === 'font-bigger') bumpFont(1)
    else if (c?.type === 'font-smaller') bumpFont(-1)
    else if (c?.type === 'font-reset') resetFont()
    else if (c?.type === 'tab') { const t = orderedTabs[c.n - 1]; if (t) setActiveTab(t.tab) }
  }

  // Pane close is one-way (rule #3): `onClose` only requests the kill. Removal
  // then flows from the daemon's SessionsChanged{removed} -> store prunes
  // state.sessions -> liveIds drops it -> reconcile drops the leaf. An optimistic
  // local removeLeaf would race reconcile, which still sees the not-yet-confirmed
  // id in liveIds and re-appends it as a fresh right-split (mispositioned pane).
  // The daemon broadcasts removal for live AND dead-not-reaped sessions
  // (daemon.rs Kill broadcasts when the session still exists; the main.rs reap
  // timer broadcasts too), so dead panes ("close to remove") also flow cleanly.
  // Remote-access status. Polls ONLY while the dialog is open (a background
  // 3 s spawn of `amber ctl web status` forever would be pure waste); when it
  // is closed a window focus is the refresh trigger.
  useEffect(() => {
    let cancelled = false
    const poll = async (): Promise<void> => {
      const s = await window.amber?.webStatus?.()
      if (!cancelled && s) setWebStatus(s)
    }
    void poll()
    if (!remoteOpen) {
      const onFocus = (): void => {
        void poll()
      }
      window.addEventListener('focus', onFocus)
      return () => {
        cancelled = true
        window.removeEventListener('focus', onFocus)
      }
    }
    const t = setInterval(() => {
      void poll()
    }, 3000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [remoteOpen])

  // Router status. Same shape as the remote-access poll above and for the
  // same reason: a 3 s spawn of `amber ctl router status` forever would be
  // pure waste, so it only ticks while the dialog is open.
  useEffect(() => {
    let cancelled = false
    const poll = async (): Promise<void> => {
      const s = await window.amber?.routerStatus?.()
      if (!cancelled && s) setRouterStatus(s)
    }
    void poll()
    if (!routerOpen) {
      const onFocus = (): void => {
        void poll()
      }
      window.addEventListener('focus', onFocus)
      return () => {
        cancelled = true
        window.removeEventListener('focus', onFocus)
      }
    }
    const t = setInterval(() => {
      void poll()
    }, 3000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [routerOpen])

  const routerManaged = routerStatus === null || routerStatus.managed
  // Green only when it is actually routing somewhere.
  const routerTone = routerDot(
    routerStatus ?? {
      managed: true,
      unit: 'unknown',
      port: 0,
      url: '',
      alias: 'auto',
      hasToken: false,
      pi: 'no-config',
      slots: [],
      keys: [],
      queueAvailable: null,
      uptimeSecs: null,
      error: null,
    },
  )

  // The browser build cannot manage the service that serves it, so the whole
  // control is hidden there rather than shown broken. `null` (first paint,
  // before the first poll answers) keeps it visible: hiding then showing would
  // make the toolbar jump on every launch.
  const webManaged = webStatus === null || webStatus.managed
  // Pill colour: green only when it is actually reachable from a phone.
  const webDot =
    webStatus?.unit === 'active' && webStatus.tailscale === 'serving'
      ? 'serving'
      : webStatus?.unit === 'active'
        ? 'local'
        : webStatus?.error !== null && webStatus?.error !== undefined
          ? 'error'
          : 'off'
  const continuity = continuityView(connected, sessions, snapshotState)
  const requestSnapshot = (): void => {
    if (!continuity.canSnapshot || !connected || !window.amber.snapshotNow) return
    setSnapshotState({ kind: 'pending' })
    window.amber.snapshotNow?.()
  }

  const pocketWorkspaceOptions = workspaces.map((workspace) => ({
    ws: workspace.ws,
    label: layout.workspaces[String(workspace.ws)]?.label ?? `Workspace ${workspace.ws}`,
  }))
  const pocketWorkspaceLabels = Object.fromEntries(
    pocketWorkspaceOptions.map((workspace) => [workspace.ws, workspace.label]),
  ) as Record<number, string>
  const pocketTabLabels: Record<string, string> = {}
  for (const workspace of workspaces) for (const workspaceTab of workspace.tabs) {
    pocketTabLabels[`${workspace.ws}:${workspaceTab.tab}`] =
      layout.workspaces[String(workspace.ws)]?.tabs[String(workspaceTab.tab)]?.label ?? `Tab ${workspaceTab.tab}`
  }
  const focusedPocketItem = zoomedPane === null
    ? null
    : pocketAll.groups.flatMap((group) => group.items).find((item) => item.pane.name === zoomedPane) ?? null
  const choosePocketWorkspace = (next: number | null): void => {
    setPocketWorkspace(next)
    if (next === null) return
    setActiveWs(next)
    const workspace = workspaces.find((candidate) => candidate.ws === next)
    setActiveTab(layout.workspaces[String(next)]?.activeTab ?? workspace?.tabs[0]?.tab ?? 1)
  }
  const desktopReturnSize = desktopControlSize(desktopScale)

  return (
    <div className={mobile
      ? `app mobile ${pocketFocused ? 'pocket-focus' : pocketView === 'sessions' ? 'pocket-sessions' : 'pocket-mosaic'}`
      : 'app'}>
      {desktopView && (
        <button className="desktop-mobile-return" aria-label="Return to mobile view"
          title="Return to Amber Pocket" onClick={showPocketView}
          style={{
            minHeight: desktopReturnSize,
            minWidth: desktopReturnSize * 2.75,
            padding: `0 ${desktopReturnSize * 0.45}px`,
            borderRadius: desktopReturnSize * 0.18,
            fontSize: desktopReturnSize * 0.3,
            right: desktopReturnSize / 3,
            bottom: `calc(${desktopReturnSize / 3}px + env(safe-area-inset-bottom, 0px))`,
          }}>Mobile view</button>
      )}
      {mobile && pocketFocused && focusedPocketItem && (() => {
        const focusTitle = pocketSessionTitle(focusedPocketItem, titles, home)
        return <PocketFocusHeader
          title={focusTitle}
          machineName={window.amber.machineName}
          stateLabel={focusedPocketItem.stateLabel}
          onBack={clearZoom}
          onActions={() => setPocketAction(focusedPocketItem)}
        />
      })()}
      {mobile && !pocketCommandActive && (!pocketFocused || !focusedPocketItem) && (
        <div className="mobile-bar">
          <span className="crumb">
            {layout.workspaces[wsKey]?.label ?? `ws ${ws?.ws ?? 1}`}
            <span className="sep">·</span>
            {layout.workspaces[wsKey]?.tabs[tabKey]?.label ?? `tab ${tab?.tab ?? 1}`}
          </span>
          <span className="spacer" />
          <button aria-label="new pane" title="new pane" onClick={() => setPocketNewOpen(true)}><Icon name="add" /></button>
          <button aria-label="workspaces and tabs" title="workspaces and tabs"
            onClick={() => setDrawerOpen(true)}><Icon name="more" /></button>
        </div>
      )}
      {mobile && drawerOpen && (
        <Drawer
          workspaces={workspaces.map((w) => ({
            ws: w.ws,
            label: layout.workspaces[String(w.ws)]?.label ?? `workspace ${w.ws}`,
            active: w.ws === (ws?.ws ?? -1),
          }))}
          tabs={orderedTabs.map((t) => ({
            tab: t.tab,
            label: layout.workspaces[wsKey]?.tabs[String(t.tab)]?.label ?? `tab ${t.tab}`,
            active: t.tab === (tab?.tab ?? -1),
            activity: hasActivity(state, t.panes, frozenSet),
          }))}
          onPickWs={setActiveWs}
          onPickTab={setActiveTab}
          onNewWs={() => { setActiveWs(nextWs); setActiveTab(1) }}
          onNewTab={() => setActiveTab(nextTab)}
          onClose={() => setDrawerOpen(false)}
        />
      )}
      {!connected && !pocketCommandActive && <div className="banner" role="status" aria-live="polite"><span className="dot" />daemon disconnected — reconnecting…</div>}
      {state.error && (
        <div className="banner error-banner" role="alert">
          <span className="dot" />
          <span className="banner-msg">daemon error: {state.error}</span>
          <button className="banner-close" aria-label="dismiss error" title="dismiss" onClick={() => dispatch({ kind: 'ClearError' })}><Icon name="close" /></button>
        </div>
      )}
      {!pocketCommandActive && state.pressure && state.pressure.level !== 'normal' && (() => {
        const { level, currentKb, budgetKb, blocked } = state.pressure
        const message = level === 'warning'
          ? `Amber memory usage is high: ${fmtMem(currentKb)} of ${fmtMem(budgetKb)}. Idle agent panes may be parked.`
          : blocked
            ? 'Amber memory is critical, but no idle resumable agent pane can be parked. Close or freeze active work.'
            : 'Amber is protecting system memory by parking idle agent panes.'
        return <div className={`banner memory-banner ${level}`} role={level === 'warning' ? 'status' : 'alert'}>
          <span className="dot" />
          <span className="banner-msg">{message}</span>
        </div>
      })()}
      {!pocketCommandActive && state.resourcePressure?.level === 'critical' && (
        <ResourcePressureBanner pressure={state.resourcePressure} />
      )}
      {notice && (
        <div className="banner notice-banner" role="status" aria-live="polite">
          <span className="dot" />
          <span className="banner-msg">{notice}</span>
          <button className="banner-close" aria-label="dismiss notice" title="dismiss" onClick={() => setNotice(null)}><Icon name="close" /></button>
        </div>
      )}
      {pocketCommandActive && (
        <PocketCommandCenter
          model={pocketModel}
          loading={!(loaded && sawSessions)}
          machineName={window.amber.machineName}
          connected={connected}
          workspaceOptions={pocketWorkspaceOptions}
          activeWorkspace={pocketWorkspace}
          workspaceLabels={pocketWorkspaceLabels}
          tabLabels={pocketTabLabels}
          titles={titles}
          home={home}
          onWorkspace={choosePocketWorkspace}
          onOpen={openPocketItem}
          onActions={setPocketAction}
          onMosaic={() => setPocketView('mosaic')}
          onDesktop={showDesktopView}
          onNew={() => setPocketNewOpen(true)}
        />
      )}
      <div className="toolbar">
        <span className="label">workspace</span>
        {workspaces.map((w) => {
          const wsLabel = layout.workspaces[String(w.ws)]?.label
          if (editing?.kind === 'ws' && editing.id === w.ws) {
            return <RenameInput key={w.ws} initial={wsLabel ?? String(w.ws)}
              onCommit={(v) => { setWsLabel(w.ws, v); setEditing(null) }}
              onCancel={() => setEditing(null)} />
          }
          return (
            <button key={w.ws} className={'btn ws-pill' + (w.ws === (ws?.ws ?? -1) ? ' active' : '')}
              data-drop-ws={w.ws}
              aria-label={`workspace ${wsLabel ?? w.ws}`} title="double-click to rename · drop a pane here to move it"
              onClick={() => setActiveWs(w.ws)}
              onDoubleClick={() => setEditing({ kind: 'ws', id: w.ws })}>{wsLabel ?? w.ws}</button>
          )
        })}
        <button className="btn btn-ghost btn-with-icon" data-drop-ws={nextWs}
          title="new workspace · drop a pane here to move it to a new workspace"
          onClick={() => {
            setActiveWs(nextWs)
            // Editors mint a sidecar entry; daemon kinds create a session.
            if (kind === 'editor') {
              const name = formatEditorName({ ws: nextWs, tab: 1, ord: 0, id: makeId() })
              setLayout((l) => ({ ...l, editors: { ...(l.editors ?? {}), [name]: { ws: nextWs, tab: 1, ord: 0, path: null } } }))
            } else window.amber.createSession(formatName({ ws: nextWs, tab: 1, ord: 0, id: makeId() }), cwd, kind)
            setActiveTab(1)
          }}><Icon name="add" size={14} /> ws</button>
        <div className="divider" />
        <button className="btn cwd-chip btn-with-icon" title={`${cwd} — choose folder`}
          onClick={() => void window.amber.pickFolder().then((p) => { if (p) setCwd(p) })}>
          <Icon name="folder" size={14} />
          <span>{shortCwd(cwd, window.amber.homeDir)}</span>
        </button>
        <div className="toolbar-popover-wrap create-wrap">
          <button className="btn btn-accent btn-with-icon pane-create" aria-haspopup="menu"
            aria-expanded={toolbarMenu === 'pane-kind'}
            onClick={() => setToolbarMenu((open) => open === 'pane-kind' ? null : 'pane-kind')}>
            <Icon name="add" size={15} /> Pane
          </button>
          {toolbarMenu === 'pane-kind' && (
            <div className="toolbar-popover kind-popover" role="menu" aria-label="Create pane">
              <div className="popover-label">Create pane</div>
              {PANE_KIND_OPTIONS.map((option) => (
                <button key={option.kind} className="popover-item kind-option" role="menuitem"
                  onClick={() => {
                    setKind(option.kind)
                    setToolbarMenu(null)
                    startPane(option.kind)
                  }}>
                  <span className={`kind-dot ${option.kind}`} />
                  <span><strong>{option.label}</strong><small>{option.detail}</small></span>
                  {kind === option.kind && <span className="current-kind">last used</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        {!mobile && remoteHost.length === 0 && !tabBrowser && (
          <button className="btn btn-with-icon" onClick={() => void openTabBrowser()} aria-label="Open tab browser">Browser</button>
        )}
        {!mobile && remoteHost.length === 0 && (
          <button className="btn" onClick={() => void refreshBrowserRecovery()} aria-label="Browser recovery">Recovery</button>
        )}
        <div className="spacer" />
        {remoteHost.length > 0 && (
          <span className="remote-marker"
            title={`Mirroring ${remoteHost} over ssh — this window does not write that machine's layout`}>
            {remoteHost} · read-only
          </span>
        )}
        {!mobile && needsAttention.length > 0 && (
          <div className="toolbar-popover-wrap">
            <button className="btn attention-pill" aria-haspopup="dialog"
              aria-expanded={toolbarMenu === 'attention'}
              aria-label={`${needsAttention.length} session${needsAttention.length === 1 ? '' : 's'} ${needsAttention.length === 1 ? 'needs' : 'need'} attention`}
              onClick={() => setToolbarMenu((open) => open === 'attention' ? null : 'attention')}>
              <span className="attention-pulse" aria-hidden="true" />
              <span className="attention-label">{needsAttention.length} need{needsAttention.length === 1 ? 's' : ''} you</span>
            </button>
            {toolbarMenu === 'attention' && (
              <DesktopAttention model={pocketAll} titles={titles}
                workspaceLabels={pocketWorkspaceLabels} tabLabels={pocketTabLabels} home={home}
                onOpen={showDesktopItem} onViewAll={() => openSessionList('all')} />
            )}
          </div>
        )}
        <div className="toolbar-popover-wrap">
          <button className={`btn continuity-pill ${continuity.tone}`} aria-haspopup="dialog"
            aria-expanded={toolbarMenu === 'continuity'}
            aria-label={`${continuity.heading}, ${continuity.compact}`}
            onClick={() => setToolbarMenu((open) => open === 'continuity' ? null : 'continuity')}>
            <span className="continuity-dot" />
            <Icon name="preserve" size={14} />
            <span>{continuity.compact}</span>
          </button>
          {toolbarMenu === 'continuity' && (
            <div className="toolbar-popover continuity-popover" role="dialog" aria-label="Continuity status">
              <div className="continuity-head">
                <span className={`continuity-mark ${continuity.tone}`}><Icon name="preserve" size={18} /></span>
                <span><strong>{continuity.heading}</strong><small>{continuity.detail}</small></span>
              </div>
              <p>Your terminal sessions are owned by the daemon and continue independently of this window.</p>
              <div className="continuity-machine">
                <span>{remoteHost ? 'Remote machine' : 'Machine'}</span>
                <code>{remoteHost || window.amber.machineName}</code>
              </div>
              <div className={`snapshot-row snapshot-${snapshotState.kind}`} role="status" aria-live="polite">
                <span>{continuity.snapshot}</span>
                <button className="btn btn-ghost" disabled={!continuity.canSnapshot || !window.amber.snapshotNow}
                  onClick={requestSnapshot}>{snapshotState.kind === 'pending' ? 'Saving…' : 'Snapshot now'}</button>
              </div>
              {productivityAvailable && <div className="snapshot-row">
                <button className="btn btn-ghost" onClick={() => openProductivity('recovery')}>Recovery center</button>
                <button className="btn btn-ghost" onClick={() => openProductivity('checkpoints')}>Restore points</button>
              </div>}
            </div>
          )}
        </div>
        {webManaged && <button
          className={`btn web-pill web-pill-${webDot}`}
          // NEVER the url here: a title attribute is read by screen readers,
          // screenshots and hover — and the login url is a full-authority credential.
          title="Remote access — run the browser/mobile server"
          aria-label={`Remote access: ${webDot}`}
          onClick={() => setRemoteOpen(true)}>
          <span className="web-dot" /> remote
        </button>}
        {routerManaged && <button
          className={`btn web-pill router-pill web-pill-${routerTone}`}
          title="Local model router — one endpoint, ordered failover"
          aria-label={`Model router: ${routerTone}`}
          onClick={() => setRouterOpen(true)}>
          <span className="web-dot" /> router
        </button>}
        <div className="toolbar-popover-wrap">
          <button className="icon-btn toolbar-icon" aria-label="workspace tools" title="Workspace tools"
            aria-haspopup="menu" aria-expanded={toolbarMenu === 'tools'}
            onClick={() => setToolbarMenu((open) => open === 'tools' ? null : 'tools')}><Icon name="more" /></button>
          {toolbarMenu === 'tools' && (
            <div className="toolbar-popover tools-popover" role="menu" aria-label="Workspace tools">
              <button className="popover-item" role="menuitem" onClick={() => { setToolbarMenu(null); setSaveScopeOpen(true) }}>
                <Icon name="save" /><span><strong>Save workspace…</strong><small>Export structure and scrollback</small></span>
              </button>
              <button className="popover-item" role="menuitem" onClick={() => { setToolbarMenu(null); void doLoad() }}>
                <Icon name="load" /><span><strong>Load workspace…</strong><small>Open a portable .amberws file</small></span>
              </button>
              {productivityAvailable && <>
                <div className="ctx-sep" />
                <button className="popover-item" role="menuitem" onClick={() => openProductivity('search')}>
                  <Icon name="sessions" /><span><strong>Search all scrollback</strong><small>Find retained text across sessions</small></span>
                </button>
                <button className="popover-item" role="menuitem" onClick={() => openProductivity('recovery')}>
                  <Icon name="preserve" /><span><strong>Recovery center</strong><small>Restore and lifecycle history</small></span>
                </button>
                <button className="popover-item" role="menuitem" onClick={() => openProductivity('templates')}>
                  <Icon name="save" /><span><strong>Templates</strong><small>Reusable workspace recipes</small></span>
                </button>
                <button className="popover-item" role="menuitem" onClick={() => openProductivity('checkpoints')}>
                  <Icon name="restore" /><span><strong>Restore points</strong><small>Named structure and scrollback captures</small></span>
                </button>
                <button className="popover-item" role="menuitem" onClick={() => openProductivity('bookmarks')}>
                  <Icon name="preserve" /><span><strong>Bookmarks</strong><small>Saved terminal text anchors</small></span>
                </button>
                <button className="popover-item" role="menuitem" onClick={() => openProductivity('presets')}>
                  <Icon name="preset" /><span><strong>Preset inputs</strong><small>Reusable text slots for terminal panes</small></span>
                </button>
                <button className="popover-item" role="menuitem" onClick={() => openProductivity('project')}>
                  <Icon name="folder" /><span><strong>Project profile</strong><small>Review {cwd}/.amber.toml</small></span>
                </button>
              </>}
              <div className="ctx-sep" />
              <button className="popover-item" role="menuitem" onClick={() => openSessionList('all')}>
                <Icon name="sessions" /><span><strong>Sessions</strong><small>Inspect activity across every daemon session</small></span>
              </button>
              <button className="popover-item" role="menuitem" onClick={() => { setToolbarMenu(null); setBudgetError(null); setBudgetOpen(true) }}>
                <Icon name="memory" /><span><strong>Memory</strong><small>View and set the aggregate budget</small></span>
              </button>
            </div>
          )}
        </div>
        <button className="icon-btn help-btn" aria-label="command palette"
          title={`Command palette (${chordLabel('command-palette')})`} onClick={() => openProductivity('palette')}><Icon name="sessions" /></button>
        <button className="icon-btn help-btn" aria-label="keyboard shortcuts"
          title={`Keyboard shortcuts (${chordLabel('help')})`} onClick={() => setShowHelp(true)}><Icon name="help" /></button>
      </div>
      <div className="tabbar" role="tablist">
        {orderedTabs.map((t) => {
          const dot = tabDot(t.panes)
          const isActive = t.tab === (tab?.tab ?? -1)
          // Background-activity dot: a non-active tab with unseen output.
          const showActivity = !isActive && hasActivity(state, t.panes, frozenSet)
          const isEditing = editing?.kind === 'tab' && editing.id === t.tab
          const tabLabel = layout.workspaces[wsKey]?.tabs[String(t.tab)]?.label
          // One-way close (rule #3): request a kill for every pane in the tab; the
          // tab vanishes when the daemon's removal events empty it. No local removal.
          const closeTab = (): void => closeTabPanes(t.panes)
          return (
            <div key={t.tab} role="tab" aria-selected={isActive} tabIndex={0}
              data-drop-tab={t.tab}
              className={'tab' + (isActive ? ' active' : '')}
              draggable={!isEditing}
              onClick={() => setActiveTab(t.tab)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveTab(t.tab) } }}
              onDoubleClick={() => setEditing({ kind: 'tab', id: t.tab })}
              onMouseDown={(e) => { if (e.button === 1) e.preventDefault() }}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab() } }}
              onDragStart={(e) => { dragTab.current = t.tab; e.dataTransfer.effectAllowed = 'move' }}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
              onDrop={(e) => { e.preventDefault(); if (dragTab.current !== null) reorderTab(dragTab.current, t.tab); dragTab.current = null }}
              onDragEnd={() => { dragTab.current = null }}>
              <span className={'kind-dot ' + dot.cls} role="img" aria-label={dot.label} title={dot.label} />
              {showActivity && <span className="activity-dot" role="img" aria-label="activity" title="background activity" />}
              {isEditing
                ? <RenameInput initial={tabLabel ?? `tab ${t.tab}`}
                    onCommit={(v) => { setTabLabel(t.tab, v); setEditing(null) }}
                    onCancel={() => setEditing(null)} />
                : <>
                    <span className="tab-label">{tabLabel ?? `tab ${t.tab}`}</span>
                    <span className="count">{t.panes.length}</span>
                    <button className="tab-close" aria-label="close tab" title="close tab"
                      onClick={(e) => { e.stopPropagation(); closeTab() }}><Icon name="close" /></button>
                  </>}
            </div>
          )
        })}
        <button className="btn btn-ghost tab-add" data-drop-tab={nextTab}
          title="new tab · drop a pane here to move it to a new tab" onClick={openTab}>+ Tab</button>
      </div>
      <div className="tab-browser-workarea">
      <div className={`pane-stage${pocketCommandActive ? ' pocket-stage-hidden' : ''}`}>
        {/* Keep-alive: render ONE SplitView per tab in the workspace, hiding the
            inactive ones with display:none instead of unmounting them. Switching
            tabs no longer disposes/rebuilds terminals or replays backlog — the
            first view of a tab still mounts+replays once; every switch after is
            instant. Keyed by ws:tab so the active toggle never remounts a layer.
            Interactive handlers close over the ACTIVE tree; background layers are
            display:none (pointer-inert) and SplitView gates chords on `active`,
            so those handlers are unreachable there. Scope: within the active
            workspace only — switching WORKSPACE still remounts (bigger footprint,
            not the reported gesture). */}
        {!(loaded && sawSessions)
          ? <div className="stage-loading">connecting to daemon…</div>
          : orderedTabs.length === 0
            ? <button className="empty-cta" onClick={() => startPane()}>
                <span className="empty-cta-title">Start a pane</span>
                <span className="empty-cta-sub">{chordLabel('new-pane')}</span>
              </button>
            : orderedTabs.map((t) => {
                const isActive = t.tab === (tab?.tab ?? -1)
                const stored = layout.workspaces[wsKey]?.tabs[String(t.tab)]?.tree ?? null
                const d = isActive ? { tree, paneMeta, deadCodes } : deriveTab(t.panes, stored, pending, titles, home, state.mem)
                // `const` so the truthy-branch narrowing (Node|null -> Node) is kept
                // inside the handler closures. Handlers operate on the layer's own
                // tree; only the active layer is reachable (background is
                // display:none + chord-gated), and putTree writes the active slot.
                const layerTree = d.tree
                return (
                  <div key={`${wsKey}:${t.tab}`} className="pane-layer"
                    style={{ position: 'absolute', inset: 0, display: isActive ? undefined : 'none' }}>
                    {layerTree
                      ? <SplitView tree={layerTree} active={isActive} deadCodes={d.deadCodes} meta={d.paneMeta}
                          epoch={reconnectEpoch} portEpoch={childEpoch} mobile={mobile}
                          fontSize={fontSize} onPaneTitle={onPaneTitle} onPaneFocus={onPaneFocus}
                          focusRequest={isActive ? focusRequest : null}
                          zoomedPane={isActive ? zoomedPane : null}
                          frozen={frozen}
                          onFreeze={freezePane}
                          onUnfreeze={unfreezePane}
                          {...(productivityAvailable ? {
                            onBookmark: addBookmark, onExportHandoff: exportHandoff, paneActionRequest,
                            onPresetInputs: choosePresetForPane, hasPresetInputs: productivity.inputSlots.length > 0, insertPresetRequest,
                            onPresetInserted: (seq: number) => setInsertPresetRequest((request) => request?.seq === seq ? undefined : request),
                          } : {})}
                          findRequest={findRequest}
                          onToggleZoom={toggleZoom}
                          onSetRatio={(path, r) => putTree(setRatio(layerTree, path, r))}
                          editors={editorEntries}
                          onEditorPath={(id, path) => setEditorState(id, { path })}
                          onEditorViewState={setEditorState}
                          onEditorDirty={setEditorDirty}
                          onEditorReady={setEditorApi}
                          onSplit={(paneId, dir, overrideKind) => {
                            // Editor splits have no daemon round-trip, so place the leaf now.
                            const k = overrideKind ?? kind
                            if (k === 'editor') {
                              const name = newEditor(currentTab, nextOrd)
                              putTree(splitLeaf(layerTree, paneId, dir, name))
                              clearZoom()
                              return
                            }
                            const name = formatName({ ws: currentWs, tab: currentTab, ord: nextOrd, id: makeId() })
                            window.amber.createSession(name, cwd, overrideKind ?? kind)
                            setPending((p) => ({ ...p, [name]: { paneId, dir } }))
                            clearZoom()
                          }}
                          onMove={(s, tgt, z) => { putTree(moveLeaf(layerTree, s, tgt, z)); clearZoom() }}
                          onMoveTo={moveTo}
                          onClose={(paneId) => { closePane(paneId); clearZoom() }} />
                      : isActive
                        ? <button className="empty-cta" onClick={() => startPane()}>
                            <span className="empty-cta-title">Start a pane</span>
                            <span className="empty-cta-sub">{chordLabel('new-pane')}</span>
                          </button>
                        : null}
                  </div>
                )
              })}
      </div>
      {tabBrowser && !mobile && remoteHost.length === 0 && (
        <BrowserRail id={tabBrowser.id} width={tabBrowser.width} collapsed={tabBrowser.collapsed}
          {...(tabBrowser.designatedPi ? { designatedPi: tabBrowser.designatedPi } : {})}
          {...(tabBrowser.sharedWithPi !== undefined ? { sharedWithPi: tabBrowser.sharedWithPi } : {})}
          controllers={(tab?.panes ?? []).filter((pane) => pane.kind === 'pi').map((pane) => ({ name: pane.name, label: titles[pane.name] || pane.name }))}
          onPolicy={(policy) => { void ensureBrowserContext().then(() => {
            if (policy.designatedPi !== tabBrowser.designatedPi) return window.amber.browserCommand({ type: 'designate', ...(policy.designatedPi ? { designatedPi: policy.designatedPi } : {}) })
            if (policy.sharedWithPi !== !!tabBrowser.sharedWithPi) return window.amber.browserCommand({ type: 'share', sharedWithPi: policy.sharedWithPi })
          }).catch((error) => setNotice(error instanceof Error ? error.message : 'STALE_BROWSER_CONTEXT')) }}
          ensureContext={ensureBrowserContext}
          onWidth={(width) => updateTabBrowser({ ...tabBrowser, width })}
          onCollapsed={(collapsed) => updateTabBrowser({ ...tabBrowser, collapsed })}
          onClose={() => void closeTabBrowser()} />
      )}
      </div>
      {pocketMosaicActive && (
        <PocketNav
          active="mosaic"
          onSessions={() => setPocketView('sessions')}
          onMosaic={() => {}}
          onDesktop={showDesktopView}
          onNew={() => setPocketNewOpen(true)}
        />
      )}
      {mobile && pocketAction && (() => {
        const item = pocketAction
        const title = pocketSessionTitle(item, titles, home)
        const parked = frozenSet.has(item.pane.name)
          || item.pane.runState === 'suspended'
          || item.pane.runState === 'memory-suspended'
          || item.pane.runState === 'resource-suspended'
        return <PocketSessionSheet
          item={item}
          title={title}
          parked={parked}
          onDismiss={() => closePocketSheet()}
          onOpen={() => closePocketSheet(() => openPocketItem(item))}
          onTogglePark={() => closePocketSheet(() => {
            if (parked) {
              unfreezePane(item.pane.name)
              if (item.pane.runState === 'memory-suspended' || item.pane.runState === 'resource-suspended') {
                window.amber.focusSession(item.pane.name)
              }
            } else freezePane(item.pane.name, '')
          })}
          onCopyCwd={() => closePocketSheet(() => window.amber.clipboardWrite(item.pane.cwd))}
          onShowMosaic={() => closePocketSheet(() => {
            setActiveWs(item.ws); setActiveTab(item.tab); setPocketView('mosaic')
            setZoom((current) => { const next = { ...current }; delete next[`${item.ws}:${item.tab}`]; return next })
          })}
          onCloseSession={() => closePocketSheet(() => setKillAsk([item.pane.name]))}
        />
      })()}
      {mobile && pocketNewOpen && (
        <PocketNewSessionSheet
          defaultKind={isAgentKind(kind) ? kind as PocketSessionKind : 'shell'}
          cwd={cwd}
          destination={`${pocketWorkspaceLabels[currentWs] ?? `Workspace ${currentWs}`} / ${pocketTabLabels[`${currentWs}:${currentTab}`] ?? `Tab ${currentTab}`}`}
          onChooseCwd={() => void window.amber.pickFolder().then((path) => { if (path) setCwd(path) })}
          onCreate={(selected) => closePocketSheet(() => createPocketPane(selected))}
          onDismiss={() => closePocketSheet()}
        />
      )}
      {closeAsk && (() => {
        // Spec §3.3: closing a pane with unsaved work asks first, and Cancel
        // ABORTS the close. Save routes through the pane's own save path, so a
        // mtime conflict is resolved there; a failed/cancelled save keeps the
        // pane open rather than losing the buffer.
        const paneId = closeAsk
        const name = layout.editors?.[paneId]?.path?.split('/').pop() ?? 'untitled'
        // `discard` must go through the pane's own handle FIRST: the editor
        // flushes its buffer to the draft file on unmount, so clearing the draft
        // without telling the pane to discard would let that flush recreate it
        // (verified live — the draft came back after a Discard close).
        const finish = (discard: boolean): void => {
          if (discard) editorApis.current.get(paneId)?.discardDraft()
          setCloseAsk(null)
          dropEditorPane(paneId)
          clearZoom()
        }
        return (
          <div className="help-overlay" onClick={() => setCloseAsk(null)}>
            <div className="help-card dialog-card" role="dialog" aria-modal="true" aria-label="Unsaved changes"
              onClick={(e) => e.stopPropagation()}>
              <div className="help-head">
                <span className="help-title">Unsaved changes</span>
                <button className="icon-btn" aria-label="close" title="close" onClick={() => setCloseAsk(null)}><Icon name="close" /></button>
              </div>
              <div className="dialog-body">
                <p className="dialog-text"><code>{name}</code> has unsaved changes.</p>
                <div className="dialog-actions">
                  <button className="btn btn-accent" onClick={() => {
                    void (async () => {
                      const ok = await editorApis.current.get(paneId)?.save()
                      if (ok) finish(false)
                      else setCloseAsk(null) // save cancelled/failed — keep the pane
                    })()
                  }}>Save and close</button>
                  <button className="btn danger-btn" onClick={() => finish(true)}>Discard</button>
                  <button className="btn btn-ghost" onClick={() => setCloseAsk(null)}>Cancel</button>
                </div>
              </div>
            </div>
          </div>
        )
      })()}
      {killAsk && (() => {
        // Closing a terminal pane KILLS its daemon session — the pty and
        // everything running in it (a claude conversation, a dev server). The
        // session is the durable thing in this app, so its destruction is
        // confirmed, never inferred from a click on ✕.
        // Rows come from the daemon's session list, not from the pane tree —
        // the cleanup dialog routes here too, and it can select a session that
        // no pane shows.
        const names = new Set(killAsk)
        const rows = sessionRows(sessions.filter((s) => names.has(s.name)), claudeNames)
        return (
          <div className="help-overlay" onClick={() => setKillAsk(null)}>
            <div className="help-card dialog-card" role="dialog" aria-modal="true" aria-label="Kill session"
              onClick={(e) => e.stopPropagation()}>
              <div className="help-head">
                <span className="help-title">{killAsk.length > 1 ? `Kill ${killAsk.length} sessions?` : 'Kill session?'}</span>
                <button className="icon-btn" aria-label="close" title="close" onClick={() => setKillAsk(null)}><Icon name="close" /></button>
              </div>
              <div className="dialog-body">
                {/* Deliberately not "closing this pane…": the cleanup dialog
                    routes here too, and it can select a session no pane shows. */}
                <p className="dialog-text">
                  Ends the pty and everything running inside
                  {killAsk.length > 1 ? ' each session' : ' it'}. This cannot be undone.
                </p>
                <ul className="session-list">
                  {rows.map((p) => (
                    <li key={p.name} className="session-row">
                      <span className="session-slot">{p.slot ? `#${p.slot}` : '—'}</span>
                      <span className={'kind-dot ' + (isAgentKind(p.kind) ? p.kind : 'shell')} title={p.kind} />
                      <span className="session-main">
                        <span className="session-name">{p.claudeName || p.cwd}</span>
                        <span className="session-sub">{p.name}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="dialog-actions">
                  <button className="btn danger-btn" autoFocus onClick={() => {
                    const names = [...killAsk]
                    void (async () => {
                      if (names.length > 1 && !(await createCheckpoint('Before bulk kill', true, 'all'))) return
                      for (const n of names) window.amber.killSession(n)
                      setKillAsk(null); clearZoom()
                    })()
                  }}>Kill</button>
                  <button className="btn btn-ghost" onClick={() => setKillAsk(null)}>Cancel</button>
                </div>
              </div>
            </div>
          </div>
        )
      })()}
      {sessionsOpen && (() => {
        // Every session the daemon still lists — including any that no pane can
        // show. The daemon outlives the app by design (core rule #6), so
        // sessions accumulate across quits with nothing in the UI that admits
        // they exist; this is that place, and the only bulk way to end them.
        const allRows = sessionRows(sessions, claudeNames)
        const attention = attentionNames(pocketAll)
        const baseRows = sessionView === 'attention'
          ? allRows.filter((row) => attention.has(row.name))
          : allRows
        const itemsByName = new Map(pocketAll.groups.flatMap((group) => group.items).map((item) => [item.pane.name, item]))
        const needle = activityQuery.trim().toLowerCase()
        const rows = baseRows.filter((row) => {
          if (needle !== '' && !`${row.name} ${row.cwd} ${row.kind} ${row.claudeName} ${titles[row.name] ?? ''}`.toLowerCase().includes(needle)) return false
          const live = sessions.find((session) => session.name === row.name)
          if (activityState === 'live') return row.alive
          if (activityState === 'exited') return !row.alive
          if (activityState === 'agents') return isAgentKind(row.kind)
          if (activityState === 'retrying') return live?.run_state?.includes('retry') === true
          if (activityState === 'fallback') return live?.run_state?.includes('shell') === true
          if (activityState === 'suspended') return live?.run_state?.includes('suspended') === true
          return true
        }).sort((a, b) => {
          if (activitySort === 'name') return a.name.localeCompare(b.name)
          if (activitySort === 'memory') return (state.mem[b.name]?.rssKb ?? 0) - (state.mem[a.name]?.rssKb ?? 0)
          if (activitySort === 'activity') return (state.lastActivity[b.name] ?? 0) - (state.lastActivity[a.name] ?? 0)
          return (a.slot || Number.MAX_SAFE_INTEGER) - (b.slot || Number.MAX_SAFE_INTEGER)
        })
        const summary = activitySummary(sessions, state)
        const toggle = (n: string): void =>
          setPicked((p) => { const c = new Set(p); if (!c.delete(n)) c.add(n); return c })
        // Adopt a session no pane can show (`amber create foo`, or a name from
        // some older grammar). Grouping is name-encoded (core rule #2), so the
        // rename IS the adoption: the daemon's SessionsChanged puts it in the
        // current tab, groupSessions buckets it, reconcile appends the leaf —
        // the exact path a reboot-restored session takes. Non-destructive: a
        // shell is renamed in place keeping its child + scrollback; a claude
        // respawns and --resumes the same conversation.
        const adopt = (n: string): void => {
          window.amber.renameSession(n, formatName({ ws: currentWs, tab: currentTab, ord: nextOrd, id: makeId() }))
          setSessionsOpen(false)
        }
        return (
          <div className="help-overlay" onClick={() => setSessionsOpen(false)}>
            <div className="help-card dialog-card sessions-card" role="dialog" aria-modal="true" aria-label="Sessions"
              onClick={(e) => e.stopPropagation()}>
              <div className="help-head">
                <span className="help-title">Sessions ({rows.length})</span>
                <button className="icon-btn" aria-label="close" title="close" onClick={() => setSessionsOpen(false)}><Icon name="close" /></button>
              </div>
              <div className="dialog-body">
                <div className="session-view-tabs" role="tablist" aria-label="Session view">
                  <button role="tab" aria-selected={sessionView === 'all'}
                    className={sessionView === 'all' ? 'active' : ''}
                    onClick={() => { setPicked(new Set()); setSessionView('all') }}>All <span>{allRows.length}</span></button>
                  <button role="tab" aria-selected={sessionView === 'attention'}
                    className={sessionView === 'attention' ? 'active' : ''}
                    onClick={() => { setPicked(new Set()); setSessionView('attention') }}>Needs you <span>{attention.size}</span></button>
                </div>
                <p className="dialog-text">
                  {sessionView === 'attention'
                    ? 'Sessions that exited, are retrying, or need recovery. Show reveals the existing pane without changing its layout.'
                    : <>Every retained Amber session. They outlive the app on purpose. Killing one ends its pty and everything running in it. A tagged <em>no pane</em> session can be adopted into the current tab.</>}
                </p>
                <div className="productivity-controls" style={{ paddingInline: 0 }}>
                  <input className="productivity-search" placeholder="Filter sessions" value={activityQuery} onChange={(event) => setActivityQuery(event.target.value)} />
                  <select value={activityState} onChange={(event) => setActivityState(event.target.value as typeof activityState)}>
                    <option value="all">all states</option><option value="live">live</option><option value="exited">exited</option><option value="agents">agents</option><option value="retrying">retrying</option><option value="fallback">fallback</option><option value="suspended">suspended</option>
                  </select>
                  <select value={activitySort} onChange={(event) => setActivitySort(event.target.value as typeof activitySort)}>
                    <option value="slot">slot</option><option value="activity">activity</option><option value="memory">memory</option><option value="name">name</option>
                  </select>
                </div>
                <div className="activity-summary" aria-label="session activity summary">
                  <span><strong>{summary.total}</strong> total</span><span><strong>{summary.alive}</strong> live</span><span><strong>{summary.exited}</strong> exited</span>
                  <span><strong>{Math.max(0, summary.agents - summary.retrying - summary.fallback - summary.suspended)}</strong> agents running</span>
                  <span><strong>{summary.retrying}</strong> retrying</span><span><strong>{summary.fallback}</strong> fallback</span><span><strong>{summary.suspended}</strong> parked</span>
                  <span><strong>{summary.unseen}</strong> unseen</span><span><strong>{fmtMem(summary.rssKb)}</strong> resident</span>
                </div>
                <div className="notification-prefs" aria-label="desktop notification preferences">
                  {(['activity', 'exit', 'retry', 'fallback', 'pressure'] as const).map((pref) => <label key={pref}><input type="checkbox"
                    checked={productivity.notifications[pref]} onChange={(event) => updateProductivity((file) => ({ ...file, notifications: { ...file.notifications, [pref]: event.target.checked } }))} /> {pref}</label>)}
                  <label><input type="checkbox" checked={productivity.notifications.mutedWorkspaces.includes(currentWs)}
                    onChange={(event) => updateProductivity((file) => ({ ...file, notifications: { ...file.notifications, mutedWorkspaces: event.target.checked
                      ? [...file.notifications.mutedWorkspaces, currentWs] : file.notifications.mutedWorkspaces.filter((ws) => ws !== currentWs) } }))} /> mute ws {currentWs}</label>
                </div>
                {rows.length === 0 && <div className="session-empty">
                  {sessionView === 'attention' && needle === '' && activityState === 'all' ? 'Nothing needs you.' : 'No sessions match these filters.'}
                </div>}
                <ul className="session-list">
                  {rows.map((r) => (
                    <li key={r.name} className={'session-row' + (picked.has(r.name) ? ' picked' : '')}>
                      <input type="checkbox" checked={picked.has(r.name)}
                        aria-label={`select ${r.name}`} onChange={() => toggle(r.name)} />
                      <span className="session-slot">{r.slot ? `#${r.slot}` : '—'}</span>
                      <span className={'kind-dot ' + (isAgentKind(r.kind) ? r.kind : 'shell')}
                        title={r.kind} />
                      <span className="session-main">
                        <span className="session-name">
                          {r.claudeName || r.cwd}
                          {!r.alive && <span className="session-tag dead"> exited</span>}
                          {!r.inPane && <span className="session-tag" title="live in the daemon, but its name maps to no pane"> no pane</span>}
                        </span>
                        <span className="session-sub">
                          {r.name}{r.ws !== null ? ` · ws ${r.ws} · tab ${r.tab}` : ''}
                          {r.claudeName ? ` · ${r.cwd}` : ''}
                        </span>
                      </span>
                      {r.inPane && itemsByName.has(r.name) && (
                        <button className="btn btn-ghost session-show"
                          aria-label={`show ${r.name}`}
                          onClick={() => showDesktopItem(itemsByName.get(r.name)!)}>Show</button>
                      )}
                      {!r.inPane && r.alive && (
                        <button className="btn btn-ghost session-adopt"
                          aria-label={`adopt ${r.name}`}
                          title={`open as a pane in ws ${currentWs} · tab ${currentTab} (renames the session)`}
                          onClick={() => adopt(r.name)}>Adopt</button>
                      )}
                      {r.inPane && <button className="btn btn-ghost session-adopt" onClick={() => { setSessionsOpen(false); navigateTo(r.name) }}>Focus</button>}
                      {isAgentKind(r.kind) && r.alive && <button className="btn btn-ghost session-adopt" onClick={() => {
                        const live = sessions.find((session) => session.name === r.name)
                        if (live?.run_state?.includes('suspended')) window.amber.resumeSession(r.name)
                        else window.amber.suspendSession(r.name)
                      }}>{sessions.find((session) => session.name === r.name)?.run_state?.includes('suspended') ? 'Resume' : 'Suspend'}</button>}
                      <button className="btn btn-ghost session-adopt" onClick={() => { setSessionsOpen(false); openProductivity('bookmarks') }}>Bookmarks</button>
                      <button className="btn btn-ghost session-adopt" onClick={() => exportHandoff(r.name)}>Export</button>
                    </li>
                  ))}
                </ul>
                <div className="dialog-actions">
                  <button className="btn danger-btn" disabled={picked.size === 0}
                    onClick={() => { setSessionsOpen(false); setKillAsk([...picked]); setPicked(new Set()) }}>
                    Kill selected ({picked.size})
                  </button>
                  <button className="btn btn-ghost" onClick={() => setSessionsOpen(false)}>Close</button>
                </div>
              </div>
            </div>
          </div>
        )
      })()}
      {budgetOpen && (() => {
        const apply = (text: string): void => {
          const req = parseBudgetInput(text)
          if (req === null) { setBudgetError('use 20G / 1536M / a MiB count / auto'); return }
          setBudgetError(null)
          window.amber.setMemoryBudget(req.kind === 'auto' ? 0 : req.mb)
          // The BudgetApplied reply refreshes `budget`; confirm out loud so a
          // silent daemon is never mistaken for success.
          setNotice(req.kind === 'auto' ? 'memory budget: auto' : `memory budget: ${req.mb} MiB`)
        }
        const clamped = budget !== null && budget.effectiveKb > 0 &&
          budget.cgroupLimitKb > 0 && budget.effectiveKb === budget.cgroupLimitKb
        return (
          <div className="help-overlay" onClick={() => setBudgetOpen(false)}>
            <div className="help-card dialog-card" role="dialog" aria-modal="true" aria-label="Memory budget"
              onClick={(e) => e.stopPropagation()}>
              <div className="help-head">
                <span className="help-title">Memory</span>
                <button className="icon-btn" aria-label="close" title="close" onClick={() => setBudgetOpen(false)}><Icon name="close" /></button>
              </div>
              <div className="dialog-body">
                <p className="dialog-text">
                  The aggregate soft ceiling amber's panes may occupy before the guardian starts
                  parking agent panes to reclaim RAM. Changes save to config and take effect
                  immediately — no restart.
                </p>
                {budget === null ? (
                  <p className="dialog-text">asking the daemon…</p>
                ) : (
                  <ul className="session-list" style={{ listStyle: 'none', padding: 0 }}>
                    <li className="session-row">
                      <span className="session-main">
                        <span className="session-name">
                          configured: {budget.configuredMb === null ? 'auto' : `${budget.configuredMb} MiB`}
                        </span>
                        <span className="session-sub">
                          effective {budget.effectiveKb > 0 ? formatKb(budget.effectiveKb) : 'none — parking disabled'}
                          {' · '}per-pane {formatKb(budget.sessionHighKb)}
                          {' · '}service cap {budget.cgroupLimitKb > 0 ? formatKb(budget.cgroupLimitKb) : 'none'}
                        </span>
                      </span>
                    </li>
                  </ul>
                )}
                {clamped && (
                  <p className="dialog-text">
                    Clamped by the service cap — raise that too with{' '}
                    <code>amber ctl budget &lt;size&gt; --systemd</code>.
                  </p>
                )}
                <div className="dialog-actions" style={{ gap: 8 }}>
                  <input
                    aria-label="new budget"
                    placeholder="20G · 1536M · auto"
                    value={budgetInput}
                    onChange={(e) => { setBudgetInput(e.target.value); setBudgetError(null) }}
                    onKeyDown={(e) => { if (e.key === 'Enter') apply(budgetInput) }}
                  />
                  <button className="btn btn-accent" onClick={() => apply(budgetInput)}>Set</button>
                  <button className="btn btn-ghost" title="half of physical RAM"
                    onClick={() => { setBudgetInput('auto'); apply('auto') }}>Auto</button>
                </div>
                {budgetError && <p className="dialog-text" style={{ color: 'crimson' }}>{budgetError}</p>}
              </div>
            </div>
          </div>
        )
      })()}
      {saveScopeOpen && (
        <div className="help-overlay" onClick={() => setSaveScopeOpen(false)}>
          <div className="help-card dialog-card" role="dialog" aria-modal="true" aria-label="Save workspace"
            onClick={(e) => e.stopPropagation()}>
            <div className="help-head">
              <span className="help-title">Save workspace</span>
              <button className="icon-btn" aria-label="close" title="close" onClick={() => setSaveScopeOpen(false)}><Icon name="close" /></button>
            </div>
            <div className="dialog-body">
              <p className="dialog-text">Save structure and scrollback to a portable <code>.amberws</code> file.</p>
              <div className="dialog-actions">
                <button className="btn btn-accent" onClick={() => void doSave('one')}>This workspace</button>
                <button className="btn" onClick={() => void doSave('all')}>All workspaces</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {browserRecoveryOpen && (
        <div className="help-overlay" onClick={() => setBrowserRecoveryOpen(false)}>
          <div className="help-card dialog-card" role="dialog" aria-modal="true" aria-label="Browser recovery" onClick={(event) => event.stopPropagation()}>
            <div className="help-head"><span className="help-title">Browser recovery</span><button className="icon-btn" aria-label="close" onClick={() => setBrowserRecoveryOpen(false)}><Icon name="close" /></button></div>
            <div className="dialog-body">
              {browserRecovery.length === 0 ? <p className="dialog-text">No recoverable browser URLs.</p> : browserRecovery.map((item) => (
                <div className="recovery-row" key={`${item.index}:${item.safeRestoreUrl}`}><code>{item.safeRestoreUrl}</code><span>ws {item.workspace} · tab {item.tab}</span>
                  <div className="dialog-actions">
                    <button className="btn" onClick={() => void ensureBrowserContext().then(() => window.amber.browserRecovery?.({ action: 'attach', index: item.index })).then(() => refreshBrowserRecovery())}>Attach here</button>
                    <button className="btn" onClick={() => void window.amber.browserRecovery?.({ action: 'copy', index: item.index })}>Copy URL</button>
                    <button className="btn danger-btn" onClick={() => void window.amber.browserRecovery?.({ action: 'delete', index: item.index }).then(() => refreshBrowserRecovery())}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {loadDoc && (() => {
        const cur = workspaces.find((w) => w.ws === currentWs)
        const paneCount = cur?.tabs.reduce((m, t) => m + t.panes.length, 0) ?? 0
        const browserIds = Object.values(layout.workspaces[String(currentWs)]?.tabs ?? {}).flatMap((tab) => tab.browser ? [tab.browser.id] : [])
        const wsCount = loadDoc.workspaces.length
        return (
          <div className="help-overlay" onClick={() => setLoadDoc(null)}>
            <div className="help-card dialog-card" role="dialog" aria-modal="true" aria-label="Load workspace"
              onClick={(e) => e.stopPropagation()}>
              <div className="help-head">
                <span className="help-title">Load workspace{wsCount > 1 ? ` (${wsCount} workspaces)` : ''}</span>
                <button className="icon-btn" aria-label="close" title="close" onClick={() => setLoadDoc(null)}><Icon name="close" /></button>
              </div>
              <div className="dialog-body">
                {browserIds.length > 0 && <p className="dialog-text" role="note">Replacing closes volatile state in: {browserIds.join(', ')}. Durable restore URLs remain recoverable until the transaction commits.</p>}
                <div className="dialog-actions column">
                  <button className="btn btn-accent" onClick={() => applyLoad('new')}>
                    Load as new workspace{wsCount > 1 ? 's' : ''}
                  </button>
                  <button className="btn danger-btn" onClick={() => applyLoad('replace')}>
                    Replace current workspace{paneCount > 0 ? ` — closes ${paneCount} pane${paneCount === 1 ? '' : 's'}` : ''}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
      })()}
      {connectOpen && (
        <div className="help-overlay" onClick={() => setConnectOpen(false)}>
          <div className="help-card dialog-card" role="dialog" aria-modal="true" aria-label="Connect to host"
            onClick={(e) => e.stopPropagation()}>
            <div className="help-head">
              <span className="help-title">Connect to host</span>
              <button className="icon-btn" aria-label="close" onClick={() => setConnectOpen(false)}><Icon name="close" /></button>
            </div>
            <div className="dialog-body">
              <p className="dialog-text">
                Opens another machine's amber in a new window, over ssh. Any destination
                ssh accepts works — an alias from your <code>~/.ssh/config</code>, or
                <code> user@host</code>. That machine's pane layout is mirrored read-only.
              </p>
              <RenameInput
                initial=""
                onCommit={(v) => {
                  setConnectOpen(false)
                  const host = v.trim()
                  if (host.length > 0) void window.amber.connectHost?.(host)
                }}
                onCancel={() => setConnectOpen(false)}
              />
            </div>
          </div>
        </div>
      )}
      {remoteOpen && (
        <RemoteAccess status={webStatus} onClose={() => setRemoteOpen(false)} onRefresh={() => { void window.amber.webStatus().then(setWebStatus) }} />
      )}
      {routerOpen && (
        <RouterPanel
          status={routerStatus}
          onClose={() => setRouterOpen(false)}
          onRefresh={() => { void window.amber.routerStatus().then(setRouterStatus) }}
        />
      )}
      {productivityOverlay === 'palette' && <CommandPalette entries={paletteEntries} onClose={() => setProductivityOverlay(null)} />}
      {productivityOverlay === 'search' && <GlobalSearchDialog results={searchResults} loading={searchLoading} error={searchError}
        onClose={() => setProductivityOverlay(null)} onSearch={runGlobalSearch}
        describe={(name) => { const info = sessions.find((session) => session.name === name); const parsed = parseName(name); return `${info?.slot ? `#${info.slot} · ` : ''}${titles[name] || shortCwd(info?.cwd ?? '', window.amber.homeDir) || name}${parsed ? ` · ws ${parsed.ws} · tab ${parsed.tab}` : ''}` }}
        onPick={(result, query) => navigateTo(result.name, query)} />}
      {productivityOverlay === 'recovery' && <RecoveryCenter events={recoveryEvents} sessions={sessions} loading={recoveryLoading} error={recoveryError}
        onClose={() => setProductivityOverlay(null)} onRefresh={refreshRecovery}
        onRetry={(session) => window.amber.resumeSession(session)} onCleanup={() => { setProductivityOverlay(null); setSessionsOpen(true) }}
        onClear={() => { if (window.confirm('Clear daemon recovery history?')) { setRecoveryLoading(true); window.amber.clearRecoveryEvents?.(); if (recoveryTimeout.current) clearTimeout(recoveryTimeout.current); recoveryTimeout.current = setTimeout(() => { setRecoveryLoading(false); setRecoveryError('Clear timed out — restart or update the daemon.') }, 8000) } }}
        onFocus={(session) => navigateTo(session)} />}
      {productivityOverlay === 'templates' && <TemplatesDialog templates={productivity.templates}
        onClose={() => setProductivityOverlay(null)} onCapture={captureTemplate}
        onLoad={(template: WorkspaceTemplate) => { setProductivityOverlay(null); applyDocument(template.doc, 'new') }}
        onRename={(id, name) => updateProductivity((file) => ({ ...file, templates: file.templates.map((template) => template.id === id ? { ...template, name } : template) }))}
        onDelete={(id) => updateProductivity((file) => ({ ...file, templates: file.templates.filter((template) => template.id !== id) }))} />}
      {productivityOverlay === 'bookmarks' && <BookmarksDialog
        bookmarks={Object.entries(productivity.bookmarks).flatMap(([session, bookmarks]) => bookmarks.map((bookmark) => ({ session, bookmark })))}
        onClose={() => setProductivityOverlay(null)} onPick={(session, bookmark: SessionBookmark) => navigateTo(session, bookmarkNeedle(bookmark))}
        onRename={(session, id, label) => updateProductivity((file) => ({ ...file, bookmarks: { ...file.bookmarks, [session]: (file.bookmarks[session] ?? []).map((bookmark) => bookmark.id === id ? { ...bookmark, label } : bookmark) } }))}
        onDelete={(session, id) => updateProductivity((file) => ({ ...file, bookmarks: { ...file.bookmarks, [session]: (file.bookmarks[session] ?? []).filter((bookmark) => bookmark.id !== id) } }))} />}
      {productivityOverlay === 'presets' && <PresetInputsDialog slots={productivity.inputSlots} targetPane={presetTarget}
        onClose={() => { setProductivityOverlay(null); setPresetTarget(null) }}
        onInsert={(entry: PresetInputSlot) => {
          const target = presetTarget
          if (!target || sessions.find((session) => session.name === target)?.alive !== true) {
            setNotice('That pane is no longer available.'); return
          }
          setProductivityOverlay(null); setPresetTarget(null)
          setInsertPresetRequest({ paneId: target, text: entry.text, seq: ++navigationSeq.current })
          setNotice(`Inserted preset #${entry.slot} without sending Enter.`)
        }}
        onSave={(slot, label, text) => updateProductivity((file) => ({ ...file, inputSlots: [
          ...file.inputSlots.filter((entry) => entry.slot !== slot), { slot, label, text, updatedAt: Date.now() },
        ].sort((a, b) => a.slot - b.slot) }))}
        onDelete={(slot) => updateProductivity((file) => ({ ...file, inputSlots: file.inputSlots.filter((entry) => entry.slot !== slot) }))} />}
      {productivityOverlay === 'checkpoints' && <CheckpointsDialog checkpoints={checkpoints}
        onClose={() => setProductivityOverlay(null)} onCreate={(name, scope) => { void createCheckpoint(name, false, scope) }}
        onDelete={(id) => { if (window.confirm('Delete this restore point?')) void window.amber.deleteCheckpoint?.(id).then(async () => setCheckpoints(await window.amber.listCheckpoints?.() ?? [])) }}
        onRestore={(id, replace) => { void (async () => {
          try {
            if (replace && !(await createCheckpoint('Before restore-point replacement', true))) return
            const text = await window.amber.readCheckpoint?.(id); if (!text) return
            const doc = parseCheckpoint(text)
            setProductivityOverlay(null); applyDocument(doc, replace ? 'replace' : 'new')
          } catch (error) { setNotice(`Could not restore point — ${String(error)}`) }
        })() }} />}
      {productivityOverlay === 'project' && <ProjectProfileDialog loaded={projectProfile} error={projectError}
        onClose={() => setProductivityOverlay(null)} onRead={() => { void window.amber.readProjectProfile?.(cwd).then((result) => {
          if (!result) return
          if ('error' in result) { setProjectError(result.error); setProjectProfile(null) }
          else { setProjectError(null); setProjectProfile(result) }
        }) }} onCreate={createProjectWorkspace} />}
      {showHelp && (
        <div className="help-overlay" onClick={() => setShowHelp(false)}>
          <div className="help-card" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"
            onClick={(e) => e.stopPropagation()}>
            <div className="help-head">
              <span className="help-title">Keyboard shortcuts</span>
              <button className="icon-btn" aria-label="close shortcuts" title="close"
                onClick={() => setShowHelp(false)}><Icon name="close" /></button>
            </div>
            <ul className="help-list">
              {CHORD_TABLE.map((c) => (
                <li key={c.action}>
                  <span className="help-desc">{c.desc}</span>
                  <kbd className="help-keys">{chordLabel(c.action)}</kbd>
                </li>
              ))}
              <li>
                <span className="help-desc">Switch to tab 1–9</span>
                <kbd className="help-keys">{modLabel('1–9')}</kbd>
              </li>
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
