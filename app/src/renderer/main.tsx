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
  // Splits whose session was requested but hasn't materialized yet. Held out of
  // reconcile so it can't prune/re-append them as columns; placed with the
  // requested direction once the daemon confirms the session exists.
  const [pending, setPending] = useState<Record<string, { paneId: string; dir: 'h' | 'v' }>>({})
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  useEffect(() => {
    if (!bridgeReady) return
    window.amber.onDaemonEvent((d) => { const ev = toEvent(d); if (ev) dispatch(ev) })
    void window.amber.loadLayout().then((text) => { if (text) setLayout(parseLayout(text)) })
  }, [bridgeReady])

  // Debounced persist whenever the layout changes.
  useEffect(() => {
    if (!bridgeReady) return
    const id = setTimeout(() => void window.amber.saveLayout(serializeLayout(layoutRef.current)), 300)
    return () => clearTimeout(id)
  }, [layout, bridgeReady])

  const ws = groupSessions(state)[0]
  const tabs = ws?.tabs ?? []
  const tab = tabs.find((t) => t.tab === activeTab) ?? tabs[0]
  const deadCodes: Record<string, number> = {}
  tab?.panes.forEach((p) => { if (p.deadCode !== null) deadCodes[p.name] = p.deadCode })

  // Reconcile the persisted tree for this tab with its live pane set. Pending
  // split targets are excluded until placed, so reconcile won't append them.
  const allLive = tab?.panes.map((p) => p.name) ?? []
  const liveIds = allLive.filter((n) => !(n in pending))
  const wsKey = String(ws?.ws ?? 1)
  const tabKey = String(tab?.tab ?? activeTab)
  const storedTree = layout.workspaces[wsKey]?.tabs[tabKey]?.tree ?? null
  const tree = reconcile(storedTree, liveIds)

  const putTree = useCallback((next: Node | null) => {
    setLayout((l) => {
      const w = l.workspaces[wsKey] ?? { activeTab, tabs: {} }
      return { ...l, workspaces: { ...l.workspaces, [wsKey]: { ...w, tabs: { ...w.tabs, [tabKey]: { tree: next } } } } }
    })
  }, [wsKey, tabKey, activeTab])

  useEffect(() => { if (tree && JSON.stringify(tree) !== JSON.stringify(storedTree)) putTree(tree) }, [tree, storedTree, putTree])

  // Place pending splits once their session exists, preserving H/V direction.
  const liveKey = allLive.join(',')
  useEffect(() => {
    const ready = Object.entries(pending).filter(([name]) => allLive.includes(name))
    if (ready.length === 0) return
    let next = reconcile(storedTree, liveIds)
    for (const [name, { paneId, dir }] of ready) {
      next = next ? splitLeaf(next, paneId, dir, name) : { kind: 'leaf', paneId: name }
    }
    putTree(next)
    setPending((p) => { const c = { ...p }; for (const [n] of ready) delete c[n]; return c })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, liveKey, storedTree, putTree])

  if (!bridgeReady) return <p style={{ color: 'crimson', padding: 16 }}>preload bridge missing.</p>

  const nextOrd = (tab?.panes.reduce((m, p) => Math.max(m, p.ord), -1) ?? -1) + 1
  const nextTab = (tabs.reduce((m, t) => Math.max(m, t.tab), 0)) + 1
  const newPane = (tabId: number, ord: number): void =>
    window.amber.createSession(formatName({ ws: 1, tab: tabId, ord, id: makeId() }), '.', 'shell')

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
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
          ? <SplitView tree={tree} deadCodes={deadCodes}
              onSetRatio={(path, r) => putTree(setRatio(tree, path, r))}
              onSplit={(paneId, dir) => {
                const name = formatName({ ws: 1, tab: tab!.tab, ord: nextOrd, id: makeId() })
                window.amber.createSession(name, '.', 'shell')
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
