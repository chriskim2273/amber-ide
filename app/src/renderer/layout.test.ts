import { describe, it, expect } from 'vitest'
import { leaves, splitLeaf, removeLeaf, setRatio, paneRects, equalColumns, reconcile, moveLeaf, type Node } from './layout'

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

  describe('moveLeaf', () => {
    // a | (b / c): 'a' beside a vertical split of 'b' over 'c'
    const tree = (): Node => ({
      kind: 'split', dir: 'h', ratio: 0.5,
      a: leaf('a'),
      b: { kind: 'split', dir: 'v', ratio: 0.5, a: leaf('b'), b: leaf('c') },
    })

    it('drop on self is a no-op', () => {
      const t = tree()
      expect(moveLeaf(t, 'a', 'a', 'right')).toEqual(t)
      expect(moveLeaf(t, 'b', 'b', 'center')).toEqual(t)
    })

    it('center swaps the two panes, leaving structure intact', () => {
      const r = moveLeaf(tree(), 'a', 'c', 'center')
      expect(r).toEqual({
        kind: 'split', dir: 'h', ratio: 0.5,
        a: leaf('c'),
        b: { kind: 'split', dir: 'v', ratio: 0.5, a: leaf('b'), b: leaf('a') },
      })
    })

    it('right zone splits the target h with source on the far side', () => {
      // move 'a' onto 'b' right: 'a' removed, 'b' becomes (b | a)
      const r = moveLeaf(tree(), 'a', 'b', 'right')
      expect(r).toEqual({
        kind: 'split', dir: 'v', ratio: 0.5,
        a: { kind: 'split', dir: 'h', ratio: 0.5, a: leaf('b'), b: leaf('a') },
        b: leaf('c'),
      })
    })

    it('left zone splits the target h with source on the near side', () => {
      const r = moveLeaf(tree(), 'c', 'a', 'left')
      // 'c' removed (its parent collapses to 'b'), 'a' becomes (c | a)
      expect(r).toEqual({
        kind: 'split', dir: 'h', ratio: 0.5,
        a: { kind: 'split', dir: 'h', ratio: 0.5, a: leaf('c'), b: leaf('a') },
        b: leaf('b'),
      })
    })

    it('top zone splits the target v with source above', () => {
      const r = moveLeaf(tree(), 'a', 'c', 'top')
      expect(r).toEqual({
        kind: 'split', dir: 'v', ratio: 0.5,
        a: leaf('b'),
        b: { kind: 'split', dir: 'v', ratio: 0.5, a: leaf('a'), b: leaf('c') },
      })
    })

    it('bottom zone splits the target v with source below', () => {
      const r = moveLeaf(tree(), 'a', 'c', 'bottom')
      expect(r).toEqual({
        kind: 'split', dir: 'v', ratio: 0.5,
        a: leaf('b'),
        b: { kind: 'split', dir: 'v', ratio: 0.5, a: leaf('c'), b: leaf('a') },
      })
    })

    it('preserves the leaf set for every zone (reconcile stays a no-op)', () => {
      for (const zone of ['left', 'right', 'top', 'bottom', 'center'] as const) {
        const r = moveLeaf(tree(), 'a', 'c', zone)
        expect(leaves(r).sort()).toEqual(['a', 'b', 'c'])
      }
    })
  })
})
