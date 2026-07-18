import { describe, it, expect } from 'vitest'
import { emptyLayout, parseLayout, serializeLayout, orderTabs, moveTab, LAYOUT_VERSION, type LayoutFile } from './layoutFile'

describe('layout browsers map', () => {
  it('round-trips valid entries', () => {
    const l: LayoutFile = { version: 1, activeWorkspace: 1, workspaces: {},
      browsers: { 'browser-1-1-0-a': { ws: 1, tab: 1, ord: 0, url: 'https://x.dev' } } }
    expect(parseLayout(serializeLayout(l)).browsers).toEqual(l.browsers)
  })
  it('drops malformed entries, keeps valid', () => {
    const text = JSON.stringify({ version: 1, activeWorkspace: 1, workspaces: {}, browsers: {
      ok: { ws: 1, tab: 1, ord: 0, url: 'https://a' },
      badUrl: { ws: 1, tab: 1, ord: 0, url: 5 },
      badWs: { ws: 'x', tab: 1, ord: 0, url: 'https://b' },
      notObj: 42,
    } })
    expect(parseLayout(text).browsers).toEqual({ ok: { ws: 1, tab: 1, ord: 0, url: 'https://a' } })
  })
  it('non-object browsers → undefined', () => {
    expect(parseLayout(JSON.stringify({ version: 1, activeWorkspace: 1, workspaces: {}, browsers: [] })).browsers).toBeUndefined()
  })
})

describe('layoutFile', () => {
  it('round-trips a layout', () => {
    const l = emptyLayout()
    l.workspaces['1'] = { activeTab: 1, tabs: { '1': { tree: { kind: 'leaf', paneId: 'amber-1-1-0-a' } } } }
    expect(parseLayout(serializeLayout(l))).toEqual(l)
  })
  it('falls back to empty on corrupt json', () => {
    expect(parseLayout('{not json')).toEqual(emptyLayout())
  })
  it('falls back to empty on version mismatch', () => {
    expect(parseLayout(JSON.stringify({ version: LAYOUT_VERSION + 99, workspaces: {} }))).toEqual(emptyLayout())
  })
  it('round-trips ws label, tab label, and tabOrder', () => {
    const l = emptyLayout()
    l.workspaces['1'] = {
      activeTab: 2,
      label: 'backend',
      tabOrder: [2, 1],
      tabs: {
        '1': { tree: { kind: 'leaf', paneId: 'amber-1-1-0-a' } },
        '2': { tree: null, label: 'logs' },
      },
    }
    expect(parseLayout(serializeLayout(l))).toEqual(l)
  })
  it('round-trips a top-level fontSize', () => {
    const l = emptyLayout()
    l.fontSize = 16
    l.workspaces['1'] = { activeTab: 1, tabs: { '1': { tree: null } } }
    expect(parseLayout(serializeLayout(l))).toEqual(l)
  })
  it('parses an old file with no fontSize (defaults undefined)', () => {
    const old = JSON.stringify({
      version: LAYOUT_VERSION,
      activeWorkspace: 1,
      workspaces: { '1': { activeTab: 1, tabs: { '1': { tree: null } } } },
    })
    expect(parseLayout(old).fontSize).toBeUndefined()
  })
  it('parses an old file with no label/tabOrder fields (defaults undefined)', () => {
    const old = JSON.stringify({
      version: LAYOUT_VERSION,
      activeWorkspace: 1,
      workspaces: { '1': { activeTab: 1, tabs: { '1': { tree: null } } } },
    })
    const l = parseLayout(old)
    expect(l.workspaces['1']!.label).toBeUndefined()
    expect(l.workspaces['1']!.tabOrder).toBeUndefined()
    expect(l.workspaces['1']!.tabs['1']!.label).toBeUndefined()
  })
  it('shape-guards a non-array tabOrder and non-string label (both dropped)', () => {
    const bad = JSON.stringify({
      version: LAYOUT_VERSION, activeWorkspace: 1,
      workspaces: { '1': { activeTab: 1, tabs: { '1': { tree: null } }, tabOrder: 'nope', label: 42 } },
    })
    const w = parseLayout(bad).workspaces['1']!
    expect(w.tabOrder).toBeUndefined()
    expect(w.label).toBeUndefined()
  })
  it('filters non-number entries out of a valid tabOrder', () => {
    const l = parseLayout(JSON.stringify({
      version: LAYOUT_VERSION, activeWorkspace: 1,
      workspaces: { '1': { activeTab: 1, tabs: { '1': { tree: null } }, tabOrder: [2, 'x', 1, null] } },
    }))
    expect(l.workspaces['1']!.tabOrder).toEqual([2, 1])
  })
  it('round-trips a frozen map (note and empty-note entries)', () => {
    const l = emptyLayout()
    l.frozen = { 'amber-1-1-0-a': { note: 'back after lunch' }, 'amber-2-1-0-b': {} }
    l.workspaces['1'] = { activeTab: 1, tabs: { '1': { tree: null } } }
    expect(parseLayout(serializeLayout(l))).toEqual(l)
  })
  it('parses an old file with no frozen field (defaults undefined)', () => {
    const old = JSON.stringify({
      version: LAYOUT_VERSION,
      activeWorkspace: 1,
      workspaces: { '1': { activeTab: 1, tabs: { '1': { tree: null } } } },
    })
    expect(parseLayout(old).frozen).toBeUndefined()
  })
  it('shape-guards a malformed frozen field (non-object → dropped)', () => {
    const bad = JSON.stringify({
      version: LAYOUT_VERSION, activeWorkspace: 1, workspaces: {}, frozen: [1, 2, 3],
    })
    expect(parseLayout(bad).frozen).toBeUndefined()
  })
  it('shape-guards malformed frozen entries (bad entry → dropped, bad note → empty)', () => {
    const bad = JSON.stringify({
      version: LAYOUT_VERSION, activeWorkspace: 1, workspaces: {},
      frozen: { good: { note: 'ok' }, arr: [1], nullish: null, num: 5, badnote: { note: 42 } },
    })
    expect(parseLayout(bad).frozen).toEqual({ good: { note: 'ok' }, badnote: {} })
  })
})

describe('orderTabs', () => {
  it('returns numeric order when no order is given', () => {
    expect(orderTabs([3, 1, 2])).toEqual([1, 2, 3])
  })
  it('handles an empty order array as numeric', () => {
    expect(orderTabs([2, 1], [])).toEqual([1, 2])
  })
  it('follows the given order for listed ids', () => {
    expect(orderTabs([1, 2, 3], [3, 1, 2])).toEqual([3, 1, 2])
  })
  it('appends unlisted ids in numeric order after listed ones', () => {
    expect(orderTabs([1, 2, 3, 4], [3, 1])).toEqual([3, 1, 2, 4])
  })
  it('drops order entries whose id no longer exists', () => {
    expect(orderTabs([1, 2], [3, 2, 1])).toEqual([2, 1])
  })
})

describe('moveTab', () => {
  it('moving left-to-right lands after the target', () => {
    expect(moveTab([1, 2, 3, 4], 1, 3)).toEqual([2, 3, 1, 4])
  })
  it('moving right-to-left lands before the target', () => {
    expect(moveTab([1, 2, 3, 4], 4, 2)).toEqual([1, 4, 2, 3])
  })
  it('is a no-op when from === to', () => {
    expect(moveTab([1, 2, 3], 2, 2)).toEqual([1, 2, 3])
  })
  it('is a no-op when an id is missing', () => {
    expect(moveTab([1, 2, 3], 9, 2)).toEqual([1, 2, 3])
  })
})
