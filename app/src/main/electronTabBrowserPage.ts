import { WebContentsView, session, type BrowserWindow, type Rectangle, type Session } from 'electron'
import { browserWebPreferences, isAllowedBrowserUrl } from './tabBrowserPolicy'
import type { BrowserId } from '../shared/tabBrowser'
import type { TabBrowserPage, TabBrowserPageFactory } from './tabBrowserHost'

export function hardenBrowserSession(browserSession: Session): void {
  browserSession.setPermissionCheckHandler(() => false)
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
}

export class ElectronTabBrowserPage implements TabBrowserPage {
  readonly view: WebContentsView
  private attached = false
  private bounds: Rectangle = { x: 0, y: 0, width: 1, height: 1 }
  constructor(private readonly window: BrowserWindow, partition: string) {
    const browserSession = session.fromPartition(partition)
    hardenBrowserSession(browserSession)
    this.view = new WebContentsView({ webPreferences: browserWebPreferences(partition) })
    this.view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.view.webContents.on('will-navigate', (event, url) => { if (!isAllowedBrowserUrl(url)) event.preventDefault() })
  }
  async loadURL(url: string): Promise<void> {
    if (!isAllowedBrowserUrl(url)) throw new Error('NAVIGATION_BLOCKED')
    await this.view.webContents.loadURL(url)
  }
  setBounds(bounds: Rectangle): void { this.bounds = bounds; if (this.attached) this.view.setBounds(bounds) }
  show(): void {
    if (!this.attached) { this.window.contentView.addChildView(this.view); this.attached = true }
    this.view.setBounds(this.bounds)
  }
  hide(): void {
    if (this.attached) { this.window.contentView.removeChildView(this.view); this.attached = false }
  }
  destroy(): void { this.hide(); if (!this.view.webContents.isDestroyed()) this.view.webContents.close() }
}

export class ElectronTabBrowserPageFactory implements TabBrowserPageFactory {
  readonly pages = new Map<BrowserId, ElectronTabBrowserPage>()
  constructor(private readonly window: BrowserWindow, private readonly partition = 'persist:amber-browser') {}
  create(id: BrowserId): ElectronTabBrowserPage {
    const page = new ElectronTabBrowserPage(this.window, this.partition)
    this.pages.set(id, page)
    return page
  }
}
