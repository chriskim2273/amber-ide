import type { BrowserWindow, Rectangle } from 'electron'
import { ElectronTabBrowserPageFactory } from './electronTabBrowserPage'
import { TabBrowserHost, type BrowserRuntimeStatus } from './tabBrowserHost'
import { isOpaqueBrowserId, safeRestoreUrl, type BrowserId } from '../shared/tabBrowser'
import type { WsBrowser } from '../shared/workspaceFile'
import { TabBrowserStateStore } from './tabBrowserStateStore'
import { BROWSER_RECOVERY_MAX, isRecoveryId, type BrowserStateFile, type RecoveryId } from '../shared/tabBrowserState'
import type { BrowserToolAction } from './browserToolProtocol'
import { parseBrowserViewport } from '../shared/browserViewport'
import { BrowserApprovalCoordinator, BrowserDialogCoordinator, interactionTargetDigest, interactionValueDigest, type ApprovalDecision } from './browserApproval'
import { navigationPolicyAllows, selectPreviewOrigin } from './tabBrowserPolicy'
import { BrowserOperationRegistry } from './browserOperationRegistry'

/** Grace after cancellation before a non-cooperative page adapter is detached from the FIFO. */
export const TAB_BROWSER_QUEUE_BARRIER_TIMEOUT_MS = 1_000

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('ACTION_CANCELLED'))
  let onAbort: (() => void) | undefined
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error('ACTION_CANCELLED'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  return Promise.race([promise, cancelled]).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  })
}

interface BrowserQueueOperation {
  /** The caller's controller. This operation, not the queue key, owns it. */
  controller: AbortController
  /** Set only after this entry has passed the pre-dispatch cancellation fence. */
  started: boolean
  /** Bound only at actual dispatch, never while the entry is merely queued. */
  identity: { id: string; pageIncarnation: string } | undefined
  /** Isolation is a one-shot transition for this operation. */
  isolationStarted: boolean
}

/**
 * Keep one queue tail per operation. A cancelled follower must still wait for
 * its predecessor's tail: resolving its tail immediately would let the next
 * entry overtake an active adapter. Only an entry that actually started may
 * arm the bounded non-cooperative adapter barrier, and the isolation callback
 * is therefore bound to that entry's runtime identity.
 */
function boundedQueueBarrier(
  promise: Promise<unknown>,
  releaseSignal: AbortSignal,
  timeoutMs: number,
  operationStarted: () => boolean,
  stillPending?: () => boolean | undefined,
  isolate?: () => void | Promise<void>,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout | undefined
    let finished = false
    let operationSettled = false
    const finish = (): void => {
      if (finished) return
      finished = true
      if (timer) clearTimeout(timer)
      releaseSignal.removeEventListener('abort', release)
      resolve()
    }
    const release = (): void => {
      if (finished || timer || operationSettled) {
        if (operationSettled) finish()
        return
      }
      // This entry is still waiting behind another entry. Its cancellation is
      // not permission to release the tail or quarantine the active entry.
      if (!operationStarted()) return
      const pending = stillPending?.()
      if (pending === false) { finish(); return }
      if (timeoutMs <= 0) {
        void Promise.resolve(isolate?.()).then(finish, () => {})
        return
      }
      timer = setTimeout(() => {
        timer = undefined
        if (operationSettled) { finish(); return }
        const adapterPending = stillPending?.()
        if (adapterPending === false) { finish(); return }
        // The operation owns this callback. Do not infer ownership from the
        // browser id: a queued follower can share the same incarnation.
        void Promise.resolve(isolate?.()).then(finish, () => {})
      }, timeoutMs)
      timer.unref()
    }
    const settled = (): void => {
      operationSettled = true
      // A cooperative operation, including a cancelled queued follower that
      // has just reached the head, releases normally. A non-cooperative active
      // operation is released by the isolation timer above.
      finish()
    }
    promise.then(settled, settled)
    releaseSignal.addEventListener('abort', release, { once: true })
    if (releaseSignal.aborted) release()
  })
}

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

export interface WorkspaceBrowserImport { entries: { id: BrowserId; browser: WsBrowser }[]; recovery: { id: RecoveryId; ws: number; tab: number; browser: WsBrowser }[] }

