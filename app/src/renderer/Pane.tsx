import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'

// Wait for the preload bridge to hand us this session's MessagePort.
function awaitPort(session: string): Promise<MessagePort> {
  return new Promise((resolve) => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { amberPanePort?: boolean; session?: string }
      if (d?.amberPanePort && d.session === session && e.ports[0]) {
        window.removeEventListener('message', onMsg)
        resolve(e.ports[0])
      }
    }
    window.addEventListener('message', onMsg)
  })
}

export function Pane({ session }: { session: string }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({ convertEol: false, fontFamily: 'monospace', fontSize: 13 })
    const fit = new FitAddon()
    term.open(host)
    term.loadAddon(fit)
    const webgl = new WebglAddon()
    webgl.onContextLoss(() => webgl.dispose())
    term.loadAddon(webgl)
    fit.fit()

    let port: MessagePort | null = null
    let disposed = false

    void awaitPort(session).then((p) => {
      if (disposed) { p.close(); return }
      port = p
      p.onmessage = (e) => {
        const d = e.data as { data?: Uint8Array }
        if (d.data) term.write(d.data) // xterm.write accepts Uint8Array (UTF-8)
      }
      p.start()
      term.onData((s) => p.postMessage({ data: new TextEncoder().encode(s) }))
      const sendResize = () => { fit.fit(); p!.postMessage({ resize: { cols: term.cols, rows: term.rows } }) }
      sendResize()
      window.addEventListener('resize', sendResize)
    })

    window.amber.openPane(session)

    return () => {
      disposed = true
      port?.close()
      term.dispose()
    }
  }, [session])

  return <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
}
