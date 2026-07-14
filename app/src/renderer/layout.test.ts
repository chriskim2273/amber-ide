import { describe, it, expect } from 'vitest'
import { leaves, splitLeaf, removeLeaf, setRatio, paneRects, equalColumns, reconcile, type Node } from './layout'

const leaf = (id: string): Node => ({ kind: 'leaf', paneId: id })

describe('layout', () => {
  it('splits a leaf into two', () => {
    const t = splitLeaf(leaf('a'), 'a', 'h', 'b')
    expect(leaves(t)).toEqual(['a', 'b'])
    expect(t).toEqual({ kind: 'split', dir: 'h', ratio: 0.5, a: leaf('a'), b: leaf('b') })
  })
  it('removes a leaf and collapses the parent to the sibling', () => {
    const t = splitLeaf(leaf('a'), 'a', 'h', 'b')
    expect(removeLeaf(t, 'a')).toEqual(leaf('b'))
    expect(removeLeaf(leaf('a'), 'a')).toBeNull()
  })
  it('setRatio updates the split on the given path', () => {
    const t = splitLeaf(leaf('a'), 'a', 'v', 'b')
    const t2 = setRatio(t, [], 0.3) as Extract<Node, { kind: 'split' }>
    expect(t2.ratio).toBeCloseTo(0.3)
  })
  it('paneRects tiles a horizontal split by ratio', () => {
    const t: Node = { kind: 'split', dir: 'h', ratio: 0.25, a: leaf('a'), b: leaf('b') }
    const r = paneRects(t, { x: 0, y: 0, w: 100, h: 40 })
    expect(r).toEqual([
      { paneId: 'a', rect: { x: 0, y: 0, w: 25, h: 40 } },
      { paneId: 'b', rect: { x: 25, y: 0, w: 75, h: 40 } },
    ])
  })
  it('equalColumns builds a fallback and reconcile prunes+appends', () => {
    const t = equalColumns(['a', 'b'])!
    expect(leaves(t)).toEqual(['a', 'b'])
    // dead 'a' pruned, new 'c' appended, 'b' kept
    const r = reconcile(t, ['b', 'c'])!
    expect(leaves(r).sort()).toEqual(['b', 'c'])
    expect(reconcile(t, [])).toBeNull()
    expect(reconcile(null, ['x'])).toEqual(leaf('x'))
  })
})
