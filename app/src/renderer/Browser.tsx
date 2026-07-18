import { useEffect, useRef, useState } from 'react'
import type { AmberWebview } from './webview'
import { normalizeUrl } from '../shared/browserName'

export interface BrowserProps {
  paneId: string
  url: string
  active: boolean
  onNav: (paneId: string, url: string) => void
  onTitle: (paneId: string, title: string) => void
}

// One embedded web viewer (spec 2026-07-18). An Electron <webview> plus a slim
// address bar. App-local: no daemon session, no MessagePort — the parent owns
// the URL in the layout sidecar and feeds it back via `url`.
export function Browser({ paneId, url, active, onNav, onTitle }: BrowserProps): JSX.Element {
  const ref = useRef<AmberWebview | null>(null)
  // The src is captured ONCE at mount. Live navigation goes through loadURL, and
  // did-navigate feeds the new URL back to the sidecar (→ the `url` prop). If src
  // tracked that prop, every persisted nav would reload the page — a loop. A
  // workspace-load mints a fresh paneId, so a new URL remounts naturally.
  const initialSrc = useRef(url)
  const [addr, setAddr] = useState(url)

  useEffect(() => {
    const wv = ref.current
    if (!wv) return
    const onNavigate = (e: Event): void => {
      const u = (e as unknown as { url: string }).url
      setAddr(u)
      onNav(paneId, u)
    }
    const onTitleUpdated = (e: Event): void => onTitle(paneId, (e as unknown as { title: string }).title)
    // Popups (target=_blank / window.open) → system browser, never a new webview.
    const onNewWindow = (e: Event): void => window.amber.openExternal((e as unknown as { url: string }).url)
    wv.addEventListener('did-navigate', onNavigate)
    wv.addEventListener('did-navigate-in-page', onNavigate)
    wv.addEventListener('page-title-updated', onTitleUpdated)
    wv.addEventListener('new-window', onNewWindow)
    return () => {
      wv.removeEventListener('did-navigate', onNavigate)
      wv.removeEventListener('did-navigate-in-page', onNavigate)
      wv.removeEventListener('page-title-updated', onTitleUpdated)
      wv.removeEventListener('new-window', onNewWindow)
    }
  }, [paneId, onNav, onTitle])

  // Focus the webview when its tab/pane becomes active so keystrokes land there.
  useEffect(() => {
    if (active) ref.current?.focus()
  }, [active])

  const go = (): void => {
    const next = normalizeUrl(addr)
    if (next === '') return
    setAddr(next)
    ref.current?.loadURL(next).catch(() => { /* bad URL / offline — webview shows its own error page */ })
    onNav(paneId, next)
  }

  return (
    <div className="browser-pane" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="browser-bar">
        <button className="icon-btn" aria-label="back" title="back" onClick={() => ref.current?.goBack()}>‹</button>
        <button className="icon-btn" aria-label="forward" title="forward" onClick={() => ref.current?.goForward()}>›</button>
        <button className="icon-btn" aria-label="reload" title="reload" onClick={() => ref.current?.reload()}>⟳</button>
        <input
          className="browser-addr"
          value={addr}
          placeholder="localhost:3000 or example.com"
          aria-label="address"
          onChange={(e) => setAddr(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); go() } }}
        />
      </div>
      <webview
        ref={ref as unknown as React.Ref<AmberWebview>}
        src={initialSrc.current || 'about:blank'}
        partition="persist:amber-browser"
        style={{ flex: 1, width: '100%', border: 'none' }}
      />
    </div>
  )
}
