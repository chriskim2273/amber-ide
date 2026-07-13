import { useEffect, useReducer, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Pane } from './Pane'
import { initialState, reduce, groupSessions, type DaemonEvent } from './store'
import { formatName, makeId } from '../shared/names'

declare global {
  interface Window {
    amber: {
      onDaemonEvent: (cb: (d: unknown) => void) => void
      openPane: (session: string) => void
      createSession: (name: string, cwd: string, sessionKind: string) => void
      killSession: (name: string) => void
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
  const [activeTab, setActiveTab] = useState(1)
  const cwd = '.' // daemon resolves; real cwd picker is later
  useEffect(() => {
    if (!bridgeReady) return
    window.amber.onDaemonEvent((d) => { const ev = toEvent(d); if (ev) dispatch(ev) })
  }, [bridgeReady])
  if (!bridgeReady) return <p style={{ color: 'crimson', padding: 16 }}>preload bridge missing.</p>

  const ws = groupSessions(state)[0] // single workspace for slice 4 (ws=1)
  const tabs = ws?.tabs ?? []
  const tab = tabs.find((t) => t.tab === activeTab) ?? tabs[0]
  const nextOrd = (tab?.panes.reduce((m, p) => Math.max(m, p.ord), -1) ?? -1) + 1
  const nextTab = (tabs.reduce((m, t) => Math.max(m, t.tab), 0)) + 1

  const newPane = (tabId: number, ord: number): void =>
    window.amber.createSession(formatName({ ws: 1, tab: tabId, ord, id: makeId() }), cwd, 'shell')

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', gap: 4, padding: 4, background: '#222' }}>
        {tabs.map((t) => (
          <button key={t.tab} onClick={() => setActiveTab(t.tab)}
            style={{ fontWeight: t.tab === (tab?.tab ?? -1) ? 'bold' : 'normal' }}>
            tab {t.tab} ({t.panes.length})
          </button>
        ))}
        <button onClick={() => { newPane(nextTab, 0); setActiveTab(nextTab) }}>+ Tab</button>
        {tab && <button onClick={() => newPane(tab.tab, nextOrd)}>+ Pane</button>}
      </div>
      <div style={{ flex: 1, display: 'flex', position: 'relative' }}>
        {tab?.panes.map((p) => (
          <div key={p.name} style={{ flex: 1, position: 'relative', borderLeft: '1px solid #333' }}>
            <button onClick={() => window.amber.killSession(p.name)}
              style={{ position: 'absolute', top: 2, right: 2, zIndex: 1 }}>×</button>
            {p.deadCode !== null && <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.6)', color: '#fff', zIndex: 2, padding: 8 }}>exited {p.deadCode}</div>}
            <Pane session={p.name} />
          </div>
        ))}
        {!tab && <p style={{ padding: 16 }}>No panes. Click “+ Pane”.</p>}
      </div>
    </div>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
