import { randomUUID } from 'node:crypto'
import { BrowserCapacity, navigationPolicyAllows, selectPreviewOrigin } from './tabBrowserPolicy'
import { createBrowserId, isOpaqueBrowserId, safeRestoreUrl, type BrowserId } from '../shared/tabBrowser'
import type { WsBrowser } from '../shared/workspaceFile'
import type { BrowserRecord, BrowserStateFile } from '../shared/tabBrowserState'
import { parseBrowserViewport } from '../shared/browserViewport'
import type { BrowserAutomation, BrowserBinaryAttachment } from './browserAutomation'
import type { BrowserInteraction, BrowserToolAction } from './browserToolProtocol'
import { classifyInteraction, type InteractionClassification, type InteractionTargetMetadata } from './browserApproval'

export type TabBrowserPageEvent =
  | { type: 'navigation-started' }
  | { type: 'navigation-committed'; url: string }
  | { type: 'navigation-in-page'; url: string }
  | { type: 'loading-stopped' }
  | { type: 'title'; title: string }
  | { type: 'focus'; focused: boolean }
  | { type: 'diagnostics'; consoleIssues: number; networkFailures: number }
  | { type: 'dialog'; dialogType: string; message: string; respond: (decision: { accept: boolean; promptText?: string }) => void }
  | { type: 'crashed'; reason: string }

