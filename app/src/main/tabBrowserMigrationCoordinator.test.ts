import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadLayoutFile, saveLayoutFile } from './layoutIO'
import { TabBrowserStateStore } from './tabBrowserStateStore'
import { collectBrowserOrphans, commitBrowserLayoutMutation, coordinateTabBrowserMigration } from './tabBrowserMigrationCoordinator'
import { parseLayout } from '../shared/layoutFile'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

function legacy(): string {
  return JSON.stringify({ version: 1, activeWorkspace: 1, workspaces: { '1': { activeTab: 1, tabs: { '1': { tree: { kind: 'leaf', paneId: 'browser-1-1-0-old' } } } } }, browsers: { 'browser-1-1-0-old': { ws: 1, tab: 1, ord: 0, url: 'https://example.test/path?secret=yes' } } })
}

describe('coordinateTabBrowserMigration', () => {
  it('collects only unassociated records older than the orphan grace', () => {
    expect(collectBrowserOrphans({ keep: 20, young: 21, old: 1 }, new Set(['keep']), 30, 10)).toEqual(['old'])
  })
  it('creates a private timestamped v1 backup before committing migration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'amber-browser-backup-')); dirs.push(dir)
    const path = join(dir, 'ui-layout.json'); const source = legacy(); await saveLayoutFile(path, source, null)
    await coordinateTabBrowserMigration(path, new TabBrowserStateStore(dir), () => new Uint8Array(16).fill(3), () => 'tx-backup')
    const backups = (await readdir(dir)).filter((name) => name.startsWith('ui-layout.json.v1.') && name.endsWith('.bak'))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(dir, backups[0]! as string), 'utf8')).toBe(source)
    if (process.platform !== 'win32') expect((await stat(join(dir, backups[0]! as string))).mode & 0o077).toBe(0)
  })

  it('leaves both stores untouched when the v1 backup cannot be committed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'amber-browser-backup-fail-')); dirs.push(dir)
    const path = join(dir, 'ui-layout.json'); const source = legacy(); await saveLayoutFile(path, source, null)
    const store = new TabBrowserStateStore(dir)
    await expect(coordinateTabBrowserMigration(path, store, () => new Uint8Array(16).fill(6), () => 'tx-backup-fail', undefined,
      async () => { throw new Error('BACKUP_FAILED') })).rejects.toThrow('BACKUP_FAILED')
    expect((await loadLayoutFile(path)).text).toBe(source)
    expect((await store.load()).pendingTransaction).toBeUndefined()
    expect((await readdir(dir)).filter((name) => name.includes('.v1.'))).toHaveLength(0)
  })

  it('fails recovery overflow before backup or either v2/state write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'amber-browser-recovery-overflow-')); dirs.push(dir)
    const path = join(dir, 'ui-layout.json')
    const browsers = Object.fromEntries(Array.from({ length: 102 }, (_, ord) => [`browser-1-1-${ord}-old${ord}`, { ws: 1, tab: 1, ord, url: `https://example.test/${ord}` }]))
    const source = JSON.stringify({ version: 1, activeWorkspace: 1, workspaces: { '1': { activeTab: 1, tabs: { '1': { tree: null } } } }, browsers })
    await saveLayoutFile(path, source, null)
    const store = new TabBrowserStateStore(dir)
    await expect(coordinateTabBrowserMigration(path, store, undefined, () => 'tx-overflow')).rejects.toThrow('BROWSER_RECOVERY_LIMIT')
    expect((await loadLayoutFile(path)).text).toBe(source)
    const unchanged = await store.load()
    expect(unchanged.records).toEqual({})
    expect(unchanged.migrationRecovery).toEqual([])
    expect(unchanged.pendingTransaction).toBeUndefined()
    expect((await readdir(dir)).filter((name) => name.includes('.v1.'))).toHaveLength(0)
  })

  it('refuses a future-version pending transaction without rewriting it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'amber-browser-future-pending-')); dirs.push(dir)
    const path = join(dir, 'ui-layout.json'); const source = JSON.stringify({ version: 2, activeWorkspace: 1, workspaces: {} }); await saveLayoutFile(path, source, null)
    const store = new TabBrowserStateStore(dir); const before = await store.load()
    const future = JSON.stringify({ version: 99, activeWorkspace: 1, workspaces: { secret: {} }, sentinel: 'keep-me' })
    await store.save({ ...before, pendingTransaction: { id: 'future', kind: 'browser-association', expectedLayoutVersion: source, layoutText: future } })
    await expect(coordinateTabBrowserMigration(path, store)).rejects.toThrow('UNSUPPORTED_LAYOUT_VERSION')
    expect((await loadLayoutFile(path)).text).toBe(source)
    expect((await store.load()).pendingTransaction?.layoutText).toBe(future)
  })

  it('commits legacy layout and browser intent through a recoverable journal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'amber-browser-migrate-')); dirs.push(dir)
    const path = join(dir, 'ui-layout.json'); await saveLayoutFile(path, legacy(), null)
    const store = new TabBrowserStateStore(dir)
    await coordinateTabBrowserMigration(path, store, () => new Uint8Array(16).fill(4), () => 'tx-1')
    const layout = parseLayout((await loadLayoutFile(path)).text!)
    const state = await store.load()
    expect(layout.version).toBe(2)
    expect(layout.workspaces['1']!.tabs['1']!.tree).toBeNull()
    expect(layout.workspaces['1']!.tabs['1']!.browser?.id).toBe('browser-04040404040404040404040404040404')
    expect(state.records['browser-04040404040404040404040404040404']?.safeRestoreUrl).toBe('https://example.test/path')
    expect(state.pendingTransaction).toBeUndefined()
  })

  it('rolls back staged browser resources when the layout CAS fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'amber-browser-rollback-')); dirs.push(dir)
    const path = join(dir, 'ui-layout.json'); await saveLayoutFile(path, JSON.stringify({ version: 2, activeWorkspace: 1, workspaces: {} }), null)
    const store = new TabBrowserStateStore(dir); const before = await store.load()
    const result = await commitBrowserLayoutMutation(path, store, '{}', 'stale', undefined, () => 'tx', (state) => ({ ...state, migrationRecovery: [{ id: 'recovery-cccccccccccccccccccccccccccccccc' as const, workspace: 1, tab: 1, safeRestoreUrl: 'https://staged.test/' }] }))
    expect(result).toHaveProperty('conflict')
    expect((await store.load()).migrationRecovery).toEqual(before.migrationRecovery)
    expect((await store.load()).pendingTransaction).toBeUndefined()
  })

  it('journals ordinary browser association mutations before the layout CAS', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'amber-browser-mutate-')); dirs.push(dir)
    const path = join(dir, 'ui-layout.json'); await saveLayoutFile(path, JSON.stringify({ version: 2, activeWorkspace: 1, browserRevision: 0, workspaces: {} }), null)
    const loaded = await loadLayoutFile(path); const store = new TabBrowserStateStore(dir)
    const target = JSON.stringify({ version: 2, activeWorkspace: 1, browserRevision: 1, workspaces: {} })
    let observedJournal = false
    await commitBrowserLayoutMutation(path, store, target, loaded.version, async (...args) => {
      observedJournal = JSON.parse(await readFile(store.path, 'utf8')).pendingTransaction?.kind === 'browser-association'
      return saveLayoutFile(...args)
    })
    expect(observedJournal).toBe(true)
    expect((await store.load()).pendingTransaction).toBeUndefined()
  })

  it('replays the same migration after interruption instead of minting a duplicate browser', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'amber-browser-migrate-')); dirs.push(dir)
    const path = join(dir, 'ui-layout.json'); await saveLayoutFile(path, legacy(), null)
    const store = new TabBrowserStateStore(dir)
    let fail = true
    await expect(coordinateTabBrowserMigration(path, store, () => new Uint8Array(16).fill(5), () => 'tx-2', async (...args) => {
      if (fail) { fail = false; return { error: 'injected' } }
      return saveLayoutFile(...args)
    })).rejects.toThrow('injected')
    expect((await store.load()).pendingTransaction?.id).toBe('tx-2')
    await coordinateTabBrowserMigration(path, store, () => new Uint8Array(16).fill(9), () => 'tx-new')
    const state = await store.load()
    expect(Object.keys(state.records)).toEqual(['browser-05050505050505050505050505050505'])
    expect(state.pendingTransaction).toBeUndefined()
  })
})