export function stageWorkspaceBrowserState(state: BrowserStateFile, input: WorkspaceBrowserImport, now = Date.now()): BrowserStateFile {
  const records = { ...state.records }
  for (const { id, browser } of input.entries) {
    if (records[id]) throw new Error('BROWSER_ID_COLLISION')
    const restoreUrl = safeRestoreUrl(browser.safeRestoreUrl), viewport = parseBrowserViewport(browser.viewport ?? { width: 1280, height: 800 })
    if (!viewport) throw new Error('INVALID_REQUEST')
    const previewOrigins = browser.mode === 'preview' && restoreUrl !== 'about:blank' && !navigationPolicyAllows('preview', [], restoreUrl) ? selectPreviewOrigin([], restoreUrl) : undefined
    records[id] = { id, profileId: 'global', mode: browser.mode, safeRestoreUrl: restoreUrl, title: '',
      viewport, ...(previewOrigins ? { previewOrigins } : {}), lifecycle: 'frozen', stateRevision: 1, lastUsedAt: now, lastFocusedAt: 0 }
  }
  if (state.migrationRecovery.length + input.recovery.length > BROWSER_RECOVERY_MAX) throw new Error('BROWSER_RECOVERY_LIMIT')
  const recoveryIds = new Set(state.migrationRecovery.map((item) => item.id))
  const migrationRecovery = input.recovery.map((item) => {
    if (!isRecoveryId(item.id) || recoveryIds.has(item.id)) throw new Error('BROWSER_RECOVERY_ID_COLLISION')
    recoveryIds.add(item.id)
    return { id: item.id, workspace: item.ws, tab: item.tab, safeRestoreUrl: safeRestoreUrl(item.browser.safeRestoreUrl) }
  })
  return { ...state, records, migrationRecovery: [...state.migrationRecovery, ...migrationRecovery] }
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

  // Recovery entries are identity-bearing records. Comparing URL/location and
  // counts cannot tell which duplicate item a concurrent delete targeted.
  const previousById = new Map(previous.migrationRecovery.map((item) => [item.id, item]))
  const runtimeById = new Map(runtime.migrationRecovery.map((item) => [item.id, item]))
  const recovery = [...current.migrationRecovery]
  for (const [id, prior] of previousById) {
    const currentIndex = recovery.findIndex((item) => item.id === id)
    if (currentIndex < 0) continue
    const currentItem = recovery[currentIndex]!
    const next = runtimeById.get(id)
    if (!next && JSON.stringify(currentItem) === JSON.stringify(prior)) recovery.splice(currentIndex, 1)
    else if (next && JSON.stringify(currentItem) === JSON.stringify(prior)) recovery[currentIndex] = next
  }
  const currentIds = new Set(recovery.map((item) => item.id))
  for (const item of runtime.migrationRecovery) if (!previousById.has(item.id) && !currentIds.has(item.id)) {
    recovery.push(item); currentIds.add(item.id)
  }
  return { ...current, revision: current.revision + 1, profiles: runtime.profiles, records, migrationRecovery: recovery }
}

export class TabBrowserService {
  private readonly browserQueues = new Map<string, Promise<void>>()
  private recoveryQueue: Promise<void> = Promise.resolve()
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
  /** Operations whose caller has gone away but whose page adapter is being isolated. */
  private readonly quarantinedOperations = new Set<symbol>()
  private drainGeneration = 0
  private runtimeFlush: NodeJS.Timeout | null = null
  private approvalSurfaceVisible: (browserId: string) => boolean = () => false
  private approvalSurfaceReveal: (browserId: string) => void = () => {}
  private draining = false

  private constructor(
    private readonly store: TabBrowserStateStore,
    private readonly pages: ElectronTabBrowserPageFactory,
    private readonly host: TabBrowserHost,
    initialState: BrowserStateFile,
    window?: BrowserWindow,
    private readonly operations = new BrowserOperationRegistry(),
  ) {
    this.persistedState = structuredClone(initialState); this.currentWindow = window ?? null
    this.approvals = new BrowserApprovalCoordinator(Date.now, (id) => this.host.isVisible(id) && this.approvalSurfaceVisible(id), (event) => this.eventSink(event), 60_000, (id) => this.approvalSurfaceReveal(id))
    this.dialogs = new BrowserDialogCoordinator(Date.now, (id) => this.host.isVisible(id) && this.approvalSurfaceVisible(id), (id) => { try { const status = this.host.status(id); return { pageIncarnation: status.pageIncarnation, generation: status.generation } } catch { return null } }, (event) => this.eventSink(event), 60_000, (id) => this.approvalSurfaceReveal(id))
  }

