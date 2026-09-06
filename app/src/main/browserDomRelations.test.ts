import { describe, expect, it } from 'vitest'
import { BrowserDomRelations } from './browserDomRelations'

describe('bounded protocol DOM ancestry', () => {
  it('recognizes a real nested hit from setChildNodes, without describeNode parentIds', () => {
    const tree = new BrowserDomRelations()
    tree.onMessage('DOM.setChildNodes', { parentId: 5, nodes: [{ nodeId: 6, backendNodeId: 70 }] })
    tree.onMessage('DOM.setChildNodes', { parentId: 6, nodes: [{ nodeId: 7, backendNodeId: 80,
      children: [{ nodeId: 8, backendNodeId: 90 }] }] })
    expect(tree.isWithin(8, 70)).toBe(true)
    expect(tree.isWithin(7, 70)).toBe(true)
    expect(tree.isWithin(8, 99)).toBe(false)
    expect(tree.parentOf(7)).toBe(6)
  })

  it('does not accept a covering sibling as a target descendant', () => {
    const tree = new BrowserDomRelations()
    tree.onMessage('DOM.setChildNodes', { parentId: 5, nodes: [
      { nodeId: 6, backendNodeId: 70 }, { nodeId: 7, backendNodeId: 80 },
    ] })
    expect(tree.isWithin(7, 70)).toBe(false)
  })

  it('tracks author-shadow descendants without crossing contentDocument boundaries', () => {
    const tree = new BrowserDomRelations()
    tree.onMessage('DOM.setChildNodes', { parentId: 1, nodes: [{ nodeId: 2, backendNodeId: 20,
      shadowRoots: [{ nodeId: 3, backendNodeId: 30, children: [{ nodeId: 4, backendNodeId: 40 }] }],
      contentDocument: { nodeId: 5, backendNodeId: 50, children: [{ nodeId: 6, backendNodeId: 60 }] },
    }] })
    expect(tree.isWithin(4, 20)).toBe(true)
    expect(tree.isWithin(6, 20)).toBe(false)
    tree.onMessage('DOM.shadowRootPopped', { hostId: 2, rootId: 3 })
    expect(tree.isWithin(4, 20)).toBe(false)
  })

  it('removes detached branches and follows inserted/moved nodes only at the new parent', () => {
    const tree = new BrowserDomRelations()
    tree.onMessage('DOM.setChildNodes', { parentId: 1, nodes: [
      { nodeId: 2, backendNodeId: 20, children: [{ nodeId: 3, backendNodeId: 30 }] },
      { nodeId: 4, backendNodeId: 40 },
    ] })
    tree.onMessage('DOM.childNodeRemoved', { parentNodeId: 1, nodeId: 2 })
    expect(tree.isWithin(3, 20)).toBe(false)
    tree.onMessage('DOM.childNodeInserted', { parentNodeId: 4, node: { nodeId: 3, backendNodeId: 30 } })
    expect(tree.isWithin(3, 40)).toBe(true)
    expect(tree.isWithin(3, 20)).toBe(false)
  })

  it('forgets document identities before IDs can be reused', () => {
    const tree = new BrowserDomRelations()
    tree.onMessage('DOM.setChildNodes', { parentId: 1, nodes: [{ nodeId: 2, backendNodeId: 20 }] })
    tree.onMessage('DOM.documentUpdated', {})
    expect(tree.isWithin(2, 20)).toBe(false)
    tree.onMessage('DOM.setChildNodes', { parentId: 1, nodes: [{ nodeId: 2, backendNodeId: 99 }] })
    expect(tree.isWithin(2, 20)).toBe(false)
    expect(tree.isWithin(2, 99)).toBe(true)
  })

  it('fails closed on budget exhaustion and recovers only after a fresh document', () => {
    const tree = new BrowserDomRelations(2)
    tree.onMessage('DOM.setChildNodes', { parentId: 1, nodes: [
      { nodeId: 2, backendNodeId: 20 }, { nodeId: 3, backendNodeId: 30 }, { nodeId: 4, backendNodeId: 40 },
    ] })
    expect(tree.isWithin(2, 20)).toBe(false)
    tree.onMessage('DOM.childNodeInserted', { parentNodeId: 1, node: { nodeId: 5, backendNodeId: 50 } })
    expect(tree.isWithin(5, 50)).toBe(false)
    tree.onMessage('DOM.documentUpdated', {})
    tree.onMessage('DOM.setChildNodes', { parentId: 1, nodes: [{ nodeId: 2, backendNodeId: 20 }] })
    expect(tree.isWithin(2, 20)).toBe(true)
  })

  it('bounds cycles and ignores malformed identities', () => {
    const tree = new BrowserDomRelations()
    tree.onMessage('DOM.setChildNodes', { parentId: 1, nodes: [{ nodeId: 2, backendNodeId: 20,
      children: [{ nodeId: 1, backendNodeId: 10 }] }, { nodeId: NaN, backendNodeId: 99 }] })
    expect(tree.isWithin(2, 999)).toBe(false)
    expect(tree.isWithin(NaN, 99)).toBe(false)
  })
})
