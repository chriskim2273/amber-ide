import { describe, it, expect } from 'vitest'
import { emptyLayout, normalizeFriendlyTitle, parseLayout, pruneLocalTitles, serializeLayout, orderTabs, moveTab, pushRecent, mergeLayout, LAYOUT_VERSION, type LayoutFile } from './layoutFile'

describe('layout editors map', () => {
  it('round-trips valid entries (incl. all optional fields)', () => {
    const l: LayoutFile = { version: 1, activeWorkspace: 1, workspaces: {},
      editors: {
        'editor-1-1-0-a': { ws: 1, tab: 1, ord: 0, path: '/tmp/a.json' },
        'editor-1-1-1-b': { ws: 1, tab: 1, ord: 1, path: '/tmp/b.md', view: 'split', outline: true, wrap: false },
      } }
    expect(parseLayout(serializeLayout(l)).editors).toEqual(l.editors)
  })
  it('keeps a null path (unsaved scratch buffer)', () => {
    const text = JSON.stringify({ version: 1, activeWorkspace: 1, workspaces: {}, editors: {
      scratch: { ws: 2, tab: 3, ord: 0, path: null },
    } })
    expect(parseLayout(text).editors).toEqual({ scratch: { ws: 2, tab: 3, ord: 0, path: null } })
  })
  it('drops malformed entries, keeps valid', () => {
    const text = JSON.stringify({ version: 1, activeWorkspace: 1, workspaces: {}, editors: {
      ok: { ws: 1, tab: 1, ord: 0, path: '/a' },
      noPath: { ws: 1, tab: 1, ord: 0 },
      badPath: { ws: 1, tab: 1, ord: 0, path: 5 },
      badWs: { ws: 'x', tab: 1, ord: 0, path: '/b' },
      notObj: 42,
      nullish: null,
      arr: [1],
    } })
    expect(parseLayout(text).editors).toEqual({ ok: { ws: 1, tab: 1, ord: 0, path: '/a' } })
  })
  it('drops malformed optional fields but keeps the entry', () => {
    const text = JSON.stringify({ version: 1, activeWorkspace: 1, workspaces: {}, editors: {
      e: { ws: 1, tab: 1, ord: 0, path: '/a', view: 'nope', outline: 'yes', wrap: 1 },
    } })
    expect(parseLayout(text).editors).toEqual({ e: { ws: 1, tab: 1, ord: 0, path: '/a' } })
  })
  it('non-object editors → undefined; missing → undefined', () => {
    expect(parseLayout(JSON.stringify({ version: 1, activeWorkspace: 1, workspaces: {}, editors: [] })).editors).toBeUndefined()
    expect(parseLayout(JSON.stringify({ version: 1, activeWorkspace: 1, workspaces: {} })).editors).toBeUndefined()
  })
})

describe('layout recentFiles', () => {
  it('round-trips', () => {
    const l: LayoutFile = { version: 1, activeWorkspace: 1, workspaces: {}, recentFiles: ['/a', '/b'] }
    expect(parseLayout(serializeLayout(l)).recentFiles).toEqual(['/a', '/b'])
  })
  it('drops non-strings, dedupes and caps at 20 on parse', () => {
    const many = Array.from({ length: 30 }, (_, i) => `/f${i}`)
    const text = JSON.stringify({ version: 1, activeWorkspace: 1, workspaces: {},
      recentFiles: ['/a', 5, '/a', null, ...many] })
    const r = parseLayout(text).recentFiles!
    expect(r.length).toBe(20)
    expect(r.slice(0, 3)).toEqual(['/a', '/f0', '/f1'])
  })
  it('non-array → undefined; missing → undefined', () => {
    expect(parseLayout(JSON.stringify({ version: 1, activeWorkspace: 1, workspaces: {}, recentFiles: 'x' })).recentFiles).toBeUndefined()
    expect(parseLayout(JSON.stringify({ version: 1, activeWorkspace: 1, workspaces: {} })).recentFiles).toBeUndefined()
  })
})

