import { describe, expect, it } from 'vitest'
import { deriveActiveBrowserId, bindRendererBrowserCommand, removedBrowserIds } from './browserAssociationAuthority'
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
  it('fails closed without an active association', () => {
    expect(() => bindRendererBrowserCommand(null, { type: 'status', id: other })).toThrow('NO_BROWSER_FOR_TAB')
  })
})
