import { describe, it, expect } from 'vitest'
import { emptyLayout, parseLayout, serializeLayout, orderTabs, moveTab, LAYOUT_VERSION } from './layoutFile'

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
