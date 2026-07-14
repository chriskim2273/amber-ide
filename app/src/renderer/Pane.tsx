import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'

// Replaying raw scrollback re-executes its escape codes, including any mouse-
// tracking enable from a prior program (e.g. an exited claude). Left set, a
// shell echoes mouse reports on every click/move. Disable all mouse modes
// after each backlog; a live program re-asserts what it needs on redraw.
const MOUSE_RESET = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l'

export function Pane({ session, epoch }: { session: string; epoch: number }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const portRef = useRef<MessagePort | null>(null)
  // Set on a reconnect so the NEXT backlog message re-runs the reset (the
  // daemon replays a fresh backlog on every re-Attach, re-enabling mouse modes).
  const rearmRef = useRef(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({ convertEol: false, fontFamily: 'monospace', fontSize: 13 })
    const fit = new FitAddon()
    term.open(host)
    term.loadAddon(fit)
    // WebGL is the fast path on hardware GL, but pathologically slow on
    // SwiftShader — under software GL, use xterm's default DOM renderer.
    if (!window.amber.softwareGl) {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    }
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    let port: MessagePort | null = null
    let wired = false

    const sendResize = (): void => {
      try { fit.fit() } catch { /* host has zero size mid-layout; ignore */ }
      port?.postMessage({ resize: { cols: term.cols, rows: term.rows } })
    }
    const ro = new ResizeObserver(() => sendResize())
    ro.observe(host)
    const focus = (): void => term.focus()

    const onPortMsg = (e: MessageEvent): void => {
      const d = e.data as { amberPanePort?: boolean; session?: string }
      if (!d?.amberPanePort || d.session !== session || !e.ports[0]) return
      window.removeEventListener('message', onPortMsg)
      if (wired) { e.ports[0].close(); return }
      wired = true
      port = e.ports[0]
      portRef.current = port
      let sawBacklog = false
      port.onmessage = (ev) => {
        const m = ev.data as { data?: Uint8Array }
        if (!m.data) return
        term.write(m.data) // xterm.write accepts Uint8Array (UTF-8)
        // First backlog after (re)attach: clear stale mouse modes.
        if (!sawBacklog || rearmRef.current) {
          sawBacklog = true
          rearmRef.current = false
          term.write(MOUSE_RESET)
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
      termRef.current = null
      fitRef.current = null
      portRef.current = null
    }
  }, [session])

  // On reconnect (epoch increments): re-arm the mouse reset for the fresh
  // backlog, and nudge a resize so an alt-screen TUI (claude — whose screen
  // isn't in scrollback) repaints. Staggered because claude may still be
  // re-resuming when the socket comes back.
  useEffect(() => {
    if (epoch === 0) return
    rearmRef.current = true
    const nudge = (): void => {
      const term = termRef.current, fit = fitRef.current, port = portRef.current
      if (!term || !port) return
      try { fit?.fit() } catch { /* ignore */ }
      term.write(MOUSE_RESET)
      port.postMessage({ resize: { cols: term.cols, rows: term.rows } })
    }
    const t1 = setTimeout(nudge, 600)
    const t2 = setTimeout(nudge, 2000)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [epoch])

  return <div ref={hostRef} style={{ width: '100%', height: '100%', background: '#000' }} />
}