  static async create(root: string, window: BrowserWindow, store = new TabBrowserStateStore(root), operations = new BrowserOperationRegistry()): Promise<TabBrowserService> {
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
    service = new TabBrowserService(store, pages, host, persistedState, window, operations)
    return service
  }

  setWindow(window: BrowserWindow): void { this.currentWindow = window; this.pages.setWindow(window) }
  windowHidden(): void {
    this.currentWindow = null
    for (const id of this.host.liveIds()) {
      this.surfaceHidden(id)
      this.host.hide(id)
    }
  }
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

  importWorkspaceBrowsers(input: WorkspaceBrowserImport): Promise<void> {
    return this.operations.run('workspace-import', async (signal) => { this.operations.assertDispatch(signal); await this.importWorkspaceBrowsersCommitted(input) })
  }

  async importWorkspaceBrowsersCommitted(input: WorkspaceBrowserImport): Promise<void> {
    const { entries, recovery } = input
    const ids = new Set<string>()
    for (const entry of entries) {
      if (!isOpaqueBrowserId(entry.id) || ids.has(entry.id)) throw new Error('BROWSER_ID_COLLISION')
      ids.add(entry.id)
      if (entry.browser.mode !== 'preview' && entry.browser.mode !== 'browse') throw new Error('INVALID_REQUEST')
    }
    this.suppressPersist = true
    try { this.host.importWorkspace(entries, recovery) } finally { this.suppressPersist = false }
    const loaded = await this.store.load()
    this.persistedState = structuredClone(loaded)
  }

  async destroyForAssociation(id: string): Promise<void> {
    this.approvals.clearBrowser(id); this.dialogs.clearBrowser(id); this.latestPiActions.delete(id)
    try { this.host.close(id) } catch { return }
    await this.schedulePersist()
  }

  workspaceSnapshot(): ReturnType<TabBrowserHost['workspaceSnapshot']> { return this.host.workspaceSnapshot() }
  recoveryItems(): ReturnType<TabBrowserHost['recoveryItems']> { return this.host.recoveryItems() }
  private enqueueRecovery<T>(work: () => Promise<T>): Promise<T> {
    const result = this.recoveryQueue.then(work)
    this.recoveryQueue = result.then(() => {}, () => {})
    return result
  }
  deleteRecovery(id: RecoveryId): Promise<void> {
    return this.operations.run('recovery', (signal) => this.enqueueRecovery(async () => {
      this.operations.assertDispatch(signal); this.host.deleteRecovery(id); await this.schedulePersist()
    }))
  }
  attachRecovery(id: RecoveryId, browserId: BrowserId): Promise<BrowserRuntimeStatus> {
    return this.operations.run('recovery', (signal) => this.enqueueRecovery(async () => {
      this.operations.assertDispatch(signal); return this.attachRecoveryCommittedUnsafe(id, browserId)
    }))
  }
  attachRecoveryCommitted(id: RecoveryId, browserId: BrowserId): Promise<BrowserRuntimeStatus> {
    return this.enqueueRecovery(() => this.attachRecoveryCommittedUnsafe(id, browserId))
  }
  private async attachRecoveryCommittedUnsafe(id: RecoveryId, browserId: BrowserId): Promise<BrowserRuntimeStatus> {
    this.suppressPersist = true
    try {
      try { return this.host.attachRecovery(id, browserId) }
      catch (error) {
        if (!(error instanceof Error) || error.message !== 'NO_RECOVERY_ITEM') throw error
        const committed = (await this.store.load()).records[browserId]
        if (!committed) throw error
        return this.host.syncCommittedBrowser(id, committed)
      }
    } finally {
      this.suppressPersist = false
      const loaded = await this.store.load(); this.persistedState = structuredClone(loaded)
    }
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
    return this.operations.run('command', (ownedSignal) => this.enqueueCommand(command, ownedSignal, validate), signal)
  }

