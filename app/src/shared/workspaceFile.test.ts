import { describe, it, expect } from 'vitest'
import type { Node } from '../renderer/layout'
import type { LayoutFile } from './layoutFile'
import {
  WORKSPACE_VERSION,
  parseWorkspaceFile,
  serializeWorkspaceFile,
  treeToPlaceholders,
  treeFromPlaceholders,
  assembleSave,
  buildLoadPlan,
  nextFreeWs,
  planLoad,
  type WorkspaceDoc,
  type SaveWorkspace,
} from './workspaceFile'

// A minimal valid doc for reuse.
function sampleDoc(): WorkspaceDoc {
  return {
    version: WORKSPACE_VERSION,
    scope: 'one',
    workspaces: [
      {
        label: 'backend',
        tabOrder: [2, 1],
        tabs: [
          {
            tab: 1,
            label: 'edit',
            tree: { kind: 'split', dir: 'h', ratio: 0.5, a: { kind: 'leaf', paneId: 'p0' }, b: { kind: 'leaf', paneId: 'p1' } },
            panes: [
              { id: 'p0', kind: 'shell', cwd: '/a', ord: 0, scrollback: '' },
              { id: 'p1', kind: 'claude', cwd: '/b', ord: 1, frozenNote: 'brb', scrollback: '' },
            ],
          },
          { tab: 2, tree: null, panes: [{ id: 'p0', kind: 'shell', cwd: '/c', ord: 0, scrollback: '' }] },
        ],
      },
    ],
  }
}

describe('parse/serialize round-trip', () => {
  it('round-trips a full doc', () => {
    const doc = sampleDoc()
    expect(parseWorkspaceFile(serializeWorkspaceFile(doc))).toEqual(doc)
  })
  it('round-trips base64 scrollback with arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 27, 91, 50, 74, 255, 254, 10, 13])
    const dumps = { 'amber-1-1-0-x': bytes }
    const live: SaveWorkspace[] = [
      { ws: 1, tabs: [{ tab: 1, panes: [{ name: 'amber-1-1-0-x', cwd: '/w', kind: 'shell', ord: 0 }] }] },
    ]
    const doc = assembleSave('one', live, { version: 1, activeWorkspace: 1, workspaces: {} }, dumps)
    const round = parseWorkspaceFile(serializeWorkspaceFile(doc))
    const plan = buildLoadPlan(round, { mode: 'new', nextWs: 5, mintId: mkMint() })
    const only = Object.values(plan.scrollback)[0]!
    expect(Array.from(only)).toEqual(Array.from(bytes))
  })
})

describe('parse validation', () => {
  it('throws on wrong version', () => {
    const bad = JSON.stringify({ ...sampleDoc(), version: 99 })
    expect(() => parseWorkspaceFile(bad)).toThrow(/unsupported version/)
  })
  it('throws on invalid json', () => {
    expect(() => parseWorkspaceFile('{not json')).toThrow()
  })
  it('throws on a non-array workspaces', () => {
    expect(() => parseWorkspaceFile(JSON.stringify({ version: 1, scope: 'one', workspaces: {} }))).toThrow()
  })
  it('throws on an invalid scope', () => {
    expect(() => parseWorkspaceFile(JSON.stringify({ version: 1, scope: 'nope', workspaces: [] }))).toThrow()
  })
  it('throws when a workspace has no tabs array', () => {
    expect(() => parseWorkspaceFile(JSON.stringify({ version: 1, scope: 'one', workspaces: [{ tabs: 5 }] }))).toThrow()
  })
  it('throws when a pane is structurally broken (missing cwd)', () => {
    const doc = { version: 1, scope: 'one', workspaces: [{ tabs: [{ tab: 1, tree: null, panes: [{ id: 'p0', kind: 'shell', ord: 0, scrollback: '' }] }] }] }
    expect(() => parseWorkspaceFile(JSON.stringify(doc))).toThrow()
  })
  it('throws when a tree is a malformed Node', () => {
    const doc = { version: 1, scope: 'one', workspaces: [{ tabs: [{ tab: 1, tree: { kind: 'bogus' }, panes: [] }] }] }
    expect(() => parseWorkspaceFile(JSON.stringify(doc))).toThrow()
  })
})

