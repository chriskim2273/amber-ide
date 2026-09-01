import { randomUUID } from 'node:crypto'
import type { SaveLayoutResult } from '../shared/layoutFile'
import { parseLayout, serializeLayout, TAB_BROWSER_LAYOUT_VERSION } from '../shared/layoutFile'
import { migrateLegacyBrowsers } from '../shared/tabBrowserMigration'
import type { BrowserStateFile } from '../shared/tabBrowserState'
import { loadLayoutFile, saveLayoutFile } from './layoutIO'
import { TabBrowserStateStore } from './tabBrowserStateStore'

export type LayoutSave = (path: string, text: string, expected: string | null) => Promise<SaveLayoutResult>

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
): Promise<SaveLayoutResult> {
  const state = await store.load()
  if (state.pendingTransaction) throw new Error('BROWSER_TRANSACTION_PENDING')
  const pending: BrowserStateFile = {
    ...state, revision: state.revision + 1,
    pendingTransaction: { id: transactionId(), kind: 'browser-association', expectedLayoutVersion, layoutText },
  }
  await store.save(pending)
  const saved = await saveLayout(layoutPath, layoutText, expectedLayoutVersion)
  if (!('ok' in saved)) {
    const { pendingTransaction: _pending, ...rolledBack } = pending
    await store.save({ ...rolledBack, revision: pending.revision + 1 })
    return saved
  }
  const { pendingTransaction: _pending, ...committed } = pending
  await store.save({ ...committed, revision: pending.revision + 1, layoutRevision: state.layoutRevision + 1 })
  return saved
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
): Promise<void> {
  let state = await store.load()
  if (state.pendingTransaction) {
    const pending = state.pendingTransaction
    const loaded = await loadLayoutFile(layoutPath)
    if (loaded.text !== pending.layoutText) {
      const saved = await saveLayout(layoutPath, pending.layoutText, pending.expectedLayoutVersion)
      if (!('ok' in saved)) throw new Error('error' in saved ? saved.error : 'LAYOUT_CONFLICT')
    }
    const { pendingTransaction: _pending, ...committed } = state
    state = { ...committed, layoutRevision: state.layoutRevision + 1, revision: state.revision + 1 }
    await store.save(state)
    return
  }

  const loaded = await loadLayoutFile(layoutPath)
  if (!loaded.text) return
  const layout = parseLayout(loaded.text)
  if (layout.readOnly) return
  if (layout.version === TAB_BROWSER_LAYOUT_VERSION) {
    const associated = new Set<string>()
    for (const workspace of Object.values(layout.workspaces)) for (const tab of Object.values(workspace.tabs)) if (tab.browser) associated.add(tab.browser.id)
    const lastUsed = Object.fromEntries(Object.entries(state.records).flatMap(([id, record]) => record ? [[id, record.lastUsedAt]] : []))
    const orphans = collectBrowserOrphans(lastUsed, associated, Date.now())
    if (orphans.length > 0) {
      const records = { ...state.records }; for (const id of orphans) delete records[id as keyof typeof records]
      await store.save({ ...state, records, revision: state.revision + 1 })
    }
    return
  }
  if (!layout.browsers || Object.keys(layout.browsers).length === 0) return

  const migrated = migrateLegacyBrowsers({ workspaces: layout.workspaces, browsers: layout.browsers }, random)
  const nextLayout = {
    ...layout,
    version: TAB_BROWSER_LAYOUT_VERSION,
    workspaces: migrated.workspaces,
    browserRevision: (layout.browserRevision ?? 0) + 1,
  }
  delete nextLayout.browsers
  const layoutText = serializeLayout(nextLayout)
  const nextState: BrowserStateFile = {
    ...state,
    revision: state.revision + 1,
    records: { ...state.records, ...migrated.records },
    migrationRecovery: [...state.migrationRecovery, ...migrated.recovery].slice(0, 100),
    pendingTransaction: {
      id: transactionId(), kind: 'legacy-layout-migration', expectedLayoutVersion: loaded.version, layoutText,
    },
  }
  await store.save(nextState)
  const saved = await saveLayout(layoutPath, layoutText, loaded.version)
  if (!('ok' in saved)) throw new Error('error' in saved ? saved.error : 'LAYOUT_CONFLICT')
  const { pendingTransaction: _pending, ...committed } = nextState
  await store.save({ ...committed, layoutRevision: state.layoutRevision + 1, revision: nextState.revision + 1 })
}
