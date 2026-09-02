import { describe, expect, it } from 'vitest'
import { resolveBrowserContext } from './browserWindowContext'

const layout = { version: 2, activeWorkspace: 1, workspaces: {
  '1': { activeTab: 1, tabs: { '1': { tree: null } } },
  '2': { activeTab: 3, tabs: { '3': { tree: null, browser: { id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', width: 420, collapsed: false } } } },
} }

describe('resolveBrowserContext', () => {
  it('acknowledges the sender-announced tab rather than the sidecar active fields', () => {
    expect(resolveBrowserContext(layout, 2, 3)).toEqual({ workspace: 2, tab: 3, browserId: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
  })
  it('rejects coordinates that main cannot resolve', () => {
    expect(() => resolveBrowserContext(layout, 2, 9)).toThrow('NO_ACTIVE_TAB')
    expect(() => resolveBrowserContext(layout, 0, 1)).toThrow('INVALID_REQUEST')
  })
})
