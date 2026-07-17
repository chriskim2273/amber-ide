import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SplitView, type PaneMeta } from './SplitView'
import { initialState, reduce, groupSessions, tabDot, hasActivity, type DaemonEvent } from './store'
import { formatName, makeId } from '../shared/names'
import { splitLeaf, setRatio, reconcile, leaves, moveLeaf, type Node } from './layout'
import { emptyLayout, parseLayout, serializeLayout, orderTabs, moveTab, type LayoutFile, type TabLayout } from '../shared/layoutFile'
import {
  parseWorkspaceFile, serializeWorkspaceFile, assembleSave, planLoad,
  type WorkspaceDoc, type SaveWorkspace, type LoadPlan,
} from '../shared/workspaceFile'
import { collectDumps } from './dumps'
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
      dumpBacklog: (name: string) => void
      loadLayout: () => Promise<string | null>
      saveLayout: (text: string) => Promise<void>
      saveWorkspaceFile: (json: string, suggestedName: string) => Promise<boolean>
      openWorkspaceFile: () => Promise<string | null>
      homeDir: string
      pickFolder: () => Promise<string | null>
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
  if (m.kind === 'Exit') return { kind: 'Exit', name: m['name'] as string, code: m['code'] as number }
  if (m.kind === 'Error') return { kind: 'Error', msg: m['msg'] as string }
  return null
}

function shortCwd(cwd: string, home: string): string {
  return home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd
}

