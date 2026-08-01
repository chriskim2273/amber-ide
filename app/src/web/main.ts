import './desktop-only.css'

// Web build entry point.
//
// Auth bootstrap (mirrors `crates/amber/assets/app.js`'s `boot()` — the
// hand-written mobile UI already solved this, so it's copied rather than
// reinvented): the URL fragment carries the one-time token (never sent to the
// server automatically — that's the point of using the fragment), so this
// POSTs it to `/api/auth` to trade it for the `HttpOnly; SameSite=Strict`
// cookie, then scrubs it from the URL bar/history before rendering anything.
async function bootstrapAuth(): Promise<void> {
  const m = /[#&]t=([^&]+)/.exec(location.hash || '')
  if (m) {
    const token = m[1] ?? ''
    try {
      await fetch('/api/auth', { method: 'POST', body: decodeURIComponent(token), credentials: 'same-origin' })
    } catch {
      // fall through — the shim's WS will show 'disconnected' either way
    }
    history.replaceState(null, '', location.pathname + location.search)
  }
}

// `homeDir` (spec §3 "Env" row) must be a real value BEFORE `window.amber` is
// installed: `main.tsx` reads it via `useState(() => window.amber?.homeDir ??
// '/')`, a lazy initializer that runs exactly ONCE — patching it in after the
// fact would permanently stick every pane's default cwd at whatever
// placeholder was there first, and `map_browser_msg`'s `Path::new(cwd)
// .is_dir()` check would then happily create sessions rooted at it.
async function fetchBootstrap(): Promise<{ home: string }> {
  try {
    const r = await fetch('/api/bootstrap', { credentials: 'same-origin' })
    if (!r.ok) return { home: '/' }
    return (await r.json()) as { home: string }
  } catch {
    return { home: '/' }
  }
}

void (async (): Promise<void> => {
  await bootstrapAuth()
  const boot = await fetchBootstrap()
  // Install the shim BEFORE the renderer runs (main.tsx reads `window.amber`
  // synchronously — bridgeReady check, homeDir initializer).
  const { installAmber } = await import('./install')
  installAmber(boot.home)
  await import('../renderer/main')
})()
