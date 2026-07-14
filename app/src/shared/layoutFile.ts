import type { Node } from '../renderer/layout'

export const LAYOUT_VERSION = 1
export interface TabLayout { tree: Node | null }
export interface WsLayout { activeTab: number; tabs: Record<string, TabLayout> }
export interface LayoutFile { version: number; activeWorkspace: number; workspaces: Record<string, WsLayout> }

export function emptyLayout(): LayoutFile {
  return { version: LAYOUT_VERSION, activeWorkspace: 1, workspaces: {} }
}

export function parseLayout(text: string): LayoutFile {
  try {
    const v = JSON.parse(text) as Partial<LayoutFile>
    if (v.version !== LAYOUT_VERSION || typeof v.workspaces !== 'object' || v.workspaces === null) {
      return emptyLayout()
    }
    return {
      version: LAYOUT_VERSION,
      activeWorkspace: typeof v.activeWorkspace === 'number' ? v.activeWorkspace : 1,
      workspaces: v.workspaces as Record<string, WsLayout>,
    }
  } catch {
    return emptyLayout()
  }
}

export function serializeLayout(l: LayoutFile): string {
  return JSON.stringify(l)
}
