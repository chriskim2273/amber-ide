import { describe, expect, it } from 'vitest'
import { applyBrowserRailAssociation, browserAuthorityChanged, deriveActiveBrowserId, bindRendererBrowserCommand, removedBrowserIds } from './browserAssociationAuthority'
import type { LayoutFile } from '../shared/layoutFile'

const id = 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const other = 'browser-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const layout: LayoutFile = { version: 2, activeWorkspace: 1, workspaces: { '1': { activeTab: 2, tabs: { '2': { tree: null, browser: { id, width: 420, collapsed: false } } } } } }

describe('renderer browser association authority', () => {
  it('derives the active browser only from main-owned window layout context', () => {
    expect(deriveActiveBrowserId(layout)).toBe(id)
    expect(deriveActiveBrowserId({ ...layout, activeWorkspace: 9 })).toBeNull()
  })
  it('replaces renderer supplied ids with the sender WindowCtx association', () => {
    expect(bindRendererBrowserCommand(id, { type: 'status', id: other })).toEqual({ type: 'status', id })
    expect(bindRendererBrowserCommand(id, { type: 'open' })).toEqual({ type: 'open' })
  })
  it('finds only associations removed by a committed replacement', () => {
    const before: LayoutFile = { ...layout, workspaces: { '1': { activeTab: 2, tabs: {
      '1': { tree: null, browser: { id: other, width: 420, collapsed: false } },
      '2': { tree: null, browser: { id, width: 420, collapsed: false } },
    } } } }
    const after: LayoutFile = { ...layout, workspaces: { '1': { activeTab: 1, tabs: {
      '1': { tree: null, browser: { id, width: 420, collapsed: false } },
    } } } }
    expect(removedBrowserIds(before, after)).toEqual([other])
  })
  it('detects structural association and sharing changes without trusting revisions or geometry', () => {
    const changed = structuredClone(layout)
    changed.workspaces['1']!.tabs['2']!.browser!.sharedWithPi = true
    expect(browserAuthorityChanged(layout, changed)).toBe(true)
    changed.workspaces['1']!.tabs['2']!.browser!.sharedWithPi = false
    changed.workspaces['1']!.tabs['2']!.browser!.width = 700
    changed.browserRevision = 99
    expect(browserAuthorityChanged(layout, changed)).toBe(false)
  })
  it('fails closed without an active association', () => {
    expect(() => bindRendererBrowserCommand(null, { type: 'status', id: other })).toThrow('NO_BROWSER_FOR_TAB')
  })
  it('does not treat Full access as a broker authority change', () => {
    const changed = structuredClone(layout)
    changed.workspaces['1']!.tabs['2']!.browser!.fullAccess = true
    expect(browserAuthorityChanged(layout, changed)).toBe(false)
  })
  it('applies Full access only for a designated shared controller and clears it on unshare or redesignate', () => {
    const privateRail = { id, width: 420, collapsed: false }
    expect(() => applyBrowserRailAssociation(privateRail, { type: 'fullAccess', fullAccess: true })).toThrow('NOT_DESIGNATED_CONTROLLER')
    expect(() => applyBrowserRailAssociation({ ...privateRail, designatedPi: 'amber-1-1-0-pi' }, { type: 'fullAccess', fullAccess: true })).toThrow('NOT_SHARED')
    const shared = applyBrowserRailAssociation({ ...privateRail, designatedPi: 'amber-1-1-0-pi' }, { type: 'share', sharedWithPi: true })
    expect(shared).toMatchObject({ designatedPi: 'amber-1-1-0-pi', sharedWithPi: true })
    expect(shared).not.toHaveProperty('fullAccess')
    const granted = applyBrowserRailAssociation(shared, { type: 'fullAccess', fullAccess: true })
    expect(granted.fullAccess).toBe(true)
    expect(applyBrowserRailAssociation(granted, { type: 'share', sharedWithPi: false })).not.toHaveProperty('fullAccess')
    expect(applyBrowserRailAssociation(granted, { type: 'designate' })).not.toHaveProperty('fullAccess')
    expect(bindRendererBrowserCommand(id, { type: 'fullAccess', fullAccess: true })).toEqual({ type: 'fullAccess', fullAccess: true })
  })
})
