import type { LayoutFile } from '../shared/layoutFile'

export interface ActiveBrowserContext { workspace: number; tab: number; browserId: string | null }

/** Validate a renderer focus announcement against the main-owned sidecar. */
export function resolveBrowserContext(layout: LayoutFile, workspace: unknown, tab: unknown): ActiveBrowserContext {
  if (!Number.isSafeInteger(workspace) || (workspace as number) < 1 || !Number.isSafeInteger(tab) || (tab as number) < 1) throw new Error('INVALID_REQUEST')
  const candidate = layout.workspaces[String(workspace)]?.tabs[String(tab)]
  if (!candidate) throw new Error('NO_ACTIVE_TAB')
  return { workspace: workspace as number, tab: tab as number, browserId: candidate.browser?.id ?? null }
}
