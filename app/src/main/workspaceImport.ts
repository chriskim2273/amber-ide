import { planLoad, type WorkspaceDoc, type LoadPlan } from '../shared/workspaceFile'
import { serializeLayout, type LayoutFile } from '../shared/layoutFile'
import type { BrowserStateFile } from '../shared/tabBrowserState'
import type { WorkspaceBrowserImport } from './tabBrowserService'
import { removedBrowserIds } from './browserAssociationAuthority'
import { saveLayoutFile } from './layoutIO'
import { commitBrowserLayoutMutation } from './tabBrowserMigrationCoordinator'
import { stageWorkspaceBrowserState } from './tabBrowserService'
import type { TabBrowserStateStore } from './tabBrowserStateStore'

export interface PreparedWorkspaceImport {
  plan: LoadPlan
  next: LayoutFile
  browsers: WorkspaceBrowserImport
  removedBrowserIds: string[]
  needsBrowserHost: boolean
}

/** Main-owned projection from portable workspace intent to local sidecar coordinates. */
export async function commitPreparedWorkspaceImport(input: {
  prepared: PreparedWorkspaceImport
  layoutPath: string
  expectedLayoutVersion: string | null
  browserStore: TabBrowserStateStore | null
  browserHost: { importWorkspaceBrowsersCommitted: (input: WorkspaceBrowserImport) => Promise<void>; destroyForAssociation: (id: string) => Promise<void> } | null
}): Promise<{ version: string | null }> {
  const { prepared } = input
  let saved
  if (prepared.needsBrowserHost) {
    if (!input.browserStore || !input.browserHost) throw new Error('BROWSER_HOST_UNAVAILABLE')
    saved = await commitBrowserLayoutMutation(input.layoutPath, input.browserStore, serializeLayout(prepared.next), input.expectedLayoutVersion, undefined, undefined,
      (state) => {
        const staged = stageWorkspaceBrowserState(state, prepared.browsers)
        const records = { ...staged.records }
        for (const id of prepared.removedBrowserIds) delete records[id as keyof typeof records]
        return { ...staged, records }
      })
  } else saved = await saveLayoutFile(input.layoutPath, serializeLayout(prepared.next), input.expectedLayoutVersion)
  if (!('ok' in saved)) throw new Error('error' in saved ? saved.error : 'LAYOUT_CONFLICT')
  if (prepared.needsBrowserHost && input.browserHost) {
    await input.browserHost.importWorkspaceBrowsersCommitted(prepared.browsers)
    for (const id of prepared.removedBrowserIds) await input.browserHost.destroyForAssociation(id).catch(() => {})
  }
  return { version: saved.version }
}

export function prepareWorkspaceImport(input: {
  current: LayoutFile
  browserState: BrowserStateFile | null
  doc: WorkspaceDoc
  mode: 'new' | 'replace'
  activeWorkspace: number
  mintId: () => string
}): PreparedWorkspaceImport {
  const existingBrowserIds = new Set([
    ...Object.keys(input.browserState?.records ?? {}),
    ...Object.values(input.current.workspaces).flatMap((workspace) => Object.values(workspace.tabs).flatMap((tab) => tab.browser ? [tab.browser.id] : [])),
  ])
  const plan = planLoad(input.doc, {
    mode: input.mode,
    currentWs: input.activeWorkspace,
    liveWs: Object.keys(input.current.workspaces).map(Number),
    mintId: input.mintId,
    existingBrowserIds,
  })
  const workspaces = { ...input.current.workspaces }
  const editors = { ...(input.current.editors ?? {}) }
  const frozen = { ...(input.current.frozen ?? {}) }
  if (input.mode === 'replace') {
    delete workspaces[String(input.activeWorkspace)]
    for (const [id, editor] of Object.entries(editors)) if (editor.ws === input.activeWorkspace) delete editors[id]
    const prefix = `amber-${input.activeWorkspace}-`
    for (const id of Object.keys(frozen)) if (id.startsWith(prefix)) delete frozen[id]
  }
  Object.assign(workspaces, plan.workspaces)
  Object.assign(editors, plan.editors)
  Object.assign(frozen, plan.frozen)
  const next: LayoutFile = {
    ...input.current,
    version: 2,
    activeWorkspace: input.activeWorkspace,
    workspaces,
    editors,
    frozen,
    browserRevision: (input.current.browserRevision ?? 0) + 1,
  }
  const browsers: WorkspaceBrowserImport = {
    entries: plan.browserRails.map(({ id, browser }) => ({ id, browser })),
    recovery: plan.browserRecovery,
  }
  const removed = removedBrowserIds(input.current, next)
  return {
    plan,
    next,
    browsers,
    removedBrowserIds: removed,
    needsBrowserHost: browsers.entries.length > 0 || browsers.recovery.length > 0 || removed.length > 0,
  }
}
