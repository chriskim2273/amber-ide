import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SplitView, type PaneMeta } from './SplitView'
import { initialState, reduce, groupSessions, type DaemonEvent } from './store'
import { formatName, makeId } from '../shared/names'
import { splitLeaf, setRatio, reconcile, leaves, moveLeaf, type Node } from './layout'
import { emptyLayout, parseLayout, serializeLayout, orderTabs, moveTab, type LayoutFile } from '../shared/layoutFile'
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
      loadLayout: () => Promise<string | null>
      saveLayout: (text: string) => Promise<void>
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
  if (m.kind === 'Exit') return { kind: 'Exit', name: m['name'] as string, code: m['code'] as number }
  if (m.kind === 'Error') return { kind: 'Error', msg: m['msg'] as string }
  return null
}

function shortCwd(cwd: string, home: string): string {
  return home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd
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
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  useEffect(() => {
    if (!bridgeReady) return
    window.amber.onDaemonEvent((d) => {
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
    paneMeta[p.name] = { kind: p.kind, title: `${shortCwd(p.cwd, home)} · ${p.kind}` }
  })

  // Reconcile the persisted tree for this tab with its live pane set. Pending
  // split targets are excluded until placed, so reconcile won't append them.
  const allLive = tab?.panes.map((p) => p.name) ?? []
  const liveIds = allLive.filter((n) => !(n in pending))
  const wsKey = String(ws?.ws ?? activeWs)
  const tabKey = String(tab?.tab ?? activeTab)
  const storedTree = layout.workspaces[wsKey]?.tabs[tabKey]?.tree ?? null
  const tree = reconcile(storedTree, liveIds)

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

  useEffect(() => {
    if (!loaded) return
    if (tree && JSON.stringify(tree) !== JSON.stringify(storedTree)) putTree(tree)
  }, [tree, storedTree, putTree, loaded])

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

  // App-owned keyboard chords (new tab / new pane / switch tab). The 'close'
  // chord is handled in SplitView (it needs the focused-pane identity). This
  // effect registers once; the latest action closures live in a ref, refreshed
  // every render below, so the handler never goes stale without re-binding.
  const chordRef = useRef<(c: ReturnType<typeof appChord>) => void>(() => {})
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      const c = appChord(e)
      if (!c || c.type === 'close') return
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
  // Refresh the keyboard-chord dispatcher with this render's live closures.
  chordRef.current = (c) => {
    if (c?.type === 'new-tab') openTab()
    else if (c?.type === 'new-pane') startPane()
    else if (c?.type === 'prev-tab') stepTab(-1)
    else if (c?.type === 'next-tab') stepTab(1)
    else if (c?.type === 'help') setShowHelp(true)
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
          const hasClaude = t.panes.some((p) => p.kind === 'claude')
          const isActive = t.tab === (tab?.tab ?? -1)
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
              <span className={'kind-dot ' + (hasClaude ? 'claude' : 'shell')} />
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
                onSetRatio={(path, r) => putTree(setRatio(tree, path, r))}
                onSplit={(paneId, dir) => {
                  const name = formatName({ ws: currentWs, tab: currentTab, ord: nextOrd, id: makeId() })
                  window.amber.createSession(name, cwd, kind)
                  setPending((p) => ({ ...p, [name]: { paneId, dir } }))
                }}
                onMove={(s, t, z) => putTree(moveLeaf(tree, s, t, z))}
                onClose={(paneId) => window.amber.killSession(paneId)} />
            : <button className="empty-cta" onClick={startPane}>
                <span className="empty-cta-title">Start a pane</span>
                <span className="empty-cta-sub">{chordLabel('new-pane')}</span>
              </button>}
      </div>
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
