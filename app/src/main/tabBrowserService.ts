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

function recoveryKey(item: BrowserStateFile['migrationRecovery'][number]): string {
  return `${item.workspace}\u0000${item.tab}\u0000${item.safeRestoreUrl}`
}

/** Apply only host-owned runtime changes, preserving transaction fields and records changed by another writer. */
export function applyBrowserRuntimeDelta(current: BrowserStateFile, previous: BrowserStateFile, runtime: BrowserStateFile): BrowserStateFile {
  const records = { ...current.records }
  for (const id of Object.keys(previous.records) as BrowserId[]) {
    if (!runtime.records[id] && JSON.stringify(current.records[id]) === JSON.stringify(previous.records[id])) delete records[id]
  }
  for (const [id, record] of Object.entries(runtime.records) as Array<[BrowserId, NonNullable<BrowserStateFile['records'][BrowserId]>]>) {
    if (JSON.stringify(previous.records[id]) !== JSON.stringify(record)) records[id] = record
  }
  const priorCounts = new Map<string, number>(); const nextCounts = new Map<string, number>()
  for (const item of previous.migrationRecovery) priorCounts.set(recoveryKey(item), (priorCounts.get(recoveryKey(item)) ?? 0) + 1)
  for (const item of runtime.migrationRecovery) nextCounts.set(recoveryKey(item), (nextCounts.get(recoveryKey(item)) ?? 0) + 1)
  const remove = new Map<string, number>()
  for (const [key, count] of priorCounts) if (count > (nextCounts.get(key) ?? 0)) remove.set(key, count - (nextCounts.get(key) ?? 0))
  const recovery = current.migrationRecovery.filter((item) => {
    const key = recoveryKey(item); const count = remove.get(key) ?? 0
    if (count === 0) return true
    remove.set(key, count - 1); return false
  })
  const currentCounts = new Map<string, number>()
  for (const item of recovery) currentCounts.set(recoveryKey(item), (currentCounts.get(recoveryKey(item)) ?? 0) + 1)
  for (const item of runtime.migrationRecovery) {
    const key = recoveryKey(item); const wanted = nextCounts.get(key) ?? 0; const have = currentCounts.get(key) ?? 0
    if (wanted > have) { recovery.push(item); currentCounts.set(key, have + 1) }
  }
  return { ...current, revision: current.revision + 1, profiles: runtime.profiles, records, migrationRecovery: recovery }
}

export class TabBrowserService {
  private readonly browserQueues = new Map<string, Promise<void>>()
  private readonly activationControllers = new Map<string, AbortController>()
  private eventSink: (event: unknown) => void = () => {}
  private persistQueue: Promise<void> = Promise.resolve()
  private persistedState: BrowserStateFile
  private suppressPersist = false

  private constructor(
    private readonly store: TabBrowserStateStore,
    private readonly pages: ElectronTabBrowserPageFactory,
    private readonly host: TabBrowserHost,
    initialState: BrowserStateFile,
  ) { this.persistedState = structuredClone(initialState) }

  static async create(root: string, window: BrowserWindow, store = new TabBrowserStateStore(root)): Promise<TabBrowserService> {
    const state = await store.load()
    const persistedState = structuredClone(state)
    // The persisted profile descriptor is authoritative. Falling back to a
    // constructor constant here silently reopens a different cookie/storage
    // partition after a compatibility migration.
    const pages = new ElectronTabBrowserPageFactory(window, state.profiles.global.partition)
    let service!: TabBrowserService
    const host = new TabBrowserHost(state, pages, Date.now, undefined, () => {
      void service.schedulePersist().catch((error) => console.error('tab browser state save failed', error))
    }, (event) => service.eventSink(event))
    service = new TabBrowserService(store, pages, host, persistedState)
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
    this.suppressPersist = true
    try { this.host.importWorkspace(entries, recovery) } finally { this.suppressPersist = false }
    this.persistedState = structuredClone(await this.store.load())
  }

  workspaceSnapshot(): ReturnType<TabBrowserHost['workspaceSnapshot']> { return this.host.workspaceSnapshot() }
  recoveryItems(): ReturnType<TabBrowserHost['recoveryItems']> { return this.host.recoveryItems() }
  async deleteRecovery(index: number): Promise<void> { this.host.deleteRecovery(index); await this.schedulePersist() }
  async attachRecovery(index: number, id: BrowserId): Promise<BrowserRuntimeStatus> {
    this.suppressPersist = true
    try { return this.host.attachRecovery(index, id) } finally { this.suppressPersist = false; this.persistedState = structuredClone(await this.store.load()) }
  }

  private schedulePersist(): Promise<void> {
    if (this.suppressPersist) return Promise.resolve()
    const runtime = this.host.snapshot()
    const save = this.persistQueue.then(async () => {
      const previous = this.persistedState
      await this.store.update((current) => applyBrowserRuntimeDelta(current, previous, runtime))
      this.persistedState = structuredClone(runtime)
    })
    this.persistQueue = save.catch(() => {})
    return save
  }

  command(command: TabBrowserCommand, signal?: AbortSignal, validate?: () => boolean | Promise<boolean>): Promise<BrowserRuntimeStatus | { closed: true }> {
    // Opens must reach the host concurrently so the global capacity FIFO sees
    // every contender. Observations and hide also cannot sit behind a wait.
    if (command.type === 'hide' || command.type === 'destroy') this.activationControllers.get(command.id)?.abort()
    if (command.type === 'open' || command.type === 'status' || command.type === 'hide' || command.type === 'destroy') return this.runCommand(command, signal, validate)
    if (command.type === 'close' || command.type === 'share' || command.type === 'designate') return Promise.reject(new Error('ASSOCIATION_COMMAND_REQUIRES_MAIN'))
    const key = command.id
    const prior = this.browserQueues.get(key) ?? Promise.resolve()
    const controller = command.type === 'show' ? new AbortController() : null
    if (controller) {
      this.activationControllers.get(command.id)?.abort(); this.activationControllers.set(command.id, controller)
      signal?.addEventListener('abort', () => controller.abort(), { once: true })
    }
    const result = prior.catch(() => {}).then(() => this.runCommand(command, controller?.signal ?? signal, validate))
    const tail = result.then(() => {}, () => {})
    this.browserQueues.set(key, tail)
    void tail.finally(() => { if (this.browserQueues.get(key) === tail) this.browserQueues.delete(key); if (controller && this.activationControllers.get(key) === controller) this.activationControllers.delete(key) })
    return result
  }

  private async runCommand(command: TabBrowserCommand, signal?: AbortSignal, validate?: () => boolean | Promise<boolean>): Promise<BrowserRuntimeStatus | { closed: true }> {
    if (validate && !(await validate())) throw new Error('STALE_BROWSER_CONTEXT')
    if (signal?.aborted) throw new Error('ACTION_CANCELLED')
    switch (command.type) {
      case 'open': {
        try {
          const opened = await this.host.open({ visible: true }, signal, validate); await this.schedulePersist(); return opened.status
        } catch (error) {
          // Capacity waiting can persist a provisional record through host events.
          // Do not reject until the compensating deletion is durable.
          await this.schedulePersist()
          throw error
        }
      }
      case 'show': {
        const before = this.host.status(command.id).stateRevision
        await this.host.thaw(command.id, signal, validate)
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
