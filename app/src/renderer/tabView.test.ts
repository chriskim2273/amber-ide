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
