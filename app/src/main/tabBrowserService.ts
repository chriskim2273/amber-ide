import type { BrowserWindow, Rectangle } from 'electron'
import { ElectronTabBrowserPageFactory } from './electronTabBrowserPage'
import { TabBrowserHost, type BrowserRuntimeStatus } from './tabBrowserHost'
import { isOpaqueBrowserId, safeRestoreUrl, type BrowserId } from '../shared/tabBrowser'
import type { WsBrowser } from '../shared/workspaceFile'
import { TabBrowserStateStore } from './tabBrowserStateStore'
import type { BrowserStateFile } from '../shared/tabBrowserState'

export type TabBrowserCommand =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'share'; sharedWithPi: boolean }
  | { type: 'designate'; designatedPi?: string }
  | { type: 'show'; id: string; bounds: Rectangle }
  | { type: 'hide'; id: string }
  | { type: 'bounds'; id: string; bounds: Rectangle }
  | { type: 'navigate'; id: string; url: string; pageIncarnation: string; expectedGeneration: number }
  | { type: 'status'; id: string }
  | { type: 'stop'; id: string }
  | { type: 'destroy'; id: string }

export interface WorkspaceBrowserImport { entries: { id: BrowserId; browser: WsBrowser }[]; recovery: { ws: number; tab: number; browser: WsBrowser }[] }

export function stageWorkspaceBrowserState(state: BrowserStateFile, input: WorkspaceBrowserImport, now = Date.now()): BrowserStateFile {
  const records = { ...state.records }
  for (const { id, browser } of input.entries) {
    if (records[id]) throw new Error('BROWSER_ID_COLLISION')
    records[id] = { id, profileId: 'global', mode: browser.mode, safeRestoreUrl: safeRestoreUrl(browser.safeRestoreUrl), title: '',
      viewport: browser.viewport ?? { width: 1280, height: 800 }, lifecycle: 'frozen', stateRevision: 1, lastUsedAt: now, lastFocusedAt: 0 }
  }
  if (state.migrationRecovery.length + input.recovery.length > 100) throw new Error('BROWSER_RECOVERY_LIMIT')
  return { ...state, records, migrationRecovery: [...state.migrationRecovery, ...input.recovery.map((item) => ({ workspace: item.ws, tab: item.tab, safeRestoreUrl: safeRestoreUrl(item.browser.safeRestoreUrl) }))] }
}

export class TabBrowserService {
  private readonly browserQueues = new Map<string, Promise<void>>()
  private eventSink: (event: unknown) => void = () => {}
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
    }, (event) => service.eventSink(event))
    service = new TabBrowserService(store, pages, host)
    return service
  }

  setWindow(window: BrowserWindow): void { this.pages.setWindow(window) }
  setEventSink(sink: (event: unknown) => void): void { this.eventSink = sink }

  async importWorkspaceBrowsers(input: WorkspaceBrowserImport): Promise<void> {
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
  recoveryItems(): ReturnType<TabBrowserHost['recoveryItems']> { return this.host.recoveryItems() }
  async deleteRecovery(index: number): Promise<void> { this.host.deleteRecovery(index); await this.schedulePersist() }
  async attachRecovery(index: number, id: BrowserId): Promise<BrowserRuntimeStatus> { const status = this.host.attachRecovery(index, id); await this.schedulePersist(); return status }

  private schedulePersist(): Promise<void> {
    const save = this.persistQueue.then(() => {
      const runtime = this.host.snapshot()
      return this.store.update((current) => ({
        ...current,
        revision: current.revision + 1,
        profiles: runtime.profiles,
        records: runtime.records,
        migrationRecovery: runtime.migrationRecovery.length >= current.migrationRecovery.length ? runtime.migrationRecovery : current.migrationRecovery,
      }))
    })
    this.persistQueue = save.catch(() => {})
    return save
  }

  command(command: TabBrowserCommand, signal?: AbortSignal): Promise<BrowserRuntimeStatus | { closed: true }> {
    // Opens must reach the host concurrently so the global capacity FIFO sees
    // every contender. Observations and hide also cannot sit behind a wait.
    if (command.type === 'open' || command.type === 'status' || command.type === 'hide' || command.type === 'destroy') return this.runCommand(command, signal)
    if (command.type === 'close' || command.type === 'share' || command.type === 'designate') return Promise.reject(new Error('ASSOCIATION_COMMAND_REQUIRES_MAIN'))
    const key = command.id
    const prior = this.browserQueues.get(key) ?? Promise.resolve()
    const result = prior.catch(() => {}).then(() => this.runCommand(command, signal))
    const tail = result.then(() => {}, () => {})
    this.browserQueues.set(key, tail)
    void tail.finally(() => { if (this.browserQueues.get(key) === tail) this.browserQueues.delete(key) })
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
      case 'destroy': this.host.close(command.id); await this.schedulePersist(); return { closed: true }
      case 'close': case 'share': case 'designate': throw new Error('ASSOCIATION_COMMAND_REQUIRES_MAIN')
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
  if (v['type'] === 'open' || v['type'] === 'close') {
    if (!exact(v, ['type'])) throw new Error('INVALID_REQUEST')
    return { type: v['type'] }
  }
  if (v['type'] === 'share' && exact(v, ['type', 'sharedWithPi']) && typeof v['sharedWithPi'] === 'boolean') return { type: 'share', sharedWithPi: v['sharedWithPi'] }
  if (v['type'] === 'designate' && (exact(v, ['type']) || exact(v, ['type', 'designatedPi']))) {
    if (v['designatedPi'] !== undefined && (typeof v['designatedPi'] !== 'string' || v['designatedPi'].length > 256)) throw new Error('INVALID_REQUEST')
    return { type: 'designate', ...(typeof v['designatedPi'] === 'string' ? { designatedPi: v['designatedPi'] } : {}) }
  }
  if (typeof v['id'] !== 'string' || !isOpaqueBrowserId(v['id'])) throw new Error('INVALID_REQUEST')
  if (v['type'] === 'hide' || v['type'] === 'status' || v['type'] === 'stop') {
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