const DEFAULT_FONT_SIZE = 13
// Stable empty frozen map so `layout.frozen ?? EMPTY_FROZEN` doesn't mint a new
// object every render (keeps SplitView's `frozen` prop referentially stable).
const EMPTY_FROZEN: Record<string, { note?: string }> = {}
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
  const [kind, setKind] = useState<'shell' | 'claude'>('shell')
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
      const stale = Object.keys(prev).filter((n) => !live.has(n))
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
      const bf = (d as { frame?: { type?: string; msg?: { kind?: string; name?: string; data?: Uint8Array } } }).frame
      if (bf?.type === 'control' && bf.msg?.kind === 'Backlog' && typeof bf.msg.name === 'string') {
        const cb = dumpResolvers.current.get(bf.msg.name)
        if (cb) { dumpResolvers.current.delete(bf.msg.name); cb(bf.msg.data ?? new Uint8Array()) }
        return
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

  const workspaces = groupSessions(state)
  const ws = workspaces.find((w) => w.ws === activeWs) ?? workspaces[0]
  const tabs = ws?.tabs ?? []
  const tab = tabs.find((t) => t.tab === activeTab) ?? tabs[0]
  const deadCodes: Record<string, number> = {}
  const paneMeta: Record<string, PaneMeta> = {}
  const home = window.amber?.homeDir ?? ''
  tab?.panes.forEach((p) => {
    if (p.deadCode !== null) deadCodes[p.name] = p.deadCode
    // Prefer a live OSC title (e.g. shell/program-set) over the cwd; else cwd.
    // Whitespace-only titles (some prompts emit blank OSC 2) fall back to cwd.
    const osc = titles[p.name]
    const lead = osc && osc.trim().length > 0 ? osc : shortCwd(p.cwd, home)
    // A claude pane that fell back to a shell (supervisor gave up / user quit)
    // is labelled as such instead of "claude"; otherwise the suffix is the kind.
    const suffix = p.runState === 'shell-fallback' ? 'shell (claude exited)' : p.kind
    // Raw absolute cwd (not shortCwd) so the context-menu "copy cwd" yields a
    // path that actually resolves when pasted.
    paneMeta[p.name] = { kind: p.kind, title: `${lead} · ${suffix}`, cwd: p.cwd, runState: p.runState }
  })

  // Reconcile the persisted tree for this tab with its live pane set. Pending
  // split targets are excluded until placed, so reconcile won't append them.
  const allLive = tab?.panes.map((p) => p.name) ?? []
  const liveIds = allLive.filter((n) => !(n in pending))
  const wsKey = String(ws?.ws ?? activeWs)
  const tabKey = String(tab?.tab ?? activeTab)
  const storedTree = layout.workspaces[wsKey]?.tabs[tabKey]?.tree ?? null
  const tree = reconcile(storedTree, liveIds)

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

  // Freeze/unfreeze a pane (display-only; daemon untouched — rule #1/#3). An
  // empty note is stored as `{}` (omit the key) to satisfy
  // exactOptionalPropertyTypes and keep the sidecar clean.
  const freezePane = useCallback((name: string, note: string): void => setLayout((l) => {
    const n = note.trim()
    const next = { ...(l.frozen ?? {}), [name]: n ? { note: n } : {} }
    return { ...l, frozen: next }
  }), [])
  const unfreezePane = useCallback((name: string): void => setLayout((l) => {
    if (!l.frozen || !(name in l.frozen)) return l
    const next = { ...l.frozen }
    delete next[name]
    return { ...l, frozen: next }
  }), [])

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
            tabs[tabKey] = tl.tree
              ? { ...tl, tree: reconcile(tl.tree, leaves(tl.tree).filter((n) => liveForFix.has(n))) }
              : tl
          }
          wsEntries[wsKey] = { ...wl, tabs }
        }
      }
      const next: LayoutFile = { ...l, workspaces: { ...l.workspaces, ...wsEntries } }
      if (Object.keys(plan.frozen).length) next.frozen = { ...(l.frozen ?? {}), ...plan.frozen }
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
      // `close`, `zoom`, and `freeze` all need the focused-pane identity — SplitView owns them.
      if (!c || c.type === 'close' || c.type === 'zoom' || c.type === 'freeze') return
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
    if (!saveScopeOpen && !loadDoc) return
    const h = (e: KeyboardEvent): void => { if (e.key === 'Escape') { setSaveScopeOpen(false); setLoadDoc(null) } }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [saveScopeOpen, loadDoc])

  if (!bridgeReady) return <p style={{ color: 'crimson', padding: 16 }}>preload bridge missing.</p>

  const nextOrd = (tab?.panes.reduce((m, p) => Math.max(m, p.ord), -1) ?? -1) + 1
  const nextTab = (tabs.reduce((m, t) => Math.max(m, t.tab), 0)) + 1
  // The workspace/tab actually on screen — NOT the raw activeWs/activeTab state,
  // which goes stale when the selected ws/tab is closed and `ws`/`tab` fall back
  // to workspaces[0]. Creating relative to the stale state would resurrect the
  // dead workspace. Always create relative to what's displayed.
  const currentWs = ws?.ws ?? activeWs
  const currentTab = tab?.tab ?? activeTab
  const newPane = (tabId: number, ord: number): void =>
    window.amber.createSession(formatName({ ws: currentWs, tab: tabId, ord, id: makeId() }), cwd, kind)

  const nextWs = (workspaces.reduce((m, w) => Math.max(m, w.ws), 0)) + 1

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
    const names = wsList.flatMap((w) => w.tabs.flatMap((t) => t.panes.map((p) => p.name)))
    const { dumps, stragglers } = await collectDumps(
      names,
      (n) => window.amber.dumpBacklog(n),
      (n, cb) => { dumpResolvers.current.set(n, cb) },
      (n) => { dumpResolvers.current.delete(n) },
    )
    const live: SaveWorkspace[] = wsList.map((w) => ({
      ws: w.ws,
      tabs: w.tabs.map((t) => ({ tab: t.tab, panes: t.panes.map((p) => ({ name: p.name, cwd: p.cwd, kind: p.kind, ord: p.ord })) })),
    }))
    const doc = assembleSave(scope, live, layoutRef.current, dumps)
    const base = scope === 'one'
      ? (layout.workspaces[String(currentWs)]?.label ?? `workspace-${currentWs}`)
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
      for (const t of cur?.tabs ?? []) for (const p of t.panes) { window.amber.killSession(p.name); killed.push(p.name) }
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
              aria-label={`workspace ${wsLabel ?? w.ws}`} title="double-click to rename"
              onClick={() => setActiveWs(w.ws)}
              onDoubleClick={() => setEditing({ kind: 'ws', id: w.ws })}>{wsLabel ?? w.ws}</button>
          )
        })}
        <button className="btn btn-ghost"
          onClick={() => { setActiveWs(nextWs); window.amber.createSession(formatName({ ws: nextWs, tab: 1, ord: 0, id: makeId() }), cwd, kind); setActiveTab(1) }}>+ ws</button>
        <button className="icon-btn ws-io" aria-label="save workspace to file" title="Save workspace…"
          onClick={() => setSaveScopeOpen(true)}>💾</button>
        <button className="icon-btn ws-io" aria-label="load workspace from file" title="Load workspace…"
          onClick={() => void doLoad()}>📂</button>
        <div className="divider" />
        <span className="label">new</span>
        <select className="select" value={kind} onChange={(e) => setKind(e.target.value as 'shell' | 'claude')}>
          <option value="shell">shell</option>
          <option value="claude">claude</option>
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
          const closeTab = (): void => t.panes.forEach((p) => window.amber.killSession(p.name))
          return (
            <div key={t.tab} role="tab" aria-selected={isActive} tabIndex={0}
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
        <button className="btn btn-ghost tab-add" onClick={openTab}>+ Tab</button>
      </div>
      <div className="pane-stage">
        {!(loaded && sawSessions)
          ? <div className="stage-loading">connecting to daemon…</div>
          : tree
            ? <SplitView tree={tree} deadCodes={deadCodes} meta={paneMeta} epoch={reconnectEpoch} portEpoch={childEpoch}
                fontSize={fontSize} onPaneTitle={onPaneTitle}
                zoomedPane={zoomedPane}
                frozen={frozen}
                onFreeze={freezePane}
                onUnfreeze={unfreezePane}
                onToggleZoom={toggleZoom}
                onSetRatio={(path, r) => putTree(setRatio(tree, path, r))}
                onSplit={(paneId, dir, overrideKind) => {
                  const name = formatName({ ws: currentWs, tab: currentTab, ord: nextOrd, id: makeId() })
                  window.amber.createSession(name, cwd, overrideKind ?? kind)
                  setPending((p) => ({ ...p, [name]: { paneId, dir } }))
                  clearZoom()
                }}
                onMove={(s, t, z) => { putTree(moveLeaf(tree, s, t, z)); clearZoom() }}
                onClose={(paneId) => { window.amber.killSession(paneId); clearZoom() }} />
            : <button className="empty-cta" onClick={startPane}>
                <span className="empty-cta-title">Start a pane</span>
                <span className="empty-cta-sub">{chordLabel('new-pane')}</span>
              </button>}
      </div>
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