export interface TabBrowserPage {
  loadURL(url: string): Promise<void>
  show(): void
  hide(): void
  stop(): void
  focus?(): void
  blur?(): void
  setBounds?(bounds: { x: number; y: number; width: number; height: number }): void
  automation?: BrowserAutomation
  destroy(): void
}
export interface TabBrowserPageFactory {
  create(id: BrowserId, onUserInput: () => void, onPageEvent: (event: TabBrowserPageEvent) => void, allowNavigation: (url: string) => boolean): TabBrowserPage
}
export interface BrowserRuntimeStatus extends BrowserRecord {
  pageIncarnation: string; generation: number; loading: boolean; capacityWaiting?: boolean
  currentUrl: string; visible: boolean; focused: boolean; restoredAfterFreeze: boolean
  diagnostics: { consoleIssues: number; networkFailures: number }
}
export type TabBrowserHostEvent = { type: 'capacity-wait'; id: BrowserId; waiting: boolean } | { type: 'runtime'; id: BrowserId; status: BrowserRuntimeStatus } | { type: 'dialog-request'; id: BrowserId; pageIncarnation: string; dialogType: string; message: string; generation: number; respond: (decision: { accept: boolean; promptText?: string }) => void }
interface Runtime {
  page: TabBrowserPage; incarnation: string; generation: number; loading: boolean; automationNavigationPending: boolean; visible: boolean
  currentUrl: string; focused: boolean; restoredAfterFreeze: boolean; diagnostics: { consoleIssues: number; networkFailures: number }
}
export interface InteractionApprovalRequest { operation: BrowserInteraction; target: InteractionTargetMetadata; secondaryTarget?: InteractionTargetMetadata; classification: InteractionClassification; origin: string; pageIncarnation: string; generation: number }

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
    for (const record of Object.values(this.state.records)) if (record) {
      record.lifecycle = 'frozen'
      if (record.mode === 'preview' && record.safeRestoreUrl !== 'about:blank' && !navigationPolicyAllows('preview', record.previewOrigins ?? [], record.safeRestoreUrl)) record.previewOrigins = selectPreviewOrigin(record.previewOrigins ?? [], record.safeRestoreUrl)
    }
  }

  private record(id: string): BrowserRecord {
    if (!isOpaqueBrowserId(id)) throw new Error('NO_BROWSER_FOR_TAB')
    const record = this.state.records[id]
    if (!record) throw new Error('NO_BROWSER_FOR_TAB')
    return record
  }

  private makeRuntime(id: BrowserId, restoredAfterFreeze = false): Runtime {
    let runtime!: Runtime
    const page = this.pages.create(
      id,
      () => { runtime.generation += 1; runtime.page.automation?.invalidate(); this.onStateChange(); this.emitRuntime(id) },
      (event) => this.pageEvent(id, runtime, event),
      (url) => this.navigationAllowed(id, url),
    )
    runtime = { page, incarnation: randomUUID(), generation: 0, loading: false, automationNavigationPending: false, visible: false,
      currentUrl: this.record(id).safeRestoreUrl, focused: false, restoredAfterFreeze, diagnostics: { consoleIssues: 0, networkFailures: 0 } }
    this.runtimes.set(id, runtime)
    this.capacity.markLive(id, this.now())
    return runtime
  }

  private navigationAllowed(id: BrowserId, url: string): boolean {
    const record = this.state.records[id]
    return !!record && navigationPolicyAllows(record.mode, record.previewOrigins ?? [], url)
  }

  private pageEvent(id: BrowserId, runtime: Runtime, event: TabBrowserPageEvent): void {
    if (this.runtimes.get(id) !== runtime) return
    const record = this.record(id)
    if (event.type === 'navigation-started') {
      if (runtime.automationNavigationPending) runtime.automationNavigationPending = false
      else if (!runtime.loading) runtime.generation += 1
      runtime.page.automation?.invalidate()
      runtime.loading = true
    } else if (event.type === 'navigation-committed' || event.type === 'navigation-in-page') {
      const currentUrl = event.url.slice(0, 8192)
      if (!this.navigationAllowed(id, currentUrl)) {
        runtime.page.stop(); runtime.page.destroy(); this.runtimes.delete(id); this.capacity.markFrozen(id)
        record.lifecycle = 'frozen'; record.restoreError = 'Navigation blocked by browser mode'; record.stateRevision += 1
        this.onStateChange(); this.emitRuntime(id); return
      }
      if (event.type === 'navigation-in-page') { if (!runtime.loading) runtime.generation += 1; runtime.page.automation?.invalidate() }
      runtime.automationNavigationPending = false
      runtime.loading = false
      runtime.currentUrl = currentUrl
      record.safeRestoreUrl = safeRestoreUrl(currentUrl)
      record.lastUsedAt = this.now()
      record.stateRevision += 1
    } else if (event.type === 'loading-stopped') {
      runtime.automationNavigationPending = false
      runtime.loading = false
    } else if (event.type === 'title') {
      record.title = event.title.slice(0, 512)
      record.stateRevision += 1
    } else if (event.type === 'focus') {
      runtime.focused = event.focused
    } else if (event.type === 'diagnostics') {
      runtime.diagnostics = { consoleIssues: Math.max(0, Math.min(10_000, Math.floor(event.consoleIssues))), networkFailures: Math.max(0, Math.min(10_000, Math.floor(event.networkFailures))) }
    } else if (event.type === 'dialog') {
      runtime.generation += 1; runtime.page.automation?.invalidate()
      this.onEvent({ type: 'dialog-request', id, pageIncarnation: runtime.incarnation, dialogType: event.dialogType, message: event.message, generation: runtime.generation, respond: event.respond })
    } else {
      runtime.automationNavigationPending = false
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
      for (const [otherId, other] of this.runtimes) if (otherId !== id) { other.page.hide(); other.visible = false; this.capacity.protect(otherId, false) }
      runtime.page.show(); runtime.visible = true; this.capacity.protect(id, true)
    } else { runtime.page.hide(); runtime.visible = false }
    return { status: this.status(id), page: runtime.page }
  }

  private capacityEvent(id: BrowserId, waiting: boolean): void {
    if (waiting) this.capacityWaiting.add(id); else this.capacityWaiting.delete(id)
    this.onEvent({ type: 'capacity-wait', id, waiting }); this.onStateChange()
  }

  status(id: string): BrowserRuntimeStatus {
    const record = this.record(id)
    const runtime = this.runtimes.get(record.id)
    return { ...record, pageIncarnation: runtime?.incarnation ?? '', generation: runtime?.generation ?? 0, loading: runtime?.loading ?? false,
      currentUrl: runtime?.currentUrl ?? record.safeRestoreUrl, visible: runtime?.visible ?? false, focused: runtime?.focused ?? false,
      restoredAfterFreeze: runtime?.restoredAfterFreeze ?? false, diagnostics: runtime?.diagnostics ?? { consoleIssues: 0, networkFailures: 0 },
      ...(this.capacityWaiting.has(record.id) ? { capacityWaiting: true } : {}) }
  }

  show(id: string, bounds?: { x: number; y: number; width: number; height: number }): BrowserRuntimeStatus {
    const record = this.record(id); const runtime = this.runtimes.get(record.id)
    if (!runtime) throw new Error('BROWSER_FROZEN')
    if (bounds) runtime.page.setBounds?.(bounds)
    for (const [otherId, other] of this.runtimes) if (otherId !== record.id) { other.page.hide(); other.visible = false; this.capacity.protect(otherId, false) }
    runtime.page.show(); runtime.visible = true; this.capacity.protect(record.id, true)
    record.lastFocusedAt = this.now(); this.capacity.touch(record.id, record.lastFocusedAt)
    const status = this.status(record.id); this.emitRuntime(record.id); return status
  }

  hide(id: string): void { const record = this.record(id); const runtime = this.runtimes.get(record.id); runtime?.page.hide(); if (runtime) { runtime.visible = false; runtime.focused = false }; this.capacity.protect(record.id, false); this.emitRuntime(record.id) }
  isVisible(id: string): boolean { return isOpaqueBrowserId(id) && this.runtimes.get(id)?.visible === true }

  setMode(id: string, mode: 'preview' | 'browse', source: 'user' | 'broker' = 'user'): BrowserRuntimeStatus {
    if (source !== 'user') throw new Error('NAVIGATION_BLOCKED')
    const record = this.record(id), runtime = this.runtimes.get(record.id)
    if (mode === 'preview' && runtime?.currentUrl && runtime.currentUrl !== 'about:blank' && !navigationPolicyAllows('preview', record.previewOrigins ?? [], runtime.currentUrl)) record.previewOrigins = selectPreviewOrigin(record.previewOrigins ?? [], runtime.currentUrl)
    record.mode = mode; record.stateRevision += 1; this.onStateChange(); this.emitRuntime(record.id); return this.status(record.id)
  }

  focusPage(id: string): BrowserRuntimeStatus {
    const record = this.record(id), runtime = this.runtimes.get(record.id)
    if (!runtime || !runtime.visible) throw new Error('BROWSER_FROZEN')
    runtime.page.focus?.(); runtime.focused = true; record.lastFocusedAt = this.now(); this.capacity.touch(record.id, record.lastFocusedAt); this.emitRuntime(record.id); return this.status(record.id)
  }

  focusChrome(id: string): BrowserRuntimeStatus {
    const record = this.record(id), runtime = this.runtimes.get(record.id); runtime?.page.blur?.(); if (runtime) runtime.focused = false; this.emitRuntime(record.id); return this.status(record.id)
  }

  setBounds(id: string, bounds: { x: number; y: number; width: number; height: number }): void {
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width < 1 || bounds.height < 1) throw new Error('INVALID_BOUNDS')
    const record = this.record(id); this.runtimes.get(record.id)?.page.setBounds?.(bounds)
  }

  async navigate(id: string, url: string, incarnation: string, generation: number, signal?: AbortSignal, source: 'user' | 'broker' = 'user'): Promise<BrowserRuntimeStatus> {
    const record = this.record(id)
    const runtime = this.runtimes.get(record.id)
    if (!runtime || runtime.incarnation !== incarnation || runtime.generation !== generation) throw new Error('STALE_GENERATION')
    let parsed: URL
    try { parsed = new URL(url) } catch { throw new Error('NAVIGATION_BLOCKED') }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('NAVIGATION_BLOCKED')
    const priorOrigins = record.previewOrigins ? [...record.previewOrigins] : undefined
    if (record.mode === 'preview' && !navigationPolicyAllows(record.mode, record.previewOrigins ?? [], parsed.href)) {
      if (source !== 'user') throw new Error('NAVIGATION_BLOCKED')
      record.previewOrigins = selectPreviewOrigin(record.previewOrigins ?? [], parsed.href)
    }
    if (!this.navigationAllowed(record.id, parsed.href)) throw new Error('NAVIGATION_BLOCKED')
    if (signal?.aborted) throw new Error('ACTION_CANCELLED')
    runtime.generation += 1
    const navigationGeneration = runtime.generation
    runtime.loading = true
    this.emitRuntime(record.id)
    let abort: (() => void) | undefined
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => { runtime.page.stop(); reject(new Error('ACTION_CANCELLED')) }
      signal?.addEventListener('abort', abort, { once: true })
    })
    this.capacity.protectFor(record.id, 'operation', true)
    try { await (signal ? Promise.race([runtime.page.loadURL(parsed.href), cancelled]) : runtime.page.loadURL(parsed.href)) }
    catch (error) { if (priorOrigins) record.previewOrigins = priorOrigins; else delete record.previewOrigins; throw error }
    finally {
      this.capacity.protectFor(record.id, 'operation', false)
      runtime.loading = false
      if (abort) signal?.removeEventListener('abort', abort)
    }
    if (this.runtimes.get(record.id) !== runtime || runtime.generation !== navigationGeneration) {
      if (priorOrigins) record.previewOrigins = priorOrigins; else delete record.previewOrigins
      throw new Error(this.runtimes.get(record.id) !== runtime ? 'NAVIGATION_BLOCKED' : 'ACTION_CANCELLED')
    }
    runtime.currentUrl = parsed.href.slice(0, 8192)
    record.safeRestoreUrl = safeRestoreUrl(parsed.href)
    record.lastUsedAt = this.now(); record.stateRevision += 1
    const status = this.status(record.id); this.onStateChange(); this.emitRuntime(record.id); return status
  }

  async runAutomation(id: string, action: BrowserToolAction, signal: AbortSignal, approve?: (request: InteractionApprovalRequest, signal: AbortSignal) => Promise<void>): Promise<unknown | BrowserBinaryAttachment> {
    const record = this.record(id)
    const runtime = this.runtimes.get(record.id)
    if (!runtime || !runtime.page.automation) throw new Error('BROWSER_FROZEN')
    if (runtime.incarnation !== action.pageIncarnation || runtime.generation !== action.expectedGeneration) throw new Error('STALE_GENERATION')
    if (signal.aborted) throw new Error('ACTION_CANCELLED')
    const automation = runtime.page.automation
    const lease = { browserId: record.id, pageIncarnation: runtime.incarnation, generation: runtime.generation }
    let result: unknown; let generationDelta = 0
    this.capacity.protectFor(record.id, 'operation', true)
    try {
      if (action.type === 'snapshot') result = await automation.snapshot(lease, action.limits, signal)
      else if (action.type === 'find') result = automation.find(lease, action.snapshotId, action.query)
      else if (action.type === 'inspect') result = await automation.inspect(lease, action.target, signal)
      else if (action.type === 'screenshot') result = await automation.screenshot(lease, action.target, action.fullPage, signal)
      else if (action.type === 'console') result = automation.consoleSince(action.cursor, action.levels, action.limit)
      else if (action.type === 'network') result = automation.networkSince(action.cursor, action.limit, action.failedOnly)
      else if (action.type === 'wait') result = await automation.wait(lease, action.condition, action.timeoutMs, signal, () => this.runtimes.get(record.id) === runtime && runtime.generation === action.expectedGeneration)
      else if (action.type === 'interact') {
        const prepared = await automation.prepareInteraction(lease, action.operation, signal)
        const classification = classifyInteraction(action.operation, prepared.target, prepared.secondaryTarget)
        if (classification.consequential) {
          if (!approve) throw new Error('APPROVAL_REQUIRED')
          await approve({ operation: action.operation, target: prepared.target, ...(prepared.secondaryTarget ? { secondaryTarget: prepared.secondaryTarget } : {}), classification, origin: new URL(record.safeRestoreUrl).origin, pageIncarnation: runtime.incarnation, generation: runtime.generation }, signal)
        }
        if (signal.aborted) throw new Error('ACTION_CANCELLED')
        if (this.runtimes.get(record.id) !== runtime || runtime.incarnation !== action.pageIncarnation || runtime.generation !== action.expectedGeneration) throw new Error('STALE_GENERATION')
        runtime.generation += 1; generationDelta = 1; automation.invalidate()
        result = await automation.executeInteraction(prepared, signal, () => this.runtimes.get(record.id) === runtime && runtime.incarnation === action.pageIncarnation && runtime.generation === action.expectedGeneration + 1)
      } else if (action.type === 'reload' || action.type === 'history') {
        runtime.automationNavigationPending = true
        try { result = action.type === 'reload' ? automation.reload(action.ignoreCache) : automation.history(action.direction) }
        catch (error) { runtime.automationNavigationPending = false; throw error }
        if ((result as { accepted: boolean }).accepted) { runtime.generation += 1; generationDelta = 1 }
        else runtime.automationNavigationPending = false
      } else { const viewport = parseBrowserViewport(action.viewport); if (!viewport) throw new Error('INVALID_REQUEST'); result = await automation.setViewport({ ...action.viewport, ...viewport }, signal); runtime.generation += 1; generationDelta = 1; record.viewport = viewport; record.stateRevision += 1 }
    } finally { this.capacity.protectFor(record.id, 'operation', false) }
    if (signal.aborted) throw new Error('ACTION_CANCELLED')
    const expectedAfter = action.expectedGeneration + generationDelta
    if (this.runtimes.get(record.id) !== runtime || runtime.incarnation !== action.pageIncarnation || runtime.generation !== expectedAfter) throw new Error('STALE_GENERATION')
    this.onStateChange(); this.emitRuntime(record.id)
    const context = { browserId: record.id, pageIncarnation: runtime.incarnation, generation: runtime.generation }
    if (typeof result === 'object' && result !== null) return { ...result, ...context }
    return { value: result, ...context }
  }

  stop(id: string, incarnation?: string, generation?: number): BrowserRuntimeStatus {
    const record = this.record(id)
    const runtime = this.runtimes.get(record.id)
    if (!runtime) throw new Error('BROWSER_FROZEN')
    if (incarnation !== undefined && (runtime.incarnation !== incarnation || runtime.generation !== generation)) throw new Error('STALE_GENERATION')
    runtime.page.stop()
    runtime.loading = false
    runtime.generation += 1
    const status = this.status(record.id); this.emitRuntime(record.id); return status
  }

  freeze(id: string): void {
    const record = this.record(id)
    this.runtimes.get(record.id)?.page.destroy()
    this.runtimes.delete(record.id)
    this.capacity.markFrozen(record.id)
    record.lifecycle = 'frozen'; record.stateRevision += 1; this.onStateChange(); this.emitRuntime(record.id)
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
    try { runtime = this.makeRuntime(record.id, true) } catch (error) { this.capacity.rollbackActivation(record.id); this.onStateChange(); throw error }
    record.lifecycle = 'live'; record.stateRevision += 1
    try {
      if (!this.navigationAllowed(record.id, record.safeRestoreUrl)) throw new Error('NAVIGATION_BLOCKED')
      if (record.safeRestoreUrl !== 'about:blank') await runtime.page.loadURL(record.safeRestoreUrl)
      if (runtime.page.automation) await runtime.page.automation.setViewport({ width: record.viewport.width, height: record.viewport.height }, signal ?? new AbortController().signal)
      delete record.restoreError; this.onStateChange(); this.emitRuntime(record.id)
      return this.status(record.id)
    } catch (error) {
      runtime.page.destroy(); this.runtimes.delete(record.id); this.capacity.markFrozen(record.id)
      const code = signal?.aborted ? 'ACTION_CANCELLED' : error instanceof Error && error.message === 'NAVIGATION_BLOCKED' ? 'NAVIGATION_BLOCKED' : 'BROWSER_RESTORE_FAILED'
      record.lifecycle = 'frozen'; record.restoreError = code === 'NAVIGATION_BLOCKED' ? 'Navigation blocked by browser mode' : code === 'ACTION_CANCELLED' ? 'Browser restore cancelled' : 'Browser restore failed'
      record.stateRevision += 1; this.onStateChange(); this.emitRuntime(record.id)
      throw new Error(code)
    } finally { this.capacity.settleActivation(record.id) }
  }

  revokePi(id: string): void {
    const record = this.record(id), runtime = this.runtimes.get(record.id)
    if (runtime) { runtime.generation += 1; runtime.page.automation?.invalidate(); this.emitRuntime(record.id) }
  }

  protectApproval(id: string, protectedValue: boolean): void {
    const record = this.record(id); const runtime = this.runtimes.get(record.id)
    this.capacity.protectFor(record.id, 'approval', protectedValue)
    if (runtime?.visible) { if (protectedValue) runtime.page.hide(); else runtime.page.show() }
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
    const at = this.now(), restoreUrl = safeRestoreUrl(browser.safeRestoreUrl), viewport = parseBrowserViewport(browser.viewport ?? { width: 1280, height: 800 })
    if (!viewport) throw new Error('INVALID_REQUEST')
    const previewOrigins = browser.mode === 'preview' && restoreUrl !== 'about:blank' && !navigationPolicyAllows('preview', [], restoreUrl) ? selectPreviewOrigin([], restoreUrl) : undefined
    this.state.records[id] = {
      id, profileId: 'global', mode: browser.mode, safeRestoreUrl: restoreUrl, title: '',
      viewport, ...(previewOrigins ? { previewOrigins } : {}), lifecycle: 'frozen', stateRevision: 1,
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
