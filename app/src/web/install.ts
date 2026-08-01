// Real-DOM glue for `amber.ts`'s pure `createAmber`: the only place in the
// web build that touches `WebSocket`, `MessageChannel`, `window.postMessage`
// or `navigator.clipboard`. Never imported by a test — `amber.test.ts` tests
// `createAmber` directly against fakes.

import { createAmber, type SocketLike, type PortLike } from './amber'

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

/** Install `window.amber`. Must run with `home` already known — `main.tsx`
 * reads `homeDir` via a lazy `useState` initializer that runs exactly once,
 * so a placeholder patched in later would permanently stick every new pane's
 * default cwd at that placeholder. */
export function installAmber(home: string): void {
  window.amber = createAmber({
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
    softwareGl: probeSoftwareGl(),
  })
}
