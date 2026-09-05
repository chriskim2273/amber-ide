import type { LayoutFile } from '../shared/layoutFile'
import type { TabBrowserCommand } from './tabBrowserService'

function browserIds(layout: LayoutFile): Set<string> {
  return new Set(Object.values(layout.workspaces).flatMap((workspace) => Object.values(workspace.tabs).flatMap((tab) => tab.browser ? [tab.browser.id] : [])))
}

function browserAuthority(layout: LayoutFile): string[] {
  return Object.entries(layout.workspaces).flatMap(([ws, workspace]) => Object.entries(workspace.tabs).flatMap(([tab, value]) => value.browser
    ? [`${ws}:${tab}:${value.browser.id}:${value.browser.designatedPi ?? ''}:${value.browser.sharedWithPi === true ? '1' : '0'}`]
    : [])).sort()
}

export function browserAuthorityChanged(before: LayoutFile, after: LayoutFile): boolean {
  return JSON.stringify(browserAuthority(before)) !== JSON.stringify(browserAuthority(after))
}

export function removedBrowserIds(before: LayoutFile, after: LayoutFile): string[] {
  const next = browserIds(after)
  return [...browserIds(before)].filter((id) => !next.has(id)).sort()
}

export function deriveActiveBrowserId(layout: LayoutFile): string | null {
  const workspace = layout.workspaces[String(layout.activeWorkspace)]
  return workspace?.tabs[String(workspace.activeTab)]?.browser?.id ?? null
}

/** Bind a parsed renderer command to the browser associated with its sender's WindowCtx. */
export function bindRendererBrowserCommand(activeBrowserId: string | null, command: TabBrowserCommand): TabBrowserCommand {
  if (command.type === 'open' || command.type === 'close' || command.type === 'share' || command.type === 'designate') return command
  if (!activeBrowserId) throw new Error('NO_BROWSER_FOR_TAB')
  return { ...command, id: activeBrowserId }
}
