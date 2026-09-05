import { ipcRenderer, contextBridge, type IpcRendererEvent } from 'electron'
import type { LoadLayoutResult, SaveLayoutResult } from '../shared/layoutFile'
import type { LoadProductivityResult, SaveProductivityResult } from '../shared/productivity'
import type { CheckpointSummary } from '../shared/checkpoint'

// This preload runs SANDBOXED — no node builtins, no `process.env`. Both would
// throw/return-empty and kill the bridge. Values come from `additionalArguments`
// (set in main's webPreferences), read here off `process.argv`.
const argv = process.argv
const homeArg = argv.find((a) => a.startsWith('--amber-home='))?.slice('--amber-home='.length)
const machineArg = argv.find((a) => a.startsWith('--amber-machine='))?.slice('--amber-machine='.length)
// Non-empty only in an SSH remote window (spec 2026-08-23): the renderer shows
// a read-only marker and suppresses layout persistence chatter. The ENFORCEMENT
// of read-only lives in main, which owns the disk — this is presentation.
const remoteArg = argv.find((a) => a.startsWith('--amber-remote='))?.slice('--amber-remote='.length)

contextBridge.exposeInMainWorld('amber', {
  // True when the app was launched with software GL (SwiftShader); the renderer
  // uses this to skip xterm's WebGL addon, which is slow on software GL.
  softwareGl: argv.includes('--amber-software-gl'),
  onDaemonEvent: (cb: (data: unknown) => void) =>
    ipcRenderer.on('daemon-event', (_e, data) => cb(data)),
  openPane: (session: string) => ipcRenderer.send('open-pane', session),
  // Pane unmounted: release its client-side port + daemon subscription.
  closePane: (session: string) => ipcRenderer.send('close-pane', session),
  createSession: (name: string, cwd: string, sessionKind: string, title?: string) =>
    ipcRenderer.send('daemon-command', { cmd: 'create', name, cwd, sessionKind, ...(title === undefined ? {} : { title }) }),
  killSession: (name: string) => ipcRenderer.send('daemon-command', { cmd: 'kill', name }),
  renameSession: (from: string, to: string) => ipcRenderer.send('daemon-command', { cmd: 'rename', from, to }),
  setSessionTitle: (name: string, title: string | null) => ipcRenderer.send('daemon-command', { cmd: 'setTitle', name, title }),
  // Slice 3 freeze grace: park/un-park a claude session to free its RAM.
  suspendSession: (name: string) => ipcRenderer.send('daemon-command', { cmd: 'suspend', name }),
  resumeSession: (name: string) => ipcRenderer.send('daemon-command', { cmd: 'resume', name }),
  focusSession: (name: string) => ipcRenderer.send('daemon-command', { cmd: 'focus', name }),
  // Request the daemon dump a session's scrollback ring; the reply arrives as a
  // `Backlog` control frame via onDaemonEvent (correlated by name renderer-side).
  dumpBacklog: (name: string) => ipcRenderer.send('daemon-command', { cmd: 'dumpBacklog', name }),
  searchScrollback: (requestId: number, query: string, names: string[], limit: number) =>
    ipcRenderer.send('daemon-command', { cmd: 'searchScrollback', requestId, query, names, limit }),
  listRecoveryEvents: (limit: number) => ipcRenderer.send('daemon-command', { cmd: 'listRecoveryEvents', limit }),
  clearRecoveryEvents: () => ipcRenderer.send('daemon-command', { cmd: 'clearRecoveryEvents' }),
  // Memory budget: view (`getMemoryBudget`) / change (`setMemoryBudget`, MiB;
  // 0 = auto). The `BudgetApplied` reply arrives via onDaemonEvent.
  getMemoryBudget: () => ipcRenderer.send('daemon-command', { cmd: 'getMemoryBudget' }),
  // Agent plan quota (design 2026-09-01). The `Usage` reply arrives via
  // onDaemonEvent, like BudgetApplied — this is a request, not a promise.
  getUsage: (refresh = false) => ipcRenderer.send('daemon-command', { cmd: 'getUsage', refresh }),
  setMemoryBudget: (mb: number) => ipcRenderer.send('daemon-command', { cmd: 'setMemoryBudget', mb }),
  // Flush daemon-owned session metadata + scrollback now. Confirmation arrives
  // as SnapshotOk through onDaemonEvent; the renderer never infers success.
  snapshotNow: () => ipcRenderer.send('daemon-command', { cmd: 'snapshot' }),
  // Absolute home dir (default cwd for new panes) + a native folder picker so
  // panes carry a real absolute cwd, not a relative '.' that drifts on restore.
  homeDir: homeArg || '/',
  machineName: machineArg || 'amber',
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('pick-folder'),
  // CAS (spec 2026-08-01 §6): `layout-load`/`layout-save` return a version
  // token alongside the text; `saveLayout` must supply it back so main can
  // detect a concurrent write (from `amber web`) and reject a stale one.
  loadLayout: (): Promise<LoadLayoutResult> => ipcRenderer.invoke('layout-load'),
  saveLayout: (text: string, version: string | null): Promise<SaveLayoutResult> =>
    ipcRenderer.invoke('layout-save', text, version),
  // Tab-owned native browser rail. A single typed command seam; main derives
  // the owning window from event.sender and rejects remote/unsupported hosts.
  setBrowserContext: (context: unknown): Promise<unknown> => ipcRenderer.invoke('browser:set-context', context),
  browserCommand: (command: unknown): Promise<unknown> => ipcRenderer.invoke('browser:command', command),
  importWorkspaceBrowsers: (entries: unknown): Promise<unknown> => ipcRenderer.invoke('browser:import-workspace', entries),
  snapshotWorkspaceBrowsers: (): Promise<unknown> => ipcRenderer.invoke('browser:workspace-snapshot'),
  browserRecovery: (command: unknown): Promise<unknown> => ipcRenderer.invoke('browser:recovery', command),
  onTabBrowserEvent: (cb: (event: unknown) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, value: unknown): void => cb(value)
    ipcRenderer.on('tab-browser-event', listener)
    return () => ipcRenderer.removeListener('tab-browser-event', listener)
  },
  onBrowserAssociation: (cb: (association: unknown) => void): void => {
    ipcRenderer.on('tab-browser-association', (_event, association) => cb(association))
  },
  loadProductivity: (): Promise<LoadProductivityResult> => ipcRenderer.invoke('productivity-load'),
  saveProductivity: (text: string, version: string | null): Promise<SaveProductivityResult> =>
    ipcRenderer.invoke('productivity-save', text, version),
  readProjectProfile: (root: string): Promise<unknown> => ipcRenderer.invoke('project-profile-read', root),
  listCheckpoints: (): Promise<CheckpointSummary[]> => ipcRenderer.invoke('checkpoint-list'),
  writeCheckpoint: (id: string, text: string): Promise<void> => ipcRenderer.invoke('checkpoint-write', id, text),
  readCheckpoint: (id: string): Promise<string> => ipcRenderer.invoke('checkpoint-read', id),
  deleteCheckpoint: (id: string): Promise<void> => ipcRenderer.invoke('checkpoint-delete', id),
  saveHandoffFile: (text: string, suggested: string): Promise<boolean> =>
    ipcRenderer.invoke('handoff-save-file', text, suggested),
  notify: (payload: { title: string; body: string; session?: string }): void => ipcRenderer.send('desktop-notify', payload),
  onNotificationActivate: (cb: (session: string) => void): void => {
    ipcRenderer.on('notification-activate', (_event, session: unknown) => {
      if (typeof session === 'string') cb(session)
    })
  },
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
  /** `user@host` when this window mirrors a remote machine, else ''. */
  remoteHost: remoteArg ?? '',
  /** SSH remote windows (spec 2026-08-23). */
  connectHost: (host: string): Promise<void> => ipcRenderer.invoke('connect-host', host),
  onConnectHostPrompt: (cb: () => void): void => { ipcRenderer.on('connect-host-prompt', () => cb()) },
  // Remote access (spec 2026-08-22 §9). `webUrl` is on-demand ONLY: it returns
  // the tokenised login url, which must never ride the 3-second status poll.
  webStatus: (): Promise<unknown> => ipcRenderer.invoke('web:status'),
  webAction: (action: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('web:action', action),
  webUrl: (): Promise<string> => ipcRenderer.invoke('web:url'),
  webLogTail: (): Promise<string> => ipcRenderer.invoke('web:logTail'),
  webOpenLocal: (): Promise<void> => ipcRenderer.invoke('web:openLocal'),
  // ---- local router
  routerStatus: (): Promise<unknown> => ipcRenderer.invoke('router:status'),
  routerAction: (action: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('router:action', action),
  routerSlots: (): Promise<{ ok: boolean; error?: string; slots: unknown[] }> =>
    ipcRenderer.invoke('router:slots'),
  routerSaveSlots: (slots: unknown[]): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('router:saveSlots', slots),
  routerRevealKey: (name: string): Promise<string> =>
    ipcRenderer.invoke('router:revealKey', name),
  routerLogTail: (): Promise<string> => ipcRenderer.invoke('router:logTail'),
  editorOpenDialog: (): Promise<
    { path: string; text: string; mtimeMs: number } | { path: string; error: string } | null
  > => ipcRenderer.invoke('editor-open-dialog'),
  editorRead: (path: string): Promise<{ text: string; mtimeMs: number } | { error: string }> =>
    ipcRenderer.invoke('editor-read', path),
  editorSave: (
    path: string,
    text: string,
    expectedMtimeMs: number | null,
  ): Promise<{ mtimeMs: number } | { conflict: true; mtimeMs: number } | { error: string }> =>
    ipcRenderer.invoke('editor-save', path, text, expectedMtimeMs),
  editorSaveDialog: (
    suggestedName: string,
    text: string,
  ): Promise<{ path: string; mtimeMs: number } | { path: string; error: string } | null> =>
    ipcRenderer.invoke('editor-save-dialog', suggestedName, text),
  editorDraftWrite: (paneId: string, text: string): Promise<void> =>
    ipcRenderer.invoke('editor-draft-write', paneId, text),
  editorDraftRead: (paneId: string): Promise<string | null> =>
    ipcRenderer.invoke('editor-draft-read', paneId),
  editorDraftClear: (paneId: string): Promise<void> =>
    ipcRenderer.invoke('editor-draft-clear', paneId),
  // Session-cleanup dialog: conversation labels for claude session ids.
  claudeNames: (entries: { id: string; cwd: string }[]): Promise<Record<string, string>> =>
    ipcRenderer.invoke('claude-names', entries),
  editorInlineImages: (mdDir: string, html: string): Promise<{ html: string }> =>
    ipcRenderer.invoke('editor-inline-images', mdDir, html),
})

// A transferred MessagePort cannot cross contextBridge; re-dispatch the live
// port into the page's main world, tagged with its session.
ipcRenderer.on('pane-port', (e, meta: { session: string }) => {
  const port = e.ports[0]
  if (!port) return
  window.postMessage({ amberPanePort: true, session: meta.session }, '*', [port])
})
