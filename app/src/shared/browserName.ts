// Pure browser-pane id grammar (mirrors names.ts for daemon sessions) + address
// normalization. No React — importable from renderer + shared + node test env.

const RE = /^browser-(\d+)-(\d+)-(\d+)-(.+)$/

export function formatBrowserName(p: { ws: number; tab: number; ord: number; id: string }): string {
  return `browser-${p.ws}-${p.tab}-${p.ord}-${p.id}`
}

export function parseBrowserName(name: string): { ws: number; tab: number; ord: number; id: string } | null {
  const m = RE.exec(name)
  if (!m) return null
  return { ws: Number(m[1]), tab: Number(m[2]), ord: Number(m[3]), id: m[4]! }
}

export function isBrowserName(name: string): boolean {
  return name.startsWith('browser-') && RE.test(name)
}

// Address-bar input → a loadable URL. Already-schemed passes through. A
// localhost/loopback host:port gets http; anything else URL-shaped gets https.
// Empty/whitespace → '' (the caller shows a blank webview). No search fallback.
export function normalizeUrl(input: string): string {
  const s = input.trim()
  if (s === '') return ''
  // Already schemed: either `scheme://…` (http/https/file/…) or an
  // authority-less scheme (about:/mailto:/data:/blob:). NOT matched by a bare
  // `host:port` like `localhost:3000` — that colon is a port, not a scheme.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(about|mailto|data|blob):/i.test(s)) return s
  const isLoopback = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(s)
  return (isLoopback ? 'http://' : 'https://') + s
}
