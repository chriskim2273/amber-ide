import type { LayoutFile } from '../shared/layoutFile'
import type { TabBrowserCommand } from './tabBrowserService'

export function deriveActiveBrowserId(layout: LayoutFile): string | null {
  const workspace = layout.workspaces[String(layout.activeWorkspace)]
  return workspace?.tabs[String(workspace.activeTab)]?.browser?.id ?? null
}

/** Bind a parsed renderer command to the browser associated with its sender's WindowCtx. */
export function bindRendererBrowserCommand(activeBrowserId: string | null, command: TabBrowserCommand): TabBrowserCommand {
  if (command.type === 'open') return command
  if (!activeBrowserId) throw new Error('NO_BROWSER_FOR_TAB')
  return { ...command, id: activeBrowserId }
}
