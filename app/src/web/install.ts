// Real-DOM glue for `amber.ts`'s pure `createAmber`: the only place in the
// web build that touches `WebSocket`, `MessageChannel`, `window.postMessage`
// or `navigator.clipboard`. Never imported by a test — `amber.test.ts` tests
// `createAmber` directly against fakes.

import { createAmber, type SocketLike, type PortLike, type RouterApi } from './amber'
import type { LoadLayoutResult, SaveLayoutResult, LayoutVersion } from '../shared/layoutFile'
import { slotFromWire, type RouterSlot } from '../shared/routerStatus'

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws`
}

function connectSocket(): SocketLike {
  const ws = new WebSocket(wsUrl())
  ws.binaryType = 'arraybuffer'
  // Structurally compatible (send/close/readyState/on*) modulo `send`'s wider
  // real signature — a thin cast here keeps `amber.ts` itself DOM-free.
  return ws as unknown as SocketLike
}

// `softwareGl` (spec §3 "Env" row) tells `Pane.tsx` whether to skip xterm's
// WebGL addon. Forced `true` (DOM renderer) rather than probed for real GPU
// support: `Pane.tsx` creates ONE WebGL context per open pane, and browsers
// cap concurrent live contexts (~16 in Chrome, oldest silently evicted past
// the cap) — a busy workspace would repeatedly hit Pane's context-loss/
// DOM-fallback path, and this pivot has never live-verified WebGL contention
// across many simultaneously open panes (the spike ran headless/CDP with
// `softwareGl` hardcoded `true` too, for the same untested-path reason). The
// DOM renderer is correctness-neutral — the spike's own finding — so it's
// the safe default. Flip this to a real `canvas.getContext('webgl')` probe
// once a live-GUI pass has exercised that contention deliberately.
function probeSoftwareGl(): boolean {
  return true
}

// Layout CAS (spec §6): thin `fetch` wrappers over `/api/layout` — the same
// cookie-gated route family as `/api/sessions`/`/api/bootstrap`. `amber.ts`
// stays fetch-free; `main.tsx`'s persist effect does the actual CAS retry/
// merge and only needs these two calls to behave like the Electron preload's
// `ipcRenderer.invoke('layout-load'/'layout-save', …)`.
async function layoutGet(): Promise<LoadLayoutResult> {
  try {
    const r = await fetch('/api/layout', { credentials: 'same-origin' })
    if (!r.ok) return { text: null, version: null }
    const body = (await r.json()) as Partial<LoadLayoutResult>
    return { text: body.text ?? null, version: body.version ?? null }
  } catch {
    return { text: null, version: null }
  }
}

function routerApi(): RouterApi {
  return {
    status: async () => {
      const r = await fetch('/api/router/status', { credentials: 'same-origin' })
      return r.text()
    },
    action: async (action) => {
      try {
        const r = await fetch('/api/router/action', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action }),
        })
        const body = (await r.json().catch(() => null)) as { ok?: boolean; error?: string } | null
        if (r.ok && body?.ok) return { ok: true }
        return { ok: false, error: body?.error ?? `HTTP ${r.status}` }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
    slots: async () => {
      try {
        const r = await fetch('/api/router/slots', { credentials: 'same-origin' })
        const body = (await r.json().catch(() => null)) as
          | { ok?: boolean; error?: string; slots?: Record<string, unknown>[] }
          | null
        const raw = Array.isArray(body?.slots) ? body.slots : []
        const slots: RouterSlot[] = raw.map(slotFromWire)
        if (!r.ok) return { ok: false, error: body?.error ?? `HTTP ${r.status}`, slots }
        return { ok: true, slots }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e), slots: [] }
      }
    },
    saveSlots: async (slots) => {
      try {
        const r = await fetch('/api/router/slots', {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ slots }),
        })
        const body = (await r.json().catch(() => null)) as { ok?: boolean; error?: string } | null
        if (r.ok) return { ok: true }
        return { ok: false, error: body?.error ?? `HTTP ${r.status}` }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
    revealKey: async (name) => {
      if (!name) return ''
      try {
        const r = await fetch(`/api/router/key?name=${encodeURIComponent(name)}`, {
          credentials: 'same-origin',
        })
        if (!r.ok) return ''
        const body = (await r.json().catch(() => null)) as { api_key?: string } | null
        return typeof body?.api_key === 'string' ? body.api_key : ''
      } catch {
        return ''
      }
    },
    logTail: async () => {
      try {
        const r = await fetch('/api/router/log', { credentials: 'same-origin' })
        return r.ok ? r.text() : ''
      } catch {
        return ''
      }
    },
  }
}

async function layoutSave(text: string, version: LayoutVersion): Promise<SaveLayoutResult> {
  try {
    const r = await fetch('/api/layout', {
      method: 'POST',
      credentials: 'same-origin',
      body: JSON.stringify({ text, version }),
    })
    const body = (await r.json().catch(() => null)) as
      | { ok?: boolean; conflict?: boolean; text?: string | null; version?: LayoutVersion; error?: string }
      | null
    if (r.status === 200 && body?.ok) return { ok: true, version: body.version ?? null }
    if (r.status === 409 && body?.conflict) return { conflict: true, text: body.text ?? null, version: body.version ?? null }
    return { error: body?.error ?? `HTTP ${r.status}` }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/** Install `window.amber`. Must run with `home` already known — `main.tsx`
 * reads `homeDir` via a lazy `useState` initializer that runs exactly once,
 * so a placeholder patched in later would permanently stick every new pane's
 * default cwd at that placeholder. */
export function installAmber(home: string): void {
  const amber = createAmber({
    connectSocket,
    newChannel: () => {
      const ch = new MessageChannel()
      return { port1: ch.port1 as unknown as PortLike, port2: ch.port2 }
    },
    postPanePort: (session, port2) => {
      window.postMessage({ amberPanePort: true, session }, '*', [port2 as MessagePort])
    },
    clipboard: {
      writeText: (text) => navigator.clipboard.writeText(text),
      readText: () => navigator.clipboard.readText(),
    },
    home,
    // The web renderer is already on the remote machine's HTTPS origin. Keep
    // only the first DNS label so command-center identity stays compact.
    machineName: location.hostname.split('.')[0] || 'amber',
    softwareGl: probeSoftwareGl(),
    layoutGet,
    layoutSave,
    routerApi: routerApi(),
  })
  window.amber = amber

  // Hand borrowed pty grids back when the page stops being looked at (spec
  // §2.3). The server releases on socket death too, but that waits out a TCP
  // timeout — during which the desktop stays squeezed to phone width.
  //
  // `pagehide` rather than `unload`: iOS Safari does not reliably fire
  // `unload`, and `pagehide` also covers the back/forward cache.
  const release = (): void => amber.releaseGrids()
  window.addEventListener('pagehide', release)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') release()
  })
}
