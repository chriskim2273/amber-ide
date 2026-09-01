import type { BrowserWindow, Rectangle } from 'electron'
import { ElectronTabBrowserPageFactory } from './electronTabBrowserPage'
import { TabBrowserHost, type BrowserRuntimeStatus } from './tabBrowserHost'
import { isOpaqueBrowserId, safeRestoreUrl, type BrowserId } from '../shared/tabBrowser'
import type { WsBrowser } from '../shared/workspaceFile'
import { TabBrowserStateStore } from './tabBrowserStateStore'

export type TabBrowserCommand =
  | { type: 'open' }
  | { type: 'show'; id: string; bounds: Rectangle }
  | { type: 'hide'; id: string }
  | { type: 'bounds'; id: string; bounds: Rectangle }
  | { type: 'navigate'; id: string; url: string; pageIncarnation: string; expectedGeneration: number }
  | { type: 'status'; id: string }
  | { type: 'stop'; id: string }
  | { type: 'close'; id: string }

export class TabBrowserService {
  private commandQueue: Promise<void> = Promise.resolve()
  private persistQueue: Promise<void> = Promise.resolve()

  private constructor(
    private readonly store: TabBrowserStateStore,
    private readonly pages: ElectronTabBrowserPageFactory,
    private readonly host: TabBrowserHost,
  ) {}

  static async create(root: string, window: BrowserWindow, store = new TabBrowserStateStore(root)): Promise<TabBrowserService> {
    const state = await store.load()
    // The persisted profile descriptor is authoritative. Falling back to a
    // constructor constant here silently reopens a different cookie/storage
    // partition after a compatibility migration.
    const pages = new ElectronTabBrowserPageFactory(window, state.profiles.global.partition)
    let service!: TabBrowserService
    const host = new TabBrowserHost(state, pages, Date.now, undefined, () => {
      void service.schedulePersist().catch((error) => console.error('tab browser state save failed', error))
    })
    service = new TabBrowserService(store, pages, host)
    return service
  }

  setWindow(window: BrowserWindow): void { this.pages.setWindow(window) }

  async importWorkspaceBrowsers(input: { entries: { id: BrowserId; browser: WsBrowser }[]; recovery: { ws: number; tab: number; browser: WsBrowser }[] }): Promise<void> {
    const { entries, recovery } = input
    const ids = new Set<string>()
    for (const entry of entries) {
      if (!isOpaqueBrowserId(entry.id) || ids.has(entry.id)) throw new Error('BROWSER_ID_COLLISION')
      ids.add(entry.id)
      if (entry.browser.mode !== 'preview' && entry.browser.mode !== 'browse') throw new Error('INVALID_REQUEST')
    }
    this.host.importWorkspace(entries, recovery)
    await this.schedulePersist()
  }

  workspaceSnapshot(): ReturnType<TabBrowserHost['workspaceSnapshot']> { return this.host.workspaceSnapshot() }

  private schedulePersist(): Promise<void> {
    const save = this.persistQueue.then(() => this.store.save(this.host.snapshot()))
    this.persistQueue = save.catch(() => {})
    return save
  }

  async command(command: TabBrowserCommand, signal?: AbortSignal): Promise<BrowserRuntimeStatus | { closed: true }> {
    // Observations and capacity-releasing commands must not sit behind an
    // activation wait; otherwise four visible/protected pages can deadlock.
    if (command.type === 'status' || command.type === 'hide' || command.type === 'close') return this.runCommand(command, signal)
    let resolve!: (value: BrowserRuntimeStatus | { closed: true }) => void
    let reject!: (reason: unknown) => void
    const result = new Promise<BrowserRuntimeStatus | { closed: true }>((ok, fail) => { resolve = ok; reject = fail })
    const run = this.commandQueue.then(async () => {
      try { resolve(await this.runCommand(command, signal)) } catch (error) { reject(error) }
    })
    this.commandQueue = run.catch(() => {})
    return result
  }

  private async runCommand(command: TabBrowserCommand, signal?: AbortSignal): Promise<BrowserRuntimeStatus | { closed: true }> {
    switch (command.type) {
      case 'open': {
        const opened = await this.host.open({ visible: true }, signal); await this.schedulePersist(); return opened.status
      }
      case 'show': {
        const before = this.host.status(command.id).stateRevision
        await this.host.thaw(command.id, signal)
        const status = this.host.show(command.id, command.bounds)
        if (status.stateRevision !== before) await this.schedulePersist()
        return status
      }
      case 'hide': this.host.hide(command.id); return this.host.status(command.id)
      case 'bounds': this.host.setBounds(command.id, command.bounds); return this.host.status(command.id)
      case 'navigate': {
        const status = await this.host.navigate(command.id, command.url, command.pageIncarnation, command.expectedGeneration, signal)
        await this.schedulePersist(); return status
      }
      case 'status': return this.host.status(command.id)
      case 'stop': return this.host.stop(command.id)
      case 'close': this.host.close(command.id); await this.schedulePersist(); return { closed: true }
    }
  }
}

function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

