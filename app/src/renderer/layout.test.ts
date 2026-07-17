import { describe, it, expect } from 'vitest'
import { leaves, splitLeaf, removeLeaf, setRatio, ratioAt, paneRects, equalColumns, reconcile, moveLeaf, nextPaneInDirection, type Node } from './layout'

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
  it('ratioAt reads the ratio at a path and returns null off a split', () => {
    const inner: Node = { kind: 'split', dir: 'v', ratio: 0.4, a: leaf('b'), b: leaf('c') }
    const t: Node = { kind: 'split', dir: 'h', ratio: 0.25, a: leaf('a'), b: inner }
    expect(ratioAt(t, [])).toBeCloseTo(0.25)
    expect(ratioAt(t, ['b'])).toBeCloseTo(0.4)
    expect(ratioAt(t, ['a'])).toBeNull() // lands on a leaf
    expect(ratioAt(leaf('a'), [])).toBeNull() // not a split
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

  // Fix 4: close is one-way. onClose only requests the kill; the leaf must
  // survive reconcile until the daemon confirms removal (id leaves liveIds).
  it('close-then-confirm: leaf stays until the daemon prunes the session', () => {
    const t = equalColumns(['a', 'b'])!
    // Kill requested for 'b' but the daemon has NOT confirmed: it is still live.
    expect(leaves(reconcile(t, ['a', 'b'])!).sort()).toEqual(['a', 'b'])
    // Daemon confirms removal -> 'b' gone from liveIds -> reconcile drops it,
    // and does NOT re-append it.
    expect(reconcile(t, ['a'])).toEqual(leaf('a'))
  })

  // Documents the bug the fix removes: optimistically removing the leaf while
  // the id is still live makes reconcile re-append it as a fresh right-split.
  it('optimistic local removal races reconcile back into a right-split', () => {
    const t = equalColumns(['a', 'b'])!
    const optimistic = removeLeaf(t, 'b') // what onClose used to do locally
    expect(leaves(optimistic!)).toEqual(['a'])
    // 'b' still live (daemon unconfirmed) -> reconcile treats it as missing and
    // re-appends it: the pane reappears, mispositioned.
    expect(leaves(reconcile(optimistic, ['a', 'b'])!).sort()).toEqual(['a', 'b'])
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

  describe('nextPaneInDirection', () => {
    // 2x2 grid of unit panes; centers at (25,25) (75,25) (25,75) (75,75).
    const grid = [
      { paneId: 'a', rect: { x: 0, y: 0, w: 50, h: 50 } },
      { paneId: 'b', rect: { x: 50, y: 0, w: 50, h: 50 } },
      { paneId: 'c', rect: { x: 0, y: 50, w: 50, h: 50 } },
      { paneId: 'd', rect: { x: 50, y: 50, w: 50, h: 50 } },
    ]

    it('moves to the adjacent pane in each direction', () => {
      expect(nextPaneInDirection(grid, 'a', 'right')).toBe('b')
      expect(nextPaneInDirection(grid, 'a', 'down')).toBe('c')
      expect(nextPaneInDirection(grid, 'd', 'left')).toBe('c')
      expect(nextPaneInDirection(grid, 'd', 'up')).toBe('b')
    })

    it('no-ops at an edge (returns null)', () => {
      expect(nextPaneInDirection(grid, 'a', 'left')).toBeNull()
      expect(nextPaneInDirection(grid, 'a', 'up')).toBeNull()
      expect(nextPaneInDirection(grid, 'd', 'right')).toBeNull()
      expect(nextPaneInDirection(grid, 'd', 'down')).toBeNull()
    })

    it('tie-breaks on secondary-axis distance (nearest on the cross axis wins)', () => {
      // Two panes to the right of the source at equal primary distance; the one
      // sharing the source row (smaller secondary distance) wins.
      const rects = [
        { paneId: 'src', rect: { x: 0, y: 0, w: 40, h: 40 } },       // center (20,20)
        { paneId: 'same-row', rect: { x: 60, y: 0, w: 40, h: 40 } }, // center (80,20)
        { paneId: 'far-row', rect: { x: 60, y: 100, w: 40, h: 40 } },// center (80,120)
      ]
      expect(nextPaneInDirection(rects, 'src', 'right')).toBe('same-row')
    })

    it('returns null for an unknown source', () => {
      expect(nextPaneInDirection(grid, 'z', 'right')).toBeNull()
    })

    it('returns null when only the source exists', () => {
      expect(nextPaneInDirection([grid[0]!], 'a', 'right')).toBeNull()
    })
  })
})
