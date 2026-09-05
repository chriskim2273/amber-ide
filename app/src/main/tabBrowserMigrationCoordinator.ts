import { open, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SaveLayoutResult } from '../shared/layoutFile'
import { layoutUtf8ByteLength, LAYOUT_FILE_MAX_BYTES, parseLayout, serializeLayout, TAB_BROWSER_LAYOUT_VERSION } from '../shared/layoutFile'
import { migrateLegacyBrowsers } from '../shared/tabBrowserMigration'
import { BROWSER_RECOVERY_MAX, type BrowserStateFile } from '../shared/tabBrowserState'
import { loadLayoutFile, saveLayoutFile } from './layoutIO'
import { TabBrowserStateStore } from './tabBrowserStateStore'

export type LayoutSave = (path: string, text: string, expected: string | null) => Promise<SaveLayoutResult>
export type LegacyLayoutBackup = (path: string, text: string) => Promise<void>

function assertNoFutureLayoutText(text: string, label: string): void {
  if (layoutUtf8ByteLength(text, LAYOUT_FILE_MAX_BYTES) > LAYOUT_FILE_MAX_BYTES) throw new Error(`${label}_LIMIT`)
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return
  const value = raw as Record<string, unknown>
  if (Object.hasOwn(value, 'version') && value['version'] !== 1 && value['version'] !== TAB_BROWSER_LAYOUT_VERSION) throw new Error('UNSUPPORTED_LAYOUT_VERSION')
}

