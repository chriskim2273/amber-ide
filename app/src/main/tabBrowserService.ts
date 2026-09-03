import type { BrowserWindow, Rectangle } from 'electron'
import { ElectronTabBrowserPageFactory } from './electronTabBrowserPage'
import { TabBrowserHost, type BrowserRuntimeStatus } from './tabBrowserHost'
import { isOpaqueBrowserId, safeRestoreUrl, type BrowserId } from '../shared/tabBrowser'
import type { WsBrowser } from '../shared/workspaceFile'
import { TabBrowserStateStore } from './tabBrowserStateStore'
import type { BrowserStateFile } from '../shared/tabBrowserState'
import type { BrowserToolAction } from './browserToolProtocol'
import { BrowserApprovalCoordinator, BrowserDialogCoordinator, interactionTargetDigest, interactionValueDigest, type ApprovalDecision } from './browserApproval'

export type TabBrowserCommand =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'share'; sharedWithPi: boolean }
  | { type: 'designate'; designatedPi?: string }
  | { type: 'show'; id: string; bounds: Rectangle }
  | { type: 'hide'; id: string }
  | { type: 'bounds'; id: string; bounds: Rectangle }
  | { type: 'reload'; id: string; pageIncarnation: string; expectedGeneration: number }
  | { type: 'history'; id: string; direction: 'back' | 'forward'; pageIncarnation: string; expectedGeneration: number }
  | { type: 'mode'; id: string; mode: 'preview' | 'browse' }
  | { type: 'viewport'; id: string; pageIncarnation: string; expectedGeneration: number; width: number; height: number }
  | { type: 'focusPage' | 'focusChrome'; id: string }
  | { type: 'navigate'; id: string; url: string; pageIncarnation: string; expectedGeneration: number; broker?: { requestId: string; controller: string } }
  | { type: 'status'; id: string }
  | { type: 'stop'; id: string; pageIncarnation?: string; expectedGeneration?: number; broker?: { requestId: string; controller: string } }
  | { type: 'automation'; id: string; action: BrowserToolAction; broker?: { requestId: string; controller: string } }
  | { type: 'resolveApproval'; id: string; approvalId: string; digest: string; decision: ApprovalDecision }
  | { type: 'stopPi'; id: string }
  | { type: 'resolveDialog'; id: string; dialogId: string; digest: string; accept: boolean; promptText?: string }
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
  private currentWindow: BrowserWindow | null
  private readonly activePi = new Map<string, Set<{ controller: AbortController; owner: string }>>()
  private readonly revokedPi = new Set<string>()
  private readonly approvals: BrowserApprovalCoordinator
  private readonly dialogs: BrowserDialogCoordinator
  private readonly observedGeneration = new Map<string, number>()
  private readonly latestPiActions = new Map<string, { type: 'pi-action'; browserId: string; controller: string; action: string; phase: 'started' | 'completed' | 'failed'; error?: string; at: number }>()
  private readonly pendingRuntimeEvents = new Map<string, unknown>()
  private runtimeFlush: NodeJS.Timeout | null = null
  private approvalSurfaceVisible: (browserId: string) => boolean = () => false
  private approvalSurfaceReveal: (browserId: string) => void = () => {}

  private constructor(
    private readonly store: TabBrowserStateStore,
    private readonly pages: ElectronTabBrowserPageFactory,
    private readonly host: TabBrowserHost,
    initialState: BrowserStateFile,
    window?: BrowserWindow,
  ) {
    this.persistedState = structuredClone(initialState); this.currentWindow = window ?? null
    this.approvals = new BrowserApprovalCoordinator(Date.now, (id) => this.host.isVisible(id) && this.approvalSurfaceVisible(id), (event) => this.eventSink(event), 60_000, (id) => this.approvalSurfaceReveal(id))
    this.dialogs = new BrowserDialogCoordinator(Date.now, (id) => this.host.isVisible(id) && this.approvalSurfaceVisible(id), (id) => { try { const status = this.host.status(id); return { pageIncarnation: status.pageIncarnation, generation: status.generation } } catch { return null } }, (event) => this.eventSink(event), 60_000, (id) => this.approvalSurfaceReveal(id))
  }

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
    }, (event) => service.handleHostEvent(event))
    service = new TabBrowserService(store, pages, host, persistedState, window)
    return service
  }

  setWindow(window: BrowserWindow): void { this.currentWindow = window; this.pages.setWindow(window) }
  setApprovalSurface(visible: (browserId: string) => boolean, reveal: (browserId: string) => void): void { this.approvalSurfaceVisible = visible; this.approvalSurfaceReveal = reveal }
  surfaceHidden(id: string): void {
    this.approvals.invalidateBrowser(id); this.dialogs.clearBrowser(id)
    for (const active of this.activePi.get(id) ?? []) active.controller.abort()
  }
  setEventSink(sink: (event: unknown) => void): void { this.eventSink = sink }
  private queueRuntimeEvent(id: string, event: unknown): void {
    if (!this.pendingRuntimeEvents.has(id) && this.pendingRuntimeEvents.size >= 256) this.pendingRuntimeEvents.delete(this.pendingRuntimeEvents.keys().next().value as string)
    this.pendingRuntimeEvents.set(id, event)
    if (this.runtimeFlush) return
    this.runtimeFlush = setTimeout(() => {
      this.runtimeFlush = null
      const pending = [...this.pendingRuntimeEvents.values()]; this.pendingRuntimeEvents.clear()
      for (const value of pending) this.eventSink(value)
    }, 16)
    this.runtimeFlush.unref()
  }
  private handleHostEvent(event: unknown): void {
    const runtime = event as { type?: unknown; id?: unknown; status?: { pageIncarnation?: unknown; generation?: unknown; lifecycle?: unknown }; pageIncarnation?: unknown; dialogType?: unknown; message?: unknown; generation?: unknown; respond?: (decision: { accept: boolean; promptText?: string }) => void }
    if (runtime.type === 'dialog-request' && typeof runtime.id === 'string' && typeof runtime.pageIncarnation === 'string' && typeof runtime.dialogType === 'string' && typeof runtime.message === 'string' && typeof runtime.generation === 'number' && runtime.respond) {
      const active = [...(this.activePi.get(runtime.id) ?? [])].at(-1), fallback = new AbortController()
      this.observedGeneration.set(runtime.id, runtime.generation)
      try { this.host.protectApproval(runtime.id, true) } catch { runtime.respond({ accept: false }); return }
      void this.dialogs.request({ browserId: runtime.id, pageIncarnation: runtime.pageIncarnation, generation: runtime.generation, owner: active?.owner ?? 'user', signal: active?.controller.signal ?? fallback.signal }, runtime.dialogType, runtime.message).then(runtime.respond, () => runtime.respond!({ accept: false })).finally(() => { try { this.host.protectApproval(runtime.id as string, false) } catch { /* page closed */ } })
      return
    }
    if (runtime.type === 'runtime' && typeof runtime.id === 'string' && typeof runtime.status?.generation === 'number') {
      const previous = this.observedGeneration.get(runtime.id); this.observedGeneration.set(runtime.id, runtime.status.generation)
      if (previous !== undefined && previous !== runtime.status.generation) this.approvals.invalidateBrowser(runtime.id)
      if (typeof runtime.status.pageIncarnation === 'string') this.dialogs.invalidateIdentity(runtime.id, runtime.status.pageIncarnation, runtime.status.generation)
      if (runtime.status.lifecycle === 'frozen') { this.approvals.clearBrowser(runtime.id); this.dialogs.clearBrowser(runtime.id) }
      this.queueRuntimeEvent(runtime.id, { ...runtime, status: this.withLatestAction(runtime.id, runtime.status as Record<string, unknown>) }); return
    }
    this.eventSink(event)
  }

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

  command(command: Exclude<TabBrowserCommand, { type: 'automation' }>, signal?: AbortSignal, validate?: () => boolean | Promise<boolean>): Promise<BrowserRuntimeStatus | { closed: true }>
  command(command: Extract<TabBrowserCommand, { type: 'automation' }>, signal?: AbortSignal, validate?: () => boolean | Promise<boolean>): Promise<unknown>
  command(command: TabBrowserCommand, signal?: AbortSignal, validate?: () => boolean | Promise<boolean>): Promise<unknown>
  command(command: TabBrowserCommand, signal?: AbortSignal, validate?: () => boolean | Promise<boolean>): Promise<unknown> {
    // Opens must reach the host concurrently so the global capacity FIFO sees
    // every contender. Observations and hide also cannot sit behind a wait.
    if (command.type === 'hide' || command.type === 'destroy') this.activationControllers.get(command.id)?.abort()
    if (command.type === 'navigate' || command.type === 'stop') this.dialogs.clearBrowser(command.id)
    if (command.type === 'open' || command.type === 'status' || command.type === 'hide' || command.type === 'destroy' || command.type === 'resolveApproval' || command.type === 'resolveDialog' || command.type === 'stopPi') return this.runCommand(command, signal, validate)
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

  private withLatestAction<T extends object>(id: string, status: T): T & { lastAction?: unknown } {
    const lastAction = this.latestPiActions.get(id); return { ...status, ...(lastAction ? { lastAction } : {}) }
  }
  private brokerStatus(id: string, input?: Record<string, unknown>): Record<string, unknown> {
    const { currentUrl: _privateCurrentUrl, ...status } = this.withLatestAction(id, input ?? this.host.status(id) as unknown as Record<string, unknown>)
    return status
  }
  private piAction(id: string, controller: string, action: string, phase: 'started' | 'completed' | 'failed', error?: unknown): void {
    const raw = error instanceof Error ? error.message : 'INTERNAL_ERROR'
    const event = { type: 'pi-action' as const, browserId: id, controller: controller.slice(0, 256), action: action.slice(0, 64), phase, ...(phase === 'failed' ? { error: /^[A-Z][A-Z0-9_]{1,63}$/.test(raw) ? raw : 'INTERNAL_ERROR' } : {}), at: Date.now() }
    if (!this.latestPiActions.has(id) && this.latestPiActions.size >= 256) this.latestPiActions.delete(this.latestPiActions.keys().next().value as string)
    this.latestPiActions.set(id, event); this.eventSink(event)
  }
  private async runCommand(command: TabBrowserCommand, signal?: AbortSignal, validate?: () => boolean | Promise<boolean>): Promise<unknown> {
    if (validate && !(await validate())) throw new Error('STALE_BROWSER_CONTEXT')
    if (signal?.aborted) throw new Error('ACTION_CANCELLED')
    switch (command.type) {
      case 'open': {
        try {
          const opened = await this.host.open({ visible: true }, signal, validate); await this.schedulePersist(); return this.withLatestAction(opened.status.id, opened.status)
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
        return this.withLatestAction(command.id, status)
      }
      case 'hide': this.surfaceHidden(command.id); this.host.hide(command.id); return this.host.status(command.id)
      case 'bounds': this.host.setBounds(command.id, command.bounds); return this.withLatestAction(command.id, this.host.status(command.id))
      case 'reload': case 'history': case 'viewport': {
        const action: BrowserToolAction = command.type === 'reload'
          ? { type: 'reload', pageIncarnation: command.pageIncarnation, expectedGeneration: command.expectedGeneration, ignoreCache: false }
          : command.type === 'history'
            ? { type: 'history', direction: command.direction, pageIncarnation: command.pageIncarnation, expectedGeneration: command.expectedGeneration }
            : { type: 'setViewport', viewport: { width: command.width, height: command.height }, pageIncarnation: command.pageIncarnation, expectedGeneration: command.expectedGeneration }
        await this.host.runAutomation(command.id, action, signal ?? new AbortController().signal)
        if (command.type === 'viewport') await this.schedulePersist()
        return this.withLatestAction(command.id, this.host.status(command.id))
      }
      case 'mode': { const status = this.host.setMode(command.id, command.mode); await this.schedulePersist(); return this.withLatestAction(command.id, status) }
      case 'focusPage': return this.withLatestAction(command.id, this.host.focusPage(command.id))
      case 'focusChrome': return this.withLatestAction(command.id, this.host.focusChrome(command.id))
      case 'navigate': {
        const activeOwner = command.broker ? { controller: new AbortController(), owner: `${command.broker.controller}\u0000${command.broker.requestId}` } : null
        const upstreamAbort = (): void => activeOwner?.controller.abort()
        if (activeOwner) { signal?.addEventListener('abort', upstreamAbort, { once: true }); if (signal?.aborted) activeOwner.controller.abort(); const set = this.activePi.get(command.id) ?? new Set<{ controller: AbortController; owner: string }>(); set.add(activeOwner); this.activePi.set(command.id, set) }
        if (command.broker) this.piAction(command.id, command.broker.controller, 'navigate', 'started')
        try { const status = await this.host.navigate(command.id, command.url, command.pageIncarnation, command.expectedGeneration, activeOwner?.controller.signal ?? signal); await this.schedulePersist(); if (command.broker) this.piAction(command.id, command.broker.controller, 'navigate', 'completed'); return command.broker ? this.brokerStatus(command.id, status as unknown as Record<string, unknown>) : this.withLatestAction(command.id, status) }
        catch (error) { if (command.broker) this.piAction(command.id, command.broker.controller, 'navigate', 'failed', error); throw error }
        finally { signal?.removeEventListener('abort', upstreamAbort); const set = this.activePi.get(command.id); if (activeOwner) set?.delete(activeOwner); if (set?.size === 0) this.activePi.delete(command.id) }
      }
      case 'status': return this.brokerStatus(command.id)
      case 'stop': {
        if (command.broker) this.piAction(command.id, command.broker.controller, 'stop', 'started')
        try { const status = this.host.stop(command.id, command.pageIncarnation, command.expectedGeneration); if (command.broker) this.piAction(command.id, command.broker.controller, 'stop', 'completed'); return command.broker ? this.brokerStatus(command.id, status as unknown as Record<string, unknown>) : this.withLatestAction(command.id, status) }
        catch (error) { if (command.broker) this.piAction(command.id, command.broker.controller, 'stop', 'failed', error); throw error }
      }
      case 'automation': {
        const controller = new AbortController(), upstreamAbort = (): void => controller.abort()
        signal?.addEventListener('abort', upstreamAbort, { once: true }); if (signal?.aborted) controller.abort()
        const activeOwner = command.broker ? { controller, owner: `${command.broker.controller}\u0000${command.broker.requestId}` } : null
        if (command.broker && activeOwner) { this.revokedPi.delete(command.id); const set = this.activePi.get(command.id) ?? new Set<{ controller: AbortController; owner: string }>(); set.add(activeOwner); this.activePi.set(command.id, set) }
        if (command.broker) this.piAction(command.id, command.broker.controller, command.action.type === 'interact' ? command.action.operation.kind : command.action.type, 'started')
        try {
          const result = await this.host.runAutomation(command.id, command.action, controller.signal, command.broker ? async (request, approvalSignal) => {
            const classification = request.classification
            if (!classification.consequential) return
            this.observedGeneration.set(command.id, request.generation)
            this.host.protectApproval(command.id, true)
            try {
              await this.approvals.request({ requestId: command.broker!.requestId, controller: command.broker!.controller, browserId: command.id,
                pageIncarnation: request.pageIncarnation, generation: request.generation, origin: request.origin, action: request.operation.kind,
                targetFingerprint: interactionTargetDigest(request.target, request.secondaryTarget), valueCategory: classification.valueCategory, valueDigest: interactionValueDigest(request.operation),
                category: classification.category as Exclude<typeof classification.category, 'benign'>, canGrantOrigin: classification.canGrantOrigin,
                targetLabel: [request.target, request.secondaryTarget].filter((target): target is NonNullable<typeof target> => !!target).map((target) => `${target.role} ${target.name}`.trim()).join(' → ').slice(0, 512), argumentSummary: classification.argumentSummary }, approvalSignal)
            } finally { try { this.host.protectApproval(command.id, false) } catch { /* record may close while approval is pending */ } }
          } : undefined)
          if (command.action.type === 'setViewport') await this.schedulePersist()
          if (command.broker) this.piAction(command.id, command.broker.controller, command.action.type === 'interact' ? command.action.operation.kind : command.action.type, 'completed')
          return result
        } catch (error) {
          if (command.broker) this.piAction(command.id, command.broker.controller, command.action.type === 'interact' ? command.action.operation.kind : command.action.type, 'failed', error)
          throw error
        } finally {
          signal?.removeEventListener('abort', upstreamAbort)
          const set = this.activePi.get(command.id); if (activeOwner) set?.delete(activeOwner); if (set?.size === 0) this.activePi.delete(command.id)
        }
      }
      case 'resolveApproval': {
        if (!this.approvals.resolve(command.id, command.approvalId, command.digest, command.decision)) throw new Error('APPROVAL_DENIED')
        return this.host.status(command.id)
      }
      case 'resolveDialog': {
        if (!this.dialogs.resolve(command.id, command.dialogId, command.digest, command.accept, command.promptText)) throw new Error('DIALOG_DENIED')
        return this.host.status(command.id)
      }
      case 'stopPi': this.revokePi(command.id); return this.host.status(command.id)
      case 'destroy': this.approvals.clearBrowser(command.id); this.dialogs.clearBrowser(command.id); this.latestPiActions.delete(command.id); this.host.close(command.id); await this.schedulePersist(); return { closed: true }
      case 'close': case 'share': case 'designate': throw new Error('ASSOCIATION_COMMAND_REQUIRES_MAIN')
    }
  }

  revokePi(id: string): void {
    if (this.revokedPi.has(id)) return
    this.revokedPi.add(id); this.approvals.clearBrowser(id); this.dialogs.clearBrowser(id)
    try { this.host.revokePi(id) } catch { /* close may already have removed the record */ }
    for (const active of this.activePi.get(id) ?? []) active.controller.abort()
    this.activePi.delete(id)
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
  if (v['type'] === 'resolveApproval' && exact(v, ['type', 'approvalId', 'digest', 'decision']) && typeof v['approvalId'] === 'string' && v['approvalId'].length <= 128
      && typeof v['digest'] === 'string' && /^[a-f0-9]{64}$/.test(v['digest']) && (v['decision'] === 'approve-once' || v['decision'] === 'reject' || v['decision'] === 'allow-origin')) return { type: 'resolveApproval', id: '' as never, approvalId: v['approvalId'], digest: v['digest'], decision: v['decision'] }
  if (v['type'] === 'stopPi' && exact(v, ['type'])) return { type: 'stopPi', id: '' as never }
  if (v['type'] === 'resolveDialog' && (exact(v, ['type', 'dialogId', 'digest', 'accept']) || exact(v, ['type', 'dialogId', 'digest', 'accept', 'promptText']))
      && typeof v['dialogId'] === 'string' && v['dialogId'].length >= 1 && v['dialogId'].length <= 128 && typeof v['digest'] === 'string' && /^[a-f0-9]{64}$/.test(v['digest'])
      && typeof v['accept'] === 'boolean' && (v['promptText'] === undefined || typeof v['promptText'] === 'string' && v['promptText'].length <= 4096)) {
    return { type: 'resolveDialog', id: '' as never, dialogId: v['dialogId'], digest: v['digest'], accept: v['accept'], ...(typeof v['promptText'] === 'string' ? { promptText: v['promptText'] } : {}) }
  }
  if (v['type'] === 'designate' && (exact(v, ['type']) || exact(v, ['type', 'designatedPi']))) {
    if (v['designatedPi'] !== undefined && (typeof v['designatedPi'] !== 'string' || v['designatedPi'].length > 256)) throw new Error('INVALID_REQUEST')
    return { type: 'designate', ...(typeof v['designatedPi'] === 'string' ? { designatedPi: v['designatedPi'] } : {}) }
  }
  if (typeof v['id'] !== 'string' || !isOpaqueBrowserId(v['id'])) throw new Error('INVALID_REQUEST')
  if (v['type'] === 'hide' || v['type'] === 'status' || v['type'] === 'stop' || v['type'] === 'focusPage' || v['type'] === 'focusChrome') {
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
  if ((v['type'] === 'reload' || v['type'] === 'history')
      && exact(v, v['type'] === 'history' ? ['type', 'id', 'direction', 'pageIncarnation', 'expectedGeneration'] : ['type', 'id', 'pageIncarnation', 'expectedGeneration'])
      && (v['type'] !== 'history' || v['direction'] === 'back' || v['direction'] === 'forward')
      && typeof v['pageIncarnation'] === 'string' && v['pageIncarnation'].length >= 1 && v['pageIncarnation'].length <= 128
      && typeof v['expectedGeneration'] === 'number' && Number.isSafeInteger(v['expectedGeneration']) && v['expectedGeneration'] >= 0) {
    return v['type'] === 'reload'
      ? { type: 'reload', id: v['id'], pageIncarnation: v['pageIncarnation'], expectedGeneration: v['expectedGeneration'] }
      : { type: 'history', id: v['id'], direction: v['direction'] as 'back' | 'forward', pageIncarnation: v['pageIncarnation'], expectedGeneration: v['expectedGeneration'] }
  }
  if (v['type'] === 'mode' && exact(v, ['type', 'id', 'mode']) && (v['mode'] === 'preview' || v['mode'] === 'browse')) return { type: 'mode', id: v['id'], mode: v['mode'] }
  if (v['type'] === 'viewport' && exact(v, ['type', 'id', 'pageIncarnation', 'expectedGeneration', 'width', 'height'])
      && typeof v['pageIncarnation'] === 'string' && v['pageIncarnation'].length >= 1 && v['pageIncarnation'].length <= 128
      && typeof v['expectedGeneration'] === 'number' && Number.isSafeInteger(v['expectedGeneration']) && v['expectedGeneration'] >= 0
      && typeof v['width'] === 'number' && Number.isSafeInteger(v['width']) && v['width'] >= 200 && v['width'] <= 4096
      && typeof v['height'] === 'number' && Number.isSafeInteger(v['height']) && v['height'] >= 200 && v['height'] <= 4096) return { type: 'viewport', id: v['id'], pageIncarnation: v['pageIncarnation'], expectedGeneration: v['expectedGeneration'], width: v['width'], height: v['height'] }
  if (v['type'] === 'navigate' && exact(v, ['type', 'id', 'url', 'pageIncarnation', 'expectedGeneration'])
      && typeof v['url'] === 'string' && v['url'].length <= 8192 && typeof v['pageIncarnation'] === 'string' && v['pageIncarnation'].length <= 128
      && typeof v['expectedGeneration'] === 'number' && Number.isSafeInteger(v['expectedGeneration']) && v['expectedGeneration'] >= 0) {
    return { type: 'navigate', id: v['id'], url: v['url'], pageIncarnation: v['pageIncarnation'], expectedGeneration: v['expectedGeneration'] }
  }
  throw new Error('INVALID_REQUEST')
}
