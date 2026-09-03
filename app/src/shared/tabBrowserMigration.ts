import { removeLeaf, type Node } from '../renderer/layout'
import { createBrowserId, parseLegacyBrowserName, safeRestoreUrl, type BrowserId } from './tabBrowser'
import { deterministicRecoveryId, type BrowserRecord, type MigrationRecoveryItem } from './tabBrowserState'

export interface LegacyBrowserEntry { ws: number; tab: number; ord: number; url: string }
export interface MigratingTab { tree: Node | null; label?: string; browser?: { id: string; width: number; collapsed: boolean; designatedPi?: string; sharedWithPi?: boolean } }
export interface MigratingWorkspace { activeTab: number; tabs: Record<string, MigratingTab>; label?: string; tabOrder?: number[] }
export interface LegacyBrowserMigrationInput { workspaces: Record<string, MigratingWorkspace>; browsers: Record<string, LegacyBrowserEntry> }
export interface LegacyBrowserMigrationResult {
  workspaces: Record<string, MigratingWorkspace>
  records: Partial<Record<string, BrowserRecord>>
  recovery: MigrationRecoveryItem[]
}

function cloneWorkspaces(value: Record<string, MigratingWorkspace>): Record<string, MigratingWorkspace> {
  return structuredClone(value)
}

export function migrateLegacyBrowsers(input: LegacyBrowserMigrationInput, random?: () => Uint8Array): LegacyBrowserMigrationResult {
  const workspaces = cloneWorkspaces(input.workspaces)
  const records: Partial<Record<BrowserId, BrowserRecord>> = {}
  const recovery: MigrationRecoveryItem[] = []; const recoveryIds = new Set<string>(); let recoveryOrdinal = 0
  const grouped = new Map<string, { name: string; entry: LegacyBrowserEntry }[]>()
  for (const [name, entry] of Object.entries(input.browsers)) {
    // Coordinates in legacy IDs became stale after cross-tab moves. The
    // sidecar entry is authoritative; parsing the ID only proves this is a
    // recognized legacy browser leaf rather than an unrelated app-local pane.
    if (!parseLegacyBrowserName(name)) continue
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
    for (const candidate of candidates.slice(1)) {
      const safeUrl = safeRestoreUrl(candidate.entry.url)
      let id = deterministicRecoveryId(candidate.entry.ws, candidate.entry.tab, safeUrl, recoveryOrdinal++)
      while (recoveryIds.has(id)) id = deterministicRecoveryId(candidate.entry.ws, candidate.entry.tab, safeUrl, recoveryOrdinal++)
      recoveryIds.add(id)
      recovery.push({ id, workspace: candidate.entry.ws, tab: candidate.entry.tab, safeRestoreUrl: safeUrl })
    }
  }
  return { workspaces, records, recovery }
}
