import { randomUUID } from 'node:crypto'
import { BrowserCapacity } from './tabBrowserPolicy'
import { createBrowserId, isOpaqueBrowserId, safeRestoreUrl, type BrowserId } from '../shared/tabBrowser'
import type { BrowserRecord, BrowserStateFile } from '../shared/tabBrowserState'

export type TabBrowserPageEvent =
  | { type: 'navigation-started' }
  | { type: 'navigation-committed'; url: string }
  | { type: 'loading-stopped' }
  | { type: 'title'; title: string }
  | { type: 'crashed'; reason: string }

export interface TabBrowserPage {
  loadURL(url: string): Promise<void>
  show(): void
  hide(): void
  stop(): void
  setBounds?(bounds: { x: number; y: number; width: number; height: number }): void
  destroy(): void
}
export interface TabBrowserPageFactory {
  create(id: BrowserId, onUserInput: () => void, onPageEvent: (event: TabBrowserPageEvent) => void): TabBrowserPage
}
export interface BrowserRuntimeStatus extends BrowserRecord { pageIncarnation: string; generation: number; loading: boolean; capacityWaiting?: boolean }
export type TabBrowserHostEvent = { type: 'capacity-wait'; id: BrowserId; waiting: boolean }
interface Runtime { page: TabBrowserPage; incarnation: string; generation: number; loading: boolean }

export class TabBrowserHost {
  private readonly capacity = new BrowserCapacity(4)
  private readonly runtimes = new Map<BrowserId, Runtime>()
  private readonly capacityWaiting = new Set<BrowserId>()
  constructor(
    private readonly state: BrowserStateFile,
    private readonly pages: TabBrowserPageFactory,
    private readonly now = Date.now,
    private readonly randomBytes?: () => Uint8Array,
    private readonly onStateChange: () => void = () => {},
    private readonly onEvent: (event: TabBrowserHostEvent) => void = () => {},
  ) {
    // A persisted `live` bit cannot mean a renderer survived process death.
    // Restore records frozen and recreate a page only on explicit activation.
    for (const record of Object.values(this.state.records)) if (record) record.lifecycle = 'frozen'
  }

  private record(id: string): BrowserRecord {
    if (!isOpaqueBrowserId(id)) throw new Error('NO_BROWSER_FOR_TAB')
    const record = this.state.records[id]
    if (!record) throw new Error('NO_BROWSER_FOR_TAB')
    return record
  }

  private makeRuntime(id: BrowserId): Runtime {
    let runtime!: Runtime
    const page = this.pages.create(
      id,
      () => { runtime.generation += 1; this.onStateChange() },
      (event) => this.pageEvent(id, runtime, event),
    )
    runtime = { page, incarnation: randomUUID(), generation: 0, loading: false }
    this.runtimes.set(id, runtime)
    this.capacity.markLive(id, this.now())
    return runtime
  }

  private pageEvent(id: BrowserId, runtime: Runtime, event: TabBrowserPageEvent): void {
    if (this.runtimes.get(id) !== runtime) return
    const record = this.record(id)
    if (event.type === 'navigation-started') {
      if (!runtime.loading) runtime.generation += 1
      runtime.loading = true
    } else if (event.type === 'navigation-committed') {
      runtime.loading = false
      record.safeRestoreUrl = safeRestoreUrl(event.url)
      record.lastUsedAt = this.now()
      record.stateRevision += 1
    } else if (event.type === 'loading-stopped') {
      runtime.loading = false
    } else if (event.type === 'title') {
      record.title = event.title.slice(0, 512)
      record.stateRevision += 1
    } else {
      runtime.loading = false
      runtime.page.destroy()
      this.runtimes.delete(id)
      this.capacity.markFrozen(id)
      record.lifecycle = 'frozen'
      record.restoreError = `Page crashed: ${event.reason}`.slice(0, 1024)
      record.stateRevision += 1
    }
    this.onStateChange()
  }

  async open(options: { visible: boolean }, signal?: AbortSignal): Promise<{ status: BrowserRuntimeStatus; page: TabBrowserPage }> {
    const id = createBrowserId(this.randomBytes)
    const at = this.now()
    this.state.records[id] = {
      id, profileId: 'global', mode: 'browse', safeRestoreUrl: 'about:blank', title: '',
      viewport: { width: 1280, height: 800 }, lifecycle: 'live', stateRevision: 1,
      lastUsedAt: at, lastFocusedAt: options.visible ? at : 0,
    }
    let activation: { freeze?: string }
    try { activation = await this.capacity.activateQueued(id, at, signal, (waiting) => this.capacityEvent(id, waiting)) }
    catch (error) { delete this.state.records[id]; throw error }
    if (activation.freeze && isOpaqueBrowserId(activation.freeze)) this.freeze(activation.freeze)
    const runtime = this.makeRuntime(id)
    this.capacity.settleActivation(id)
    if (options.visible) {
      for (const [otherId, other] of this.runtimes) if (otherId !== id) { other.page.hide(); this.capacity.protect(otherId, false) }
      runtime.page.show(); this.capacity.protect(id, true)
    } else runtime.page.hide()
    return { status: this.status(id), page: runtime.page }
  }

