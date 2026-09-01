import { randomUUID } from 'node:crypto'
import type { SaveLayoutResult } from '../shared/layoutFile'
import { parseLayout, serializeLayout, TAB_BROWSER_LAYOUT_VERSION } from '../shared/layoutFile'
import { migrateLegacyBrowsers } from '../shared/tabBrowserMigration'
import type { BrowserStateFile } from '../shared/tabBrowserState'
import { loadLayoutFile, saveLayoutFile } from './layoutIO'
import { TabBrowserStateStore } from './tabBrowserStateStore'

export type LayoutSave = (path: string, text: string, expected: string | null) => Promise<SaveLayoutResult>

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
  if (layout.readOnly || layout.version === TAB_BROWSER_LAYOUT_VERSION || !layout.browsers || Object.keys(layout.browsers).length === 0) return

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
