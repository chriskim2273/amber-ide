import { describe, expect, it } from 'vitest'
import { browserContextMatches, captureBrowserContext, hasExactApprovalSurface, resolveBrowserContext, setBrowserForCurrentContext, type BrowserContextState } from './browserWindowContext'

const layout = { version: 2, activeWorkspace: 1, workspaces: {
  '1': { activeTab: 1, tabs: { '1': { tree: null } } },
  '2': { activeTab: 3, tabs: { '3': { tree: null, browser: { id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', width: 420, collapsed: false } } } },
} }

describe('resolveBrowserContext', () => {
  it('acknowledges the sender-announced tab rather than the sidecar active fields', () => {
    expect(resolveBrowserContext(layout, 2, 3)).toEqual({ workspace: 2, tab: 3, browserId: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
  })
  it('never lets a stale async completion overwrite a newer window context', () => {
    const state: BrowserContextState = { activeWorkspace: 1, activeTab: 1, activeBrowserId: null, browserContextGeneration: 4 }
    const lease = captureBrowserContext(state)
    state.activeWorkspace = 2; state.activeTab = 3; state.activeBrowserId = 'browser-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; state.browserContextGeneration += 1
    expect(browserContextMatches(state, lease)).toBe(false)
    expect(setBrowserForCurrentContext(state, lease, 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false)
    expect(state.activeBrowserId).toBe('browser-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
  })

  it('requires the exact owning browser to be visible and expanded for approvals', () => {
    const exact = { local: true, destroyed: false, visible: true, expanded: true, browserId: 'browser-a' }
    expect(hasExactApprovalSurface([exact], 'browser-a')).toBe(true)
    for (const changed of [{ visible: false }, { expanded: false }, { destroyed: true }, { local: false }, { browserId: 'browser-b' }]) expect(hasExactApprovalSurface([{ ...exact, ...changed }], 'browser-a')).toBe(false)
  })

  it('rejects coordinates that main cannot resolve', () => {
    expect(() => resolveBrowserContext(layout, 2, 9)).toThrow('NO_ACTIVE_TAB')
    expect(() => resolveBrowserContext(layout, 0, 1)).toThrow('INVALID_REQUEST')
  })
})
