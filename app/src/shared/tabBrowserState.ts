import { isOpaqueBrowserId, safeRestoreUrl, type BrowserId } from './tabBrowser'

export const BROWSER_STATE_VERSION = 1
export const BROWSER_STATE_RECORD_MAX = 1000
export const BROWSER_RECOVERY_MAX = 100

export interface ProfileDescriptor {
  id: 'global'
  partition: string
  createdAt: number
  migratedFrom?: string
}

export interface BrowserRecord {
  id: BrowserId
  profileId: 'global'
  mode: 'preview' | 'browse'
  safeRestoreUrl: string
  title: string
  viewport: { width: number; height: number }
  lifecycle: 'live' | 'frozen'
  stateRevision: number
  lastUsedAt: number
  lastFocusedAt: number
  restoreError?: string
}

export interface MigrationRecoveryItem { workspace: number; tab: number; safeRestoreUrl: string }
export interface BrowserStateTransaction {
  id: string
  kind: 'legacy-layout-migration'
  expectedLayoutVersion: string | null
  layoutText: string
}
export interface BrowserStateFile {
  version: 1
  revision: number
  layoutRevision: number
  profiles: { global: ProfileDescriptor }
  records: Partial<Record<BrowserId, BrowserRecord>>
  migrationRecovery: MigrationRecoveryItem[]
  pendingTransaction?: BrowserStateTransaction
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) }

export function emptyBrowserState(now = Date.now()): BrowserStateFile {
  return {
    version: 1, revision: 0, layoutRevision: 0,
    profiles: { global: { id: 'global', partition: 'persist:amber-browser', createdAt: now } },
    records: {}, migrationRecovery: [],
  }
}

function record(value: unknown, key: string): BrowserRecord | null {
  const v = object(value)
  const viewport = object(v?.['viewport'])
  if (!v || !isOpaqueBrowserId(key) || v['id'] !== key || v['profileId'] !== 'global') return null
  if (v['mode'] !== 'preview' && v['mode'] !== 'browse') return null
  if (v['lifecycle'] !== 'live' && v['lifecycle'] !== 'frozen') return null
  if (typeof v['safeRestoreUrl'] !== 'string' || typeof v['title'] !== 'string') return null
  if (!viewport || !finite(viewport['width']) || !finite(viewport['height'])) return null
  if (!finite(v['stateRevision']) || !finite(v['lastUsedAt']) || !finite(v['lastFocusedAt'])) return null
  return {
    id: key, profileId: 'global', mode: v['mode'],
    safeRestoreUrl: safeRestoreUrl(v['safeRestoreUrl']), title: v['title'].slice(0, 512),
    viewport: { width: Math.min(4096, Math.max(320, viewport['width'])), height: Math.min(4096, Math.max(240, viewport['height'])) },
    lifecycle: v['lifecycle'], stateRevision: v['stateRevision'], lastUsedAt: v['lastUsedAt'], lastFocusedAt: v['lastFocusedAt'],
    ...(typeof v['restoreError'] === 'string' ? { restoreError: v['restoreError'].slice(0, 1024) } : {}),
  }
}

export function parseBrowserState(text: string): BrowserStateFile {
  const fallback = emptyBrowserState()
  if (text.length > 8 * 1024 * 1024) return fallback
  try {
    const raw = object(JSON.parse(text))
    const profiles = object(raw?.['profiles']); const global = object(profiles?.['global'])
    if (!raw || raw['version'] !== 1 || !global || global['id'] !== 'global' || typeof global['partition'] !== 'string'
        || !/^persist:amber-browser(?:-[a-z0-9-]+)?$/.test(global['partition']) || !finite(global['createdAt'])) return fallback
    const recordsRaw = object(raw['records']) ?? {}
    const records: Partial<Record<BrowserId, BrowserRecord>> = {}
    for (const [key, value] of Object.entries(recordsRaw).slice(0, BROWSER_STATE_RECORD_MAX)) {
      const parsed = record(value, key)
      if (parsed) records[parsed.id] = parsed
    }
    const migrationRecovery: MigrationRecoveryItem[] = []
    if (Array.isArray(raw['migrationRecovery'])) {
      for (const value of raw['migrationRecovery'].slice(0, BROWSER_RECOVERY_MAX)) {
        const item = object(value)
        if (!item || !finite(item['workspace']) || !finite(item['tab']) || typeof item['safeRestoreUrl'] !== 'string') continue
        migrationRecovery.push({ workspace: item['workspace'], tab: item['tab'], safeRestoreUrl: safeRestoreUrl(item['safeRestoreUrl']) })
      }
    }
    const pendingRaw = object(raw['pendingTransaction'])
    const pendingTransaction = pendingRaw && pendingRaw['kind'] === 'legacy-layout-migration'
      && typeof pendingRaw['id'] === 'string' && pendingRaw['id'].length <= 128
      && (typeof pendingRaw['expectedLayoutVersion'] === 'string' || pendingRaw['expectedLayoutVersion'] === null)
      && typeof pendingRaw['layoutText'] === 'string' && pendingRaw['layoutText'].length <= 2 * 1024 * 1024
      ? { id: pendingRaw['id'], kind: 'legacy-layout-migration' as const, expectedLayoutVersion: pendingRaw['expectedLayoutVersion'] as string | null, layoutText: pendingRaw['layoutText'] }
      : undefined
    return {
      version: 1,
      revision: finite(raw['revision']) ? raw['revision'] : 0,
      layoutRevision: finite(raw['layoutRevision']) ? raw['layoutRevision'] : 0,
      profiles: { global: { id: 'global', partition: global['partition'].slice(0, 128), createdAt: global['createdAt'], ...(typeof global['migratedFrom'] === 'string' ? { migratedFrom: global['migratedFrom'].slice(0, 128) } : {}) } },
      records,
      migrationRecovery,
      ...(pendingTransaction ? { pendingTransaction } : {}),
    }
  } catch { return fallback }
}
