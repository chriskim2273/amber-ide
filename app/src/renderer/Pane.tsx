import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'

export function Pane({ session }: { session: string }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({ convertEol: false, fontFamily: 'monospace', fontSize: 13 })
    const fit = new FitAddon()
    term.open(host)
    term.loadAddon(fit)
    // WebGL is the fast path on hardware GL, but pathologically slow on
    // SwiftShader — under software GL, use xterm's default DOM renderer so
    // keystrokes paint without a frame of software-rasterization lag.
    if (!window.amber.softwareGl) {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    }
    fit.fit()

    let port: MessagePort | null = null
    let wired = false

    const sendResize = (): void => {
      try { fit.fit() } catch { /* host has zero size mid-layout; ignore */ }
      port?.postMessage({ resize: { cols: term.cols, rows: term.rows } })
    }
    // Refit to the pane's own box on ANY size change (window resize, divider
    // drag, split) — not just window 'resize' — so xterm always fills its
    // container and never leaves an unpainted gap.
    const ro = new ResizeObserver(() => sendResize())
    ro.observe(host)
    const focus = (): void => term.focus()

    // The preload bridge re-dispatches this session's MessagePort via
    // window.postMessage. Wire exactly one port (guard against StrictMode /
    // repeat dispatches) and remove this listener as soon as it lands.
    const onPortMsg = (e: MessageEvent): void => {
      const d = e.data as { amberPanePort?: boolean; session?: string }
      if (!d?.amberPanePort || d.session !== session || !e.ports[0]) return
      window.removeEventListener('message', onPortMsg)
      if (wired) { e.ports[0].close(); return }
      wired = true
      port = e.ports[0]
      let sawBacklog = false
      port.onmessage = (ev) => {
        const m = ev.data as { data?: Uint8Array }
        if (!m.data) return
        term.write(m.data) // xterm.write accepts Uint8Array (UTF-8)
        if (!sawBacklog) {
          sawBacklog = true
          // Replaying raw scrollback re-executes its escape codes, including any
          // mouse-tracking enable from a prior program (e.g. a claude session
          // that's since exited). That leaves a shell echoing mouse reports on
          // click. Reset all mouse modes after the backlog; a live program that
          // wants the mouse re-asserts it on its next redraw (we send a resize).
          term.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l')
        }
      }
      port.start()
      term.onData((s) => port?.postMessage({ data: new TextEncoder().encode(s) }))
      sendResize()
      term.focus()
    }

    window.addEventListener('message', onPortMsg)
    host.addEventListener('click', focus)
    term.focus()
    window.amber.openPane(session)

    return () => {
      window.removeEventListener('message', onPortMsg)
      host.removeEventListener('click', focus)
      ro.disconnect()
      port?.close()
      term.dispose()
    }
  }, [session])

  return <div ref={hostRef} style={{ width: '100%', height: '100%', background: '#000' }} />
}
