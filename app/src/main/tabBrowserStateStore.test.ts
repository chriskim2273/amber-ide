import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TabBrowserStateStore } from './tabBrowserStateStore'
import { emptyBrowserState } from '../shared/tabBrowserState'

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

  it('returns an empty state when the file is malformed', async () => {
    const store = new TabBrowserStateStore(dir)
    await writeFile(join(dir, 'browser-state.json'), '{bad')
    expect((await store.load()).revision).toBe(0)
  })
})
