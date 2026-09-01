import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