describe('pushRecent', () => {
  it('puts the path first', () => {
    expect(pushRecent(['/a', '/b'], '/c')).toEqual(['/c', '/a', '/b'])
  })
  it('dedupes (moves an existing path to the front)', () => {
    expect(pushRecent(['/a', '/b'], '/b')).toEqual(['/b', '/a'])
  })
  it('handles a missing list', () => {
    expect(pushRecent(undefined, '/a')).toEqual(['/a'])
  })
  it('caps at 20', () => {
    const list = Array.from({ length: 20 }, (_, i) => `/f${i}`)
    const out = pushRecent(list, '/new')
    expect(out.length).toBe(20)
    expect(out[0]).toBe('/new')
    expect(out).not.toContain('/f19')
  })
})

describe('layout friendly titles', () => {
  it('uses the 120-byte UTF-8 boundary shared with the daemon', () => {
    expect(normalizeFriendlyTitle('x'.repeat(120))).toBe('x'.repeat(120))
    expect(normalizeFriendlyTitle('x'.repeat(121))).toBeUndefined()
    expect(normalizeFriendlyTitle('é'.repeat(60))).toBe('é'.repeat(60))
    expect(normalizeFriendlyTitle('é'.repeat(61))).toBeUndefined()
  })

  it('prunes title entries for closed or unknown app-local panes', () => {
    const layout: LayoutFile = {
      version: 1, activeWorkspace: 1, workspaces: {},
      titles: { 'browser-1-1-0-live': 'Docs', 'editor-1-1-1-live': 'Notes', orphan: 'Stale' },
      browsers: { 'browser-1-1-0-live': { ws: 1, tab: 1, ord: 0, url: '' } },
      editors: { 'editor-1-1-1-live': { ws: 1, tab: 1, ord: 1, path: null } },
    }
    expect(pruneLocalTitles(layout).titles).toEqual({
      'browser-1-1-0-live': 'Docs', 'editor-1-1-1-live': 'Notes',
    })
  })

  it('round-trips valid titles and drops unsafe values', () => {
    const l: LayoutFile = { version: 1, activeWorkspace: 1, workspaces: {}, titles: { 'browser-1-1-0-a': 'Docs' } }
    expect(parseLayout(serializeLayout(l)).titles).toEqual(l.titles)
    const parsed = parseLayout(JSON.stringify({ version: 1, activeWorkspace: 1, workspaces: {}, titles: {
      ok: ' Build ', blank: '  ', control: 'bad\nname', c1: 'bad\u0085name', tooLong: 'x'.repeat(121), emojiTooLong: '😀'.repeat(121), bad: 4,
    } }))
    expect(parsed.titles).toEqual({ ok: 'Build' })
  })
})

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

