import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SplitView, type PaneMeta } from './SplitView'
import type { EditorApi } from './Editor'
import { initialState, reduce, groupSessions, mergeBrowsers, mergeEditors, tabDot, hasActivity, type DaemonEvent } from './store'
import { sessionRows } from './sessionRows'
import { deriveTab, shortCwd } from './tabView'
import { formatName, makeId, retargetPane } from '../shared/names'
import { formatBrowserName, isBrowserName } from '../shared/browserName'
import { formatEditorName, isEditorName } from '../shared/editorName'
import { splitLeaf, setRatio, reconcile, leaves, moveLeaf, type Node } from './layout'
import { emptyLayout, parseLayout, serializeLayout, orderTabs, moveTab, type LayoutFile, type TabLayout } from '../shared/layoutFile'
import {
  parseWorkspaceFile, serializeWorkspaceFile, assembleSave, planLoad,
  type WorkspaceDoc, type SaveWorkspace, type LoadPlan,
} from '../shared/workspaceFile'
import { collectDumps, matchDumpError } from './dumps'
import { stageReplay } from './replay'
import { appChord, chordLabel, modLabel, CHORD_TABLE } from './keys'
import './theme.css'

declare global {
  interface Window {
    amber: {
      softwareGl: boolean
      onDaemonEvent: (cb: (d: unknown) => void) => void
      openPane: (session: string) => void
      createSession: (name: string, cwd: string, sessionKind: string) => void
      killSession: (name: string) => void
      renameSession: (from: string, to: string) => void
      suspendSession: (name: string) => void
      resumeSession: (name: string) => void
      dumpBacklog: (name: string) => void
      loadLayout: () => Promise<string | null>
      saveLayout: (text: string) => Promise<void>
      saveWorkspaceFile: (json: string, suggestedName: string) => Promise<boolean>
      openWorkspaceFile: () => Promise<string | null>
      homeDir: string
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
    }
  }
}

function toEvent(d: unknown): DaemonEvent | null {
  const f = (d as { frame?: { type: string; msg?: Record<string, unknown> } }).frame
  if (f?.type !== 'control' || !f.msg) return null
  const m = f.msg as { kind: string; [k: string]: unknown }
  if (m.kind === 'Sessions') return { kind: 'Sessions', sessions: m['sessions'] as never }
  if (m.kind === 'SessionsChanged') return { kind: 'SessionsChanged', added: m['added'] as never, removed: m['removed'] as never }
  if (m.kind === 'Activity') return { kind: 'Activity', name: m['name'] as string }
  if (m.kind === 'MemoryStat') return { kind: 'Memory', name: m['name'] as string, rssKb: (m['rss_kb'] as number) ?? 0, growing: (m['growing'] as boolean) ?? false }
  if (m.kind === 'Exit') return { kind: 'Exit', name: m['name'] as string, code: m['code'] as number }
  if (m.kind === 'Error') return { kind: 'Error', msg: m['msg'] as string }
  return null
}