function assertWritableLayoutText(text: string, label: string): void {
  assertNoFutureLayoutText(text, label)
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Error(`${label}_INVALID`) }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${label}_INVALID`)
  const value = raw as Record<string, unknown>
  if (value['version'] !== 1 && value['version'] !== TAB_BROWSER_LAYOUT_VERSION) throw new Error('UNSUPPORTED_LAYOUT_VERSION')
  if (typeof value['workspaces'] !== 'object' || value['workspaces'] === null || Array.isArray(value['workspaces'])) throw new Error(`${label}_INVALID`)
  if (parseLayout(text).readOnly) throw new Error('UNSUPPORTED_LAYOUT_VERSION')
}

/** Create a private, durable copy before the first v1 migration write. */
export async function backupLegacyLayout(path: string, text: string): Promise<void> {
  const backup = `${path}.v1.${Date.now()}.${randomUUID()}.bak`
  const handle = await open(backup, 'wx', 0o600)
  let committed = false
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    committed = true
  } finally {
    await handle.close().catch(() => {})
    if (!committed) await unlink(backup).catch(() => {})
  }
  if (process.platform !== 'win32') {
    const parent = await open(dirname(path), 'r')
    try { await parent.sync() } finally { await parent.close() }
  }
}

export function collectBrowserOrphans(lastUsed: Record<string, number>, associated: Set<string>, now: number, graceMs = 24 * 60 * 60 * 1000): string[] {
  return Object.entries(lastUsed).filter(([id, at]) => !associated.has(id) && now - at >= graceMs).map(([id]) => id)
}

export async function commitBrowserLayoutMutation(
  layoutPath: string,
  store: TabBrowserStateStore,
  layoutText: string,
  expectedLayoutVersion: string | null,
  saveLayout: LayoutSave = saveLayoutFile,
  transactionId: () => string = randomUUID,
  mutateState: (state: BrowserStateFile) => BrowserStateFile = (state) => state,
): Promise<SaveLayoutResult> {
  return store.withLock(async (io) => {
    assertNoFutureLayoutText(layoutText, 'LAYOUT_TARGET')
    const currentLayout = await loadLayoutFile(layoutPath)
    if (currentLayout.error) throw new Error(currentLayout.error)
    if (currentLayout.text) assertWritableLayoutText(currentLayout.text, 'LAYOUT_CURRENT')
    const state = await io.load()
    if (state.pendingTransaction) throw new Error('BROWSER_TRANSACTION_PENDING')
    const staged = mutateState(state)
    const pending: BrowserStateFile = {
      ...staged, revision: state.revision + 1,
      pendingTransaction: { id: transactionId(), kind: 'browser-association', expectedLayoutVersion, layoutText },
    }
    await io.save(pending)
    const saved = await saveLayout(layoutPath, layoutText, expectedLayoutVersion)
    if (!('ok' in saved)) {
      await io.save({ ...state, revision: pending.revision + 1 })
      return saved
    }
    const { pendingTransaction: _pending, ...committed } = pending
    await io.save({ ...committed, revision: pending.revision + 1, layoutRevision: state.layoutRevision + 1 })
    return saved
  })
}

/**
 * Upgrade legacy browser leaves with a journal stored before the layout CAS.
 * If the process dies after that write, startup replays the exact same target
 * (and therefore the exact same opaque ids) rather than minting duplicates.
 */
export async function coordinateTabBrowserMigration(
  layoutPath: string,
  store: TabBrowserStateStore,
  random?: () => Uint8Array,
  transactionId: () => string = randomUUID,
  saveLayout: LayoutSave = saveLayoutFile,
  backupLayout: LegacyLayoutBackup = backupLegacyLayout,
): Promise<void> {
  return store.withLock(async (io) => {
  let state = await io.load()
  if (state.pendingTransaction) {
    const pending = state.pendingTransaction
    assertWritableLayoutText(pending.layoutText, 'PENDING_LAYOUT')
    const loaded = await loadLayoutFile(layoutPath)
    if (loaded.error) throw new Error(loaded.error)
    if (loaded.text) assertWritableLayoutText(loaded.text, 'LAYOUT_CURRENT')
    if (loaded.text !== pending.layoutText) {
      const saved = await saveLayout(layoutPath, pending.layoutText, pending.expectedLayoutVersion)
      if (!('ok' in saved)) throw new Error('error' in saved ? saved.error : 'LAYOUT_CONFLICT')
    }
    const { pendingTransaction: _pending, ...committed } = state
    state = { ...committed, layoutRevision: state.layoutRevision + 1, revision: state.revision + 1 }
    await io.save(state)
    return
  }

  const loaded = await loadLayoutFile(layoutPath)
  if (loaded.error) throw new Error(loaded.error)
  if (!loaded.text) return
  assertWritableLayoutText(loaded.text, 'LAYOUT_CURRENT')
  const layout = parseLayout(loaded.text)
  if (layout.readOnly) return
  if (layout.version === TAB_BROWSER_LAYOUT_VERSION) {
    const associated = new Set<string>()
    for (const workspace of Object.values(layout.workspaces)) for (const tab of Object.values(workspace.tabs)) if (tab.browser) associated.add(tab.browser.id)
    const lastUsed = Object.fromEntries(Object.entries(state.records).flatMap(([id, record]) => record ? [[id, record.lastUsedAt]] : []))
    const orphans = collectBrowserOrphans(lastUsed, associated, Date.now())
    if (orphans.length > 0) {
      const records = { ...state.records }; for (const id of orphans) delete records[id as keyof typeof records]
      await io.save({ ...state, records, revision: state.revision + 1 })
    }
    return
  }
  if (!layout.browsers || Object.keys(layout.browsers).length === 0) return

  const migrated = migrateLegacyBrowsers({ workspaces: layout.workspaces, browsers: layout.browsers }, random)
  if (state.migrationRecovery.length + migrated.recovery.length > BROWSER_RECOVERY_MAX) throw new Error('BROWSER_RECOVERY_LIMIT')
  const nextLayout = {
    ...layout,
    version: TAB_BROWSER_LAYOUT_VERSION,
    workspaces: migrated.workspaces,
    browserRevision: (layout.browserRevision ?? 0) + 1,
  }
  delete nextLayout.browsers
  const layoutText = serializeLayout(nextLayout)
  // This is deliberately after the pure migration and overflow preflight, but
  // before either store receives v2 data. A backup failure therefore leaves the
  // original v1 layout and state untouched.
  await backupLayout(layoutPath, loaded.text)
  const nextState: BrowserStateFile = {
    ...state,
    revision: state.revision + 1,
    records: { ...state.records, ...migrated.records },
    migrationRecovery: [...state.migrationRecovery, ...migrated.recovery],
    pendingTransaction: {
      id: transactionId(), kind: 'legacy-layout-migration', expectedLayoutVersion: loaded.version, layoutText,
    },
  }
  await io.save(nextState)
  const saved = await saveLayout(layoutPath, layoutText, loaded.version)
  if (!('ok' in saved)) throw new Error('error' in saved ? saved.error : 'LAYOUT_CONFLICT')
  const { pendingTransaction: _pending, ...committed } = nextState
  await io.save({ ...committed, layoutRevision: state.layoutRevision + 1, revision: nextState.revision + 1 })
  })
}
