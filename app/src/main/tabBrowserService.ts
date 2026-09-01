import type { BrowserWindow, Rectangle } from 'electron'
import { ElectronTabBrowserPageFactory } from './electronTabBrowserPage'
import { TabBrowserHost, type BrowserRuntimeStatus } from './tabBrowserHost'
import { TabBrowserStateStore } from './tabBrowserStateStore'

export type TabBrowserCommand =
  | { type: 'open' }
  | { type: 'show'; id: string; bounds: Rectangle }
  | { type: 'hide'; id: string }
  | { type: 'bounds'; id: string; bounds: Rectangle }
  | { type: 'navigate'; id: string; url: string; pageIncarnation: string; expectedGeneration: number }
  | { type: 'status'; id: string }
  | { type: 'close'; id: string }

export class TabBrowserService {
  private constructor(
    private readonly store: TabBrowserStateStore,
    private readonly pages: ElectronTabBrowserPageFactory,
    private readonly host: TabBrowserHost,
  ) {}

  static async create(root: string, window: BrowserWindow): Promise<TabBrowserService> {
    const store = new TabBrowserStateStore(root)
    const pages = new ElectronTabBrowserPageFactory(window)
    return new TabBrowserService(store, pages, new TabBrowserHost(await store.load(), pages))
  }

  setWindow(window: BrowserWindow): void { this.pages.setWindow(window) }

  private async persist(): Promise<void> { await this.store.save(this.host.snapshot()) }

  async command(command: TabBrowserCommand): Promise<BrowserRuntimeStatus | { closed: true }> {
    switch (command.type) {
      case 'open': {
        const opened = await this.host.open({ visible: true }); await this.persist(); return opened.status
      }
      case 'show': {
        const before = this.host.status(command.id).stateRevision
        await this.host.thaw(command.id)
        const status = this.host.show(command.id, command.bounds)
        if (status.stateRevision !== before) await this.persist()
        return status
      }
      case 'hide': this.host.hide(command.id); return this.host.status(command.id)
      case 'bounds': this.host.setBounds(command.id, command.bounds); return this.host.status(command.id)
      case 'navigate': {
        const status = await this.host.navigate(command.id, command.url, command.pageIncarnation, command.expectedGeneration)
        await this.persist(); return status
      }
      case 'status': return this.host.status(command.id)
      case 'close': this.host.close(command.id); await this.persist(); return { closed: true }
    }
  }
}

export function parseTabBrowserCommand(value: unknown): TabBrowserCommand {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('INVALID_REQUEST')
  const v = value as Record<string, unknown>
  if (v['type'] === 'open') return { type: 'open' }
  if (typeof v['id'] !== 'string') throw new Error('INVALID_REQUEST')
  if (v['type'] === 'hide' || v['type'] === 'status' || v['type'] === 'close') return { type: v['type'], id: v['id'] }
  if (v['type'] === 'show' || v['type'] === 'bounds') {
    const b = v['bounds'] as Record<string, unknown> | undefined
    if (!b || !['x', 'y', 'width', 'height'].every((key) => typeof b[key] === 'number' && Number.isFinite(b[key]))) throw new Error('INVALID_REQUEST')
    return { type: v['type'], id: v['id'], bounds: { x: b['x'] as number, y: b['y'] as number, width: b['width'] as number, height: b['height'] as number } }
  }
  if (v['type'] === 'navigate' && typeof v['url'] === 'string' && typeof v['pageIncarnation'] === 'string' && typeof v['expectedGeneration'] === 'number') {
    return { type: 'navigate', id: v['id'], url: v['url'], pageIncarnation: v['pageIncarnation'], expectedGeneration: v['expectedGeneration'] }
  }
  throw new Error('INVALID_REQUEST')
}
