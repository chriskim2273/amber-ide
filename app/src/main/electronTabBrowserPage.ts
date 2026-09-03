import { WebContentsView, session, type BrowserWindow, type Rectangle, type Session } from 'electron'
import { browserWebPreferences, isAllowedBrowserUrl } from './tabBrowserPolicy'
import type { BrowserId } from '../shared/tabBrowser'
import type { TabBrowserPage, TabBrowserPageEvent, TabBrowserPageFactory } from './tabBrowserHost'
import { BrowserAutomation, type BrowserDebuggerTransport } from './browserAutomation'

const hardenedSessions = new WeakSet<Session>()
export function hardenBrowserSession(browserSession: Session): void {
  if (hardenedSessions.has(browserSession)) return
  hardenedSessions.add(browserSession)
  browserSession.setPermissionCheckHandler(() => false)
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  // File writes stay outside the semantic tool surface. Even an approved
  // page click cannot turn into an unbounded filesystem download.
  browserSession.on('will-download', (event) => event.preventDefault())
}

export function projectInPageNavigation(url: string, isMainFrame: boolean): TabBrowserPageEvent | null {
  return isMainFrame ? { type: 'navigation-in-page', url: url.slice(0, 8192) } : null
}

export class ElectronTabBrowserPage implements TabBrowserPage {
  readonly view: WebContentsView
  readonly automation: BrowserAutomation
  private attached = false
  private disposing = false
  private bounds: Rectangle = { x: 0, y: 0, width: 1, height: 1 }
  constructor(private window: BrowserWindow, partition: string, onUserInput: () => void, onPageEvent: (event: TabBrowserPageEvent) => void, allowNavigation: (url: string) => boolean, private readonly onDestroy: () => void) {
    const browserSession = session.fromPartition(partition)
    hardenBrowserSession(browserSession)
    this.view = new WebContentsView({ webPreferences: browserWebPreferences(partition) })
    const contents = this.view.webContents
    const debuggerTransport: BrowserDebuggerTransport = {
      isAttached: () => contents.debugger.isAttached(),
      attach: (version) => { contents.debugger.attach(version) },
      detach: () => { contents.debugger.detach() },
      send: async (method, params) => (await contents.debugger.sendCommand(method, params)) as Record<string, unknown>,
      onMessage: (listener) => { contents.debugger.on('message', (_event, method, params) => listener(method, (params ?? {}) as Record<string, unknown>)) },
    }
    this.automation = new BrowserAutomation(debuggerTransport, () => contents.getURL(), () => contents.isLoading(), {}, {
      reload: (ignoreCache) => { if (ignoreCache) contents.reloadIgnoringCache(); else contents.reload(); return true },
      history: (direction) => {
        const history = contents.navigationHistory
        if (direction === 'back' && history.canGoBack()) { history.goBack(); return true }
        if (direction === 'forward' && history.canGoForward()) { history.goForward(); return true }
        return false
      },
      dialog: (dialog) => new Promise((resolve) => onPageEvent({ type: 'dialog', dialogType: dialog.type, message: dialog.message, respond: resolve })),
      onDiagnostics: (diagnostics) => onPageEvent({ type: 'diagnostics', ...diagnostics }),
    })
    // Attach to this WebContents only; there is no remote-debugging endpoint
    // and therefore no target enumeration or cross-page control surface.
    void this.automation.ensureAttached().catch(() => {})
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.view.webContents.on('will-navigate', (event, url) => { if (!isAllowedBrowserUrl(url) || !allowNavigation(url)) event.preventDefault() })
    this.view.webContents.on('will-redirect', (event, url) => { if (!isAllowedBrowserUrl(url) || !allowNavigation(url)) event.preventDefault() })
    this.view.webContents.on('will-frame-navigate', (event) => { if (!isAllowedBrowserUrl(event.url) || (event.isMainFrame && !allowNavigation(event.url))) event.preventDefault() })
    this.view.webContents.on('before-input-event', (event, input) => {
      if ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'b') { event.preventDefault(); this.blur(); onPageEvent({ type: 'focus', focused: false }); return }
      onUserInput()
    })
    this.view.webContents.on('before-mouse-event', onUserInput)
    this.view.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) onPageEvent({ type: 'navigation-started' }) })
    this.view.webContents.on('did-navigate', (_event, url) => onPageEvent({ type: 'navigation-committed', url }))
    this.view.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => { const projected = projectInPageNavigation(url, isMainFrame); if (projected) onPageEvent(projected) })
    this.view.webContents.on('did-stop-loading', () => onPageEvent({ type: 'loading-stopped' }))
    this.view.webContents.on('page-title-updated', (_event, title) => onPageEvent({ type: 'title', title }))
    this.view.webContents.on('focus', () => onPageEvent({ type: 'focus', focused: true }))
    this.view.webContents.on('blur', () => onPageEvent({ type: 'focus', focused: false }))
    this.view.webContents.on('render-process-gone', (_event, details) => { if (!this.disposing) onPageEvent({ type: 'crashed', reason: details.reason }) })
  }
  async loadURL(url: string): Promise<void> {
    if (!isAllowedBrowserUrl(url)) throw new Error('NAVIGATION_BLOCKED')
    await this.view.webContents.loadURL(url)
  }
  stop(): void { this.view.webContents.stop() }
  focus(): void { this.view.webContents.focus() }
  blur(): void { this.window.webContents.focus() }
  setWindow(window: BrowserWindow): void {
    if (window === this.window) return
    this.hide(); this.window = window
  }
  setBounds(bounds: Rectangle): void { this.bounds = bounds; if (this.attached) this.view.setBounds(bounds) }
  show(): void {
    if (!this.attached) { this.window.contentView.addChildView(this.view); this.attached = true }
    this.view.setBounds(this.bounds)
  }
  hide(): void {
    if (this.attached) { this.window.contentView.removeChildView(this.view); this.attached = false }
  }
  destroy(): void { this.disposing = true; this.automation.dispose(); this.hide(); if (!this.view.webContents.isDestroyed()) this.view.webContents.close(); this.onDestroy() }
}

export class ElectronTabBrowserPageFactory implements TabBrowserPageFactory {
  readonly pages = new Map<BrowserId, ElectronTabBrowserPage>()
  constructor(private window: BrowserWindow, private readonly partition = 'persist:amber-browser') {}
  setWindow(window: BrowserWindow): void { this.window = window; for (const page of this.pages.values()) page.setWindow(window) }
  create(id: BrowserId, onUserInput: () => void, onPageEvent: (event: TabBrowserPageEvent) => void, allowNavigation: (url: string) => boolean): ElectronTabBrowserPage {
    const page = new ElectronTabBrowserPage(this.window, this.partition, onUserInput, onPageEvent, allowNavigation, () => this.pages.delete(id))
    this.pages.set(id, page)
    return page
  }
}
