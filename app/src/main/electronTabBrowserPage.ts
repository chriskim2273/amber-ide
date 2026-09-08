import { WebContentsView, session, screen, type BrowserWindow, type Input, type MouseInputEvent, type Rectangle, type Session } from 'electron'
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

/** The initial implicit blank document is not a safe debugger target in Electron 43.
 * An explicit blank navigation is a real document request and remains automatable. */
export function documentCanArmBrowserDebugger(url: string, explicitlyLoadedBlank: boolean): boolean {
  return url !== 'about:blank' || explicitlyLoadedBlank
}

/** A closed BrowserWindow cannot receive removeChildView during reparenting. */
export function browserWindowCanRemoveChildView(window: Pick<BrowserWindow, 'isDestroyed'>): boolean {
  return !window.isDestroyed()
}

interface PreventableInputEvent { preventDefault(): void }

/**
 * Electron does not expose a trustworthy source marker for page input. Every
 * callback therefore advances the page generation, including CDP-dispatched,
 * physical, and composing input. Reserved Amber shortcuts still count as
 * input before their default action is prevented.
 */
export function createInputEventHandlers(
  onUserInput: () => void,
  onBlurShortcut: () => void,
): {
  beforeInputEvent: (event: PreventableInputEvent, input: Input) => void
  beforeMouseEvent: (_event: PreventableInputEvent, input: MouseInputEvent) => void
} {
  return {
    beforeInputEvent: (event, input) => {
      onUserInput()
      if ((input.control || input.meta) && input.shift && typeof input.key === 'string' && input.key.toLowerCase() === 'b') { event.preventDefault(); onBlurShortcut() }
    },
    beforeMouseEvent: () => { onUserInput() },
  }
}

export class ElectronTabBrowserPage implements TabBrowserPage {
  readonly view: WebContentsView
  readonly automation: BrowserAutomation
  private attached = false
  private disposing = false
  private explicitlyLoadedBlank = false
  private bounds: Rectangle = { x: 0, y: 0, width: 1, height: 1 }
  constructor(private window: BrowserWindow, partition: string, onUserInput: () => void, onPageEvent: (event: TabBrowserPageEvent) => void, allowNavigation: (url: string) => boolean, private readonly onDestroy: () => void) {
    const browserSession = session.fromPartition(partition)
    hardenBrowserSession(browserSession)
    this.view = new WebContentsView({ webPreferences: browserWebPreferences(partition) })
    const contents = this.view.webContents
    // Electron 43 can leave every debugger command pending while a newly
    // created WebContentsView is still on its implicit document. Wait for the
    // renderer's load lifecycle rather than using the URL as a readiness bit:
    // an explicitly loaded about:blank page is a valid automation target too.
    let debuggerReady = false
    const debuggerTransport: BrowserDebuggerTransport = {
      isAttached: () => contents.debugger.isAttached(),
      attach: (version) => { contents.debugger.attach(version) },
      detach: () => { contents.debugger.detach() },
      send: async (method, params) => (await contents.debugger.sendCommand(method, params)) as Record<string, unknown>,
      onMessage: (listener) => { contents.debugger.on('message', (_event, method, params) => listener(method, (params ?? {}) as Record<string, unknown>)) },
    }
    this.automation = new BrowserAutomation(debuggerTransport, () => contents.getURL(), () => contents.isLoading(), {}, {
      deviceScaleFactor: () => screen.getDisplayMatching(this.window.getBounds()).scaleFactor,
      reload: (ignoreCache) => { if (ignoreCache) contents.reloadIgnoringCache(); else contents.reload(); return true },
      history: (direction) => {
        const history = contents.navigationHistory
        if (direction === 'back' && history.canGoBack()) { history.goBack(); return true }
        if (direction === 'forward' && history.canGoForward()) { history.goForward(); return true }
        return false
      },
      dialog: (dialog) => new Promise((resolve) => onPageEvent({ type: 'dialog', dialogType: dialog.type, message: dialog.message, respond: resolve })),
      onDiagnostics: (diagnostics) => onPageEvent({ type: 'diagnostics', ...diagnostics }),
      isDebuggerReady: () => debuggerReady,
    })
    // Attach to this WebContents only; there is no remote-debugging endpoint
    // and therefore no target enumeration or cross-page control surface. The
    // first attach is armed by the document load event below, independent of
    // whether that document is about:blank or a navigated page.
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.view.webContents.on('will-navigate', (event, url) => { if (!isAllowedBrowserUrl(url) || !allowNavigation(url)) event.preventDefault() })
    this.view.webContents.on('will-redirect', (event, url) => { if (!isAllowedBrowserUrl(url) || !allowNavigation(url)) event.preventDefault() })
    this.view.webContents.on('will-frame-navigate', (event) => { if (!isAllowedBrowserUrl(event.url) || (event.isMainFrame && !allowNavigation(event.url))) event.preventDefault() })
    const inputHandlers = createInputEventHandlers(onUserInput, () => { this.blur(); onPageEvent({ type: 'focus', focused: false }) })
    this.view.webContents.on('before-input-event', inputHandlers.beforeInputEvent)
    this.view.webContents.on('before-mouse-event', inputHandlers.beforeMouseEvent)
    this.view.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) onPageEvent({ type: 'navigation-started' }) })
    this.view.webContents.on('did-navigate', (_event, url) => onPageEvent({ type: 'navigation-committed', url }))
    this.view.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => { const projected = projectInPageNavigation(url, isMainFrame); if (projected) onPageEvent(projected) })
    this.view.webContents.on('did-stop-loading', () => onPageEvent({ type: 'loading-stopped' }))
    this.view.webContents.on('did-finish-load', () => {
      if (this.disposing || debuggerReady || !documentCanArmBrowserDebugger(contents.getURL(), this.explicitlyLoadedBlank)) return
      debuggerReady = true
      this.explicitlyLoadedBlank = false
      void this.automation.ensureAttached().catch(() => {})
    })
    this.view.webContents.on('page-title-updated', (_event, title) => onPageEvent({ type: 'title', title }))
    this.view.webContents.on('focus', () => onPageEvent({ type: 'focus', focused: true }))
    this.view.webContents.on('blur', () => onPageEvent({ type: 'focus', focused: false }))
    this.view.webContents.on('render-process-gone', (_event, details) => { if (!this.disposing) onPageEvent({ type: 'crashed', reason: details.reason }) })
  }
  async loadURL(url: string, signal?: AbortSignal): Promise<void> {
    if (!isAllowedBrowserUrl(url)) throw new Error('NAVIGATION_BLOCKED')
    if (signal?.aborted) throw new Error('ACTION_CANCELLED')
    const explicitBlank = url === 'about:blank'
    if (explicitBlank) this.explicitlyLoadedBlank = true
    let onAbort: (() => void) | undefined, completed = false
    const cancelled = signal ? new Promise<never>((_resolve, reject) => {
      onAbort = () => { this.stop(); reject(new Error('ACTION_CANCELLED')) }
      signal.addEventListener('abort', onAbort, { once: true })
    }) : null
    try {
      const loading = this.view.webContents.loadURL(url)
      await (cancelled ? Promise.race([loading, cancelled]) : loading)
      completed = true
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort)
      if (explicitBlank && !completed) this.explicitlyLoadedBlank = false
    }
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
    if (this.attached) {
      if (browserWindowCanRemoveChildView(this.window)) this.window.contentView.removeChildView(this.view)
      this.attached = false
    }
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