describe('parse shape-guards (drop malformed optionals silently)', () => {
  it('drops a non-string ws label and non-array tabOrder', () => {
    const doc = { version: 1, scope: 'one', workspaces: [{ label: 42, tabOrder: 'x', tabs: [{ tab: 1, tree: null, panes: [] }] }] }
    const ws = parseWorkspaceFile(JSON.stringify(doc)).workspaces[0]!
    expect(ws.label).toBeUndefined()
    expect(ws.tabOrder).toBeUndefined()
  })
  it('filters non-number entries out of tabOrder', () => {
    const doc = { version: 1, scope: 'one', workspaces: [{ tabOrder: [2, 'x', 1, null], tabs: [{ tab: 1, tree: null, panes: [] }] }] }
    expect(parseWorkspaceFile(JSON.stringify(doc)).workspaces[0]!.tabOrder).toEqual([2, 1])
  })
  it('drops a non-string tab label and a non-string frozenNote', () => {
    const doc = { version: 1, scope: 'one', workspaces: [{ tabs: [{ tab: 1, label: 9, tree: null, panes: [{ id: 'p0', kind: 'shell', cwd: '/a', ord: 0, frozenNote: 5, scrollback: '' }] }] }] }
    const tab = parseWorkspaceFile(JSON.stringify(doc)).workspaces[0]!.tabs[0]!
    expect(tab.label).toBeUndefined()
    expect(tab.panes[0]!.frozenNote).toBeUndefined()
  })
  it('keeps an empty-string frozenNote (presence = frozen)', () => {
    const doc = { version: 1, scope: 'one', workspaces: [{ tabs: [{ tab: 1, tree: null, panes: [{ id: 'p0', kind: 'shell', cwd: '/a', ord: 0, frozenNote: '', scrollback: '' }] }] }] }
    expect(parseWorkspaceFile(JSON.stringify(doc)).workspaces[0]!.tabs[0]!.panes[0]!.frozenNote).toBe('')
  })
})

describe('placeholder rewrites', () => {
  const tree: Node = { kind: 'split', dir: 'v', ratio: 0.5, a: { kind: 'leaf', paneId: 'amber-1-1-0-a' }, b: { kind: 'leaf', paneId: 'amber-1-1-1-b' } }
  it('rewrites live names → placeholders and back', () => {
    const nameToId = { 'amber-1-1-0-a': 'p0', 'amber-1-1-1-b': 'p1' }
    const placeholders = treeToPlaceholders(tree, nameToId)
    expect(placeholders).toEqual({ kind: 'split', dir: 'v', ratio: 0.5, a: { kind: 'leaf', paneId: 'p0' }, b: { kind: 'leaf', paneId: 'p1' } })
    const idToName = { p0: 'amber-9-1-0-z', p1: 'amber-9-1-1-y' }
    const back = treeFromPlaceholders(placeholders, idToName)
    expect(back).toEqual({ kind: 'split', dir: 'v', ratio: 0.5, a: { kind: 'leaf', paneId: 'amber-9-1-0-z' }, b: { kind: 'leaf', paneId: 'amber-9-1-1-y' } })
  })
  it('handles a null tree in both directions', () => {
    expect(treeToPlaceholders(null, {})).toBeNull()
    expect(treeFromPlaceholders(null, {})).toBeNull()
  })
  it('drops an unmapped leaf and collapses the split (write-clean)', () => {
    const t: Node = { kind: 'split', dir: 'h', ratio: 0.5, a: { kind: 'leaf', paneId: 'p0' }, b: { kind: 'leaf', paneId: 'p5' } }
    // Only p0 maps → sibling p5 dropped, split collapses to the surviving leaf.
    expect(treeFromPlaceholders(t, { p0: 'amber-1-1-0-a' })).toEqual({ kind: 'leaf', paneId: 'amber-1-1-0-a' })
  })
  it('reduces a tree with no mapped leaves to null', () => {
    const t: Node = { kind: 'split', dir: 'v', ratio: 0.5, a: { kind: 'leaf', paneId: 'p0' }, b: { kind: 'leaf', paneId: 'p1' } }
    expect(treeFromPlaceholders(t, {})).toBeNull()
  })
})

// Deterministic id minter for load-plan tests.
function mkMint(): () => string {
  let n = 0
  return () => `id${n++}`
}

