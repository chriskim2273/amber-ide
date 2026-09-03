import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TabBrowserStateStore } from './tabBrowserStateStore'
import { BROWSER_RECOVERY_MAX, emptyBrowserState } from '../shared/tabBrowserState'
import { TabBrowserHost, type TabBrowserPageFactory } from './tabBrowserHost'
import type { BrowserAutomation } from './browserAutomation'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'amber-browser-state-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('TabBrowserStateStore', () => {
  it('atomically round-trips a private state file', async () => {
    const store = new TabBrowserStateStore(dir)
    const state = emptyBrowserState(1); state.revision = 2
    await store.save(state)
    expect((await store.load()).revision).toBe(2)
    expect(JSON.parse(await readFile(join(dir, 'browser-state.json'), 'utf8')).revision).toBe(2)
    if (process.platform !== 'win32') expect((await lstat(join(dir, 'browser-state.json'))).mode & 0o777).toBe(0o600)
  })

  it('round-trips the minimum viewport through disk, process restart, and thaw', async () => {
    const id = 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const, store = new TabBrowserStateStore(dir), state = emptyBrowserState(1)
    state.records[id] = { id, profileId: 'global', mode: 'browse', safeRestoreUrl: 'about:blank', title: '', viewport: { width: 200, height: 200 }, lifecycle: 'live', stateRevision: 1, lastUsedAt: 1, lastFocusedAt: 1 }
    await store.save(state)
    const applied: Array<{ width: number; height: number }> = []
    const pages: TabBrowserPageFactory = { create: () => ({ loadURL: async () => {}, show: () => {}, hide: () => {}, stop: () => {}, destroy: () => {}, automation: { setViewport: async (viewport: { width: number; height: number }) => { applied.push(viewport); return { viewport } } } as unknown as BrowserAutomation }) }
    const restarted = new TabBrowserHost(await store.load(), pages)
    expect(restarted.status(id)).toMatchObject({ lifecycle: 'frozen', viewport: { width: 200, height: 200 } })
    await restarted.thaw(id)
    expect(applied).toEqual([{ width: 200, height: 200 }])
  })

  it('read-modify-write preserves transaction metadata', async () => {
    const store = new TabBrowserStateStore(dir)
    const state = emptyBrowserState(1)
    state.pendingTransaction = { id: 'tx', kind: 'browser-association', expectedLayoutVersion: null, layoutText: '{}' }
    state.layoutRevision = 7
    await store.save(state)
    await store.update((current) => ({ ...current, revision: current.revision + 1 }))
    await expect(store.load()).resolves.toMatchObject({ layoutRevision: 7, pendingTransaction: { id: 'tx' } })
  })

  it('serializes an async host save behind a multi-step journal transaction', async () => {
    const store = new TabBrowserStateStore(dir)
    const initial = emptyBrowserState(1); await store.save(initial)
    let release!: () => void; let journalReady!: () => void
    const paused = new Promise<void>((resolve) => { release = resolve })
    const ready = new Promise<void>((resolve) => { journalReady = resolve })
    const journal = store.withLock(async (io) => {
      const state = await io.load()
      await io.save({ ...state, revision: 1, pendingTransaction: { id: 'tx', kind: 'browser-association', expectedLayoutVersion: null, layoutText: '{}' } })
      journalReady(); await paused
      const pending = await io.load()
      expect(pending.pendingTransaction?.id).toBe('tx')
      const { pendingTransaction: _pending, ...committed } = pending
      await io.save({ ...committed, revision: 2 })
    })
    await ready
    const staleHost = store.save({ ...initial, revision: 3 })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await readFile(join(dir, 'browser-state.json'), 'utf8')).toContain('pendingTransaction')
    release(); await journal; await staleHost
    expect((await store.load()).pendingTransaction).toBeUndefined()
  })

  it('preserves recovery overflow for migration preflight instead of dropping URLs', async () => {
    const store = new TabBrowserStateStore(dir)
    const recovery = Array.from({ length: BROWSER_RECOVERY_MAX + 1 }, (_, index) => ({
      id: `recovery-${index.toString(16).padStart(32, '0')}` as `recovery-${string}`,
      workspace: 1, tab: index + 1, safeRestoreUrl: `https://recovery.test/${index}`,
    }))
    await writeFile(join(dir, 'browser-state.json'), JSON.stringify({ ...emptyBrowserState(1), migrationRecovery: recovery }))
    const loaded = await store.load()
    expect(loaded.migrationRecovery).toHaveLength(BROWSER_RECOVERY_MAX + 1)
    expect(loaded.migrationRecovery.at(-1)?.safeRestoreUrl).toBe(`https://recovery.test/${BROWSER_RECOVERY_MAX}`)
  })

  it('returns an empty state when the file is malformed', async () => {
    const store = new TabBrowserStateStore(dir)
    await writeFile(join(dir, 'browser-state.json'), '{bad')
    expect((await store.load()).revision).toBe(0)
  })
})