  private enqueueCommand(command: TabBrowserCommand, signal?: AbortSignal, validate?: () => boolean | Promise<boolean>): Promise<unknown> {
    // Opens must reach the host concurrently so the global capacity FIFO sees
    // every contender. Observations and hide also cannot sit behind a wait.
    if (command.type === 'hide' || command.type === 'destroy') this.activationControllers.get(command.id)?.abort()
    if (command.type === 'navigate' || command.type === 'stop') this.dialogs.clearBrowser(command.id)
    if (command.type === 'open' || command.type === 'status' || command.type === 'stop' || command.type === 'hide' || command.type === 'destroy' || command.type === 'resolveApproval' || command.type === 'resolveDialog' || command.type === 'stopPi') {
      const immediate = this.runCommand(command, signal, validate)
      return signal ? abortable(immediate, signal) : immediate
    }
    if (command.type === 'close' || command.type === 'share' || command.type === 'designate') return Promise.reject(new Error('ASSOCIATION_COMMAND_REQUIRES_MAIN'))
    const key = command.id
    const prior = this.browserQueues.get(key) ?? Promise.resolve()
    const controller = new AbortController()
    if (command.type === 'show') {
      this.activationControllers.get(command.id)?.abort(); this.activationControllers.set(command.id, controller)
    }
    const abort = (): void => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    const ownership: BrowserQueueOperation = { controller, started: false, identity: undefined, isolationStarted: false }
    const operation = prior.catch(() => {}).then(async () => {
      this.operations.assertDispatch(controller.signal)
      // This is the ownership boundary. A follower that was cancelled while
      // queued never gets a bound runtime and therefore cannot quarantine the
      // operation that was active before it.
      ownership.started = true
      ownership.identity = this.browserOperationIdentity(command)
      const result = await this.runCommand(command, controller.signal, validate)
      // A non-cooperative adapter may resolve after its caller was cancelled.
      // Do not let that late result cross the service boundary or commit the
      // command's post-dispatch state update to a dead request.
      this.operations.assertDispatch(controller.signal)
      return result
    })
    // Normal adapters retain strict FIFO and no overlap. Once cancellation
    // aborts an adapter, wait for cooperative settlement, but release the
    // queue after a bounded grace so one hung WebContents cannot block later
    // mutations or resident quit forever. The late operation remains attached
    // to this promise, so any eventual rejection is observed and isolated.
    const tail = boundedQueueBarrier(operation, controller.signal, TAB_BROWSER_QUEUE_BARRIER_TIMEOUT_MS,
      () => ownership.started,
      () => {
        const identity = ownership.identity
        if (!identity) return false
        const pending = (this.host as unknown as { hasPendingOperation?: (id: string, incarnation: string) => boolean }).hasPendingOperation
        return typeof pending === 'function' ? pending.call(this.host, identity.id, identity.pageIncarnation) : undefined
      },
      () => this.isolateBrowserOperation(ownership))
    this.browserQueues.set(key, tail)
    void tail.then(() => {}, () => {}).finally(() => {
      signal?.removeEventListener('abort', abort)
      if (this.browserQueues.get(key) === tail) this.browserQueues.delete(key)
      if (command.type === 'show' && this.activationControllers.get(key) === controller) this.activationControllers.delete(key)
    })
    return abortable(operation, controller.signal)
  }

  private browserOperationIdentity(command: TabBrowserCommand): { id: string; pageIncarnation: string } | undefined {
    if (command.type === 'navigate' || command.type === 'reload' || command.type === 'history' || command.type === 'viewport') return { id: command.id, pageIncarnation: command.pageIncarnation }
    if (command.type === 'automation') return { id: command.id, pageIncarnation: command.action.pageIncarnation }
    return undefined
  }

  private async isolateBrowserOperation(ownership: BrowserQueueOperation): Promise<void> {
    if (!ownership.started || ownership.isolationStarted || !ownership.identity) return
    ownership.isolationStarted = true
    const { id, pageIncarnation } = ownership.identity
    const key = Symbol('browser-quarantine')
    this.quarantinedOperations.add(key)
    try { await this.host.quarantine?.(id, pageIncarnation) } finally { this.quarantinedOperations.delete(key) }
  }