describe('assembleSave', () => {
  const sidecar: LayoutFile = {
    version: 1,
    activeWorkspace: 1,
    workspaces: {
      '1': {
        activeTab: 1,
        label: 'backend',
        tabOrder: [2, 1],
        tabs: {
          '1': { tree: { kind: 'split', dir: 'h', ratio: 0.5, a: { kind: 'leaf', paneId: 'amber-1-1-0-a' }, b: { kind: 'leaf', paneId: 'amber-1-1-1-b' } }, label: 'edit' },
          '2': { tree: null },
        },
      },
    },
    frozen: { 'amber-1-1-1-b': { note: 'brb' } },
  }
  const live: SaveWorkspace[] = [
    {
      ws: 1,
      tabs: [
        { tab: 1, panes: [{ name: 'amber-1-1-0-a', cwd: '/a', kind: 'shell', ord: 0 }, { name: 'amber-1-1-1-b', cwd: '/b', kind: 'claude', ord: 1 }] },
        { tab: 2, panes: [{ name: 'amber-1-2-0-c', cwd: '/c', kind: 'shell', ord: 0 }] },
      ],
    },
  ]

  it('builds a doc from live groupings + sidecar + dumps', () => {
    const dumps = { 'amber-1-1-0-a': new Uint8Array([65, 66]) }
    const doc = assembleSave('one', live, sidecar, dumps)
    expect(doc.version).toBe(WORKSPACE_VERSION)
    expect(doc.scope).toBe('one')
    expect(doc.workspaces).toHaveLength(1)
    const ws = doc.workspaces[0]!
    expect(ws.label).toBe('backend')
    expect(ws.tabOrder).toEqual([2, 1])
    const t1 = ws.tabs[0]!
    expect(t1.label).toBe('edit')
    // Tree leaves rewritten to placeholders p0/p1 in pane order.
    expect(t1.tree).toEqual({ kind: 'split', dir: 'h', ratio: 0.5, a: { kind: 'leaf', paneId: 'p0' }, b: { kind: 'leaf', paneId: 'p1' } })
    expect(t1.panes.map((p) => p.id)).toEqual(['p0', 'p1'])
    expect(t1.panes[0]!.scrollback).not.toBe('') // has a dump
    expect(t1.panes[1]!.scrollback).toBe('')     // no dump → empty
    // Frozen pane carries frozenNote.
    expect(t1.panes[1]!.frozenNote).toBe('brb')
    expect(t1.panes[0]!.frozenNote).toBeUndefined()
  })

  it('drops a sidecar tree leaf naming a session absent from live panes (no raw-name leak)', () => {
    const sc: LayoutFile = {
      version: 1, activeWorkspace: 1,
      workspaces: { '1': { activeTab: 1, tabs: { '1': { tree: { kind: 'split', dir: 'h', ratio: 0.5, a: { kind: 'leaf', paneId: 'amber-1-1-0-a' }, b: { kind: 'leaf', paneId: 'amber-1-1-9-gone' } } } } } },
    }
    // Only pane -a is live; the stale -gone leaf must not leak into the file.
    const doc = assembleSave('one', [{ ws: 1, tabs: [{ tab: 1, panes: [{ name: 'amber-1-1-0-a', cwd: '/a', kind: 'shell', ord: 0 }] }] }], sc, {})
    expect(doc.workspaces[0]!.tabs[0]!.tree).toEqual({ kind: 'leaf', paneId: 'p0' })
  })

  it('encodes a noteless-frozen pane as an empty-string frozenNote', () => {
    const sc: LayoutFile = { version: 1, activeWorkspace: 1, workspaces: {}, frozen: { 'amber-1-1-0-a': {} } }
    const doc = assembleSave('one', [{ ws: 1, tabs: [{ tab: 1, panes: [{ name: 'amber-1-1-0-a', cwd: '/a', kind: 'shell', ord: 0 }] }] }], sc, {})
    expect(doc.workspaces[0]!.tabs[0]!.panes[0]!.frozenNote).toBe('')
  })

  it('serializes multiple workspaces for scope all', () => {
    const multi: SaveWorkspace[] = [
      { ws: 1, tabs: [{ tab: 1, panes: [{ name: 'amber-1-1-0-a', cwd: '/a', kind: 'shell', ord: 0 }] }] },
      { ws: 2, tabs: [{ tab: 1, panes: [{ name: 'amber-2-1-0-b', cwd: '/b', kind: 'shell', ord: 0 }] }] },
    ]
    const doc = assembleSave('all', multi, { version: 1, activeWorkspace: 1, workspaces: {} }, {})
    expect(doc.scope).toBe('all')
    expect(doc.workspaces).toHaveLength(2)
  })
})

