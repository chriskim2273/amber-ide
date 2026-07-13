import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Pane } from './Pane'

declare global {
  interface Window {
    amber: {
      onDaemonEvent: (cb: (d: unknown) => void) => void
      openPane: (session: string) => void
    }
  }
}

interface Frame { type: string; msg?: { kind: string; sessions?: { name: string }[] } }

function App(): JSX.Element {
  const [session, setSession] = useState<string | null>(null)
  const bridgeReady = typeof window.amber?.onDaemonEvent === 'function'
  useEffect(() => {
    if (!bridgeReady) return
    window.amber.onDaemonEvent((d) => {
      const evt = d as { frame?: Frame }
      const f = evt.frame
      if (f?.type === 'control' && f.msg?.kind === 'Sessions') {
        const first = f.msg.sessions?.[0]
        if (first) setSession(first.name)
      }
    })
  }, [bridgeReady])
  if (!bridgeReady) {
    return <p style={{ color: 'crimson', fontFamily: 'monospace', padding: 16 }}>preload bridge missing (window.amber undefined) — the preload script failed to load.</p>
  }
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      {session ? <Pane session={session} /> : <p>waiting for a session… (create one: <code>amber create amber-1-1-0-a --kind shell</code>)</p>}
    </div>
  )
}

const root = document.getElementById('root')
// No StrictMode: its dev double-mount re-runs the pane effect, spawning
// duplicate MessagePorts/openPane calls that multiply keystrokes.
if (root) createRoot(root).render(<App />)