const DEFAULT_FONT_SIZE = 13
// Slice 3: how long a claude pane stays frozen before the daemon kills its child
// to free RAM (resumed on unfreeze). A brief freeze/unfreeze pays nothing.
const SUSPEND_GRACE_MS = 30_000
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
  const [kind, setKind] = useState<'shell' | 'claude' | 'browser' | 'editor'>('shell')
  // Absolute working directory for newly created panes (default $HOME). Sent
  // verbatim so a session restores in the SAME folder — a relative '.' would
  // drift to the daemon's cwd ($HOME under systemd) on restart.
  const [cwd, setCwd] = useState<string>(() => window.amber?.homeDir ?? '/')
  const [connected, setConnected] = useState(true)
  const [showHelp, setShowHelp] = useState(false)
  // Workspace save/load UI. `saveScopeOpen` shows the one-vs-all scope dialog;
  // `loadDoc` (a parsed file) shows the new-vs-replace mode dialog; `notice` is a
  // local, dismissible info banner (parse errors, dump-timeout stragglers) kept
  // SEPARATE from the daemon-error banner (state.error) so neither hijacks the other.
  const [saveScopeOpen, setSaveScopeOpen] = useState(false)
  const [loadDoc, setLoadDoc] = useState<WorkspaceDoc | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
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
  const [claudeNames, setClaudeNames] = useState<Record<string, string>>({})
  const [picked, setPicked] = useState<Set<string>>(new Set())
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
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  // App-wide terminal font size lives in the layout sidecar (single source of
  // truth → auto-persists via the debounced save, no separate state to sync).
  const fontSize = clampFont(layout.fontSize ?? DEFAULT_FONT_SIZE)
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

  // Prune titles whose session the daemon removed (state.sessions is the
  // authoritative live set) — without this the map grows without bound in a
  // long-lived renderer as sessions come and go.
  const sessions = state.sessions
  useEffect(() => {
    setTitles((prev) => {
      const live = new Set(sessions.map((s) => s.name))
      // App-local panes (browser/editor) are NEVER in the daemon's session list,
      // so they must be exempt — otherwise the very next Sessions event deletes
      // the title they just reported (an editor's file name, a page's title) and
      // the header falls back to the cwd. Their own close path prunes them.
      const stale = Object.keys(prev).filter((n) =>
        !live.has(n) && !isBrowserName(n) && !isEditorName(n))
      if (stale.length === 0) return prev
      const next = { ...prev }
      for (const n of stale) delete next[n]
      return next
    })
  }, [sessions])

  useEffect(() => {
    if (!bridgeReady) return
    window.amber.onDaemonEvent((d) => {
      // Backlog replies are routed to the pending dump resolver by name (not
      // through the store reducer) — a save is waiting on collectDumps for them.
      const bf = (d as { frame?: { type?: string; msg?: { kind?: string; name?: string; msg?: string; data?: Uint8Array } } }).frame
      if (bf?.type === 'control' && bf.msg?.kind === 'Backlog' && typeof bf.msg.name === 'string') {
        const cb = dumpResolvers.current.get(bf.msg.name)
        if (cb) { dumpResolvers.current.delete(bf.msg.name); cb(bf.msg.data ?? new Uint8Array()) }
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
      else if (st === 'disconnected') setConnected(false)
      // The client utilityProcess was relaunched: its old pane ports are dead,
      // so ask every Pane to re-acquire from the new child.
      if ((d as { childRestart?: boolean }).childRestart) setChildEpoch((e) => e + 1)
      const ev = toEvent(d); if (ev) dispatch(ev)
      if (ev?.kind === 'Sessions') setSawSessions(true)
    })
    void window.amber.loadLayout().then((text) => {
      if (text) setLayout(parseLayout(text))
      setLoaded(true)
    })
  }, [bridgeReady])

  // Detect the disconnected -> connected edge and bump the reconnect epoch.
  useEffect(() => {
    if (connected && !prevConnected.current) setReconnectEpoch((e) => e + 1)
    prevConnected.current = connected
  }, [connected])

  // Debounced persist whenever the layout changes — only after the sidecar loaded.
  useEffect(() => {
    if (!bridgeReady || !loaded) return
    const id = setTimeout(() => void window.amber.saveLayout(serializeLayout(layoutRef.current)), 300)
    return () => clearTimeout(id)
  }, [layout, bridgeReady, loaded])

  const workspaces = mergeEditors(mergeBrowsers(groupSessions(state), layout.browsers ?? {}), layout.editors ?? {})
  const ws = workspaces.find((w) => w.ws === activeWs) ?? workspaces[0]
  const tabs = ws?.tabs ?? []
  const tab = tabs.find((t) => t.tab === activeTab) ?? tabs[0]
  const home = window.amber?.homeDir ?? ''
  const wsKey = String(ws?.ws ?? activeWs)
  const tabKey = String(tab?.tab ?? activeTab)
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
  const toggleZoom = (paneId: string): void => setZoom((z) => {
    if (z[zoomKey] === paneId) { const c = { ...z }; delete c[zoomKey]; return c }
    return { ...z, [zoomKey]: paneId }
  })
  const clearZoom = (): void => setZoom((z) => {
    if (!(zoomKey in z)) return z
    const c = { ...z }; delete c[zoomKey]; return c
  })
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

  const putTree = useCallback((next: Node | null) => {
    setLayout((l) => {
      const w = l.workspaces[wsKey] ?? { activeTab, tabs: {} }
      // Preserve any existing tab-level fields (e.g. `label`) — only the tree changes.
      const prev = w.tabs[tabKey]
      return { ...l, workspaces: { ...l.workspaces, [wsKey]: { ...w, tabs: { ...w.tabs, [tabKey]: { ...prev, tree: next } } } } }
    })
  }, [wsKey, tabKey, activeTab])

  // Persist a browser pane's current URL to the sidecar (fired on every webview
  // navigation). Preserves ws/tab/ord; no-ops on an unchanged URL so a stable
  // page never churns state or the debounced save. Stable identity so Browser's
  // event effect doesn't re-subscribe each render.
  const setBrowserUrl = useCallback((paneId: string, url: string): void => setLayout((l) => {
    const prev = l.browsers?.[paneId]
    if (!prev || prev.url === url) return l
    return { ...l, browsers: { ...(l.browsers ?? {}), [paneId]: { ...prev, url } } }
  }), [])

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

  // Slice 3 freeze grace: per-pane pending suspend timers + the set of sessions
  // currently suspended (child killed). Refs so scheduling never re-renders.
  // `sessionsRef` gives freezePane the live kind without a dep on state.sessions.
  const suspendTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const suspendedRef = useRef<Set<string>>(new Set())
  const sessionsRef = useRef(state.sessions)
  sessionsRef.current = state.sessions

  // Freeze/unfreeze a pane. The sidecar `frozen` map is display-only (rule #1/#3).
  // For a CLAUDE pane, freezing ALSO schedules a daemon suspend after the grace:
  // the daemon kills claude (frees RAM) and the supervisor resumes it on unfreeze.
  // An empty note is stored as `{}` (exactOptionalPropertyTypes) to keep it clean.
  const freezePane = useCallback((name: string, note: string): void => {
    setLayout((l) => {
      const n = note.trim()
      const next = { ...(l.frozen ?? {}), [name]: n ? { note: n } : {} }
      return { ...l, frozen: next }
    })
    const isClaude = sessionsRef.current.find((s) => s.name === name)?.kind === 'claude'
    if (isClaude && !suspendTimers.current.has(name)) {
      const t = setTimeout(() => {
        window.amber.suspendSession(name)
        suspendedRef.current.add(name)
        suspendTimers.current.delete(name)
      }, SUSPEND_GRACE_MS)
      suspendTimers.current.set(name, t)
    }
  }, [])
  const unfreezePane = useCallback((name: string): void => {
    setLayout((l) => {
      if (!l.frozen || !(name in l.frozen)) return l
      const next = { ...l.frozen }
      delete next[name]
      return { ...l, frozen: next }
    })
    // Cancel a pending suspend; if the child was already killed, resume it.
    const t = suspendTimers.current.get(name)
    if (t) { clearTimeout(t); suspendTimers.current.delete(name) }
    if (suspendedRef.current.has(name)) {
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
    if (visibleNames.length > 0) dispatch({ kind: 'MarkSeen', names: visibleNames })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey, state.seq])

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
            // Browser leaves are app-local (never a daemon session), so they must
            // survive the live-daemon filter — keep any browser id unconditionally.
            tabs[tabKey] = tl.tree
              ? { ...tl, tree: reconcile(tl.tree, leaves(tl.tree).filter((n) => liveForFix.has(n) || isBrowserName(n) || isEditorName(n))) }
              : tl
          }
          wsEntries[wsKey] = { ...wl, tabs }
        }
      }
      const next: LayoutFile = { ...l, workspaces: { ...l.workspaces, ...wsEntries } }
      if (Object.keys(plan.frozen).length) next.frozen = { ...(l.frozen ?? {}), ...plan.frozen }
      if (Object.keys(plan.browsers).length) next.browsers = { ...(l.browsers ?? {}), ...plan.browsers }
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

  // Esc dismisses the save-scope / load-mode dialogs.
  useEffect(() => {
    if (!saveScopeOpen && !loadDoc && !closeAsk && !killAsk && !sessionsOpen) return
    const h = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      setSaveScopeOpen(false); setLoadDoc(null); setCloseAsk(null)
      setKillAsk(null); setSessionsOpen(false)
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [saveScopeOpen, loadDoc, closeAsk, killAsk, sessionsOpen])

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

  const nextOrd = (tab?.panes.reduce((m, p) => Math.max(m, p.ord), -1) ?? -1) + 1
  const nextTab = (tabs.reduce((m, t) => Math.max(m, t.tab), 0)) + 1
  // The workspace/tab actually on screen — NOT the raw activeWs/activeTab state,
  // which goes stale when the selected ws/tab is closed and `ws`/`tab` fall back
  // to workspaces[0]. Creating relative to the stale state would resurrect the
  // dead workspace. Always create relative to what's displayed.
  const currentWs = ws?.ws ?? activeWs
  const currentTab = tab?.tab ?? activeTab
  // App-local browser pane: no daemon session. Write the sidecar entry and let
  // mergeBrowsers + deriveTab place it (reconcile appends it as a new leaf).
  // Returns the minted paneId so a split caller can position it with direction.
  const newBrowser = (tabId: number, ord: number): string => {
    const name = formatBrowserName({ ws: currentWs, tab: tabId, ord, id: makeId() })
    setLayout((l) => ({ ...l, browsers: { ...(l.browsers ?? {}), [name]: { ws: currentWs, tab: tabId, ord, url: '' } } }))
    return name
  }
  // App-local editor pane (spec 2026-07-19) — same class as a browser pane: no
  // daemon session, the sidecar entry IS the pane. Starts unsaved (path null).
  const newEditor = (tabId: number, ord: number): string => {
    const name = formatEditorName({ ws: currentWs, tab: tabId, ord, id: makeId() })
    setLayout((l) => ({ ...l, editors: { ...(l.editors ?? {}), [name]: { ws: currentWs, tab: tabId, ord, path: null } } }))
    return name
  }
  const newPane = (tabId: number, ord: number): void => {
    if (kind === 'browser') { newBrowser(tabId, ord); return }
    if (kind === 'editor') { newEditor(tabId, ord); return }
    window.amber.createSession(formatName({ ws: currentWs, tab: tabId, ord, id: makeId() }), cwd, kind)
  }
  // url-only view of the sidecar browsers map for SplitView (referentially stable
  // enough — a new object only when layout changes, which already re-renders).
  const browserUrls: Record<string, { url: string }> =
    Object.fromEntries(Object.entries(layout.browsers ?? {}).map(([k, v]) => [k, { url: v.url }]))
  // Same shape for editor panes: the sidecar entry IS the pane (path + per-pane
  // view state). SplitView feeds these straight to <Editor>.
  const editorEntries = layout.editors ?? EMPTY_EDITORS
  // Close a pane: browser panes are purged from the sidecar (mergeBrowsers then
  // drops them → reconcile prunes the leaf); daemon panes go through Kill (the
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
    if (isBrowserName(paneId)) {
      setTitles((t) => { if (!(paneId in t)) return t; const c = { ...t }; delete c[paneId]; return c })
      setLayout((l) => {
        if (!l.browsers?.[paneId]) return l
        const rest = { ...l.browsers }
        delete rest[paneId]
        return { ...l, browsers: rest }
      })
    } else if (isEditorName(paneId)) {
      dropEditorPane(paneId)
    } else setKillAsk([paneId]) // terminal pane — killing its session is not undoable
  }

  // Close every pane of a tab. App-local panes go immediately (their own guards
  // still apply); the terminal panes are confirmed ONCE for the whole tab —
  // routing each through closePane would stack a dialog per pane.
  const closeTabPanes = (panes: { name: string }[]): void => {
    const terminals: string[] = []
    for (const p of panes) {
      if (isBrowserName(p.name) || isEditorName(p.name)) closePane(p.name)
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
  // an optimistic local tree edit. A browser pane has no daemon session — its
  // grouping already lives in the sidecar, so it moves by an entry edit (id kept).
  const moveTo = (paneId: string, target: { ws: number } | { tab: number }): void => {
    const destWs = 'ws' in target ? target.ws : currentWs
    const destTabs = workspaces.find((w) => w.ws === destWs)?.tabs ?? []
    const destTab = 'tab' in target ? target.tab : (destTabs[0]?.tab ?? 1)
    const destPanes = destTabs.find((t) => t.tab === destTab)?.panes ?? []
    if (destPanes.some((p) => p.name === paneId)) return // already there — no-op
    const ord = destPanes.reduce((m, p) => Math.max(m, p.ord), -1) + 1
    if (isBrowserName(paneId)) {
      setLayout((l) => {
        const prev = l.browsers?.[paneId]
        if (!prev) return l
        return { ...l, browsers: { ...(l.browsers ?? {}), [paneId]: { ...prev, ws: destWs, tab: destTab, ord } } }
      })
    } else if (isEditorName(paneId)) {
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
  // first session at tab 1, ord 0 in the shown workspace. Shared by the toolbar
  // `+ Pane` button and the empty-state CTA.
  const startPane = (): void => {
    if (tab) newPane(tab.tab, nextOrd)
    else { newPane(1, 0); setActiveTab(1) }
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

  // Save: dump each target pane's scrollback (name-correlated, per-pane timeout),
  // assemble the file from live grouping + sidecar + dumps, write via native
  // dialog. Cancel anywhere → clean no-op. Uses layoutRef for the freshest sidecar.
  const doSave = async (scope: 'one' | 'all'): Promise<void> => {
    setSaveScopeOpen(false)
    const wsList = scope === 'one' ? workspaces.filter((w) => w.ws === currentWs) : workspaces
    // Browser panes have no daemon session, so no backlog to dump — exclude them
    // (a dumpBacklog for a non-session would just draw an Error reply).
    const names = wsList.flatMap((w) => w.tabs.flatMap((t) => t.panes.filter((p) => p.kind === 'shell' || p.kind === 'claude').map((p) => p.name)))
    const { dumps, stragglers } = await collectDumps(
      names,
      (n) => window.amber.dumpBacklog(n),
      (n, cb) => { dumpResolvers.current.set(n, cb) },
      (n) => { dumpResolvers.current.delete(n) },
    )
    const live: SaveWorkspace[] = wsList.map((w) => ({
      ws: w.ws,
      tabs: w.tabs.map((t) => ({ tab: t.tab, panes: t.panes.map((p) => ({
        name: p.name, cwd: p.cwd, kind: p.kind, ord: p.ord,
        ...(p.kind === 'browser' ? { url: layoutRef.current.browsers?.[p.name]?.url ?? '' } : {}),
        ...(p.kind === 'editor' ? { path: layoutRef.current.editors?.[p.name]?.path ?? null } : {}),
      })) })),
    }))
    const doc = assembleSave(scope, live, layoutRef.current, dumps)
    const base = scope === 'one'
      ? (layoutRef.current.workspaces[String(currentWs)]?.label ?? `workspace-${currentWs}`)
      : 'workspaces'
    const ok = await window.amber.saveWorkspaceFile(serializeWorkspaceFile(doc), `${base}.amberws`)
    if (ok && stragglers.length > 0) {
      setNotice(`Saved. Scrollback capture timed out for ${stragglers.length} pane(s) — saved with empty history for those.`)
    }
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
    setLoadDoc(doc)
  }

  // Load step 2: chosen mode. Replace kills the current workspace's panes first
  // (one-way — removal lands via daemon events); createSession per planned pane;
  // the pendingLoad effect commits the sidecar + replay once the daemon confirms.
  const applyLoad = (mode: 'new' | 'replace'): void => {
    const doc = loadDoc
    setLoadDoc(null)
    if (!doc) return
    const liveWs = workspaces.map((w) => w.ws)
    const killed: string[] = []
    if (mode === 'replace') {
      const cur = workspaces.find((w) => w.ws === currentWs)
      // Browser panes are purged from the sidecar (closePane); only real daemon
      // sessions are killed + gated on in pendingLoad.
      for (const t of cur?.tabs ?? []) for (const p of t.panes) {
        if (isBrowserName(p.name) || isEditorName(p.name)) closePane(p.name)
        else { window.amber.killSession(p.name); killed.push(p.name) }
      }
    }
    const plan = planLoad(doc, { mode, currentWs, liveWs, mintId: makeId })
    // Stage scrollback NOW, before the panes can mount. In replace mode reconcile
    // appends the new live sessions to the current tab as they arrive (during the
    // pending-load window, before commitLoad runs), mounting each Pane — and a
    // Pane's mount effect (child) runs before App's commit effect (parent), so
    // takeReplay must find its bytes already staged or the replay is lost.
    stageReplay(plan.scrollback)
    for (const c of plan.creates) window.amber.createSession(c.name, c.cwd, c.kind)
    setPendingLoad({ plan, createNames: plan.creates.map((c) => c.name), killed })
  }

  // Refresh the keyboard-chord dispatcher with this render's live closures.
  chordRef.current = (c) => {
    if (c?.type === 'new-tab') openTab()
    else if (c?.type === 'new-pane') startPane()
    else if (c?.type === 'prev-tab') stepTab(-1)
    else if (c?.type === 'next-tab') stepTab(1)
    else if (c?.type === 'help') setShowHelp(true)
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
  return (
    <div className="app">
      {!connected && <div className="banner" role="status" aria-live="polite"><span className="dot" />daemon disconnected — reconnecting…</div>}
      {state.error && (
        <div className="banner error-banner" role="alert">
          <span className="dot" />
          <span className="banner-msg">daemon error: {state.error}</span>
          <button className="banner-close" aria-label="dismiss error" title="dismiss" onClick={() => dispatch({ kind: 'ClearError' })}>✕</button>
        </div>
      )}
      {notice && (
        <div className="banner notice-banner" role="status" aria-live="polite">
          <span className="dot" />
          <span className="banner-msg">{notice}</span>
          <button className="banner-close" aria-label="dismiss notice" title="dismiss" onClick={() => setNotice(null)}>✕</button>
        </div>
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
        <button className="btn btn-ghost" data-drop-ws={nextWs}
          title="new workspace · drop a pane here to move it to a new workspace"
          onClick={() => {
            setActiveWs(nextWs)
            // App-local kinds mint a sidecar entry; only daemon kinds create a
            // session (an `editor`/`browser` kind sent to Create would be an
            // invalid session kind → daemon Error banner and no pane).
            if (kind === 'browser') {
              const name = formatBrowserName({ ws: nextWs, tab: 1, ord: 0, id: makeId() })
              setLayout((l) => ({ ...l, browsers: { ...(l.browsers ?? {}), [name]: { ws: nextWs, tab: 1, ord: 0, url: '' } } }))
            } else if (kind === 'editor') {
              const name = formatEditorName({ ws: nextWs, tab: 1, ord: 0, id: makeId() })
              setLayout((l) => ({ ...l, editors: { ...(l.editors ?? {}), [name]: { ws: nextWs, tab: 1, ord: 0, path: null } } }))
            } else window.amber.createSession(formatName({ ws: nextWs, tab: 1, ord: 0, id: makeId() }), cwd, kind)
            setActiveTab(1)
          }}>+ ws</button>
        <button className="icon-btn ws-io" aria-label="save workspace to file" title="Save workspace…"
          onClick={() => setSaveScopeOpen(true)}>💾</button>
        <button className="icon-btn ws-io" aria-label="load workspace from file" title="Load workspace…"
          onClick={() => void doLoad()}>📂</button>
        <button className="icon-btn ws-io" aria-label="manage daemon sessions" title="Sessions — see and kill every live amber session"
          onClick={() => setSessionsOpen(true)}>🧹</button>
        <div className="divider" />
        <span className="label">new</span>
        <select className="select" value={kind} onChange={(e) => setKind(e.target.value as 'shell' | 'claude' | 'browser' | 'editor')}>
          <option value="shell">shell</option>
          <option value="claude">claude</option>
          <option value="browser">browser</option>
          <option value="editor">editor</option>
        </select>
        <span className="label">in</span>
        <button className="btn cwd-chip" title={`${cwd} — click to choose folder`}
          onClick={() => void window.amber.pickFolder().then((p) => { if (p) setCwd(p) })}>
          📁 {shortCwd(cwd, window.amber.homeDir)}
        </button>
        <div className="spacer" />
        <button className="btn btn-accent" onClick={startPane}>+ Pane</button>
        <button className="icon-btn help-btn" aria-label="keyboard shortcuts"
          title={`Keyboard shortcuts (${chordLabel('help')})`} onClick={() => setShowHelp(true)}>?</button>
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
                      onClick={(e) => { e.stopPropagation(); closeTab() }}>✕</button>
                  </>}
            </div>
          )
        })}
        <button className="btn btn-ghost tab-add" data-drop-tab={nextTab}
          title="new tab · drop a pane here to move it to a new tab" onClick={openTab}>+ Tab</button>
      </div>
      <div className="pane-stage">
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
            ? <button className="empty-cta" onClick={startPane}>
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
                          epoch={reconnectEpoch} portEpoch={childEpoch}
                          fontSize={fontSize} onPaneTitle={onPaneTitle}
                          zoomedPane={isActive ? zoomedPane : null}
                          frozen={frozen}
                          onFreeze={freezePane}
                          onUnfreeze={unfreezePane}
                          onToggleZoom={toggleZoom}
                          onSetRatio={(path, r) => putTree(setRatio(layerTree, path, r))}
                          browsers={browserUrls}
                          onBrowserNav={setBrowserUrl}
                          editors={editorEntries}
                          onEditorPath={(id, path) => setEditorState(id, { path })}
                          onEditorViewState={setEditorState}
                          onEditorDirty={setEditorDirty}
                          onEditorReady={setEditorApi}
                          onSplit={(paneId, dir, overrideKind) => {
                            // App-local splits (browser/editor): no daemon round-trip, so place
                            // the leaf NOW with its requested direction (`pending` exists only
                            // to position a leaf once the DAEMON confirms its session).
                            const k = overrideKind ?? kind
                            if (k === 'browser' || k === 'editor') {
                              const name = k === 'browser' ? newBrowser(currentTab, nextOrd) : newEditor(currentTab, nextOrd)
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
                        ? <button className="empty-cta" onClick={startPane}>
                            <span className="empty-cta-title">Start a pane</span>
                            <span className="empty-cta-sub">{chordLabel('new-pane')}</span>
                          </button>
                        : null}
                  </div>
                )
              })}
      </div>
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
                <button className="icon-btn" aria-label="close" title="close" onClick={() => setCloseAsk(null)}>✕</button>
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
                <button className="icon-btn" aria-label="close" title="close" onClick={() => setKillAsk(null)}>✕</button>
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
                      <span className={'kind-dot ' + (p.kind === 'claude' ? 'claude' : 'shell')} title={p.kind} />
                      <span className="session-main">
                        <span className="session-name">{p.claudeName || p.cwd}</span>
                        <span className="session-sub">{p.name}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="dialog-actions">
                  <button className="btn danger-btn" autoFocus onClick={() => {
                    for (const n of killAsk) window.amber.killSession(n)
                    setKillAsk(null)
                    clearZoom()
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
        const rows = sessionRows(sessions, claudeNames)
        const toggle = (n: string): void =>
          setPicked((p) => { const c = new Set(p); if (!c.delete(n)) c.add(n); return c })
        return (
          <div className="help-overlay" onClick={() => setSessionsOpen(false)}>
            <div className="help-card dialog-card sessions-card" role="dialog" aria-modal="true" aria-label="Sessions"
              onClick={(e) => e.stopPropagation()}>
              <div className="help-head">
                <span className="help-title">Sessions ({rows.length})</span>
                <button className="icon-btn" aria-label="close" title="close" onClick={() => setSessionsOpen(false)}>✕</button>
              </div>
              <div className="dialog-body">
                <p className="dialog-text">
                  Every live amber session. These outlive the app on purpose — quitting never
                  kills them. Killing one ends its pty and everything running in it.
                </p>
                <ul className="session-list">
                  {rows.map((r) => (
                    <li key={r.name} className={'session-row' + (picked.has(r.name) ? ' picked' : '')}>
                      <input type="checkbox" checked={picked.has(r.name)}
                        aria-label={`select ${r.name}`} onChange={() => toggle(r.name)} />
                      <span className="session-slot">{r.slot ? `#${r.slot}` : '—'}</span>
                      <span className={'kind-dot ' + (r.kind === 'claude' ? 'claude' : 'shell')}
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
      {saveScopeOpen && (
        <div className="help-overlay" onClick={() => setSaveScopeOpen(false)}>
          <div className="help-card dialog-card" role="dialog" aria-modal="true" aria-label="Save workspace"
            onClick={(e) => e.stopPropagation()}>
            <div className="help-head">
              <span className="help-title">Save workspace</span>
              <button className="icon-btn" aria-label="close" title="close" onClick={() => setSaveScopeOpen(false)}>✕</button>
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
      {loadDoc && (() => {
        const cur = workspaces.find((w) => w.ws === currentWs)
        const paneCount = cur?.tabs.reduce((m, t) => m + t.panes.length, 0) ?? 0
        const wsCount = loadDoc.workspaces.length
        return (
          <div className="help-overlay" onClick={() => setLoadDoc(null)}>
            <div className="help-card dialog-card" role="dialog" aria-modal="true" aria-label="Load workspace"
              onClick={(e) => e.stopPropagation()}>
              <div className="help-head">
                <span className="help-title">Load workspace{wsCount > 1 ? ` (${wsCount} workspaces)` : ''}</span>
                <button className="icon-btn" aria-label="close" title="close" onClick={() => setLoadDoc(null)}>✕</button>
              </div>
              <div className="dialog-body">
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
      {showHelp && (
        <div className="help-overlay" onClick={() => setShowHelp(false)}>
          <div className="help-card" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"
            onClick={(e) => e.stopPropagation()}>
            <div className="help-head">
              <span className="help-title">Keyboard shortcuts</span>
              <button className="icon-btn" aria-label="close shortcuts" title="close"
                onClick={() => setShowHelp(false)}>✕</button>
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
