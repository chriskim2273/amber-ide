import { afterEach, describe, expect, it } from 'vitest'
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
