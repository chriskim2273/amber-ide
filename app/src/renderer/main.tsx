import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SplitView } from './SplitView'
import { initialState, reduce, groupSessions, type DaemonEvent } from './store'
import { formatName, makeId } from '../shared/names'
import { splitLeaf, removeLeaf, setRatio, reconcile, leaves, type Node } from './layout'
import { emptyLayout, parseLayout, serializeLayout, type LayoutFile } from '../shared/layoutFile'

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

function App(): JSX.Element {
  const bridgeReady = typeof window.amber?.onDaemonEvent === 'function'
  const [state, dispatch] = useReducer(reduce, undefined, initialState)
  const [layout, setLayout] = useState<LayoutFile>(emptyLayout)
  const [activeTab, setActiveTab] = useState(1)
  const [activeWs, setActiveWs] = useState(1)
  const [kind, setKind] = useState<'shell' | 'claude'>('shell')
  const [connected, setConnected] = useState(true)
  // Gate ALL layout persistence until the sidecar has loaded. Otherwise a
  // Sessions event arriving before loadLayout resolves would reconcile against
  // an empty layout (equal-columns 'h' fallback) and overwrite the real,
  // possibly-vertical saved tree before we ever read it.
  const [loaded, setLoaded] = useState(false)
  // Bumped on each daemon reconnect (disconnected -> connected edge) so panes
  // can re-run their attach fixups (mouse-mode reset, TUI repaint nudge).
  const [reconnectEpoch, setReconnectEpoch] = useState(0)
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
      const ev = toEvent(d); if (ev) dispatch(ev)
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
  tab?.panes.forEach((p) => { if (p.deadCode !== null) deadCodes[p.name] = p.deadCode })

  // Reconcile the persisted tree for this tab with its live pane set. Pending
  // split targets are excluded until placed, so reconcile won't append them.
  const allLive = tab?.panes.map((p) => p.name) ?? []
  const liveIds = allLive.filter((n) => !(n in pending))
  const wsKey = String(ws?.ws ?? activeWs)
  const tabKey = String(tab?.tab ?? activeTab)
  const storedTree = layout.workspaces[wsKey]?.tabs[tabKey]?.tree ?? null
  const tree = reconcile(storedTree, liveIds)

  const putTree = useCallback((next: Node | null) => {
    setLayout((l) => {
      const w = l.workspaces[wsKey] ?? { activeTab, tabs: {} }
      return { ...l, workspaces: { ...l.workspaces, [wsKey]: { ...w, tabs: { ...w.tabs, [tabKey]: { tree: next } } } } }
    })
  }, [wsKey, tabKey, activeTab])

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
    window.amber.createSession(formatName({ ws: currentWs, tab: tabId, ord, id: makeId() }), '.', kind)

  const nextWs = (workspaces.reduce((m, w) => Math.max(m, w.ws), 0)) + 1

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: '#000', color: '#ddd' }}>
      {!connected && <div style={{ background: '#822', color: '#fff', padding: '4px 8px' }}>daemon disconnected — reconnecting…</div>}
      <div style={{ display: 'flex', gap: 4, padding: 4, background: '#111', alignItems: 'center' }}>
        <span>ws:</span>
        {workspaces.map((w) => (
          <button key={w.ws} onClick={() => setActiveWs(w.ws)} style={{ fontWeight: w.ws === (ws?.ws ?? -1) ? 'bold' : 'normal' }}>{w.ws}</button>
        ))}
        <button onClick={() => { setActiveWs(nextWs); window.amber.createSession(formatName({ ws: nextWs, tab: 1, ord: 0, id: makeId() }), '.', kind); setActiveTab(1) }}>+ ws</button>
        <span style={{ marginLeft: 12 }}>new:</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as 'shell' | 'claude')}>
          <option value="shell">shell</option>
          <option value="claude">claude</option>
        </select>
      </div>
      <div style={{ display: 'flex', gap: 4, padding: 4, background: '#222' }}>
        {tabs.map((t) => (
          <button key={t.tab} onClick={() => setActiveTab(t.tab)}
            style={{ fontWeight: t.tab === (tab?.tab ?? -1) ? 'bold' : 'normal' }}>tab {t.tab} ({t.panes.length})</button>
        ))}
        <button onClick={() => { newPane(nextTab, 0); setActiveTab(nextTab) }}>+ Tab</button>
        {tab && <button onClick={() => newPane(tab.tab, nextOrd)}>+ Pane</button>}
      </div>
      <div style={{ flex: 1, position: 'relative' }}>
        {tree
          ? <SplitView tree={tree} deadCodes={deadCodes} epoch={reconnectEpoch}
              onSetRatio={(path, r) => putTree(setRatio(tree, path, r))}
              onSplit={(paneId, dir) => {
                const name = formatName({ ws: currentWs, tab: currentTab, ord: nextOrd, id: makeId() })
                window.amber.createSession(name, '.', kind)
                setPending((p) => ({ ...p, [name]: { paneId, dir } }))
              }}
              onClose={(paneId) => { window.amber.killSession(paneId); putTree(removeLeaf(tree, paneId)) }} />
          : <p style={{ padding: 16 }}>No panes. Click “+ Pane”.</p>}
      </div>
    </div>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
