import { randomUUID } from 'node:crypto'
import { BrowserCapacity } from './tabBrowserPolicy'
import { createBrowserId, isOpaqueBrowserId, safeRestoreUrl, type BrowserId } from '../shared/tabBrowser'
import type { BrowserRecord, BrowserStateFile } from '../shared/tabBrowserState'

export interface TabBrowserPage {
  loadURL(url: string): Promise<void>
  show(): void
  hide(): void
  destroy(): void
}
export interface TabBrowserPageFactory { create(id: BrowserId): TabBrowserPage }
export interface BrowserRuntimeStatus extends BrowserRecord { pageIncarnation: string; generation: number; loading: boolean }
interface Runtime { page: TabBrowserPage; incarnation: string; generation: number; loading: boolean }

export class TabBrowserHost {
  private readonly capacity = new BrowserCapacity(4)
  private readonly runtimes = new Map<BrowserId, Runtime>()
  constructor(
    private readonly state: BrowserStateFile,
    private readonly pages: TabBrowserPageFactory,
    private readonly now = Date.now,
    private readonly randomBytes?: () => Uint8Array,
  ) {}

  private record(id: string): BrowserRecord {
    if (!isOpaqueBrowserId(id)) throw new Error('NO_BROWSER_FOR_TAB')
    const record = this.state.records[id]
    if (!record) throw new Error('NO_BROWSER_FOR_TAB')
    return record
  }

  private makeRuntime(id: BrowserId): Runtime {
    const page = this.pages.create(id)
    const runtime = { page, incarnation: randomUUID(), generation: 0, loading: false }
    this.runtimes.set(id, runtime)
    this.capacity.markLive(id, this.now())
    return runtime
  }

  async open(options: { visible: boolean }): Promise<{ status: BrowserRuntimeStatus; page: TabBrowserPage }> {
    const id = createBrowserId(this.randomBytes)
    const at = this.now()
    this.state.records[id] = {
      id, profileId: 'global', mode: 'browse', safeRestoreUrl: 'about:blank', title: '',
      viewport: { width: 1280, height: 800 }, lifecycle: 'live', stateRevision: 1,
      lastUsedAt: at, lastFocusedAt: options.visible ? at : 0,
    }
    const activation = this.capacity.activate(id, at)
    if (activation.busy) { delete this.state.records[id]; throw new Error('BROWSER_CAPACITY_BUSY') }
    if (activation.freeze && isOpaqueBrowserId(activation.freeze)) this.freeze(activation.freeze)
    const runtime = this.makeRuntime(id)
    if (options.visible) runtime.page.show(); else runtime.page.hide()
    return { status: this.status(id), page: runtime.page }
  }

  status(id: string): BrowserRuntimeStatus {
    const record = this.record(id)
    const runtime = this.runtimes.get(record.id)
    return { ...record, pageIncarnation: runtime?.incarnation ?? '', generation: runtime?.generation ?? 0, loading: runtime?.loading ?? false }
  }

  async navigate(id: string, url: string, incarnation: string, generation: number): Promise<BrowserRuntimeStatus> {
    const record = this.record(id)
    const runtime = this.runtimes.get(record.id)
    if (!runtime || runtime.incarnation !== incarnation || runtime.generation !== generation) throw new Error('STALE_GENERATION')
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('NAVIGATION_BLOCKED')
    runtime.generation += 1
    runtime.loading = true
    try { await runtime.page.loadURL(parsed.href) } finally { runtime.loading = false }
    record.safeRestoreUrl = safeRestoreUrl(parsed.href)
    record.lastUsedAt = this.now(); record.stateRevision += 1
    return this.status(record.id)
  }

  freeze(id: string): void {
    const record = this.record(id)
    this.runtimes.get(record.id)?.page.destroy()
    this.runtimes.delete(record.id)
    this.capacity.markFrozen(record.id)
    record.lifecycle = 'frozen'; record.stateRevision += 1
  }

  async thaw(id: string): Promise<BrowserRuntimeStatus> {
    const record = this.record(id)
    if (this.runtimes.has(record.id)) return this.status(record.id)
    const activation = this.capacity.activate(record.id, this.now())
    if (activation.busy) throw new Error('BROWSER_CAPACITY_BUSY')
    if (activation.freeze && isOpaqueBrowserId(activation.freeze)) this.freeze(activation.freeze)
    const runtime = this.makeRuntime(record.id)
    record.lifecycle = 'live'; record.stateRevision += 1
    if (record.safeRestoreUrl !== 'about:blank') await runtime.page.loadURL(record.safeRestoreUrl)
    return this.status(record.id)
  }

  close(id: string): void {
    const record = this.record(id)
    this.runtimes.get(record.id)?.page.destroy()
    this.runtimes.delete(record.id); this.capacity.markFrozen(record.id)
    delete this.state.records[record.id]
  }

  snapshot(): BrowserStateFile { return structuredClone(this.state) }
}
