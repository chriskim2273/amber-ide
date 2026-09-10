// Real mounted Pane + xterm, with only the external daemon/clipboard bridge replaced.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Pane, type SearchApi } from '../src/renderer/Pane'

let api: SearchApi
let daemonPort: MessagePort | undefined
let cols = 80, rows = 24
let messages: string[] = []
let kind = 'pi'
let runState: string | undefined = 'claude'
let mounted = true
const root = createRoot(document.getElementById('root')!)
Object.assign(window, {
  amber: {
    softwareGl: true,
    openPane(session: string) {
      const channel = new MessageChannel()
      daemonPort = channel.port1
      daemonPort.onmessage = ({ data }) => {
        if (data.resize) { cols = data.resize.cols; rows = data.resize.rows }
        if (data.data) messages.push(new TextDecoder().decode(data.data))
      }
      window.postMessage({ amberPanePort: true, session }, '*', [channel.port2])
    },
    closePane() { daemonPort?.close(); daemonPort = undefined },
    resolvePath: async () => null,
    clipboardWrite: () => {},
  },
})
function render(): void {
  // runState is delivered as a runtime prop even before Pane gains its typed
  // declaration, so the baseline regression can exercise the existing code.
  const props = { session: 'fixture', kind, runState, epoch: 0, portEpoch: 0,
    activateSeq: 0, fontSize: 14, cwd: '/', onSearchReady: (value: SearchApi) => { api = value } }
  flushSync(() => root.render(mounted ? <Pane {...props} /> : null))
}
function output(text: string, backlog = false): void {
  daemonPort?.postMessage({ data: new TextEncoder().encode(text), backlog })
}
Object.assign(window, { fixture: {
  ready: () => Boolean(api && daemonPort && document.querySelector('.xterm-screen')),
  geometry: () => ({ cols, rows }),
  output,
  padded: () => output('  First line'.padEnd(cols) + '\r\n' + ' '.repeat(cols) + '\r\n' + '    indented code'.padEnd(cols) + '\r\n', true),
  parsed: () => api.findNext('indented code'),
  copy: () => api.copySelection(),
  paste: (text: string) => api.paste(text),
  messages: () => messages,
  clearMessages: () => { messages = [] },
  state: (value: string | undefined) => { runState = value; render() },
  remount: (value: string) => { mounted = false; render(); kind = value; mounted = true; render() },
  unmount: () => { mounted = false; render() },
} })
render()
