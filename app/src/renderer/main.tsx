import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

function App(): JSX.Element {
  return <h1>amber-ide</h1>
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<StrictMode><App /></StrictMode>)
