import { commitBrowserLayoutMutation, coordinateTabBrowserMigration } from '../../src/main/tabBrowserMigrationCoordinator'
import { loadLayoutFile } from '../../src/main/layoutIO'
import { TabBrowserStateStore } from '../../src/main/tabBrowserStateStore'
import type { BrowserRecord } from '../../src/shared/tabBrowserState'

const [mode, root, layoutPath, targetEncoded, orphanId] = process.argv.slice(2)
if (!root || !layoutPath) throw new Error('sidecar transaction arguments missing')

const target = targetEncoded ? Buffer.from(targetEncoded, 'base64').toString('utf8') : undefined
const record = (id: string): BrowserRecord => ({
  id: id as BrowserRecord['id'], profileId: 'global', mode: 'browse', safeRestoreUrl: 'about:blank', title: '',
  viewport: { width: 1280, height: 800 }, lifecycle: 'frozen', stateRevision: 1, lastUsedAt: 1, lastFocusedAt: 0,
})

if (mode === 'stage-crash') {
  if (!target || !orphanId) throw new Error('stage-crash arguments missing')
  const loaded = await loadLayoutFile(layoutPath)
  if (!loaded.text) throw new Error('missing base layout')
  try {
    await commitBrowserLayoutMutation(layoutPath, new TabBrowserStateStore(root), target, loaded.version,
      async () => { throw new Error('SIMULATED_PROCESS_EXIT') }, undefined,
      (state) => ({ ...state, records: { ...state.records, [orphanId]: record(orphanId) } }))
    throw new Error('transaction unexpectedly committed')
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'SIMULATED_PROCESS_EXIT') throw error
  }
  process.stdout.write('staged\n')
} else if (mode === 'recover') {
  await coordinateTabBrowserMigration(layoutPath, new TabBrowserStateStore(root))
  process.stdout.write('recovered\n')
} else {
  throw new Error(`unknown sidecar transaction mode: ${String(mode)}`)
}
