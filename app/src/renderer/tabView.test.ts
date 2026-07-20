import { describe, it, expect } from 'vitest'
import { deriveTab, shortCwd } from './tabView'
import { leaves } from './layout'
import type { PaneModel } from './store'

const pane = (over: Partial<PaneModel> & { name: string }): PaneModel => ({
  cwd: '/home/u/proj', kind: 'shell', alive: true, ord: 0, deadCode: null, ...over,
})

describe('shortCwd', () => {
  it('collapses $HOME to ~', () => {
    expect(shortCwd('/home/u/proj', '/home/u')).toBe('~/proj')
    expect(shortCwd('/etc', '/home/u')).toBe('/etc')
    expect(shortCwd('/anything', '')).toBe('/anything')
  })
})

describe('deriveTab', () => {
  const home = '/home/u'

  it('titles a pane from its OSC title when present, else the short cwd', () => {
    const { paneMeta } = deriveTab(
      [pane({ name: 'a', cwd: '/home/u/proj' }), pane({ name: 'b', cwd: '/home/u/x' })],
      null, {}, { a: 'vim' }, home,
    )
    expect(paneMeta.a!.title).toBe('vim · shell')      // OSC title wins
    expect(paneMeta.b!.title).toBe('~/x · shell')      // falls back to shortCwd
  })

  it('falls back to cwd when the OSC title is blank/whitespace', () => {
    const { paneMeta } = deriveTab([pane({ name: 'a', cwd: '/home/u/z' })], null, {}, { a: '  ' }, home)
    expect(paneMeta.a!.title).toBe('~/z · shell')
  })

  it('labels a shell-fallback claude pane distinctly', () => {
    const { paneMeta } = deriveTab(
      [pane({ name: 'c', kind: 'claude', runState: 'shell-fallback', cwd: '/home/u' })],
      null, {}, {}, home,
    )
    expect(paneMeta.c!.title).toBe('~ · shell (claude exited)')
  })

  it('records deadCodes only for exited panes', () => {
    const { deadCodes } = deriveTab(
      [pane({ name: 'a' }), pane({ name: 'b', deadCode: 130 }), pane({ name: 'c', deadCode: 0 })],
      null, {}, {}, home,
    )
    expect(deadCodes).toEqual({ b: 130, c: 0 })   // note: code 0 IS recorded (not null)
  })

  it('holds pending-split names out of liveIds and the reconciled tree', () => {
    const { liveIds, tree } = deriveTab(
      [pane({ name: 'a' }), pane({ name: 'pending-1' })],
      null, { 'pending-1': { paneId: 'a', dir: 'h' } }, {}, home,
    )
    expect(liveIds).toEqual(['a'])
    expect(leaves(tree)).toEqual(['a'])            // pending pane not appended
  })

  it('reconciles the stored tree down to the live pane set', () => {
    const stored = { kind: 'leaf', paneId: 'a' } as const
    // 'a' persists; 'b' is new -> appended; there is no dead leaf to prune here.
    const { tree } = deriveTab([pane({ name: 'a' }), pane({ name: 'b' })], stored, {}, {}, home)
    expect(new Set(leaves(tree))).toEqual(new Set(['a', 'b']))
  })

  it('yields a null tree for an empty tab', () => {
    expect(deriveTab([], null, {}, {}, home).tree).toBeNull()
  })
})

// Cross-tab move of a BROWSER pane: its grouping lives only in the sidecar entry
// (id kept), so the source tab must drop the leaf purely from reconcile — the
// per-tab liveIds no longer list it — and the target tab must gain it.
describe('browser pane cross-tab move', () => {
  const bid = 'browser-1-1-0-abc'
  const stored = { kind: 'split', dir: 'h', ratio: 0.5, a: { kind: 'leaf', paneId: 'amber-1-1-0-x' }, b: { kind: 'leaf', paneId: bid } } as never
  it('source tab prunes the moved browser leaf', () => {
    const { tree } = deriveTab([pane({ name: 'amber-1-1-0-x' })], stored, {}, {}, '/home/u')
    expect(leaves(tree!)).toEqual(['amber-1-1-0-x'])
  })
  it('target tab gains it', () => {
    const { tree } = deriveTab([pane({ name: bid, kind: 'browser' })], null, {}, {}, '/home/u')
    expect(leaves(tree!)).toEqual([bid])
  })
})

// The pane header leads with the `amber ls` index so the user can jump to it
// with `amber attach <n>` from any terminal.
describe('deriveTab index prefix', () => {
  const idx = { 'amber-1-1-0-x': 3, 'amber-1-1-1-y': 7 }
  it('prefixes the daemon pane title with its ls index', () => {
    const { paneMeta } = deriveTab([pane({ name: 'amber-1-1-0-x' })], null, {}, {}, '/home/u', {}, idx)
    expect(paneMeta['amber-1-1-0-x']!.title).toBe('#3 ~/proj · shell')
  })
  it('keeps an OSC title but still leads with the index', () => {
    const { paneMeta } = deriveTab([pane({ name: 'amber-1-1-1-y' })], null,
      {}, { 'amber-1-1-1-y': 'vim README' }, '/home/u', {}, idx)
    expect(paneMeta['amber-1-1-1-y']!.title).toBe('#7 vim README · shell')
  })
  it('gives an app-local pane no index (it has no daemon session)', () => {
    const { paneMeta } = deriveTab([pane({ name: 'editor-1-1-0-z', kind: 'editor', cwd: '' })],
      null, {}, {}, '/home/u', {}, idx)
    expect(paneMeta['editor-1-1-0-z']!.title).toBe('untitled · editor')
  })
  it('omits the prefix when the index is unknown (session not in the list yet)', () => {
    const { paneMeta } = deriveTab([pane({ name: 'amber-9-9-9-new' })], null, {}, {}, '/home/u', {}, idx)
    expect(paneMeta['amber-9-9-9-new']!.title).toBe('~/proj · shell')
  })
})
