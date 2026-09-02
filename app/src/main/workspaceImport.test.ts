import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyBrowserState } from '../shared/tabBrowserState'
import { parseWorkspaceFile, type WorkspaceDoc } from '../shared/workspaceFile'
import { commitPreparedWorkspaceImport, prepareWorkspaceImport } from './workspaceImport'
import { TabBrowserStateStore } from './tabBrowserStateStore'
import { stageWorkspaceBrowserState } from './tabBrowserService'
import { saveLayoutFile } from './layoutIO'
import { parseLayout, serializeLayout } from '../shared/layoutFile'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

const current = {
  version: 2,
  activeWorkspace: 1,
  workspaces: {
    '1': { activeTab: 1, tabs: { '1': { tree: { kind: 'leaf' as const, paneId: 'editor-1-1-0-old' }, browser: { id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', width: 420, collapsed: false } } } },
    '4': { activeTab: 1, tabs: { '1': { tree: null } } },
  },
  editors: { 'editor-1-1-0-old': { ws: 1, tab: 1, ord: 0, path: '/old' } },
  frozen: { 'amber-1-1-1-old': { note: 'old' }, 'amber-4-1-0-keep': { note: 'keep' } },
}

function doc(withBrowser: boolean): WorkspaceDoc {
  return { version: 2, scope: 'one', workspaces: [{ tabs: [{ tab: 7, tree: { kind: 'split', dir: 'h', ratio: 0.5, a: { kind: 'leaf', paneId: 'p0' }, b: { kind: 'leaf', paneId: 'p1' } }, panes: [
    { id: 'p0', kind: 'shell', cwd: '/tmp', ord: 0, scrollback: '', frozenNote: 'restored' },
    { id: 'p1', kind: 'editor', cwd: '', ord: 1, scrollback: '', path: '/new' },
  ], ...(withBrowser ? { browser: { mode: 'browse', safeRestoreUrl: 'https://example.test/' } } : {}) }] }] }
}

describe('prepareWorkspaceImport', () => {
  it('derives destinations in main and includes trees, editors, and frozen intent in one sidecar', () => {
    let n = 0
    const prepared = prepareWorkspaceImport({ current, browserState: emptyBrowserState(1), doc: doc(true), mode: 'replace', activeWorkspace: 1, mintId: () => `mint${++n}` })
    expect(prepared.plan.targetWorkspaces).toEqual([1])
    expect(prepared.next.workspaces['1']!.tabs['7']!.tree).not.toBeNull()
    expect(Object.values(prepared.next.editors ?? {})).toContainEqual(expect.objectContaining({ ws: 1, tab: 7, path: '/new' }))
    expect(prepared.next.editors).not.toHaveProperty('editor-1-1-0-old')
    expect(Object.entries(prepared.next.frozen ?? {})).toContainEqual([expect.stringMatching(/^amber-1-7-/), { note: 'restored' }])
    expect(prepared.next.frozen).toHaveProperty('amber-4-1-0-keep')
    expect(prepared.next.frozen).not.toHaveProperty('amber-1-1-1-old')
    expect(prepared.needsBrowserHost).toBe(true)
  })

  it('commits the complete sidecar and browser resources through the production transaction', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'amber-workspace-import-')); dirs.push(dir)
    const layoutPath = join(dir, 'ui-layout.json'); const stored = await saveLayoutFile(layoutPath, serializeLayout(current), null)
    if (!('ok' in stored)) throw new Error('fixture save failed')
    const store = new TabBrowserStateStore(dir)
    const browserState = stageWorkspaceBrowserState(await store.load(), { entries: [{ id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', browser: { mode: 'browse', safeRestoreUrl: 'https://old.test/' } }], recovery: [] }, 1)
    await store.save(browserState)
    let n = 0
    const prepared = prepareWorkspaceImport({ current, browserState, doc: doc(true), mode: 'replace', activeWorkspace: 1, mintId: () => `mint${++n}` })
    let imported = false
    await commitPreparedWorkspaceImport({ prepared, layoutPath, expectedLayoutVersion: stored.version, browserStore: store, browserHost: {
      importWorkspaceBrowsers: async () => { imported = true }, command: async () => ({}),
    } })
    expect(imported).toBe(true)
    const reloaded = parseLayout(await readFile(layoutPath, 'utf8'))
    expect(reloaded.editors).toEqual(prepared.next.editors)
    expect(reloaded.frozen).toEqual(prepared.next.frozen)
    expect(reloaded.workspaces).toEqual(prepared.next.workspaces)
    expect(Object.keys((await store.load()).records)).toEqual([prepared.plan.browserRails[0]!.id])
    expect((await store.load()).records).not.toHaveProperty('browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  })

  it('keeps v1 extra browser intent as bounded recovery when main parses the portable source', () => {
    const legacy = parseWorkspaceFile(JSON.stringify({ version: 1, scope: 'one', workspaces: [{ tabs: [{ tab: 1, tree: { kind: 'split', dir: 'h', ratio: 0.5, a: { kind: 'leaf', paneId: 'p0' }, b: { kind: 'leaf', paneId: 'p1' } }, panes: [
      { id: 'p0', kind: 'browser', cwd: '', ord: 0, scrollback: '', url: 'https://one.test/' },
      { id: 'p1', kind: 'browser', cwd: '', ord: 1, scrollback: '', url: 'https://two.test/' },
    ] }] }] }))
    const prepared = prepareWorkspaceImport({ current: { version: 2, activeWorkspace: 1, workspaces: { '1': current.workspaces['1']! } }, browserState: emptyBrowserState(1), doc: legacy, mode: 'new', activeWorkspace: 1, mintId: () => 'mint' })
    expect(prepared.browsers.entries).toHaveLength(1)
    expect(prepared.browsers.recovery).toEqual([expect.objectContaining({ browser: expect.objectContaining({ safeRestoreUrl: 'https://two.test/' }) })])
  })

  it('requires no BrowserHost for a terminal/editor-only new import', async () => {
    const prepared = prepareWorkspaceImport({ current: { version: 2, activeWorkspace: 1, workspaces: { '1': current.workspaces['1']! } }, browserState: null, doc: doc(false), mode: 'new', activeWorkspace: 1, mintId: () => 'mint' })
    expect(prepared.plan.targetWorkspaces).toEqual([2])
    expect(prepared.needsBrowserHost).toBe(false)
    expect(prepared.browsers).toEqual({ entries: [], recovery: [] })
    const dir = await mkdtemp(join(tmpdir(), 'amber-workspace-no-browser-')); dirs.push(dir)
    const path = join(dir, 'ui-layout.json'); const initial = await saveLayoutFile(path, serializeLayout({ version: 2, activeWorkspace: 1, workspaces: { '1': current.workspaces['1']! } }), null)
    if (!('ok' in initial)) throw new Error('fixture save failed')
    await expect(commitPreparedWorkspaceImport({ prepared, layoutPath: path, expectedLayoutVersion: initial.version, browserStore: null, browserHost: null })).resolves.toHaveProperty('version')
    expect(parseLayout(await readFile(path, 'utf8')).workspaces['2']).toBeDefined()
  })
})
