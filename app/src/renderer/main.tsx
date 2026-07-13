import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

declare global {
  interface Window { amber: { onDaemonEvent: (cb: (d: unknown) => void) => void } }
}

function App(): JSX.Element {
  const [events, setEvents] = useState<string[]>([])
  useEffect(() => {
    window.amber.onDaemonEvent((d) => setEvents((prev) => [...prev, JSON.stringify(d)]))
  }, [])
  return (
    <div>
      <h1>amber-ide</h1>
      <pre>{events.join('\n')}</pre>
    </div>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<StrictMode><App /></StrictMode>)
