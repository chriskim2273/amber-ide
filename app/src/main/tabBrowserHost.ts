import { randomUUID } from 'node:crypto'
import { BrowserCapacity } from './tabBrowserPolicy'
import { createBrowserId, isOpaqueBrowserId, safeRestoreUrl, type BrowserId } from '../shared/tabBrowser'
import type { WsBrowser } from '../shared/workspaceFile'
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
export type TabBrowserHostEvent = { type: 'capacity-wait'; id: BrowserId; waiting: boolean } | { type: 'runtime'; id: BrowserId; status: BrowserRuntimeStatus }
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
      () => { runtime.generation += 1; this.onStateChange(); this.emitRuntime(id) },
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
    this.onStateChange(); this.emitRuntime(id)
  }

  private emitRuntime(id: BrowserId): void {
    if (this.state.records[id]) this.onEvent({ type: 'runtime', id, status: this.status(id) })
  }

  async open(options: { visible: boolean }, signal?: AbortSignal, validate?: () => boolean | Promise<boolean>): Promise<{ status: BrowserRuntimeStatus; page: TabBrowserPage }> {
    const id = createBrowserId(this.randomBytes)
    const at = this.now()
    this.state.records[id] = {
      id, profileId: 'global', mode: 'browse', safeRestoreUrl: 'about:blank', title: '',
      viewport: { width: 1280, height: 800 }, lifecycle: 'live', stateRevision: 1,
      lastUsedAt: at, lastFocusedAt: options.visible ? at : 0,
    }
    let activation: { freeze?: string }
    try {
      activation = await this.capacity.activateQueued(id, at, signal, (waiting) => this.capacityEvent(id, waiting))
      if (validate && !(await validate())) throw new Error('STALE_BROWSER_CONTEXT')
      if (signal?.aborted) throw new Error('ACTION_CANCELLED')
    } catch (error) { this.capacity.rollbackActivation(id); delete this.state.records[id]; this.onStateChange(); throw error }
    if (activation.freeze && isOpaqueBrowserId(activation.freeze)) { this.capacity.markAdmissionVictimFrozen(id); this.freeze(activation.freeze) }
    let runtime: Runtime
    try { runtime = this.makeRuntime(id) }
    catch (error) { this.capacity.rollbackActivation(id); delete this.state.records[id]; this.onStateChange(); throw error }
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

  async thaw(id: string, signal?: AbortSignal, validate?: () => boolean | Promise<boolean>): Promise<BrowserRuntimeStatus> {
    const record = this.record(id)
    if (this.runtimes.has(record.id)) return this.status(record.id)
    const activation = await this.capacity.activateQueued(record.id, this.now(), signal, (waiting) => this.capacityEvent(record.id, waiting))
    if (validate) {
      let valid = false
      try { valid = await validate() } catch (error) { this.capacity.rollbackActivation(record.id); throw error }
      if (!valid) { this.capacity.rollbackActivation(record.id); throw new Error('STALE_BROWSER_CONTEXT') }
    }
    if (signal?.aborted) { this.capacity.rollbackActivation(record.id); throw new Error('ACTION_CANCELLED') }
    if (activation.freeze && isOpaqueBrowserId(activation.freeze)) { this.capacity.markAdmissionVictimFrozen(record.id); this.freeze(activation.freeze) }
    let runtime: Runtime
    try { runtime = this.makeRuntime(record.id) } catch (error) { this.capacity.rollbackActivation(record.id); this.onStateChange(); throw error }
    record.lifecycle = 'live'; record.stateRevision += 1
    try {
      if (record.safeRestoreUrl !== 'about:blank') await runtime.page.loadURL(record.safeRestoreUrl)
      return this.status(record.id)
    } finally { this.capacity.settleActivation(record.id) }
  }

  protectApproval(id: string, protectedValue: boolean): void {
    const record = this.record(id); this.capacity.protectFor(record.id, 'approval', protectedValue)
  }

  recoveryItems(): { index: number; workspace: number; tab: number; safeRestoreUrl: string }[] {
    return this.state.migrationRecovery.map((item, index) => ({ index, ...item }))
  }

  deleteRecovery(index: number): void {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.state.migrationRecovery.length) throw new Error('NO_RECOVERY_ITEM')
    this.state.migrationRecovery.splice(index, 1); this.onStateChange()
  }

  attachRecovery(index: number, id: BrowserId): BrowserRuntimeStatus {
    const item = this.state.migrationRecovery[index]
    if (!item) throw new Error('NO_RECOVERY_ITEM')
    const status = this.importFrozen(id, { mode: 'browse', safeRestoreUrl: item.safeRestoreUrl })
    this.state.migrationRecovery.splice(index, 1); this.onStateChange()
    return status
  }

  importWorkspace(entries: { id: BrowserId; browser: WsBrowser }[], recovery: { ws: number; tab: number; browser: WsBrowser }[]): BrowserRuntimeStatus[] {
    if (entries.some((entry) => this.state.records[entry.id])) throw new Error('BROWSER_ID_COLLISION')
    if (this.state.migrationRecovery.length + recovery.length > 100) throw new Error('BROWSER_RECOVERY_LIMIT')
    const statuses = entries.map((entry) => this.importFrozen(entry.id, entry.browser))
    this.state.migrationRecovery.push(...recovery.map((item) => ({ workspace: item.ws, tab: item.tab, safeRestoreUrl: safeRestoreUrl(item.browser.safeRestoreUrl) })))
    this.onStateChange()
    return statuses
  }

  importFrozen(id: BrowserId, browser: WsBrowser): BrowserRuntimeStatus {
    if (this.state.records[id]) throw new Error('BROWSER_ID_COLLISION')
    const at = this.now()
    this.state.records[id] = {
      id, profileId: 'global', mode: browser.mode, safeRestoreUrl: safeRestoreUrl(browser.safeRestoreUrl), title: '',
      viewport: browser.viewport ?? { width: 1280, height: 800 }, lifecycle: 'frozen', stateRevision: 1,
      lastUsedAt: at, lastFocusedAt: 0,
    }
    this.onStateChange()
    return this.status(id)
  }

  close(id: string): void {
    const record = this.record(id)
    this.capacity.cancel(record.id)
    this.runtimes.get(record.id)?.page.destroy()
    this.runtimes.delete(record.id); this.capacity.markFrozen(record.id)
    delete this.state.records[record.id]
  }

  /** Current renderer-capacity membership; used to prove admission compensation. */
  liveIds(): string[] { return this.capacity.liveIds() }

  workspaceSnapshot(): Record<string, { mode: 'preview' | 'browse'; safeRestoreUrl: string; viewport: { width: number; height: number } }> {
    const out: Record<string, { mode: 'preview' | 'browse'; safeRestoreUrl: string; viewport: { width: number; height: number } }> = {}
    for (const record of Object.values(this.state.records)) {
      if (!record) continue
      out[record.id] = { mode: record.mode, safeRestoreUrl: record.safeRestoreUrl, viewport: { ...record.viewport } }
    }
    return out
  }

  snapshot(): BrowserStateFile { return structuredClone(this.state) }
}
