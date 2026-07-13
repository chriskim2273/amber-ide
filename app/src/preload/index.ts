import { ipcRenderer, contextBridge } from 'electron'

contextBridge.exposeInMainWorld('amber', {
  onDaemonEvent: (cb: (data: unknown) => void) =>
    ipcRenderer.on('daemon-event', (_e, data) => cb(data)),
  openPane: (session: string) => ipcRenderer.send('open-pane', session),
})

// A transferred MessagePort cannot cross contextBridge; re-dispatch the live
// port into the page's main world, tagged with its session.
ipcRenderer.on('pane-port', (e, meta: { session: string }) => {
  const port = e.ports[0]
  if (!port) return
  window.postMessage({ amberPanePort: true, session: meta.session }, '*', [port])
})
