import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyBrowserRuntimeDelta, parseTabBrowserCommand, TabBrowserService } from './tabBrowserService'
import { TabBrowserStateStore } from './tabBrowserStateStore'
import { TabBrowserHost } from './tabBrowserHost'
import { emptyBrowserState, type BrowserStateFile } from '../shared/tabBrowserState'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

describe('parseTabBrowserCommand', () => {
  it('accepts the bounded renderer command surface', () => {
    expect(parseTabBrowserCommand({ type: 'open' })).toEqual({ type: 'open' })
    expect(parseTabBrowserCommand({ type: 'close' })).toEqual({ type: 'close' })
    expect(parseTabBrowserCommand({ type: 'share', sharedWithPi: true })).toEqual({ type: 'share', sharedWithPi: true })
    expect(parseTabBrowserCommand({ type: 'designate', designatedPi: 'amber-1-1-0-pi' })).toEqual({ type: 'designate', designatedPi: 'amber-1-1-0-pi' })
    expect(parseTabBrowserCommand({ type: 'show', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', bounds: { x: 1, y: 2, width: 3, height: 4 } })).toEqual({ type: 'show', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', bounds: { x: 1, y: 2, width: 3, height: 4 } })
    expect(parseTabBrowserCommand({ type: 'stopPi' }).type).toBe('stopPi')
    expect(parseTabBrowserCommand({ type: 'resolveApproval', approvalId: 'a', digest: 'a'.repeat(64), decision: 'approve-once' }).type).toBe('resolveApproval')
  })
  it('rejects generic methods, unknown keys, invalid ids, and unsafe geometry', () => {
    expect(() => parseTabBrowserCommand({ type: 'cdp', method: 'Runtime.evaluate' })).toThrow('INVALID_REQUEST')
    expect(() => parseTabBrowserCommand({ type: 'open', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })).toThrow('INVALID_REQUEST')
    expect(() => parseTabBrowserCommand({ type: 'close', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })).toThrow('INVALID_REQUEST')
    expect(() => parseTabBrowserCommand({ type: 'status', id: 'browser-a' })).toThrow('INVALID_REQUEST')
    expect(() => parseTabBrowserCommand({ type: 'bounds', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', bounds: { x: 0, y: 0, width: NaN, height: 2 } })).toThrow('INVALID_REQUEST')
    expect(() => parseTabBrowserCommand({ type: 'bounds', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', bounds: { x: 0, y: 0, width: 100_000, height: 2 } })).toThrow('INVALID_REQUEST')
  })
})

describe('TabBrowserService dispatch authorization', () => {
  it('rejects an already-live show after the sender context switches', async () => {
    const state = emptyBrowserState(1); let shown = false; let thawed = false
    const host = { status: () => ({ id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', stateRevision: 1 }), thaw: async () => { thawed = true }, show: () => { shown = true; return { id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', stateRevision: 1 } }, snapshot: () => state }
    const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state) => TabBrowserService
    const service = new Service({ update: async () => state } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state)
    await expect(service.command({ type: 'show', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', bounds: { x: 0, y: 0, width: 100, height: 100 } }, undefined, () => false)).rejects.toThrow('STALE_BROWSER_CONTEXT')
    expect({ thawed, shown }).toEqual({ thawed: false, shown: false })
  })

  it('revalidates a navigate after it waits behind another serialized command', async () => {
    const state = emptyBrowserState(1); let release!: () => void; let calls = 0; let current = true
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const host = { navigate: async () => { calls += 1; if (calls === 1) await blocked; return { id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', stateRevision: calls } }, snapshot: () => state }
    const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state) => TabBrowserService
    const service = new Service({ update: async () => state } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state)
    const command = { type: 'navigate' as const, id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', url: 'https://example.test/', pageIncarnation: 'page', expectedGeneration: 1 }
    const first = service.command(command)
    const queued = service.command(command, undefined, () => current)
    current = false; release(); await first
    await expect(queued).rejects.toThrow('STALE_BROWSER_CONTEXT')
    expect(calls).toBe(1)
  })

  it('revalidates a queued observation immediately before debugger dispatch', async () => {
    const state = emptyBrowserState(1); let release!: () => void; let automationCalls = 0
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const host = { navigate: async () => { await blocked; return { id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', stateRevision: 1 } }, runAutomation: async () => { automationCalls += 1; return {} }, snapshot: () => state }
    const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state) => TabBrowserService
    const service = new Service({ update: async () => state } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state)
    const first = service.command({ type: 'navigate', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', url: 'https://example.test/', pageIncarnation: 'page', expectedGeneration: 1 })
    const queued = service.command({ type: 'automation', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', action: { type: 'console', pageIncarnation: 'page', expectedGeneration: 1, limit: 10 } }, undefined, () => false)
    release(); await first
    await expect(queued).rejects.toThrow('STALE_BROWSER_CONTEXT')
    expect(automationCalls).toBe(0)
  })

  it('rejects a queued stop after authorization is lost without stopping the page', async () => {
    const state = emptyBrowserState(1); let release!: () => void; let stopped = 0
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const host = { navigate: async () => { await blocked; return { id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', stateRevision: 1 } }, stop: () => { stopped += 1; return { id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', stateRevision: 2 } }, snapshot: () => state }
    const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state) => TabBrowserService
    const service = new Service({ update: async () => state } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state)
    const first = service.command({ type: 'navigate', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', url: 'https://example.test/', pageIncarnation: 'page', expectedGeneration: 1 })
    const controller = new AbortController()
    const queued = service.command({ type: 'stop', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, controller.signal, () => false)
    release(); await first
    await expect(queued).rejects.toThrow('STALE_BROWSER_CONTEXT')
    expect(stopped).toBe(0)
  })

  it('revalidates queued bounds at dispatch rather than at enqueue', async () => {
    const state = emptyBrowserState(1); let release!: () => void; let boundsCalls = 0
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const host = { navigate: async () => { await blocked; return { id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', stateRevision: 1 } }, setBounds: () => { boundsCalls += 1 }, status: () => ({ id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', stateRevision: 1 }), snapshot: () => state }
    const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state) => TabBrowserService
    const service = new Service({ update: async () => state } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state)
    const first = service.command({ type: 'navigate', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', url: 'https://example.test/', pageIncarnation: 'page', expectedGeneration: 1 })
    const queued = service.command({ type: 'bounds', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', bounds: { x: 0, y: 0, width: 100, height: 100 } }, undefined, () => false)
    release(); await first
    await expect(queued).rejects.toThrow('STALE_BROWSER_CONTEXT')
    expect(boundsCalls).toBe(0)
  })

  it('revalidates a capacity-waiting open and removes its provisional record after a context switch', async () => {
    let disk = emptyBrowserState(1)
    const store = { update: async (mutate: (state: BrowserStateFile) => BrowserStateFile) => { disk = mutate(disk); return disk } } as unknown as TabBrowserStateStore
    const pageFactory = { create: () => ({ loadURL: async () => {}, show: () => {}, hide: () => {}, stop: () => {}, destroy: () => {} }) }
    let service!: TabBrowserService
    const host = new TabBrowserHost(disk, pageFactory, Date.now, undefined, () => { void (service as unknown as { schedulePersist: () => Promise<void> }).schedulePersist() })
    const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: TabBrowserHost, i: BrowserStateFile) => TabBrowserService
    service = new Service(store, { setWindow: () => {} }, host, disk)
    const ids: string[] = []
    for (let i = 0; i < 4; i++) { const opened = await service.command({ type: 'open' }); if ('id' in opened) { ids.push(opened.id); host.protectApproval(opened.id, true) } }
    let current = true
    const waiting = service.command({ type: 'open' }, undefined, () => current)
    await Promise.resolve(); current = false; host.protectApproval(ids[0]!, false)
    await expect(waiting).rejects.toThrow('STALE_BROWSER_CONTEXT')
    expect(host.liveIds().sort()).toEqual([...ids].sort())
    expect(Object.keys(host.snapshot().records)).toHaveLength(4)
    expect(Object.keys(disk.records)).toHaveLength(4)
    const subsequent = await service.command({ type: 'open' }, undefined, () => true)
    expect(subsequent).toHaveProperty('id')
  })
})

describe('TabBrowserService approvals and Stop Pi', () => {
  it('occludes while awaiting an exact approval and never emits a credential value', async () => {
    const state = emptyBrowserState(1), events: Array<Record<string, unknown>> = [], protectedValues: boolean[] = []
    const id = 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const host = {
      runAutomation: async (_id: string, action: { operation: unknown }, signal: AbortSignal, approve: (request: unknown, signal: AbortSignal) => Promise<void>) => {
        await approve({ operation: action.operation, target: { role: 'textbox', name: 'Password', tag: 'input', type: 'password', fingerprint: 'fp' },
          classification: { consequential: true, category: 'credential', valueCategory: 'credential', canGrantOrigin: false, argumentSummary: '[credential value omitted]' },
          origin: 'https://example.test', pageIncarnation: 'page', generation: 1 }, signal)
        return { dispatched: true, rollbackPossible: false }
      },
      protectApproval: (_id: string, value: boolean) => protectedValues.push(value), status: () => ({ id, stateRevision: 1 }), snapshot: () => state,
    }
    const window = { isDestroyed: () => false, isVisible: () => true, show: () => {}, focus: () => {} }
    const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state, w: typeof window) => TabBrowserService
    const service = new Service({ update: async () => state } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state, window)
    service.setEventSink((event) => events.push(event as Record<string, unknown>))
    const pending = service.command({ type: 'automation', id, broker: { requestId: 'request-1', controller: 'amber-1-1-0-pi' }, action: { type: 'interact', pageIncarnation: 'page', expectedGeneration: 1, operation: { kind: 'fill', target: { snapshotId: 'snap', ref: 'n1' }, text: 'super-secret' } } })
    await vi.waitFor(() => expect(events.some((event) => event['type'] === 'approval-request')).toBe(true))
    const request = events.find((event) => event['type'] === 'approval-request')!
    expect(JSON.stringify(request)).not.toContain('super-secret')
    await service.command({ type: 'resolveApproval', id, approvalId: String(request['approvalId']), digest: String(request['digest']), decision: 'approve-once' })
    await expect(pending).resolves.toMatchObject({ dispatched: true, rollbackPossible: false })
    expect(protectedValues).toEqual([true, false])
  })

  it('Stop Pi aborts active broker work and clears its approval', async () => {
    const state = emptyBrowserState(1), id = 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; let aborted = false; let started = false
    const host = { runAutomation: async (_id: string, _action: unknown, signal: AbortSignal) => new Promise((_resolve, reject) => { started = true; signal.addEventListener('abort', () => { aborted = true; reject(new Error('ACTION_CANCELLED')) }, { once: true }) }), status: () => ({ id, stateRevision: 1 }), snapshot: () => state }
    const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state) => TabBrowserService
    const service = new Service({ update: async () => state } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state)
    const active = service.command({ type: 'automation', id, broker: { requestId: 'request-1', controller: 'amber-1-1-0-pi' }, action: { type: 'console', pageIncarnation: 'page', expectedGeneration: 1, limit: 10 } })
    await vi.waitFor(() => expect(started).toBe(true)); await service.command({ type: 'stopPi', id })
    await expect(active).rejects.toThrow('ACTION_CANCELLED'); expect(aborted).toBe(true)
  })
})

describe('TabBrowserService activation cancellation', () => {
  it('hide cancels a queued show before it can attach', async () => {
    const state = emptyBrowserState(1); const store = { update: async () => state } as unknown as TabBrowserStateStore
    let attached = false
    const host = {
      status: () => ({ id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', stateRevision: 1 }),
      thaw: async (_id: string, signal?: AbortSignal) => new Promise((_resolve, reject) => {
        if (signal?.aborted) reject(new Error('ACTION_CANCELLED'))
        else signal?.addEventListener('abort', () => reject(new Error('ACTION_CANCELLED')), { once: true })
      }),
      show: () => { attached = true; return { id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', stateRevision: 1 } },
      hide: () => {}, snapshot: () => state,
    }
    const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state) => TabBrowserService
    const service = new Service(store, { setWindow: () => {} }, host, state)
    const showing = service.command({ type: 'show', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', bounds: { x: 0, y: 0, width: 100, height: 100 } })
    await Promise.resolve(); await service.command({ type: 'hide', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
    await expect(showing).rejects.toThrow('ACTION_CANCELLED')
    expect(attached).toBe(false)
  })
})

describe('TabBrowserService recovery persistence', () => {
  it('survives a service restart after deleting a recovery item', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'amber-recovery-delete-')); dirs.push(dir)
    const store = new TabBrowserStateStore(dir)
    const state = { ...emptyBrowserState(1), migrationRecovery: [{ workspace: 1, tab: 2, safeRestoreUrl: 'https://recover.test/' }] }
    await store.save(state)
    let service!: TabBrowserService
    const host = new TabBrowserHost(state, { create: () => { throw new Error('not used') } }, Date.now, undefined,
      () => { void (service as unknown as { schedulePersist: () => Promise<void> }).schedulePersist() })
    const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: TabBrowserHost, i: typeof state) => TabBrowserService
    service = new Service(store, { setWindow: () => {} }, host, state)
    await service.deleteRecovery(0)
    const restartedState = await new TabBrowserStateStore(dir).load()
    const restartedHost = new TabBrowserHost(restartedState, { create: () => { throw new Error('not used') } })
    const restarted = new Service(store, { setWindow: () => {} }, restartedHost, restartedState)
    expect(restarted.recoveryItems()).toEqual([])
  })
})

describe('applyBrowserRuntimeDelta', () => {
  it('preserves transaction records while applying an independent runtime record change', () => {
    const previous = emptyBrowserState(1)
    const runtime: BrowserStateFile = { ...previous, records: { 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': { id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', profileId: 'global', mode: 'browse', safeRestoreUrl: 'about:blank', title: '', viewport: { width: 800, height: 600 }, lifecycle: 'frozen', stateRevision: 1, lastUsedAt: 1, lastFocusedAt: 0 } } }
    const transaction: BrowserStateFile = { ...previous, pendingTransaction: { id: 'tx', kind: 'browser-association', expectedLayoutVersion: null, layoutText: '{}' }, records: { 'browser-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb': { ...runtime.records['browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']!, id: 'browser-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } } }
    const merged = applyBrowserRuntimeDelta(transaction, previous, runtime)
    expect(Object.keys(merged.records).sort()).toEqual(['browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'browser-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'])
    expect(merged.pendingTransaction?.id).toBe('tx')
  })
  it('applies an exact recovery deletion without discarding concurrently added recovery', () => {
    const previous = { ...emptyBrowserState(1), migrationRecovery: [{ workspace: 1, tab: 1, safeRestoreUrl: 'https://old.test/' }] }
    const runtime = { ...previous, migrationRecovery: [] }
    const current = { ...previous, migrationRecovery: [...previous.migrationRecovery, { workspace: 2, tab: 2, safeRestoreUrl: 'https://new.test/' }] }
    expect(applyBrowserRuntimeDelta(current, previous, runtime).migrationRecovery).toEqual([{ workspace: 2, tab: 2, safeRestoreUrl: 'https://new.test/' }])
  })
})
