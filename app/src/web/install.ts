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

// `softwareGl` (spec §3 "Env" row) is a browser-local fact the server cannot
// know — probed here with a native feature check rather than served in the
// bootstrap JSON like `homeDir` (which the server DOES uniquely know).
function probeSoftwareGl(): boolean {
  try {
    const c = document.createElement('canvas')
    return !(c.getContext('webgl2') ?? c.getContext('webgl'))
  } catch {
    return true
  }
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
