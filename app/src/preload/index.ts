import { ipcRenderer, contextBridge } from 'electron'

contextBridge.exposeInMainWorld('amber', {
  onDaemonEvent: (cb: (data: unknown) => void) =>
    ipcRenderer.on('daemon-event', (_e, data) => cb(data)),
})