  private withLatestAction<T extends object>(id: string, status: T): T & { lastAction?: unknown } {
    const lastAction = this.latestPiActions.get(id); return { ...status, ...(lastAction ? { lastAction } : {}) }
  }
  private brokerStatus(id: string, input?: Record<string, unknown>): Record<string, unknown> {
    const { currentUrl: _privateCurrentUrl, previewOrigins: _privatePreviewOrigins, ...status } = this.withLatestAction(id, input ?? this.host.status(id) as unknown as Record<string, unknown>)
    return status
  }
  private piAction(id: string, controller: string, action: string, phase: 'started' | 'completed' | 'failed', error?: unknown): void {
    const raw = error instanceof Error ? error.message : 'INTERNAL_ERROR'
    const event = { type: 'pi-action' as const, browserId: id, controller: controller.slice(0, 256), action: action.slice(0, 64), phase, ...(phase === 'failed' ? { error: /^[A-Z][A-Z0-9_]{1,63}$/.test(raw) ? raw : 'INTERNAL_ERROR' } : {}), at: Date.now() }
    if (!this.latestPiActions.has(id) && this.latestPiActions.size >= 256) this.latestPiActions.delete(this.latestPiActions.keys().next().value as string)
    this.latestPiActions.set(id, event); this.eventSink(event)
  }
  private async runCommand(command: TabBrowserCommand, signal?: AbortSignal, validate?: () => boolean | Promise<boolean>): Promise<unknown> {
    this.operations.assertDispatch(signal)
    if (validate && !(await validate())) throw new Error('STALE_BROWSER_CONTEXT')
    this.operations.assertDispatch(signal)
    switch (command.type) {
      case 'open': {
        try {
          const opened = await this.host.open({ visible: true }, signal, validate)
          this.operations.assertDispatch(signal)
          await this.schedulePersist(); return this.withLatestAction(opened.status.id, opened.status)
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
        this.operations.assertDispatch(signal)
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
        this.operations.assertDispatch(signal)
        if (command.type === 'viewport') await this.schedulePersist()
        return this.withLatestAction(command.id, this.host.status(command.id))
      }
      case 'mode': { const status = this.host.setMode(command.id, command.mode, 'user'); await this.schedulePersist(); return this.withLatestAction(command.id, status) }
      case 'focusPage': return this.withLatestAction(command.id, this.host.focusPage(command.id))
      case 'focusChrome': return this.withLatestAction(command.id, this.host.focusChrome(command.id))
      case 'navigate': {
        const activeOwner = command.broker ? { controller: new AbortController(), owner: `${command.broker.controller}\u0000${command.broker.requestId}` } : null
        const upstreamAbort = (): void => activeOwner?.controller.abort()
        if (activeOwner) { signal?.addEventListener('abort', upstreamAbort, { once: true }); if (signal?.aborted) activeOwner.controller.abort(); const set = this.activePi.get(command.id) ?? new Set<{ controller: AbortController; owner: string }>(); set.add(activeOwner); this.activePi.set(command.id, set) }
        if (command.broker) this.piAction(command.id, command.broker.controller, 'navigate', 'started')
        try {
          const status = await this.host.navigate(command.id, command.url, command.pageIncarnation, command.expectedGeneration, activeOwner?.controller.signal ?? signal, command.broker ? 'broker' : 'user')
          this.operations.assertDispatch(signal)
          await this.schedulePersist(); if (command.broker) this.piAction(command.id, command.broker.controller, 'navigate', 'completed'); return command.broker ? this.brokerStatus(command.id, status as unknown as Record<string, unknown>) : this.withLatestAction(command.id, status)
        }
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
          this.operations.assertDispatch(signal)
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

  pendingWork(): { operations: number; piActions: number; approvals: number; dialogs: number; pageLoads: number; queued: number; quarantined: number; total: number } {
    const operations = this.operations.summary().total
    const piActions = [...this.activePi.values()].reduce((sum, entries) => sum + entries.size, 0)
    const approvals = this.approvals.pendingCount(), dialogs = this.dialogs.pendingCount()
    const pageLoads = this.host.pendingLoadCount(), queued = this.browserQueues.size + this.activationControllers.size
    const quarantined = this.quarantinedOperations.size
    return { operations, piActions, approvals, dialogs, pageLoads, queued, quarantined, total: operations + approvals + dialogs + pageLoads + queued + quarantined }
  }

  beginDrain(): void {
    if (this.draining) return
    this.draining = true; this.drainGeneration += 1
    this.operations.beginDrain()
    for (const controller of this.activationControllers.values()) controller.abort()
    this.approvals.clearAll(); this.dialogs.clearAll()
    for (const id of Object.keys(this.host.snapshot().records)) this.revokePi(id)
  }

  cancelDrain(): void {
    if (!this.draining) return
    this.draining = false; this.drainGeneration += 1; this.operations.cancelDrain()
  }

  private async waitForDrain<T>(work: Promise<T>, signal: AbortSignal | undefined, generation: number): Promise<T> {
    if (signal?.aborted || generation !== this.drainGeneration) throw new Error('ACTION_CANCELLED')
    let abort: (() => void) | undefined
    const cancelled = signal ? new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error('ACTION_CANCELLED'))
      signal.addEventListener('abort', abort, { once: true })
    }) : null
    try {
      const result = cancelled ? await Promise.race([work, cancelled]) : await work
      if (signal?.aborted || generation !== this.drainGeneration) throw new Error('ACTION_CANCELLED')
      return result
    } finally { if (abort) signal?.removeEventListener('abort', abort) }
  }

  async flushAndDestroy(signal?: AbortSignal): Promise<void> {
    const generation = this.drainGeneration
    await this.waitForDrain(this.operations.waitForEmpty(), signal, generation)
    await this.waitForDrain(Promise.allSettled([...this.browserQueues.values()]), signal, generation)
    this.host.freezeAll()
    await this.waitForDrain(this.schedulePersist(), signal, generation)
    await this.waitForDrain(this.persistQueue, signal, generation)
    if (signal?.aborted || generation !== this.drainGeneration) throw new Error('ACTION_CANCELLED')
    if (this.runtimeFlush) { clearTimeout(this.runtimeFlush); this.runtimeFlush = null }
    this.pendingRuntimeEvents.clear()
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
  if (v['type'] === 'hide' || v['type'] === 'status' || v['type'] === 'focusPage' || v['type'] === 'focusChrome') {
    if (!exact(v, ['type', 'id'])) throw new Error('INVALID_REQUEST')
    return { type: v['type'], id: v['id'] }
  }
  if (v['type'] === 'stop') {
    if (exact(v, ['type', 'id'])) return { type: 'stop', id: v['id'] }
    if (!exact(v, ['type', 'id', 'pageIncarnation', 'expectedGeneration']) || typeof v['pageIncarnation'] !== 'string' || v['pageIncarnation'].length < 1 || v['pageIncarnation'].length > 128
        || typeof v['expectedGeneration'] !== 'number' || !Number.isSafeInteger(v['expectedGeneration']) || v['expectedGeneration'] < 0) throw new Error('INVALID_REQUEST')
    return { type: 'stop', id: v['id'], pageIncarnation: v['pageIncarnation'], expectedGeneration: v['expectedGeneration'] }
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
  const viewport = v['type'] === 'viewport' ? parseBrowserViewport({ width: v['width'], height: v['height'] }) : null
  if (v['type'] === 'viewport' && viewport && exact(v, ['type', 'id', 'pageIncarnation', 'expectedGeneration', 'width', 'height'])
      && typeof v['pageIncarnation'] === 'string' && v['pageIncarnation'].length >= 1 && v['pageIncarnation'].length <= 128
      && typeof v['expectedGeneration'] === 'number' && Number.isSafeInteger(v['expectedGeneration']) && v['expectedGeneration'] >= 0) return { type: 'viewport', id: v['id'], pageIncarnation: v['pageIncarnation'], expectedGeneration: v['expectedGeneration'], ...viewport }
  if (v['type'] === 'navigate' && exact(v, ['type', 'id', 'url', 'pageIncarnation', 'expectedGeneration'])
      && typeof v['url'] === 'string' && v['url'].length <= 8192 && typeof v['pageIncarnation'] === 'string' && v['pageIncarnation'].length <= 128
      && typeof v['expectedGeneration'] === 'number' && Number.isSafeInteger(v['expectedGeneration']) && v['expectedGeneration'] >= 0) {
    return { type: 'navigate', id: v['id'], url: v['url'], pageIncarnation: v['pageIncarnation'], expectedGeneration: v['expectedGeneration'] }
  }
  throw new Error('INVALID_REQUEST')
}
