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

void (async (): Promise<void> => {
  await bootstrapAuth()
  // Install the shim BEFORE the renderer runs (main.tsx reads `window.amber`
  // synchronously — bridgeReady check, homeDir initializer).
  await import('./amber')
  await import('../renderer/main')
})()
