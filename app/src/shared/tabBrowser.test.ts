import { describe, expect, it } from 'vitest'
import { createBrowserId, isOpaqueBrowserId, parseLegacyBrowserName, safeRestoreUrl } from './tabBrowser'
import { migrateLegacyBrowsers, type LegacyBrowserMigrationInput } from './tabBrowserMigration'
import { parseBrowserState } from './tabBrowserState'

const leaf = (paneId: string) => ({ kind: 'leaf' as const, paneId })

describe('tab browser identity and policy', () => {
  it('creates coordinate-free 128-bit ids and keeps legacy parsing separate', () => {
    const id = createBrowserId(() => new Uint8Array(16).fill(0xab))
    expect(id).toBe('browser-abababababababababababababababab')
    expect(isOpaqueBrowserId(id)).toBe(true)
    expect(isOpaqueBrowserId('browser-1-2-3-old')).toBe(false)
    expect(parseLegacyBrowserName('browser-1-2-3-old')).toEqual({ ws: 1, tab: 2, ord: 3, id: 'old' })
  })

  it('persists only http(s) origin and path', () => {
    expect(safeRestoreUrl('https://user:pass@example.com/a?q=secret#token')).toBe('https://example.com/a')
    expect(safeRestoreUrl('javascript:alert(1)')).toBe('about:blank')
  })
})

describe('legacy migration', () => {
  it('promotes one browser, removes all recognized leaves, and recovers extras', () => {
    const input: LegacyBrowserMigrationInput = {
      workspaces: { '1': { activeTab: 1, tabs: { '1': { tree: { kind: 'split', dir: 'h', ratio: 0.5, a: leaf('shell'), b: { kind: 'split', dir: 'v', ratio: 0.5, a: leaf('browser-1-1-1-a'), b: leaf('browser-1-1-2-b') } } } } } },
      browsers: {
        'browser-1-1-1-a': { ws: 1, tab: 1, ord: 1, url: 'https://one.test/?token=x' },
        'browser-1-1-2-b': { ws: 1, tab: 1, ord: 2, url: 'https://two.test/path#secret' },
      },
    }
    const result = migrateLegacyBrowsers(input, () => new Uint8Array(16).fill(1))
    const tab = result.workspaces['1']!.tabs['1']!
    expect(tab.tree).toEqual(leaf('shell'))
    expect(tab.browser?.id).toBe('browser-01010101010101010101010101010101')
    expect(result.records[tab.browser!.id]!.safeRestoreUrl).toBe('https://one.test/')
    expect(result.recovery).toEqual([{ workspace: 1, tab: 1, safeRestoreUrl: 'https://two.test/path' }])
  })

  it('trusts sidecar coordinates rather than stale coordinates encoded in a legacy id', () => {
    const input: LegacyBrowserMigrationInput = {
      workspaces: { '2': { activeTab: 3, tabs: { '3': { tree: leaf('browser-1-1-7-stale') } } } },
      browsers: { 'browser-1-1-7-stale': { ws: 2, tab: 3, ord: 7, url: 'https://moved.test/path' } },
    }
    const result = migrateLegacyBrowsers(input, () => new Uint8Array(16).fill(3))
    expect(result.workspaces['2']!.tabs['3']!.tree).toBeNull()
    expect(result.workspaces['2']!.tabs['3']!.browser?.id).toBe('browser-03030303030303030303030303030303')
  })

  it('preserves a browser-only tab with a null terminal tree', () => {
    const input: LegacyBrowserMigrationInput = {
      workspaces: { '1': { activeTab: 1, tabs: { '1': { tree: leaf('browser-1-1-0-a') } } } },
      browsers: { 'browser-1-1-0-a': { ws: 1, tab: 1, ord: 0, url: 'http://localhost:3000/' } },
    }
    expect(migrateLegacyBrowsers(input, () => new Uint8Array(16)).workspaces['1']!.tabs['1']!.tree).toBeNull()
  })
})

describe('browser state parser', () => {
  it('keeps valid records individually, requires the global profile, and drops corrupt records', () => {
    const parsed = parseBrowserState(JSON.stringify({
      version: 1,
      revision: 2,
      layoutRevision: 3,
      profiles: { global: { id: 'global', partition: 'persist:amber-browser', createdAt: 1 } },
      records: {
        'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': {
          id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', profileId: 'global', mode: 'browse', safeRestoreUrl: 'https://example.test/', title: 'x', viewport: { width: 800, height: 600 }, lifecycle: 'frozen', stateRevision: 1, lastUsedAt: 1, lastFocusedAt: 1,
        },
        bad: { id: 'bad' },
      },
      migrationRecovery: [],
    }))
    expect(Object.keys(parsed.records)).toEqual(['browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'])
    expect(parsed.profiles.global.partition).toBe('persist:amber-browser')
  })

  it('round-trips the shared minimum viewport and bounded Preview origins without widening it', () => {
    const parsed = parseBrowserState(JSON.stringify({
      version: 1, revision: 0, layoutRevision: 0,
      profiles: { global: { id: 'global', partition: 'persist:amber-browser', createdAt: 1 } },
      records: { 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': {
        id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', profileId: 'global', mode: 'preview', safeRestoreUrl: 'https://dev.example/app', title: '',
        viewport: { width: 200, height: 200 }, previewOrigins: ['https://dev.example', 'file:///tmp', 'https://dev.example'],
        lifecycle: 'frozen', stateRevision: 1, lastUsedAt: 1, lastFocusedAt: 1,
      } }, migrationRecovery: [],
    }))
    expect(parsed.records['browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']).toMatchObject({ viewport: { width: 200, height: 200 }, previewOrigins: ['https://dev.example'] })
  })

  it('retains bounded, redacted migration recovery entries', () => {
    const parsed = parseBrowserState(JSON.stringify({
      version: 1, revision: 0, layoutRevision: 0,
      profiles: { global: { id: 'global', partition: 'persist:amber-browser', createdAt: 1 } },
      records: {},
      migrationRecovery: [{ workspace: 1, tab: 2, safeRestoreUrl: 'https://example.test/a?token=secret' }, { workspace: 'bad', tab: 2, safeRestoreUrl: 'https://bad.test' }],
    }))
    expect(parsed.migrationRecovery).toEqual([{ workspace: 1, tab: 2, safeRestoreUrl: 'https://example.test/a' }])
  })
})
