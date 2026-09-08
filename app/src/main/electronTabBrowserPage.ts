import { BrowserWindow, WebContentsView, session, screen, type Input, type MouseInputEvent, type Rectangle, type Session } from 'electron'
import { browserWebPreferences, isAllowedBrowserUrl } from './tabBrowserPolicy'
import type { BrowserId } from '../shared/tabBrowser'
import type { TabBrowserPage, TabBrowserPageEvent, TabBrowserPageFactory } from './tabBrowserHost'
import { BrowserAutomation, type BrowserBinaryAttachment, type BrowserDebuggerTransport } from './browserAutomation'
import type { RemoteInputEvent } from './remoteBrowserInput'
import { encodeRemoteFrame, remoteSurfaceOptions } from './remoteBrowserFrame'

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

const guestCloseDepth = new WeakMap<object, number>()

/** A guest WebContents is closing. Owner-window `close` must not hide or quit. */
export function noteGuestWebContentsClosing(owner: object): void {
  guestCloseDepth.set(owner, (guestCloseDepth.get(owner) ?? 0) + 1)
}

export function guestWebContentsCloseFinished(owner: object): void {
  const n = guestCloseDepth.get(owner) ?? 0
  if (n <= 1) guestCloseDepth.delete(owner)
  else guestCloseDepth.set(owner, n - 1)
}

export function ownerWindowCloseIsFromGuest(owner: object): boolean {
  return (guestCloseDepth.get(owner) ?? 0) > 0
}

/**
 * Electron maps `webContents.close()` onto the owner BrowserWindow's close
 * path (the same page-close used by the window chrome). Mark that close as
 * guest-owned *before* calling close() so a still-alive Amber window is
 * ignored rather than hidden or quit.
 */
export function closeGuestWebContents(
  owner: object & Pick<BrowserWindow, 'isDestroyed'>,
  contents: { isDestroyed(): boolean; close: () => void },
): void {
  if (contents.isDestroyed()) return
  if (!owner.isDestroyed() && !ownerWindowCloseIsFromGuest(owner)) noteGuestWebContentsClosing(owner)
  contents.close()
}

export function shouldHideLocalWindowOnClose(opts: {
  hostEnabled: boolean
  isLocal: boolean
  allowFinalQuit: boolean
  fromGuestWebContents: boolean
}): 'hide' | 'allow-close' | 'ignore' {
  if (opts.allowFinalQuit) return 'allow-close'
  if (opts.fromGuestWebContents) return 'ignore'
  if (opts.hostEnabled && opts.isLocal) return 'hide'
  return 'allow-close'
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
  private lastEncoded: BrowserBinaryAttachment | null = null
  private capturing: Promise<BrowserBinaryAttachment | null> | null = null
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
      send: async (method, params) => {
        const command = Promise.resolve(contents.debugger.sendCommand(method, params)) as Promise<Record<string, unknown>>
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          return await Promise.race([
            command,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error('ACTION_TIMEOUT')), 8_000)
            }),
          ])
        } finally { if (timer) clearTimeout(timer) }
      },
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
    // whether that document is about:blank or a navigated page. This also avoids
    // the constructor-attachment hang affecting remote show/frame.
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
    // A page `window.close()` (or our own close after the owner is gone) must
    // not be treated as Amber's window chrome. Depth is held until `destroyed`
    // because Electron posts the actual teardown off this turn.
    contents.on('close', () => {
      if (this.window.isDestroyed() || ownerWindowCloseIsFromGuest(this.window)) return
      noteGuestWebContentsClosing(this.window)
    })
    contents.on('destroyed', () => { if (!this.window.isDestroyed()) guestWebContentsCloseFinished(this.window) })
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
  async captureFrame(signal?: AbortSignal): Promise<BrowserBinaryAttachment> {
    if (signal?.aborted) throw new Error('ACTION_CANCELLED')
    if (!this.attached) this.show()
    if (!this.capturing) this.capturing = this.captureNow().finally(() => { this.capturing = null })
    if (this.lastEncoded) return this.lastEncoded
    const encoded = await this.capturing
    if (signal?.aborted) throw new Error('ACTION_CANCELLED')
    if (!encoded) throw new Error('BROWSER_FROZEN')
    return encoded
  }
  private async captureNow(): Promise<BrowserBinaryAttachment | null> {
    const width = Math.max(2, this.bounds.width)
    const height = Math.max(2, this.bounds.height)
    if (this.bounds.width < 2 || this.bounds.height < 2) this.setBounds({ ...this.bounds, width, height })
    const view = { width: this.bounds.width, height: this.bounds.height, pageX: 0, pageY: 0 }
    const shot = await this.window.capturePage({
      x: Math.max(0, this.bounds.x),
      y: Math.max(0, this.bounds.y),
      width,
      height,
    })
    const encoded = encodeRemoteFrame(shot)
    if (!encoded) return null
    const frame = { ...encoded, viewport: view }
    this.lastEncoded = frame
    return frame
  }
  dispatchRemoteInput(events: RemoteInputEvent[]): void {
    const contents = this.view.webContents
    contents.focus()
    for (const event of events) {
      if (event.type === 'insertText') {
        contents.insertText(event.text)
        continue
      }
      contents.sendInputEvent({
        type: event.type === 'mouseMove' ? 'mouseMove' : event.type === 'mouseDown' ? 'mouseDown' : 'mouseUp',
        x: event.x,
        y: event.y,
        button: event.button,
        clickCount: event.clickCount,
      })
    }
  }
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
  destroy(): void {
    this.disposing = true
    this.automation.dispose()
    this.hide()
    closeGuestWebContents(this.window, this.view.webContents)
    this.onDestroy()
  }
}

export class ElectronTabBrowserPageFactory implements TabBrowserPageFactory {
  readonly pages = new Map<BrowserId, ElectronTabBrowserPage>()
  private remoteSurface: BrowserWindow | null = null
  constructor(private window: BrowserWindow, private readonly partition = 'persist:amber-browser') {}
  setWindow(window: BrowserWindow): void { this.window = window; for (const page of this.pages.values()) page.setWindow(window) }
  presentRemote(id: BrowserId, bounds: { width: number; height: number }): void {
    const surface = this.ensureRemoteSurface(bounds.width, bounds.height)
    const page = this.pages.get(id)
    page?.setWindow(surface)
  }
  presentLocal(id: BrowserId): void {
    this.pages.get(id)?.setWindow(this.window)
  }
  closeRemoteSurface(): void {
    if (!this.remoteSurface || this.remoteSurface.isDestroyed()) { this.remoteSurface = null; return }
    this.remoteSurface.destroy()
    this.remoteSurface = null
  }
  private ensureRemoteSurface(width: number, height: number): BrowserWindow {
    if (this.remoteSurface && !this.remoteSurface.isDestroyed()) {
      this.remoteSurface.setContentSize(Math.max(2, Math.round(width)), Math.max(2, Math.round(height)))
      return this.remoteSurface
    }
    const surface = new BrowserWindow(remoteSurfaceOptions(width, height))
    surface.setMenuBarVisibility(false)
    surface.setPosition(-2400, -2400)
    surface.showInactive()
    this.remoteSurface = surface
    return surface
  }
  create(id: BrowserId, onUserInput: () => void, onPageEvent: (event: TabBrowserPageEvent) => void, allowNavigation: (url: string) => boolean): ElectronTabBrowserPage {
    const page = new ElectronTabBrowserPage(this.window, this.partition, onUserInput, onPageEvent, allowNavigation, () => this.pages.delete(id))
    this.pages.set(id, page)
    return page
  }
}
