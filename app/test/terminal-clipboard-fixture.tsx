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
let web = false
let uploads: Array<{ session: string; size: number; type: string }> = []
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
    clipboardRead: async () => '',
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
  uploads: () => uploads,
  web: () => {
    web = true
    window.amber.pasteImage = async (session, file) => {
      uploads.push({ session, size: file.size, type: file.type })
      return '/tmp/amber-clip-fixture.png'
    }
  },
  imagePaste: () => {
    uploads = []
    const data = new DataTransfer()
    data.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'image.png', { type: 'image/png' }))
    document.querySelector('.xterm-helper-textarea')!.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
  },
  menuPaste: async () => {
    uploads = []
    if (!web) throw new Error('web fixture not enabled')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      read: async () => [{ types: ['image/png'], getType: async () => new Blob([new Uint8Array(8)], { type: 'image/png' }) }],
    } })
    await api.pasteClipboard!()
  },
  clearMessages: () => { messages = [] },
  state: (value: string | undefined) => { runState = value; render() },
  remount: (value: string) => { mounted = false; render(); kind = value; mounted = true; render() },
  unmount: () => { mounted = false; render() },
} })
render()
