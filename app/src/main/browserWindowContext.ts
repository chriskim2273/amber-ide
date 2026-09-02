import type { LayoutFile } from '../shared/layoutFile'

export interface ActiveBrowserContext { workspace: number; tab: number; browserId: string | null }
export interface BrowserContextState { activeWorkspace: number | null; activeTab: number | null; activeBrowserId: string | null; browserContextGeneration: number }
export interface BrowserContextLease { workspace: number; tab: number; browserId: string | null; generation: number }

export function captureBrowserContext(state: BrowserContextState): BrowserContextLease {
  if (state.activeWorkspace === null || state.activeTab === null) throw new Error('NO_ACTIVE_TAB')
  return { workspace: state.activeWorkspace, tab: state.activeTab, browserId: state.activeBrowserId, generation: state.browserContextGeneration }
}

export function browserContextMatches(state: BrowserContextState, lease: BrowserContextLease): boolean {
  return state.activeWorkspace === lease.workspace && state.activeTab === lease.tab && state.activeBrowserId === lease.browserId && state.browserContextGeneration === lease.generation
}

export function setBrowserForCurrentContext(state: BrowserContextState, lease: BrowserContextLease, browserId: string | null): boolean {
  if (!browserContextMatches(state, lease)) return false
  state.activeBrowserId = browserId
  return true
}

/** Validate a renderer focus announcement against the main-owned sidecar. */
export function resolveBrowserContext(layout: LayoutFile, workspace: unknown, tab: unknown): ActiveBrowserContext {
  if (!Number.isSafeInteger(workspace) || (workspace as number) < 1 || !Number.isSafeInteger(tab) || (tab as number) < 1) throw new Error('INVALID_REQUEST')
  const candidate = layout.workspaces[String(workspace)]?.tabs[String(tab)]
  if (!candidate) throw new Error('NO_ACTIVE_TAB')
  return { workspace: workspace as number, tab: tab as number, browserId: candidate.browser?.id ?? null }
}
