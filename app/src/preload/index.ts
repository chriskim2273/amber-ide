import { ipcRenderer, contextBridge } from 'electron'

// This preload runs SANDBOXED — no node builtins, no `process.env`. Both would
// throw/return-empty and kill the bridge. Values come from `additionalArguments`
// (set in main's webPreferences), read here off `process.argv`.
const argv = process.argv
const homeArg = argv.find((a) => a.startsWith('--amber-home='))?.slice('--amber-home='.length)

contextBridge.exposeInMainWorld('amber', {
  // True when the app was launched with software GL (SwiftShader); the renderer
  // uses this to skip xterm's WebGL addon, which is slow on software GL.
  softwareGl: argv.includes('--amber-software-gl'),
  onDaemonEvent: (cb: (data: unknown) => void) =>
    ipcRenderer.on('daemon-event', (_e, data) => cb(data)),
  openPane: (session: string) => ipcRenderer.send('open-pane', session),
  createSession: (name: string, cwd: string, sessionKind: string) =>
    ipcRenderer.send('daemon-command', { cmd: 'create', name, cwd, sessionKind }),
  killSession: (name: string) => ipcRenderer.send('daemon-command', { cmd: 'kill', name }),
  // Request the daemon dump a session's scrollback ring; the reply arrives as a
  // `Backlog` control frame via onDaemonEvent (correlated by name renderer-side).
  dumpBacklog: (name: string) => ipcRenderer.send('daemon-command', { cmd: 'dumpBacklog', name }),
  // Absolute home dir (default cwd for new panes) + a native folder picker so
  // panes carry a real absolute cwd, not a relative '.' that drifts on restore.
  homeDir: homeArg || '/',
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('pick-folder'),
  loadLayout: (): Promise<string | null> => ipcRenderer.invoke('layout-load'),
  saveLayout: (text: string): Promise<void> => ipcRenderer.invoke('layout-save', text),
  // Portable `.amberws` workspace files via native OS dialogs. Save returns true
  // on write, false on cancel; open returns the file text or null on cancel.
  saveWorkspaceFile: (json: string, suggestedName: string): Promise<boolean> =>
    ipcRenderer.invoke('workspace-save-file', json, suggestedName),
  openWorkspaceFile: (): Promise<string | null> => ipcRenderer.invoke('workspace-open-file'),
  // Resolve a pane selection to an existing absolute path (null if none), then
  // reveal it in the OS file manager. Powers the pane's floating "Open" button.
  resolvePath: (cwd: string, raw: string): Promise<string | null> =>
    ipcRenderer.invoke('resolve-path', cwd, raw),
  revealPath: (abs: string): void => ipcRenderer.send('reveal-path', abs),
  // Terminal copy/paste through Electron's clipboard (reliable across platforms;
  // xterm's visual selection isn't in a DOM selection, and Linux has no Edit
  // menu, so the native copy role can't reach it).
  clipboardWrite: (text: string): void => ipcRenderer.send('clipboard-write', text),
  clipboardRead: (): Promise<string> => ipcRenderer.invoke('clipboard-read'),
})

// A transferred MessagePort cannot cross contextBridge; re-dispatch the live
// port into the page's main world, tagged with its session.
ipcRenderer.on('pane-port', (e, meta: { session: string }) => {
  const port = e.ports[0]
  if (!port) return
  window.postMessage({ amberPanePort: true, session: meta.session }, '*', [port])
})