export function parseWorkspaceBrowserImports(value: unknown): { entries: { id: BrowserId; browser: WsBrowser }[]; recovery: { ws: number; tab: number; browser: WsBrowser }[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('INVALID_REQUEST')
  const input = value as Record<string, unknown>
  if (!exact(input, ['entries', 'recovery']) || !Array.isArray(input['entries']) || input['entries'].length > 100 || !Array.isArray(input['recovery']) || input['recovery'].length > 100) throw new Error('INVALID_REQUEST')
  const parseBrowser = (browser: unknown): WsBrowser => {
    if (typeof browser !== 'object' || browser === null || Array.isArray(browser)) throw new Error('INVALID_REQUEST')
    const b = browser as Record<string, unknown>
    if (b['mode'] !== 'preview' && b['mode'] !== 'browse') throw new Error('INVALID_REQUEST')
    if (typeof b['safeRestoreUrl'] !== 'string' || b['safeRestoreUrl'].length > 8192) throw new Error('INVALID_REQUEST')
    const viewport = b['viewport']
    const viewportObject = typeof viewport === 'object' && viewport !== null && !Array.isArray(viewport) ? viewport as Record<string, unknown> : undefined
    if (viewport !== undefined && (!viewportObject || typeof viewportObject['width'] !== 'number' || !Number.isFinite(viewportObject['width'])
        || typeof viewportObject['height'] !== 'number' || !Number.isFinite(viewportObject['height']))) throw new Error('INVALID_REQUEST')
    return { mode: b['mode'], safeRestoreUrl: safeRestoreUrl(b['safeRestoreUrl']),
      ...(viewportObject ? { viewport: { width: Math.min(4096, Math.max(320, viewportObject['width'] as number)), height: Math.min(4096, Math.max(240, viewportObject['height'] as number)) } } : {}) }
  }
  const entries = input['entries'].map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('INVALID_REQUEST')
    const v = entry as Record<string, unknown>
    if (!exact(v, ['id', 'browser']) || !isOpaqueBrowserId(v['id'])) throw new Error('INVALID_REQUEST')
    return { id: v['id'], browser: parseBrowser(v['browser']) }
  })
  const recovery = input['recovery'].map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('INVALID_REQUEST')
    const v = entry as Record<string, unknown>
    if (!exact(v, ['ws', 'tab', 'browser']) || typeof v['ws'] !== 'number' || !Number.isSafeInteger(v['ws']) || typeof v['tab'] !== 'number' || !Number.isSafeInteger(v['tab'])) throw new Error('INVALID_REQUEST')
    return { ws: v['ws'], tab: v['tab'], browser: parseBrowser(v['browser']) }
  })
  return { entries, recovery }
}

export function parseTabBrowserCommand(value: unknown): TabBrowserCommand {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('INVALID_REQUEST')
  const v = value as Record<string, unknown>
  if (v['type'] === 'open') {
    if (!exact(v, ['type'])) throw new Error('INVALID_REQUEST')
    return { type: 'open' }
  }
  if (typeof v['id'] !== 'string' || !isOpaqueBrowserId(v['id'])) throw new Error('INVALID_REQUEST')
  if (v['type'] === 'hide' || v['type'] === 'status' || v['type'] === 'stop' || v['type'] === 'close') {
    if (!exact(v, ['type', 'id'])) throw new Error('INVALID_REQUEST')
    return { type: v['type'], id: v['id'] }
  }
  if (v['type'] === 'show' || v['type'] === 'bounds') {
    if (!exact(v, ['type', 'id', 'bounds'])) throw new Error('INVALID_REQUEST')
    const b = v['bounds'] as Record<string, unknown> | undefined
    if (!b || !exact(b, ['x', 'y', 'width', 'height'])) throw new Error('INVALID_REQUEST')
    const values = ['x', 'y', 'width', 'height'].map((key) => b[key])
    if (!values.every((entry) => typeof entry === 'number' && Number.isSafeInteger(entry))) throw new Error('INVALID_REQUEST')
    const [x, y, width, height] = values as number[]
    if (Math.abs(x!) > 100_000 || Math.abs(y!) > 100_000 || width! < 1 || height! < 1 || width! > 16_384 || height! > 16_384) throw new Error('INVALID_REQUEST')
    return { type: v['type'], id: v['id'], bounds: { x: x!, y: y!, width: width!, height: height! } }
  }
  if (v['type'] === 'navigate' && exact(v, ['type', 'id', 'url', 'pageIncarnation', 'expectedGeneration'])
      && typeof v['url'] === 'string' && v['url'].length <= 8192 && typeof v['pageIncarnation'] === 'string' && v['pageIncarnation'].length <= 128
      && typeof v['expectedGeneration'] === 'number' && Number.isSafeInteger(v['expectedGeneration']) && v['expectedGeneration'] >= 0) {
    return { type: 'navigate', id: v['id'], url: v['url'], pageIncarnation: v['pageIncarnation'], expectedGeneration: v['expectedGeneration'] }
  }
  throw new Error('INVALID_REQUEST')
}
