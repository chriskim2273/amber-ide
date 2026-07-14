import { describe, it, expect } from 'vitest'
import { emptyLayout, parseLayout, serializeLayout, LAYOUT_VERSION } from './layoutFile'

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
})
