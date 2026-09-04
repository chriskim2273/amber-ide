import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyBrowserRuntimeDelta, parseTabBrowserCommand, stageWorkspaceBrowserState, TAB_BROWSER_QUEUE_BARRIER_TIMEOUT_MS, TabBrowserService } from './tabBrowserService'
import { TabBrowserStateStore } from './tabBrowserStateStore'
import { TabBrowserHost, type TabBrowserPageEvent } from './tabBrowserHost'
import { emptyBrowserState, type BrowserStateFile } from '../shared/tabBrowserState'
import { railReloadCommand, railStopCommand } from '../renderer/browserRailModel'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

describe('parseTabBrowserCommand', () => {
  it('accepts the bounded renderer command surface', () => {
    expect(parseTabBrowserCommand({ type: 'open' })).toEqual({ type: 'open' })
    expect(parseTabBrowserCommand({ type: 'close' })).toEqual({ type: 'close' })
    expect(parseTabBrowserCommand({ type: 'share', sharedWithPi: true })).toEqual({ type: 'share', sharedWithPi: true })
    expect(parseTabBrowserCommand({ type: 'designate', designatedPi: 'amber-1-1-0-pi' })).toEqual({ type: 'designate', designatedPi: 'amber-1-1-0-pi' })
    expect(parseTabBrowserCommand({ type: 'show', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', bounds: { x: 1, y: 2, width: 3, height: 4 } })).toEqual({ type: 'show', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', bounds: { x: 1, y: 2, width: 3, height: 4 } })
    expect(parseTabBrowserCommand({ type: 'reload', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', pageIncarnation: 'page', expectedGeneration: 2 })).toMatchObject({ type: 'reload', expectedGeneration: 2 })
    expect(parseTabBrowserCommand({ type: 'history', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', direction: 'back', pageIncarnation: 'page', expectedGeneration: 2 })).toMatchObject({ type: 'history', direction: 'back' })
    expect(parseTabBrowserCommand({ type: 'mode', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', mode: 'preview' })).toMatchObject({ type: 'mode', mode: 'preview' })
    expect(parseTabBrowserCommand({ type: 'viewport', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', pageIncarnation: 'page', expectedGeneration: 2, width: 390, height: 844 })).toMatchObject({ type: 'viewport', width: 390, height: 844 })
    expect(parseTabBrowserCommand({ type: 'focusPage', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })).toMatchObject({ type: 'focusPage' })
    const stop = railStopCommand({ id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', pageIncarnation: 'page', generation: 2, lifecycle: 'live' })
    expect(parseTabBrowserCommand(stop)).toEqual(stop)
    expect(parseTabBrowserCommand({ type: 'stopPi' }).type).toBe('stopPi')
    expect(parseTabBrowserCommand({ type: 'resolveApproval', approvalId: 'a', digest: 'a'.repeat(64), decision: 'approve-once' }).type).toBe('resolveApproval')
    expect(parseTabBrowserCommand({ type: 'resolveDialog', dialogId: 'd', digest: 'b'.repeat(64), accept: true, promptText: 'ok' }).type).toBe('resolveDialog')
  })
  it('rejects generic methods, unknown keys, invalid ids, and unsafe geometry', () => {
    expect(() => parseTabBrowserCommand({ type: 'cdp', method: 'Runtime.evaluate' })).toThrow('INVALID_REQUEST')
    expect(() => parseTabBrowserCommand({ type: 'open', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })).toThrow('INVALID_REQUEST')
    expect(() => parseTabBrowserCommand({ type: 'close', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })).toThrow('INVALID_REQUEST')
    expect(() => parseTabBrowserCommand({ type: 'status', id: 'browser-a' })).toThrow('INVALID_REQUEST')
    expect(() => parseTabBrowserCommand({ type: 'bounds', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', bounds: { x: 0, y: 0, width: NaN, height: 2 } })).toThrow('INVALID_REQUEST')
    expect(() => parseTabBrowserCommand({ type: 'bounds', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', bounds: { x: 0, y: 0, width: 100_000, height: 2 } })).toThrow('INVALID_REQUEST')
    expect(() => parseTabBrowserCommand({ type: 'viewport', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', pageIncarnation: 'page', expectedGeneration: 2, width: 1, height: 844 })).toThrow('INVALID_REQUEST')
    expect(() => parseTabBrowserCommand({ type: 'mode', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', mode: 'unsafe' })).toThrow('INVALID_REQUEST')
  })
})

describe('workspace browser staging contracts', () => {
  it('keeps minimum viewport and records an imported Preview restore origin', () => {
    const id = 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const
    const state = stageWorkspaceBrowserState(emptyBrowserState(1), { entries: [{ id, browser: { mode: 'preview', safeRestoreUrl: 'https://dev.example/app', viewport: { width: 200, height: 200 } } }], recovery: [] }, 2)
    expect(state.records[id]).toMatchObject({ viewport: { width: 200, height: 200 }, previewOrigins: ['https://dev.example'] })
  })
})

describe('TabBrowserService dispatch authorization', () => {
  it('registers queued commands before dispatch and aborts them all during drain', async () => {
    const state = emptyBrowserState(1); let calls = 0
    const host = {
      navigate: async (_id: string, _url: string, _page: string, _generation: number, signal: AbortSignal) => {
        calls += 1
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('ACTION_CANCELLED')), { once: true }))
      },
      snapshot: () => state, pendingLoadCount: () => 0, liveIds: () => [], freezeAll: () => {},
    }
    const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state) => TabBrowserService
    const service = new Service({ update: async () => state } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state)
    const command = { type: 'navigate' as const, id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', url: 'https://example.test', pageIncarnation: 'page', expectedGeneration: 1 }
    const first = service.command(command); const queued = service.command(command)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(service.pendingWork().operations).toBe(2)
    service.beginDrain(); await service.flushAndDestroy()
    await expect(first).rejects.toThrow('ACTION_CANCELLED'); await expect(queued).rejects.toThrow(/ACTION_CANCELLED|BROWSER_HOST_SHUTTING_DOWN/)
    expect(calls).toBe(1)
  })

  it('releases a cancelled non-cooperative browser queue after bounded grace', async () => {
    vi.useFakeTimers()
    try {
      const state = emptyBrowserState(1), id = 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; let release!: () => void; let calls = 0; let persists = 0
      const host = {
        navigate: async () => {
          calls += 1
          if (calls === 1) return new Promise((resolve) => { release = () => resolve({ id }) })
          return { id }
        },
        quarantine: () => {}, snapshot: () => state, pendingLoadCount: () => 0, liveIds: () => [], freezeAll: () => {},
      }
      const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state) => TabBrowserService
      const service = new Service({ update: async () => { persists += 1; return state } } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state)
      const command = { type: 'navigate' as const, id, url: 'https://example.test/', pageIncarnation: 'page', expectedGeneration: 1 }
      const owner = new AbortController(); const first = service.command(command, owner.signal)
      for (let attempt = 0; attempt < 10 && calls === 0; attempt++) await Promise.resolve()
      expect(calls).toBe(1)
      owner.abort()
      await expect(first).rejects.toThrow('ACTION_CANCELLED')
      const later = service.command(command)
      await Promise.resolve()
      expect(calls).toBe(1)
      await vi.advanceTimersByTimeAsync(TAB_BROWSER_QUEUE_BARRIER_TIMEOUT_MS)
      for (let attempt = 0; attempt < 10 && calls < 2; attempt++) await Promise.resolve()
      expect(calls).toBe(2)
      await expect(later).resolves.toMatchObject({ id })
      release()
      await Promise.resolve()
      expect(persists).toBe(1)
    } finally { vi.useRealTimers() }
  })

  it('does not let a cancelled queued follower release the active browser tail', async () => {
    vi.useFakeTimers()
    try {
      const state = emptyBrowserState(1), id = 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const order: string[] = [], quarantines: string[] = []
      let releaseActive!: () => void
      let calls = 0
      const host = {
        navigate: async (_id: string, url: string) => {
          calls += 1; order.push(`start:${url}`)
          if (calls === 1) return new Promise((resolve) => { releaseActive = () => { order.push('settle:a'); resolve({ id }) } })
          order.push(`end:${url}`); return { id }
        },
        // Deliberately reports the active runtime for every identity. A queue
        // implementation that keys ownership only by browser/incarnation will
        // quarantine A when B is cancelled.
        hasPendingOperation: () => true,
        quarantine: (_browserId: string, pageIncarnation: string) => { quarantines.push(pageIncarnation) },
        snapshot: () => state, pendingLoadCount: () => 0, liveIds: () => [], freezeAll: () => {},
      }
      const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state) => TabBrowserService
      const service = new Service({ update: async () => state } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state)
      const command = (url: string) => ({ type: 'navigate' as const, id, url, pageIncarnation: 'page-a', expectedGeneration: 1 })
      const ownerA = new AbortController(), ownerB = new AbortController()
      const active = service.command(command('https://example.test/a'), ownerA.signal)
      for (let attempt = 0; attempt < 10 && calls === 0; attempt++) await Promise.resolve()
      expect(calls).toBe(1)
      const cancelled = service.command(command('https://example.test/b'), ownerB.signal)
      const later = service.command(command('https://example.test/c'))
      ownerB.abort()
      await expect(cancelled).rejects.toThrow('ACTION_CANCELLED')
      await Promise.resolve()
      expect(calls).toBe(1)
      releaseActive()
      await expect(active).resolves.toMatchObject({ id })
      await expect(later).resolves.toMatchObject({ id })
      expect(order).toEqual(['start:https://example.test/a', 'settle:a', 'start:https://example.test/c', 'end:https://example.test/c'])
      expect(quarantines).toEqual([])
      expect(service.pendingWork()).toMatchObject({ queued: 0, quarantined: 0, total: 0 })
    } finally { vi.useRealTimers() }
  })

  it('isolates a timed-out owner once, then lets later work thaw a fresh incarnation', async () => {
    vi.useFakeTimers()
    try {
      const state = emptyBrowserState(1), id = 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const order: string[] = []
      let releaseActive!: () => void
      let isolated = false, calls = 0
      const host = {
        navigate: async () => {
          calls += 1; order.push('start:a')
          return new Promise((resolve) => { releaseActive = () => { order.push('late:a'); resolve({ id }) } })
        },
        hasPendingOperation: () => !isolated,
        quarantine: (browserId: string, pageIncarnation: string) => {
          expect(browserId).toBe(id); expect(pageIncarnation).toBe('page-a')
          isolated = true; order.push('quarantine:a')
        },
        status: () => ({ id, stateRevision: isolated ? 2 : 1 }),
        thaw: async () => { expect(isolated).toBe(true); order.push('thaw:fresh') },
        show: () => { order.push('show:fresh'); return { id, stateRevision: 2, pageIncarnation: 'page-fresh' } },
        snapshot: () => state, pendingLoadCount: () => 0, liveIds: () => [], freezeAll: () => {},
      }
      const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state) => TabBrowserService
      const service = new Service({ update: async () => state } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state)
      const owner = new AbortController()
      const active = service.command({ type: 'navigate', id, url: 'https://example.test/a', pageIncarnation: 'page-a', expectedGeneration: 1 }, owner.signal)
      for (let attempt = 0; attempt < 10 && calls === 0; attempt++) await Promise.resolve()
      owner.abort()
      await expect(active).rejects.toThrow('ACTION_CANCELLED')
      const later = service.command({ type: 'show', id, bounds: { x: 0, y: 0, width: 100, height: 100 } })
      await vi.advanceTimersByTimeAsync(TAB_BROWSER_QUEUE_BARRIER_TIMEOUT_MS)
      await expect(later).resolves.toMatchObject({ id })
      expect(order).toEqual(['start:a', 'quarantine:a', 'thaw:fresh', 'show:fresh'])
      releaseActive(); await Promise.resolve()
      expect(service.pendingWork()).toMatchObject({ queued: 0, quarantined: 0, total: 0 })
    } finally { vi.useRealTimers() }
  })

  it('poisons a browser when quarantine fails without hanging later FIFO work or quit', async () => {
    vi.useFakeTimers()
    try {
      const state = emptyBrowserState(1), id = 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      let releaseActive!: () => void
      let calls = 0, maxActive = 0, active = 0, freezes = 0
      const host = {
        navigate: async () => {
          calls += 1; active += 1; maxActive = Math.max(maxActive, active)
          if (calls === 1) return new Promise((resolve) => { releaseActive = () => { active -= 1; resolve({ id }) } })
          active -= 1; return { id }
        },
        hasPendingOperation: () => true,
        quarantine: async () => { throw new Error('DISPOSAL_FAILED') },
        snapshot: () => state, pendingLoadCount: () => 0, liveIds: () => [], freezeAll: () => { freezes += 1 },
      }
      const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state) => TabBrowserService
      const service = new Service({ update: async () => state } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state)
      const command = (url: string) => ({ type: 'navigate' as const, id, url, pageIncarnation: 'page', expectedGeneration: 1 })
      const ownerA = new AbortController(), ownerB = new AbortController()
      const first = service.command(command('https://example.test/a'), ownerA.signal)
      await vi.waitFor(() => expect(calls).toBe(1))
      const cancelled = service.command(command('https://example.test/b'), ownerB.signal)
      const later = service.command(command('https://example.test/c'))
      ownerA.abort(); ownerB.abort()
      const laterResult = expect(later).rejects.toThrow('BROWSER_HOST_POISONED')
      await expect(first).rejects.toThrow('ACTION_CANCELLED')
      await expect(cancelled).rejects.toThrow('ACTION_CANCELLED')
      await vi.advanceTimersByTimeAsync(TAB_BROWSER_QUEUE_BARRIER_TIMEOUT_MS)
      await laterResult
      expect(calls).toBe(1)
      expect(maxActive).toBe(1)
      expect(service.pendingWork()).toMatchObject({ queued: 0, quarantined: 0, total: 0 })
      service.beginDrain()
      await expect(service.flushAndDestroy()).resolves.toBeUndefined()
      expect(freezes).toBe(1)
      releaseActive(); await Promise.resolve()
    } finally { vi.useRealTimers() }
  })

  it('aborts queued direct work when its browser is hidden, without releasing a live predecessor', async () => {
    vi.useFakeTimers()
    try {
      const state = emptyBrowserState(1), id = 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; let release!: () => void; let calls = 0; let signal!: AbortSignal
      const host = {
        navigate: async (_id: string, _url: string, _page: string, _generation: number, operationSignal: AbortSignal) => {
          calls += 1; signal = operationSignal
          if (calls === 1) return new Promise((resolve) => { release = () => resolve({ id }) })
          return { id }
        },
        hasPendingOperation: () => true,
        quarantine: () => {},
        snapshot: () => state, pendingLoadCount: () => 0, liveIds: () => [], freezeAll: () => {},
      }
      const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state) => TabBrowserService
      const service = new Service({ update: async () => state } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state)
      const command = (url: string) => ({ type: 'navigate' as const, id, url, pageIncarnation: 'page', expectedGeneration: 1 })
      const first = service.command(command('https://example.test/a'))
      const firstResult = expect(first).rejects.toThrow('ACTION_CANCELLED')
      await vi.waitFor(() => expect(calls).toBe(1))
      const hidden = service.command(command('https://example.test/b'))
      service.surfaceHidden(id)
      await expect(hidden).rejects.toThrow('ACTION_CANCELLED')
      expect(signal.aborted).toBe(true)
      expect(calls).toBe(1)
      release(); await firstResult
      await vi.advanceTimersByTimeAsync(TAB_BROWSER_QUEUE_BARRIER_TIMEOUT_MS)
      expect(service.pendingWork()).toMatchObject({ queued: 0, quarantined: 0, total: 0 })
    } finally { vi.useRealTimers() }
  })

  it('closes a browser by aborting its queue owner before disposing the host runtime', async () => {
    vi.useFakeTimers()
    try {
      const state = emptyBrowserState(1), id = 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; let release!: () => void; let signal!: AbortSignal; const order: string[] = []
      const host = {
        navigate: async (_id: string, _url: string, _page: string, _generation: number, operationSignal: AbortSignal) => {
          signal = operationSignal
          return new Promise((resolve) => { release = () => resolve({ id }) })
        },
        close: () => { order.push(`close:${signal.aborted}`) },
        hasPendingOperation: () => false,
        snapshot: () => state, pendingLoadCount: () => 0, liveIds: () => [], freezeAll: () => {},
      }
      const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state) => TabBrowserService
      const service = new Service({ update: async () => state } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state)
      const pending = service.command({ type: 'navigate', id, url: 'https://example.test/', pageIncarnation: 'page', expectedGeneration: 1 })
      const pendingResult = expect(pending).rejects.toThrow('ACTION_CANCELLED')
      await vi.waitFor(() => expect(signal).toBeDefined())
      await service.destroyForAssociation(id)
      expect(order).toEqual(['close:true'])
      release(); await pendingResult
      await vi.advanceTimersByTimeAsync(TAB_BROWSER_QUEUE_BARRIER_TIMEOUT_MS)
      expect(service.pendingWork()).toMatchObject({ queued: 0, quarantined: 0, total: 0 })
    } finally { vi.useRealTimers() }
  })

  it('revokes Pi work through both the active adapter and its queued owner, preserving direct work', async () => {
    const state = emptyBrowserState(1), id = 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; let started = false; let automationCalls = 0; let navigations = 0
    const host = {
      runAutomation: async (_id: string, _action: unknown, signal: AbortSignal) => {
        automationCalls += 1; started = true
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('ACTION_CANCELLED')), { once: true }))
      },
      navigate: async () => { navigations += 1; return { id } },
      snapshot: () => state, pendingLoadCount: () => 0, liveIds: () => [],
    }
    const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state) => TabBrowserService
    const service = new Service({ update: async () => state } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state)
    const action = { type: 'console' as const, pageIncarnation: 'page', expectedGeneration: 1, limit: 10 }
    const first = service.command({ type: 'automation', id, broker: { requestId: 'one', controller: 'pi-owner' }, action })
    await vi.waitFor(() => expect(started).toBe(true))
    const queued = service.command({ type: 'automation', id, broker: { requestId: 'two', controller: 'pi-owner' }, action })
    service.revokePi(id)
    await expect(first).rejects.toThrow('ACTION_CANCELLED')
    await expect(queued).rejects.toThrow('ACTION_CANCELLED')
    await expect(service.command({ type: 'navigate', id, url: 'https://example.test/', pageIncarnation: 'page', expectedGeneration: 1 })).resolves.toMatchObject({ id })
    expect({ automationCalls, navigations }).toEqual({ automationCalls: 1, navigations: 1 })
  })

  it('quarantines a non-cooperative adapter before the same-browser FIFO continues', async () => {
    vi.useFakeTimers()
    try {
      const state = emptyBrowserState(1), id = 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; let release!: () => void; let calls = 0
      const quarantines: Array<{ id: string; page: string }> = []
      const host = {
        navigate: async (_id: string, _url: string, _page: string, _generation: number) => {
          calls += 1
          if (calls === 1) return new Promise((resolve) => { release = () => resolve({ id }) })
          return { id }
        },
        quarantine: (browserId: string, pageIncarnation: string) => { quarantines.push({ id: browserId, page: pageIncarnation }) },
        snapshot: () => state, pendingLoadCount: () => 0, liveIds: () => [], freezeAll: () => {},
      }
      const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state) => TabBrowserService
      const service = new Service({ update: async () => state } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state)
      const command = { type: 'navigate' as const, id, url: 'https://example.test/', pageIncarnation: 'page', expectedGeneration: 1 }
      const owner = new AbortController(); const first = service.command(command, owner.signal)
      await vi.waitFor(() => expect(calls).toBe(1))
      owner.abort(); await expect(first).rejects.toThrow('ACTION_CANCELLED')
      const later = service.command(command)
      await vi.advanceTimersByTimeAsync(TAB_BROWSER_QUEUE_BARRIER_TIMEOUT_MS)
      await expect(later).resolves.toMatchObject({ id })
      expect(quarantines).toEqual([{ id, page: 'page' }])
      release(); await Promise.resolve()
    } finally { vi.useRealTimers() }
  })

  it('bounds quit drain when a browser adapter ignores cancellation', async () => {
    vi.useFakeTimers()
    try {
      const state = emptyBrowserState(1), id = 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; let release!: () => void; let freezes = 0; let calls = 0
      const host = {
        navigate: async () => { calls += 1; return new Promise((resolve) => { release = () => resolve({ id }) }) },
        snapshot: () => state, pendingLoadCount: () => 0, liveIds: () => [], freezeAll: () => { freezes += 1 },
      }
      const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state) => TabBrowserService
      const service = new Service({ update: async () => state } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state)
      const pending = service.command({ type: 'navigate', id, url: 'https://example.test/', pageIncarnation: 'page', expectedGeneration: 1 })
      const pendingCancelled = expect(pending).rejects.toThrow('ACTION_CANCELLED')
      for (let attempt = 0; attempt < 10 && calls === 0; attempt++) await Promise.resolve()
      expect(calls).toBe(1)
      service.beginDrain()
      const flushing = service.flushAndDestroy()
      await vi.advanceTimersByTimeAsync(TAB_BROWSER_QUEUE_BARRIER_TIMEOUT_MS)
      await expect(flushing).resolves.toBeUndefined()
      await pendingCancelled
      expect(freezes).toBe(1)
      release()
      await Promise.resolve()
    } finally { vi.useRealTimers() }
  })

  it('rejects new commands during quit and freezes before the final durable save', async () => {
    const state = emptyBrowserState(1), order: string[] = []
    const host = {
      snapshot: () => state, pendingLoadCount: () => 0, liveIds: () => [],
      freezeAll: () => { order.push('freeze') },
    }
    const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state) => TabBrowserService
    const service = new Service({ load: async () => state, update: async () => { order.push('persist'); return state } } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state)
    expect(service.pendingWork()).toMatchObject({ total: 0 })
    service.beginDrain()
    await expect(service.command({ type: 'open' })).rejects.toThrow('BROWSER_HOST_SHUTTING_DOWN')
    await service.flushAndDestroy()
    expect(order).toEqual(['freeze', 'persist'])
    service.cancelDrain()
  })

  it('cancels a timed-out flush before late completion can freeze pages, then permits a later quit', async () => {
    const state = emptyBrowserState(1); let release!: () => void; let navigateCalls = 0; let freezes = 0
    const host = {
      navigate: async () => { navigateCalls += 1; return new Promise((resolve) => { release = () => resolve({ id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }) }) },
      snapshot: () => state, pendingLoadCount: () => 0, liveIds: () => [], freezeAll: () => { freezes += 1 },
    }
    const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state) => TabBrowserService
    const service = new Service({ load: async () => state, update: async () => state } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state)
    const pending = service.command({ type: 'navigate', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', url: 'https://example.test/', pageIncarnation: 'page', expectedGeneration: 1 })
    const pendingCancelled = expect(pending).rejects.toThrow('ACTION_CANCELLED')
    await vi.waitFor(() => expect(navigateCalls).toBe(1))
    service.beginDrain()
    const controller = new AbortController(); const flush = service.flushAndDestroy(controller.signal)
    controller.abort()
    await expect(flush).rejects.toThrow('ACTION_CANCELLED')
    expect(freezes).toBe(0)
    release(); await pendingCancelled
    service.cancelDrain(); service.beginDrain(); await service.flushAndDestroy()
    expect(freezes).toBe(1)
  })

  it('coalesces high-rate host status changes into a bounded renderer update', async () => {
    vi.useFakeTimers()
    try {
      const state = emptyBrowserState(1), sink = vi.fn()
      const host = { snapshot: () => state }
      const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state) => TabBrowserService
      const service = new Service({ update: async () => state } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state)
      service.setEventSink(sink)
      const internal = service as unknown as { handleHostEvent(event: unknown): void }
      for (let generation = 0; generation < 40; generation++) internal.handleHostEvent({ type: 'runtime', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', status: { generation, pageIncarnation: 'page', lifecycle: 'live' } })
      expect(sink).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(16)
      expect(sink).toHaveBeenCalledOnce()
      expect(sink.mock.calls[0]?.[0]).toMatchObject({ status: { generation: 39 } })
    } finally { vi.useRealTimers() }
  })

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

  it('dispatches the rail stop contract immediately so it can cancel an active load', async () => {
    const state = emptyBrowserState(1), id = 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; let release!: () => void; let stops = 0
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const host = { navigate: async () => { await blocked; return { id, stateRevision: 1 } }, stop: () => { stops += 1; return { id, stateRevision: 2 } }, snapshot: () => state }
    const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state) => TabBrowserService
    const service = new Service({ update: async () => state } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state)
    const navigating = service.command({ type: 'navigate', id, url: 'https://example.test/', pageIncarnation: 'page', expectedGeneration: 1 })
    await Promise.resolve()
    const stopping = service.command(railStopCommand({ id, pageIncarnation: 'page', generation: 2, lifecycle: 'live' }))
    await vi.waitFor(() => expect(stops).toBe(1))
    release(); await navigating; await stopping
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

  it('reports broker navigation start and completion without exposing its URL', async () => {
    const state = emptyBrowserState(1), id = 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', events: Array<Record<string, unknown>> = [], sources: string[] = []
    const host = { navigate: async (...args: unknown[]) => { sources.push(String(args[5])); return { id, stateRevision: 1 } }, snapshot: () => state }
    const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state) => TabBrowserService
    const service = new Service({ update: async () => state } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state); service.setEventSink((event) => events.push(event as Record<string, unknown>))
    await service.command({ type: 'navigate', id, url: 'https://example.test/?token=secret', pageIncarnation: 'page', expectedGeneration: 1, broker: { requestId: 'navigate-1', controller: 'amber-1-1-0-pi' } })
    expect(events.map((event) => event['phase'])).toEqual(['started', 'completed']); expect(JSON.stringify(events)).not.toContain('secret')
    expect(sources).toEqual(['broker'])
  })

  it('marks trusted renderer navigation as user-selected for Preview policy', async () => {
    const state = emptyBrowserState(1), id = 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; let source = ''
    const host = { navigate: async (...args: unknown[]) => { source = String(args[5]); return { id, stateRevision: 1 } }, snapshot: () => state }
    const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state) => TabBrowserService
    const service = new Service({ update: async () => state } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state)
    await service.command({ type: 'navigate', id, url: 'https://dev.example/', pageIncarnation: 'page', expectedGeneration: 1 })
    expect(source).toBe('user')
  })

  it('runs the frozen Reload show contract through service thaw with a new page incarnation', async () => {
    const state = emptyBrowserState(1), pages: Array<{ url: string; stopped: boolean }> = []; let emit!: (event: TabBrowserPageEvent) => void
    const pageFactory = { create: (_id: string, _input: () => void, event: (value: TabBrowserPageEvent) => void) => { emit = event; const data = { url: 'about:blank', stopped: false }; pages.push(data); return { loadURL: async (url: string) => { data.url = url }, show: () => {}, hide: () => {}, stop: () => { data.stopped = true }, setBounds: () => {}, destroy: () => {} } } }
    let service!: TabBrowserService
    const host = new TabBrowserHost(state, pageFactory, Date.now, undefined, () => {}, (event) => (service as unknown as { handleHostEvent(event: unknown): void }).handleHostEvent(event))
    const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: TabBrowserHost, i: typeof state) => TabBrowserService
    service = new Service({ update: async () => state } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state)
    const opened = await service.command({ type: 'open' }); if (!('id' in opened)) throw new Error('expected browser')
    const initial = host.status(opened.id)
    await host.navigate(opened.id, 'https://restore.example/path?secret=1', initial.pageIncarnation, initial.generation, undefined, 'user')
    emit({ type: 'crashed', reason: 'renderer-gone' })
    const frozen = host.status(opened.id); expect(frozen.lifecycle).toBe('frozen')
    const restored = await service.command(railReloadCommand(frozen, { x: 1, y: 2, width: 400, height: 500 }))
    expect(restored).toMatchObject({ id: opened.id, lifecycle: 'live', currentUrl: 'https://restore.example/path', visible: true }); expect(restored).not.toHaveProperty('restoreError')
    expect((restored as { pageIncarnation: string }).pageIncarnation).not.toBe(initial.pageIncarnation)
    expect(pages.at(-1)?.url).toBe('https://restore.example/path')
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
      protectApproval: (_id: string, value: boolean) => protectedValues.push(value), isVisible: () => true, status: () => ({ id, stateRevision: 1 }), snapshot: () => state,
    }
    const window = { isDestroyed: () => false, isVisible: () => true, show: () => {}, focus: () => {} }
    const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state, w: typeof window) => TabBrowserService
    const service = new Service({ update: async () => state } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state, window)
    service.setApprovalSurface(() => true, () => {})
    service.setEventSink((event) => events.push(event as Record<string, unknown>))
    const pending = service.command({ type: 'automation', id, broker: { requestId: 'request-1', controller: 'amber-1-1-0-pi' }, action: { type: 'interact', pageIncarnation: 'page', expectedGeneration: 1, operation: { kind: 'fill', target: { snapshotId: 'snap', ref: 'n1' }, text: 'super-secret' } } })
    await vi.waitFor(() => expect(events.some((event) => event['type'] === 'approval-request')).toBe(true))
    const request = events.find((event) => event['type'] === 'approval-request')!
    expect(JSON.stringify(request)).not.toContain('super-secret')
    await service.command({ type: 'resolveApproval', id, approvalId: String(request['approvalId']), digest: String(request['digest']), decision: 'approve-once' })
    await expect(pending).resolves.toMatchObject({ dispatched: true, rollbackPossible: false })
    expect(events.filter((event) => event['type'] === 'pi-action').map((event) => event['phase'])).toEqual(['started', 'completed'])
    expect(protectedValues).toEqual([true, false])
  })

  it('fails immediately and requests exact-surface reveal for a collapsed or background browser', async () => {
    const state = emptyBrowserState(1), id = 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', reveal = vi.fn(), protectedValues: boolean[] = []
    const host = { runAutomation: async (_id: string, action: { operation: unknown }, signal: AbortSignal, approve: (request: unknown, signal: AbortSignal) => Promise<void>) => approve({ operation: action.operation, target: { role: 'button', name: 'Delete', tag: 'button', type: 'button', fingerprint: 'fp' }, classification: { consequential: true, category: 'destructive', valueCategory: 'none', canGrantOrigin: false, argumentSummary: '' }, origin: 'https://example.test', pageIncarnation: 'page', generation: 1 }, signal), protectApproval: (_id: string, value: boolean) => protectedValues.push(value), isVisible: () => true, status: () => ({ id, stateRevision: 1 }), snapshot: () => state }
    const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state) => TabBrowserService
    const service = new Service({ update: async () => state } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state)
    service.setApprovalSurface(() => false, reveal)
    await expect(service.command({ type: 'automation', id, broker: { requestId: 'request-bg', controller: 'amber-1-1-0-pi' }, action: { type: 'interact', pageIncarnation: 'page', expectedGeneration: 1, operation: { kind: 'click', target: { snapshotId: 'snap', ref: 'n1' } } } })).rejects.toThrow('APPROVAL_REQUIRED')
    expect(reveal).toHaveBeenCalledWith(id); expect(protectedValues).toEqual([true, false])
    service.setApprovalSurface(() => true, reveal); host.isVisible = () => false
    await expect(service.command({ type: 'automation', id, broker: { requestId: 'request-hidden', controller: 'amber-1-1-0-pi' }, action: { type: 'interact', pageIncarnation: 'page', expectedGeneration: 1, operation: { kind: 'click', target: { snapshotId: 'snap', ref: 'n1' } } } })).rejects.toThrow('APPROVAL_REQUIRED')
  })

  it('collapse invalidates an already-visible approval and aborts its owning action', async () => {
    const state = emptyBrowserState(1), id = 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', events: Array<Record<string, unknown>> = []
    const host = {
      runAutomation: async (_id: string, action: { operation: unknown }, signal: AbortSignal, approve: (request: unknown, signal: AbortSignal) => Promise<void>) => {
        await approve({ operation: action.operation, target: { role: 'button', name: 'Delete', tag: 'button', type: 'button', fingerprint: 'fp' }, classification: { consequential: true, category: 'destructive', valueCategory: 'none', canGrantOrigin: false, argumentSummary: '' }, origin: 'https://example.test', pageIncarnation: 'page', generation: 1 }, signal)
      }, protectApproval: () => {}, isVisible: () => true, hide: () => {}, status: () => ({ id, stateRevision: 1 }), snapshot: () => state,
    }
    const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state) => TabBrowserService
    const service = new Service({ update: async () => state } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state)
    service.setApprovalSurface(() => true, () => {}); service.setEventSink((event) => events.push(event as Record<string, unknown>))
    const action = service.command({ type: 'automation', id, broker: { requestId: 'request-collapse', controller: 'amber-1-1-0-pi' }, action: { type: 'interact', pageIncarnation: 'page', expectedGeneration: 1, operation: { kind: 'click', target: { snapshotId: 'snap', ref: 'n1' } } } })
    await vi.waitFor(() => expect(events.some((event) => event['type'] === 'approval-request')).toBe(true))
    await service.command({ type: 'hide', id })
    await expect(action).rejects.toThrow('ACTION_CANCELLED')
    expect(events.some((event) => event['type'] === 'approval-resolved')).toBe(true)
  })

  it('coordinates a visible dialog and keeps the native page occluded until its exact decision', async () => {
    const state = emptyBrowserState(1), id = 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', events: Array<Record<string, unknown>> = [], protectedValues: boolean[] = [], respond = vi.fn()
    const host = { protectApproval: (_id: string, value: boolean) => protectedValues.push(value), isVisible: () => true, status: () => ({ id, stateRevision: 1, pageIncarnation: 'page', generation: 2 }), snapshot: () => state }
    const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state) => TabBrowserService
    const service = new Service({ update: async () => state } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state)
    service.setApprovalSurface(() => true, () => {}); service.setEventSink((event) => events.push(event as Record<string, unknown>))
    ;(service as unknown as { handleHostEvent: (event: unknown) => void }).handleHostEvent({ type: 'dialog-request', id, pageIncarnation: 'page', dialogType: 'prompt', message: 'Value?', generation: 2, respond })
    await vi.waitFor(() => expect(events.some((event) => event['type'] === 'dialog-request')).toBe(true))
    const request = events.find((event) => event['type'] === 'dialog-request')!
    await service.command({ type: 'resolveDialog', id, dialogId: String(request['dialogId']), digest: String(request['digest']), accept: true, promptText: 'answer' })
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith({ accept: true, promptText: 'answer' }))
    expect(protectedValues).toEqual([true, false])
  })

  it('binds a Pi dialog to the owning request cancellation signal', async () => {
    const state = emptyBrowserState(1), id = 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', events: Array<Record<string, unknown>> = []
    const host = { protectApproval: () => {}, isVisible: () => true, status: () => ({ id, stateRevision: 1, pageIncarnation: 'page', generation: 2 }), snapshot: () => state, runAutomation: async () => ({}) }
    const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state) => TabBrowserService
    const service = new Service({ update: async () => state } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state)
    service.setApprovalSurface(() => true, () => {}); service.setEventSink((event) => events.push(event as Record<string, unknown>))
    const handle = (event: unknown): void => (service as unknown as { handleHostEvent: (value: unknown) => void }).handleHostEvent(event)
    host.runAutomation = async () => new Promise((_resolve, reject) => handle({ type: 'dialog-request', id, pageIncarnation: 'page', dialogType: 'confirm', message: 'Continue?', generation: 2, respond: (decision: { accept: boolean }) => reject(new Error(decision.accept ? 'UNEXPECTED_ACCEPT' : 'DIALOG_DENIED')) }))
    const owner = new AbortController()
    const action = service.command({ type: 'automation', id, broker: { requestId: 'request-cancel', controller: 'amber-1-1-0-pi' }, action: { type: 'reload', pageIncarnation: 'page', expectedGeneration: 1, ignoreCache: false } }, owner.signal)
    await vi.waitFor(() => expect(events.some((event) => event['type'] === 'dialog-request')).toBe(true))
    owner.abort()
    await expect(action).rejects.toThrow('ACTION_CANCELLED')
    expect(events.some((event) => event['type'] === 'dialog-resolved' && event['decision'] === 'revoked')).toBe(true)
  })

  it('invalidates a dialog when its page generation advances before resolution', async () => {
    const state = emptyBrowserState(1), id = 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', events: Array<Record<string, unknown>> = [], respond = vi.fn()
    let generation = 2
    const host = { protectApproval: () => {}, isVisible: () => true, status: () => ({ id, stateRevision: 1, pageIncarnation: 'page', generation }), snapshot: () => state }
    const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state) => TabBrowserService
    const service = new Service({ update: async () => state } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state)
    service.setApprovalSurface(() => true, () => {}); service.setEventSink((event) => events.push(event as Record<string, unknown>))
    const handle = (event: unknown): void => (service as unknown as { handleHostEvent: (value: unknown) => void }).handleHostEvent(event)
    handle({ type: 'dialog-request', id, pageIncarnation: 'page', dialogType: 'confirm', message: 'Continue?', generation, respond })
    await vi.waitFor(() => expect(events.some((event) => event['type'] === 'dialog-request')).toBe(true))
    const request = events.find((event) => event['type'] === 'dialog-request')!
    generation = 3; handle({ type: 'runtime', id, status: { pageIncarnation: 'page', generation, lifecycle: 'live' } })
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith({ accept: false }))
    await expect(service.command({ type: 'resolveDialog', id, dialogId: String(request['dialogId']), digest: String(request['digest']), accept: true })).rejects.toThrow('DIALOG_DENIED')
  })

  it('keeps raw current URL in renderer events while redacting broker status results', async () => {
    const state = emptyBrowserState(1), id = 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', events: Array<Record<string, unknown>> = []
    const raw = 'https://example.test/private?token=secret#part'
    const host = { isVisible: () => true, status: () => ({ id, currentUrl: raw, safeRestoreUrl: 'https://example.test/private', stateRevision: 1 }), snapshot: () => state }
    const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state) => TabBrowserService
    const service = new Service({ update: async () => state } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state)
    service.setEventSink((event) => events.push(event as Record<string, unknown>))
    ;(service as unknown as { handleHostEvent: (event: unknown) => void }).handleHostEvent({ type: 'runtime', id, status: host.status() })
    await vi.waitFor(() => expect(JSON.stringify(events)).toContain(raw))
    const result = await service.command({ type: 'status', id })
    expect(JSON.stringify(result)).not.toContain('token=secret')
    expect(result).toMatchObject({ safeRestoreUrl: 'https://example.test/private' })
  })

  it('retains a bounded secret-safe latest Pi action for renderer remount status', async () => {
    const state = emptyBrowserState(1), id = 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const host = { runAutomation: async () => ({ ok: true }), status: (browserId: string) => ({ id: browserId, stateRevision: 1 }), snapshot: () => state }
    const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state) => TabBrowserService
    const service = new Service({ update: async () => state } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state)
    await service.command({ type: 'automation', id, broker: { requestId: 'request-remount', controller: 'amber-1-1-0-pi' }, action: { type: 'reload', pageIncarnation: 'page', expectedGeneration: 1, ignoreCache: false } })
    await expect(service.command({ type: 'status', id })).resolves.toMatchObject({ lastAction: { browserId: id, controller: 'amber-1-1-0-pi', action: 'reload', phase: 'completed' } })
    const internals = service as unknown as { piAction: (id: string, controller: string, action: string, phase: 'started') => void; latestPiActions: Map<string, unknown> }
    for (let index = 0; index < 300; index++) internals.piAction(`browser-${index.toString(16).padStart(32, '0')}`, 'controller', 'status', 'started')
    expect(internals.latestPiActions.size).toBe(256)
    expect(JSON.stringify([...internals.latestPiActions.values()])).not.toContain('request-remount')
  })

  it('Stop Pi aborts active broker work and clears its approval', async () => {
    const state = emptyBrowserState(1), id = 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; let aborted = false; let started = false
    const host = { runAutomation: async (_id: string, _action: unknown, signal: AbortSignal) => new Promise((_resolve, reject) => { started = true; signal.addEventListener('abort', () => { aborted = true; reject(new Error('ACTION_CANCELLED')) }, { once: true }) }), status: () => ({ id, stateRevision: 1 }), snapshot: () => state }
    const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state) => TabBrowserService
    const service = new Service({ update: async () => state } as unknown as TabBrowserStateStore, { setWindow: () => {} }, host, state); const events: Array<Record<string, unknown>> = []
    service.setEventSink((event) => events.push(event as Record<string, unknown>))
    const active = service.command({ type: 'automation', id, broker: { requestId: 'request-1', controller: 'amber-1-1-0-pi' }, action: { type: 'console', pageIncarnation: 'page', expectedGeneration: 1, limit: 10 } })
    await vi.waitFor(() => expect(started).toBe(true)); await service.command({ type: 'stopPi', id })
    await expect(active).rejects.toThrow('ACTION_CANCELLED'); expect(aborted).toBe(true)
    expect(events.filter((event) => event['type'] === 'pi-action').map((event) => event['phase'])).toEqual(['started', 'failed'])
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
  it('serializes recovery cleanup and syncs an already-committed attach after a racing delete', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'amber-recovery-attach-race-')); dirs.push(dir)
    const store = new TabBrowserStateStore(dir)
    const recoveryId = 'recovery-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const
    const browserId = 'browser-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const
    const initial: BrowserStateFile = { ...emptyBrowserState(1), migrationRecovery: [{ id: recoveryId, workspace: 1, tab: 2, safeRestoreUrl: 'https://recover.test/' }] }
    const committed: BrowserStateFile = { ...initial, migrationRecovery: [], records: {
      [browserId]: { id: browserId, profileId: 'global', mode: 'browse', safeRestoreUrl: 'https://recover.test/', title: '', viewport: { width: 1280, height: 800 }, lifecycle: 'frozen', stateRevision: 1, lastUsedAt: 1, lastFocusedAt: 0 },
    } }
    await store.save(committed)
    let service!: TabBrowserService
    const host = new TabBrowserHost(initial, { create: () => { throw new Error('not used') } }, Date.now, undefined,
      () => { void (service as unknown as { schedulePersist: () => Promise<void> }).schedulePersist() })
    const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: TabBrowserHost, i: typeof initial) => TabBrowserService
    service = new Service(store, { setWindow: () => {} }, host, initial)
    const deleting = service.deleteRecovery(recoveryId)
    const attaching = service.attachRecoveryCommitted(recoveryId, browserId)
    await expect(deleting).resolves.toBeUndefined()
    await expect(attaching).resolves.toMatchObject({ id: browserId, lifecycle: 'frozen' })
    expect(host.status(browserId)).toMatchObject({ safeRestoreUrl: 'https://recover.test/' })
  })

  it('keeps recovery cleanup queued until committed host synchronization finishes', async () => {
    const recoveryId = 'recovery-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const
    const browserId = 'browser-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const
    const state: BrowserStateFile = { ...emptyBrowserState(1), migrationRecovery: [{ id: recoveryId, workspace: 1, tab: 2, safeRestoreUrl: 'https://recover.test/' }] }
    let releaseLoad!: () => void; let loadStarted!: () => void; let deletes = 0
    const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve }); const loaded = new Promise<void>((resolve) => { loadStarted = resolve })
    const store = { load: async () => { loadStarted(); await loadGate; return state }, update: async () => {} } as unknown as TabBrowserStateStore
    const status = { id: browserId, lifecycle: 'frozen', stateRevision: 1 } as unknown as ReturnType<TabBrowserHost['status']>
    const host = { attachRecovery: () => status, deleteRecovery: () => { deletes += 1 }, snapshot: () => state }
    const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: typeof host, i: typeof state) => TabBrowserService
    const service = new Service(store, { setWindow: () => {} }, host, state)
    const attaching = service.attachRecoveryCommitted(recoveryId, browserId)
    await loaded
    const deleting = service.deleteRecovery(recoveryId)
    await Promise.resolve()
    expect(deletes).toBe(0)
    releaseLoad()
    await attaching
    await deleting
    expect(deletes).toBe(1)
  })

  it('survives a service restart after deleting a recovery item', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'amber-recovery-delete-')); dirs.push(dir)
    const store = new TabBrowserStateStore(dir)
    const state: BrowserStateFile = { ...emptyBrowserState(1), migrationRecovery: [{ id: 'recovery-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', workspace: 1, tab: 2, safeRestoreUrl: 'https://recover.test/' }] }
    await store.save(state)
    let service!: TabBrowserService
    const host = new TabBrowserHost(state, { create: () => { throw new Error('not used') } }, Date.now, undefined,
      () => { void (service as unknown as { schedulePersist: () => Promise<void> }).schedulePersist() })
    const Service = TabBrowserService as unknown as new (s: TabBrowserStateStore, p: { setWindow: () => void }, h: TabBrowserHost, i: typeof state) => TabBrowserService
    service = new Service(store, { setWindow: () => {} }, host, state)
    await service.deleteRecovery('recovery-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
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
    const previous = { ...emptyBrowserState(1), migrationRecovery: [{ id: 'recovery-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const, workspace: 1, tab: 1, safeRestoreUrl: 'https://old.test/' }] }
    const runtime = { ...previous, migrationRecovery: [] }
    const current = { ...previous, migrationRecovery: [...previous.migrationRecovery, { id: 'recovery-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const, workspace: 2, tab: 2, safeRestoreUrl: 'https://new.test/' }] }
    expect(applyBrowserRuntimeDelta(current, previous, runtime).migrationRecovery).toEqual([{ id: 'recovery-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', workspace: 2, tab: 2, safeRestoreUrl: 'https://new.test/' }])
  })

  it('deletes only the selected identity when duplicate recovery URLs race', () => {
    const first = { id: 'recovery-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const, workspace: 1, tab: 1, safeRestoreUrl: 'https://same.test/' }
    const second = { id: 'recovery-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const, workspace: 1, tab: 1, safeRestoreUrl: 'https://same.test/' }
    const previous = { ...emptyBrowserState(1), migrationRecovery: [first, second] }
    const runtime = { ...previous, migrationRecovery: [second] }
    const current = { ...previous, migrationRecovery: [first, second] }
    expect(applyBrowserRuntimeDelta(current, previous, runtime).migrationRecovery).toEqual([second])
  })
})