  private capacityEvent(id: BrowserId, waiting: boolean): void {
    if (waiting) this.capacityWaiting.add(id); else this.capacityWaiting.delete(id)
    this.onEvent({ type: 'capacity-wait', id, waiting }); this.onStateChange()
  }

  status(id: string): BrowserRuntimeStatus {
    const record = this.record(id)
    const runtime = this.runtimes.get(record.id)
    return { ...record, pageIncarnation: runtime?.incarnation ?? '', generation: runtime?.generation ?? 0, loading: runtime?.loading ?? false, ...(this.capacityWaiting.has(record.id) ? { capacityWaiting: true } : {}) }
  }

  show(id: string, bounds?: { x: number; y: number; width: number; height: number }): BrowserRuntimeStatus {
    const record = this.record(id); const runtime = this.runtimes.get(record.id)
    if (!runtime) throw new Error('BROWSER_FROZEN')
    if (bounds) runtime.page.setBounds?.(bounds)
    for (const [otherId, other] of this.runtimes) if (otherId !== record.id) { other.page.hide(); this.capacity.protect(otherId, false) }
    runtime.page.show(); this.capacity.protect(record.id, true)
    record.lastFocusedAt = this.now(); this.capacity.touch(record.id, record.lastFocusedAt)
    return this.status(record.id)
  }

  hide(id: string): void { const record = this.record(id); this.runtimes.get(record.id)?.page.hide(); this.capacity.protect(record.id, false) }

  setBounds(id: string, bounds: { x: number; y: number; width: number; height: number }): void {
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width < 1 || bounds.height < 1) throw new Error('INVALID_BOUNDS')
    const record = this.record(id); this.runtimes.get(record.id)?.page.setBounds?.(bounds)
  }

  async navigate(id: string, url: string, incarnation: string, generation: number, signal?: AbortSignal): Promise<BrowserRuntimeStatus> {
    const record = this.record(id)
    const runtime = this.runtimes.get(record.id)
    if (!runtime || runtime.incarnation !== incarnation || runtime.generation !== generation) throw new Error('STALE_GENERATION')
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('NAVIGATION_BLOCKED')
    if (signal?.aborted) throw new Error('ACTION_CANCELLED')
    runtime.generation += 1
    runtime.loading = true
    let abort: (() => void) | undefined
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => { runtime.page.stop(); reject(new Error('ACTION_CANCELLED')) }
      signal?.addEventListener('abort', abort, { once: true })
    })
    this.capacity.protectFor(record.id, 'operation', true)
    try { await (signal ? Promise.race([runtime.page.loadURL(parsed.href), cancelled]) : runtime.page.loadURL(parsed.href)) }
    finally {
      this.capacity.protectFor(record.id, 'operation', false)
      runtime.loading = false
      if (abort) signal?.removeEventListener('abort', abort)
    }
    record.safeRestoreUrl = safeRestoreUrl(parsed.href)
    record.lastUsedAt = this.now(); record.stateRevision += 1
    return this.status(record.id)
  }

  stop(id: string): BrowserRuntimeStatus {
    const record = this.record(id)
    const runtime = this.runtimes.get(record.id)
    if (!runtime) throw new Error('BROWSER_FROZEN')
    runtime.page.stop()
    runtime.loading = false
    runtime.generation += 1
    return this.status(record.id)
  }

  freeze(id: string): void {
    const record = this.record(id)
    this.runtimes.get(record.id)?.page.destroy()
    this.runtimes.delete(record.id)
    this.capacity.markFrozen(record.id)
    record.lifecycle = 'frozen'; record.stateRevision += 1
  }

  async thaw(id: string, signal?: AbortSignal): Promise<BrowserRuntimeStatus> {
    const record = this.record(id)
    if (this.runtimes.has(record.id)) return this.status(record.id)
    const activation = await this.capacity.activateQueued(record.id, this.now(), signal, (waiting) => this.capacityEvent(record.id, waiting))
    if (activation.freeze && isOpaqueBrowserId(activation.freeze)) this.freeze(activation.freeze)
    const runtime = this.makeRuntime(record.id)
    this.capacity.settleActivation(record.id)
    record.lifecycle = 'live'; record.stateRevision += 1
    if (record.safeRestoreUrl !== 'about:blank') await runtime.page.loadURL(record.safeRestoreUrl)
    return this.status(record.id)
  }

  protectApproval(id: string, protectedValue: boolean): void {
    const record = this.record(id); this.capacity.protectFor(record.id, 'approval', protectedValue)
  }

  close(id: string): void {
    const record = this.record(id)
    this.runtimes.get(record.id)?.page.destroy()
    this.runtimes.delete(record.id); this.capacity.markFrozen(record.id)
    delete this.state.records[record.id]
  }

  snapshot(): BrowserStateFile { return structuredClone(this.state) }
}