describe('buildLoadPlan', () => {
  it('mints names, rewrites trees, and emits sidecar + scrollback for mode new', () => {
    const doc = assembleSave(
      'one',
      [{ ws: 1, tabs: [{ tab: 1, panes: [{ name: 'amber-1-1-0-a', cwd: '/a', kind: 'shell', ord: 0 }, { name: 'amber-1-1-1-b', cwd: '/b', kind: 'claude', ord: 1 }] }] }],
      {
        version: 1, activeWorkspace: 1,
        workspaces: { '1': { activeTab: 1, label: 'be', tabs: { '1': { tree: { kind: 'split', dir: 'h', ratio: 0.5, a: { kind: 'leaf', paneId: 'amber-1-1-0-a' }, b: { kind: 'leaf', paneId: 'amber-1-1-1-b' } } } } } },
        frozen: { 'amber-1-1-1-b': { note: 'brb' } },
      },
      { 'amber-1-1-0-a': new Uint8Array([1, 2, 3]) },
    )
    const plan = buildLoadPlan(doc, { mode: 'new', nextWs: 7, mintId: mkMint() })
    expect(plan.targetWorkspaces).toEqual([7])
    // Two creates with minted names in ws 7.
    expect(plan.creates.map((c) => c.name)).toEqual(['amber-7-1-0-id0', 'amber-7-1-1-id1'])
    expect(plan.creates.map((c) => c.kind)).toEqual(['shell', 'claude'])
    expect(plan.creates.map((c) => c.cwd)).toEqual(['/a', '/b'])
    // Sidecar tree rewritten to real minted names.
    const ws = plan.workspaces['7']!
    expect(ws.label).toBe('be')
    expect(ws.activeTab).toBe(1)
    expect(ws.tabs['1']!.tree).toEqual({ kind: 'split', dir: 'h', ratio: 0.5, a: { kind: 'leaf', paneId: 'amber-7-1-0-id0' }, b: { kind: 'leaf', paneId: 'amber-7-1-1-id1' } })
    // Frozen entry keyed by the minted name.
    expect(plan.frozen).toEqual({ 'amber-7-1-1-id1': { note: 'brb' } })
    // Scrollback keyed by minted name; missing dump omitted.
    expect(Object.keys(plan.scrollback)).toEqual(['amber-7-1-0-id0'])
    expect(Array.from(plan.scrollback['amber-7-1-0-id0']!)).toEqual([1, 2, 3])
  })

  it('reuses the target ws for mode replace', () => {
    const doc = assembleSave('one', [{ ws: 1, tabs: [{ tab: 1, panes: [{ name: 'amber-1-1-0-a', cwd: '/a', kind: 'shell', ord: 0 }] }] }], { version: 1, activeWorkspace: 1, workspaces: {} }, {})
    const plan = buildLoadPlan(doc, { mode: 'replace', ws: 3, mintId: mkMint() })
    expect(plan.targetWorkspaces).toEqual([3])
    expect(plan.creates[0]!.name).toBe('amber-3-1-0-id0')
  })

  it('assigns consecutive ws numbers for a multi-workspace all-scope load', () => {
    const doc = assembleSave(
      'all',
      [
        { ws: 1, tabs: [{ tab: 1, panes: [{ name: 'amber-1-1-0-a', cwd: '/a', kind: 'shell', ord: 0 }] }] },
        { ws: 5, tabs: [{ tab: 1, panes: [{ name: 'amber-5-1-0-b', cwd: '/b', kind: 'shell', ord: 0 }] }] },
      ],
      { version: 1, activeWorkspace: 1, workspaces: {} },
      {},
    )
    const plan = buildLoadPlan(doc, { mode: 'new', nextWs: 10, mintId: mkMint() })
    expect(plan.targetWorkspaces).toEqual([10, 11])
    expect(plan.creates.map((c) => c.name)).toEqual(['amber-10-1-0-id0', 'amber-11-1-0-id1'])
    expect(Object.keys(plan.workspaces).sort()).toEqual(['10', '11'])
  })

  it('encodes an empty-string frozenNote back to a noteless frozen entry', () => {
    const doc: WorkspaceDoc = {
      version: 1, scope: 'one',
      workspaces: [{ tabs: [{ tab: 1, tree: null, panes: [{ id: 'p0', kind: 'shell', cwd: '/a', ord: 0, frozenNote: '', scrollback: '' }] }] }],
    }
    const plan = buildLoadPlan(doc, { mode: 'new', nextWs: 1, mintId: mkMint() })
    expect(plan.frozen).toEqual({ 'amber-1-1-0-id0': {} })
  })

  it('drops a dangling tree leaf on load (placeholder with no pane)', () => {
    const doc: WorkspaceDoc = {
      version: 1, scope: 'one',
      workspaces: [{ tabs: [{ tab: 1, tree: { kind: 'split', dir: 'h', ratio: 0.5, a: { kind: 'leaf', paneId: 'p0' }, b: { kind: 'leaf', paneId: 'p5' } }, panes: [{ id: 'p0', kind: 'shell', cwd: '/a', ord: 0, scrollback: '' }] }] }],
    }
    const plan = buildLoadPlan(doc, { mode: 'new', nextWs: 1, mintId: mkMint() })
    // p5 has no pane → dropped; tree collapses to the one real leaf, no 'p5' leak.
    expect(plan.workspaces['1']!.tabs['1']!.tree).toEqual({ kind: 'leaf', paneId: 'amber-1-1-0-id0' })
  })

  it('keeps a null tab tree null (renderer reconciles it to equal splits)', () => {
    const doc: WorkspaceDoc = {
      version: 1, scope: 'one',
      workspaces: [{ tabs: [{ tab: 1, tree: null, panes: [{ id: 'p0', kind: 'shell', cwd: '/a', ord: 0, scrollback: '' }, { id: 'p1', kind: 'shell', cwd: '/b', ord: 1, scrollback: '' }] }] }],
    }
    const plan = buildLoadPlan(doc, { mode: 'new', nextWs: 1, mintId: mkMint() })
    expect(plan.workspaces['1']!.tabs['1']!.tree).toBeNull()
    // Panes still created so the renderer can reconstruct the grouping.
    expect(plan.creates.map((c) => c.name)).toEqual(['amber-1-1-0-id0', 'amber-1-1-1-id1'])
  })
})