describe('mergeLayout (spec §6 CAS conflict retry)', () => {
  const leaf = (paneId: string) => ({ kind: 'leaf' as const, paneId })

  it('merges edits to two different workspaces made from the same base', () => {
    const base: LayoutFile = {
      version: 1, activeWorkspace: 1,
      workspaces: {
        '1': { activeTab: 1, tabs: { '1': { tree: leaf('a') } } },
        '2': { activeTab: 1, tabs: { '1': { tree: leaf('b') } } },
      },
    }
    // local (e.g. the browser) only touched ws 1.
    const local: LayoutFile = {
      ...base,
      workspaces: { ...base.workspaces, '1': { activeTab: 1, tabs: { '1': { tree: leaf('a-edited') } } } },
    }
    // remote (e.g. the desktop) only touched ws 2, written while local's edit was in flight.
    const remote: LayoutFile = {
      ...base,
      workspaces: { ...base.workspaces, '2': { activeTab: 1, tabs: { '1': { tree: leaf('b-edited') } } } },
    }
    const merged = mergeLayout(base, local, remote)
    expect(merged.workspaces['1']?.tabs['1']?.tree).toEqual(leaf('a-edited'))
    expect(merged.workspaces['2']?.tabs['1']?.tree).toEqual(leaf('b-edited'))
  })

  it('never prunes desktop-only browser/editor panes the web build cannot create', () => {
    // Reproduces the exact risk the spec calls out (§7): a web client's local
    // tree has no browsers/editors at all (it never created any), and while
    // its save was in flight the desktop added one of each. A naive
    // "overwrite with local" retry would silently destroy them.
    const base: LayoutFile = {
      version: 1, activeWorkspace: 1,
      workspaces: { '1': { activeTab: 1, tabs: { '1': { tree: leaf('a') } } } },
    }
    const local: LayoutFile = {
      ...base,
      workspaces: { '1': { activeTab: 1, tabs: { '1': { tree: leaf('a-edited-by-browser') } } } },
    }
    const remote: LayoutFile = {
      ...base,
      browsers: { 'browser-1-1-1-x': { ws: 1, tab: 1, ord: 1, url: 'https://example.com' } },
      editors: { 'editor-1-1-2-y': { ws: 1, tab: 1, ord: 2, path: '/tmp/notes.md' } },
    }
    const merged = mergeLayout(base, local, remote)
    expect(merged.workspaces['1']?.tabs['1']?.tree).toEqual(leaf('a-edited-by-browser'))
    expect(merged.browsers).toEqual(remote.browsers)
    expect(merged.editors).toEqual(remote.editors)
  })

  it('accepts a remote deletion the local side never touched', () => {
    const base: LayoutFile = { version: 1, activeWorkspace: 1, workspaces: {}, frozen: { s1: {}, s2: {} } }
    const local: LayoutFile = { ...base, activeWorkspace: 2 } // unrelated local edit
    const remote: LayoutFile = { ...base, frozen: { s1: {} } } // desktop un-froze s2
    const merged = mergeLayout(base, local, remote)
    expect(merged.activeWorkspace).toBe(2)
    expect(merged.frozen).toEqual({ s1: {} })
  })

  it('a genuine same-leaf double-edit resolves to local (documented ponytail tradeoff)', () => {
    const base: LayoutFile = { version: 1, activeWorkspace: 1, workspaces: {}, fontSize: 14 }
    const local: LayoutFile = { ...base, fontSize: 16 }
    const remote: LayoutFile = { ...base, fontSize: 18 }
    expect(mergeLayout(base, local, remote).fontSize).toBe(16)
  })

  it('keeps a complete local split tree when both clients rearrange the same tab', () => {
    const base: LayoutFile = {
      version: 1, activeWorkspace: 1,
      workspaces: {
        '1': { activeTab: 1, tabs: { '1': { tree: { kind: 'split', dir: 'h', ratio: 0.5, a: leaf('a'), b: leaf('b') } } } },
      },
    }
    // Browser swaps the panes while desktop independently splits pane a. A
    // property-wise JSON merge can combine these incompatible tree shapes,
    // duplicate a, and discard b. The whole tree is one atomic arrangement.
    const local: LayoutFile = {
      ...base,
      workspaces: {
        '1': { activeTab: 1, tabs: { '1': { tree: { kind: 'split', dir: 'h', ratio: 0.5, a: leaf('b'), b: leaf('a') } } } },
      },
    }
    const remote: LayoutFile = {
      ...base,
      workspaces: {
        '1': { activeTab: 1, tabs: { '1': { tree: {
          kind: 'split', dir: 'h', ratio: 0.5,
          a: { kind: 'split', dir: 'v', ratio: 0.5, a: leaf('a'), b: leaf('c') }, b: leaf('b'),
        } } } },
      },
    }
    expect(mergeLayout(base, local, remote).workspaces['1']?.tabs['1']?.tree)
      .toEqual(local.workspaces['1']?.tabs['1']?.tree)
  })

  it('is a no-op when local and remote ended up identical', () => {
    const base = emptyLayout()
    const local: LayoutFile = { ...base, fontSize: 16 }
    const remote: LayoutFile = { ...base, fontSize: 16 }
    expect(mergeLayout(base, local, remote)).toEqual(local)
  })
})
