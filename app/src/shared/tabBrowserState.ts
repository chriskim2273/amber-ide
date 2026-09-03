import { isOpaqueBrowserId, safeRestoreUrl, type BrowserId } from './tabBrowser'
import { parseBrowserViewport } from './browserViewport'

export const BROWSER_STATE_VERSION = 1
export const BROWSER_STATE_RECORD_MAX = 1000
export const BROWSER_RECOVERY_MAX = 100

export type RecoveryId = `recovery-${string}`
const RECOVERY_ID_RE = /^recovery-[0-9a-f]{32}$/

export function isRecoveryId(value: unknown): value is RecoveryId {
  return typeof value === 'string' && RECOVERY_ID_RE.test(value)
}

export function createRecoveryId(random = (): Uint8Array => crypto.getRandomValues(new Uint8Array(16))): RecoveryId {
  const bytes = random()
  if (bytes.length !== 16) throw new Error('recovery id entropy must be exactly 16 bytes')
  return `recovery-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

/** Stable migration identity for a legacy entry that did not carry an id. */
export function deterministicRecoveryId(workspace: number, tab: number, safeUrl: string, ordinal: number): RecoveryId {
  const input = `${workspace}\u0000${tab}\u0000${safeUrl}\u0000${ordinal}`
  const seeds = [0x811c9dc5, 0x9e3779b1, 0x85ebca77, 0xc2b2ae35]
  const hashes = seeds.map((seed) => {
    let hash = seed >>> 0
    for (let index = 0; index < input.length; index++) hash = Math.imul(hash ^ input.charCodeAt(index), 0x01000193) >>> 0
    return hash.toString(16).padStart(8, '0')
  })
  return `recovery-${hashes.join('')}`
}

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
  previewOrigins?: string[]
  lifecycle: 'live' | 'frozen'
  stateRevision: number
  lastUsedAt: number
  lastFocusedAt: number
  restoreError?: string
}

export interface MigrationRecoveryItem { id: RecoveryId; workspace: number; tab: number; safeRestoreUrl: string }
export interface BrowserStateTransaction {
  id: string
  kind: 'legacy-layout-migration' | 'browser-association'
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

function previewOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const candidate of value.slice(0, 32)) {
    if (typeof candidate !== 'string' || candidate.length > 256) continue
    try {
      const url = new URL(candidate)
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== candidate || out.includes(candidate)) continue
      out.push(candidate)
    } catch { /* malformed origins are ignored independently */ }
  }
  return out
}

export function emptyBrowserState(now = Date.now()): BrowserStateFile {
  return {
    version: 1, revision: 0, layoutRevision: 0,
    profiles: { global: { id: 'global', partition: 'persist:amber-browser', createdAt: now } },
    records: {}, migrationRecovery: [],
  }
}

function record(value: unknown, key: string): BrowserRecord | null {
  const v = object(value)
  const viewport = parseBrowserViewport(v?.['viewport'])
  const parsedPreviewOrigins = previewOrigins(v?.['previewOrigins'])
  if (!v || !isOpaqueBrowserId(key) || v['id'] !== key || v['profileId'] !== 'global') return null
  if (v['mode'] !== 'preview' && v['mode'] !== 'browse') return null
  if (v['lifecycle'] !== 'live' && v['lifecycle'] !== 'frozen') return null
  if (typeof v['safeRestoreUrl'] !== 'string' || typeof v['title'] !== 'string') return null
  if (!viewport) return null
  if (!finite(v['stateRevision']) || !finite(v['lastUsedAt']) || !finite(v['lastFocusedAt'])) return null
  return {
    id: key, profileId: 'global', mode: v['mode'],
    safeRestoreUrl: safeRestoreUrl(v['safeRestoreUrl']), title: v['title'].slice(0, 512),
    viewport,
    ...(parsedPreviewOrigins.length > 0 ? { previewOrigins: parsedPreviewOrigins } : {}),
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
    const migrationRecovery: MigrationRecoveryItem[] = []; const recoveryIds = new Set<RecoveryId>()
    if (Array.isArray(raw['migrationRecovery'])) {
      // Do not truncate recovery URLs at the presentation bound. A legacy
      // file with more than BROWSER_RECOVERY_MAX entries is handled by the
      // migration preflight, which fails before any rewrite; parsing it here
      // must preserve every durable item so a user can recover/delete them.
      for (const [sourceIndex, value] of raw['migrationRecovery'].entries()) {
        const item = object(value)
        if (!item || !finite(item['workspace']) || !finite(item['tab']) || typeof item['safeRestoreUrl'] !== 'string') continue
        const workspace = item['workspace'], tab = item['tab'], restoreUrl = safeRestoreUrl(item['safeRestoreUrl'])
        let id = isRecoveryId(item['id']) && !recoveryIds.has(item['id']) ? item['id'] : deterministicRecoveryId(workspace, tab, restoreUrl, sourceIndex)
        for (let collision = 1; recoveryIds.has(id); collision++) id = deterministicRecoveryId(workspace, tab, restoreUrl, sourceIndex + collision)
        recoveryIds.add(id)
        migrationRecovery.push({ id, workspace, tab, safeRestoreUrl: restoreUrl })
      }
    }
    const pendingRaw = object(raw['pendingTransaction'])
    const pendingTransaction = pendingRaw && (pendingRaw['kind'] === 'legacy-layout-migration' || pendingRaw['kind'] === 'browser-association')
      && typeof pendingRaw['id'] === 'string' && pendingRaw['id'].length <= 128
      && (typeof pendingRaw['expectedLayoutVersion'] === 'string' || pendingRaw['expectedLayoutVersion'] === null)
      && typeof pendingRaw['layoutText'] === 'string' && pendingRaw['layoutText'].length <= 2 * 1024 * 1024
      ? { id: pendingRaw['id'], kind: pendingRaw['kind'] as BrowserStateTransaction['kind'], expectedLayoutVersion: pendingRaw['expectedLayoutVersion'] as string | null, layoutText: pendingRaw['layoutText'] }
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