describe('nextFreeWs', () => {
  it('is max+1, never reuses gaps', () => {
    expect(nextFreeWs([1, 3, 4])).toBe(5) // gap at 2 not reused
    expect(nextFreeWs([2])).toBe(3)
    expect(nextFreeWs([])).toBe(1)
  })
})

// One-pane-per-workspace doc, N workspaces, for targeting assertions.
function multiWsDoc(n: number): WorkspaceDoc {
  return {
    version: 1, scope: 'all',
    workspaces: Array.from({ length: n }, (_, i) => ({
      tabs: [{ tab: 1, tree: null, panes: [{ id: 'p0', kind: 'shell', cwd: `/w${i}`, ord: 0, scrollback: '' }] }],
    })),
  }
}

describe('planLoad', () => {
  it('new mode: every file workspace lands above max live ws, in doc order', () => {
    const plan = planLoad(multiWsDoc(2), { mode: 'new', currentWs: 1, liveWs: [1, 3, 4], mintId: mkMint() })
    expect(plan.targetWorkspaces).toEqual([5, 6]) // max(4)+1, +2
  })

  it('replace mode single-ws file: reuses the current workspace number', () => {
    const plan = planLoad(multiWsDoc(1), { mode: 'replace', currentWs: 3, liveWs: [1, 3, 4], mintId: mkMint() })
    expect(plan.targetWorkspaces).toEqual([3])
  })

  it('replace mode multi-ws file: first replaces current, rest are new above max', () => {
    // DECIDED policy: first→currentWs, remaining→genuinely free numbers (max+1…).
    const plan = planLoad(multiWsDoc(3), { mode: 'replace', currentWs: 3, liveWs: [1, 3, 4], mintId: mkMint() })
    expect(plan.targetWorkspaces).toEqual([3, 5, 6])
    // Every created pane's name encodes its target ws — no collision with live.
    const wsOf = (name: string): number => Number(name.split('-')[1])
    expect(plan.creates.map((c) => wsOf(c.name))).toEqual([3, 5, 6])
  })

  it('empty file → empty plan (no creates)', () => {
    const plan = planLoad(multiWsDoc(0), { mode: 'replace', currentWs: 2, liveWs: [1, 2], mintId: mkMint() })
    expect(plan.creates).toEqual([])
    expect(plan.targetWorkspaces).toEqual([])
  })
})
