import { removeLeaf, type Node } from '../renderer/layout'
import { createBrowserId, parseLegacyBrowserName, safeRestoreUrl, type BrowserId } from './tabBrowser'
import type { BrowserRecord, MigrationRecoveryItem } from './tabBrowserState'

export interface LegacyBrowserEntry { ws: number; tab: number; ord: number; url: string }
export interface MigratingTab { tree: Node | null; label?: string; browser?: { id: BrowserId; width: number; collapsed: boolean } }
export interface MigratingWorkspace { activeTab: number; tabs: Record<string, MigratingTab>; label?: string; tabOrder?: number[] }
export interface LegacyBrowserMigrationInput { workspaces: Record<string, MigratingWorkspace>; browsers: Record<string, LegacyBrowserEntry> }
export interface LegacyBrowserMigrationResult {
  workspaces: Record<string, MigratingWorkspace>
  records: Partial<Record<BrowserId, BrowserRecord>>
  recovery: MigrationRecoveryItem[]
}

function cloneWorkspaces(value: Record<string, MigratingWorkspace>): Record<string, MigratingWorkspace> {
  return structuredClone(value)
}

export function migrateLegacyBrowsers(input: LegacyBrowserMigrationInput, random?: () => Uint8Array): LegacyBrowserMigrationResult {
  const workspaces = cloneWorkspaces(input.workspaces)
  const records: Partial<Record<BrowserId, BrowserRecord>> = {}
  const recovery: MigrationRecoveryItem[] = []
  const grouped = new Map<string, { name: string; entry: LegacyBrowserEntry }[]>()
  for (const [name, entry] of Object.entries(input.browsers)) {
    const parsed = parseLegacyBrowserName(name)
    if (!parsed || parsed.ws !== entry.ws || parsed.tab !== entry.tab || parsed.ord !== entry.ord) continue
    const key = `${entry.ws}:${entry.tab}`
    grouped.set(key, [...(grouped.get(key) ?? []), { name, entry }])
  }
  for (const candidates of grouped.values()) {
    candidates.sort((a, b) => a.entry.ord - b.entry.ord || a.name.localeCompare(b.name))
    const first = candidates[0]!
    const ws = workspaces[String(first.entry.ws)]
    const tab = ws?.tabs[String(first.entry.tab)]
    if (!tab) continue
    const browserId = createBrowserId(random)
    tab.browser = { id: browserId, width: 420, collapsed: false }
    const now = Date.now()
    records[browserId] = {
      id: browserId, profileId: 'global', mode: 'browse', safeRestoreUrl: safeRestoreUrl(first.entry.url), title: '',
      viewport: { width: 1280, height: 800 }, lifecycle: 'frozen', stateRevision: 1, lastUsedAt: now, lastFocusedAt: now,
    }
    for (const candidate of candidates) tab.tree = tab.tree ? removeLeaf(tab.tree, candidate.name) : null
    for (const candidate of candidates.slice(1)) recovery.push({ workspace: candidate.entry.ws, tab: candidate.entry.tab, safeRestoreUrl: safeRestoreUrl(candidate.entry.url) })
  }
  return { workspaces, records, recovery }
}
