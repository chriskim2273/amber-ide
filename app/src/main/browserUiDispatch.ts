import { randomUUID } from 'node:crypto'
import { emptyLayout, parseLayout, serializeLayout } from '../shared/layoutFile'
import { parseWorkspaceFile } from '../shared/workspaceFile'
import { isRecoveryId } from '../shared/tabBrowserState'
import { applyBrowserRailAssociation, bindRendererBrowserCommand } from './browserAssociationAuthority'
import {
  approvalSurfaceDuringPresentationCommand,
  browserContextMatches,
  captureBrowserContext,
  resolveBrowserContext,
  sameBrowserContextIdentity,
  setBrowserForCurrentContext,
  type BrowserContextState,
} from './browserWindowContext'
import { parseBrowserToolAction } from './browserToolProtocol'
import { isEligiblePiController, type ControllerSession, type UiConnection, type UiRequest } from './tabBrowserBroker'
import { parseTabBrowserCommand, type TabBrowserCommand, type TabBrowserService } from './tabBrowserService'
import type { TabBrowserStateStore } from './tabBrowserStateStore'
import { commitBrowserLayoutMutation } from './tabBrowserMigrationCoordinator'
import { loadLayoutFile } from './layoutIO'
import { commitPreparedWorkspaceImport, prepareWorkspaceImport } from './workspaceImport'
import type { BrowserOperationRegistry } from './browserOperationRegistry'

export interface BrowserUiActor extends BrowserContextState {
  activeBrowserExpanded: boolean
  remote: boolean
  sendAssociation(ws: number, tab: number, browser?: Record<string, unknown>): void
}

export interface BrowserUiDeps {
  tabBrowser: TabBrowserService
  tabBrowserStateStore: TabBrowserStateStore
  layoutPath: string
  operations: BrowserOperationRegistry
  controller: (name: string) => ControllerSession | undefined
  cancelController: (name: string) => void
  rollbackOpenedBrowser: (ws: number, tab: number, id: string) => Promise<void>
}

export function rewriteRemotePresentation(command: TabBrowserCommand): TabBrowserCommand {
  if (command.type !== 'show' && command.type !== 'bounds') return command
  return { ...command, bounds: { x: 0, y: 0, width: command.bounds.width, height: command.bounds.height } }
}

export function parseRemoteInput(value: unknown, browserId: string): TabBrowserCommand {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('INVALID_REQUEST')
  const raw = value as Record<string, unknown>
  if (raw['type'] !== 'remoteInput' || typeof raw['pageIncarnation'] !== 'string' || typeof raw['expectedGeneration'] !== 'number') throw new Error('INVALID_REQUEST')
  const action = parseBrowserToolAction({
    type: 'interact',
    pageIncarnation: raw['pageIncarnation'],
    expectedGeneration: raw['expectedGeneration'],
    operation: raw['operation'],
  })
  return { type: 'automation', id: browserId, action }
}

export function attachRemotePresentation(result: unknown, remote: boolean): unknown {
  if (!remote || result === null || typeof result !== 'object' || Array.isArray(result)) return result
  return { ...result, presentation: 'remote' }
}

export function createBrowserUiActor(sendAssociation: BrowserUiActor['sendAssociation']): BrowserUiActor {
  return {
    activeWorkspace: null,
    activeTab: null,
    activeBrowserId: null,
    browserContextGeneration: 0,
    activeBrowserExpanded: false,
    remote: true,
    sendAssociation,
  }
}

export async function applyBrowserUiContext(deps: BrowserUiDeps, actor: BrowserUiActor, workspace: number, tab: number, collapsed: boolean, signal: AbortSignal): Promise<unknown> {
  deps.operations.assertDispatch(signal)
  const loaded = await loadLayoutFile(deps.layoutPath)
  if (!loaded.text) throw new Error('NO_ACTIVE_TAB')
  const context = resolveBrowserContext(parseLayout(loaded.text), workspace, tab)
  if (actor.activeBrowserId && actor.activeBrowserId !== context.browserId) {
    deps.tabBrowser.surfaceHidden(actor.activeBrowserId)
    await deps.tabBrowser.command({ type: 'hide', id: actor.activeBrowserId }).catch(() => {})
  }
  deps.operations.assertDispatch(signal)
  const changed = !sameBrowserContextIdentity(actor, context)
  actor.activeWorkspace = context.workspace
  actor.activeTab = context.tab
  actor.activeBrowserId = context.browserId
  if (changed || collapsed) actor.activeBrowserExpanded = false
  if (context.browserId && collapsed) deps.tabBrowser.surfaceHidden(context.browserId)
  actor.browserContextGeneration += 1
  return context
}

export async function dispatchBrowserUiCommand(deps: BrowserUiDeps, actor: BrowserUiActor, raw: unknown, signal: AbortSignal): Promise<unknown> {
  deps.operations.assertDispatch(signal)
  if (actor.remote && typeof raw === 'object' && raw !== null && !Array.isArray(raw) && (raw as { type?: unknown }).type === 'remoteInput') {
    if (!actor.activeBrowserId) throw new Error('NO_BROWSER_FOR_TAB')
    const command = parseRemoteInput(raw, actor.activeBrowserId)
    if (command.type !== 'automation' || command.action.type !== 'interact') throw new Error('INVALID_REQUEST')
    const expected = captureBrowserContext(actor)
    const stillAssociated = async (): Promise<boolean> => {
      if (!browserContextMatches(actor, expected)) return false
      const latest = await loadLayoutFile(deps.layoutPath)
      return !!latest.text && parseLayout(latest.text).workspaces[String(expected.workspace)]?.tabs[String(expected.tab)]?.browser?.id === expected.browserId
    }
    const result = await deps.tabBrowser.remoteInput(command.id, command.action.operation, signal, stillAssociated)
    return attachRemotePresentation(result, actor.remote)
  }
  const parsed = rewriteRemotePresentation(parseTabBrowserCommand(raw))
  if (parsed.type === 'open' || parsed.type === 'close' || parsed.type === 'share' || parsed.type === 'designate' || parsed.type === 'fullAccess') {
    const loaded = await loadLayoutFile(deps.layoutPath)
    if (!loaded.text) throw new Error('NO_BROWSER_FOR_TAB')
    const current = parseLayout(loaded.text)
    if (actor.activeWorkspace === null || actor.activeTab === null) throw new Error('NO_ACTIVE_TAB')
    const wsKey = String(actor.activeWorkspace)
    const workspace = current.workspaces[wsKey]
    const tabKey = String(actor.activeTab)
    const previous = workspace?.tabs[tabKey]
    if (!workspace || !previous) throw new Error('NO_BROWSER_FOR_TAB')
    const expectedContext = { ...captureBrowserContext(actor), browserId: previous.browser?.id ?? null }
    const contextMatches = (): boolean => browserContextMatches(actor, expectedContext)
    const stillAssociated = async (expectedBrowserId: string | null): Promise<boolean> => {
      if (!contextMatches()) return false
      const latest = await loadLayoutFile(deps.layoutPath)
      if (!latest.text) return false
      return (parseLayout(latest.text).workspaces[String(expectedContext.workspace)]?.tabs[String(expectedContext.tab)]?.browser?.id ?? null) === expectedBrowserId
    }
    let workingLoaded = loaded; let workingCurrent = current; let workingWorkspace = workspace; let workingPrevious = previous
    let openedId: string | null = null
    let browser = previous.browser
    if (parsed.type === 'open') {
      if (browser) return attachRemotePresentation(await deps.tabBrowser.command({ type: 'status', id: browser.id }), actor.remote)
      const opened = await deps.tabBrowser.command({ type: 'open' }, undefined, () => stillAssociated(null))
      if (!('id' in opened)) throw new Error('INTERNAL_ERROR')
      openedId = opened.id
      if (!(await stillAssociated(null))) { await deps.tabBrowser.destroyForAssociation(opened.id).catch(() => {}); throw new Error('STALE_BROWSER_CONTEXT') }
      workingLoaded = await loadLayoutFile(deps.layoutPath)
      if (!workingLoaded.text) { await deps.tabBrowser.destroyForAssociation(opened.id).catch(() => {}); throw new Error('STALE_BROWSER_CONTEXT') }
      workingCurrent = parseLayout(workingLoaded.text)
      workingWorkspace = workingCurrent.workspaces[wsKey]!
      workingPrevious = workingWorkspace.tabs[tabKey]!
      browser = { id: opened.id, width: 420, collapsed: false }
    } else {
      if (!browser) throw new Error('NO_BROWSER_FOR_TAB')
      if (parsed.type === 'close') browser = undefined
      else {
        if (parsed.type === 'designate' && parsed.designatedPi) {
          const match = /^amber-(\d+)-(\d+)-/.exec(parsed.designatedPi)
          const controller = deps.controller(parsed.designatedPi)
          if (!match || Number(match[1]) !== actor.activeWorkspace || Number(match[2]) !== actor.activeTab || !isEligiblePiController(controller)) throw new Error('NOT_DESIGNATED_CONTROLLER')
        }
        browser = applyBrowserRailAssociation(browser, parsed)
      }
    }
    const nextTab = { ...workingPrevious, ...(browser ? { browser } : {}) }
    if (!browser) delete nextTab.browser
    const next = { ...workingCurrent, version: 2, browserRevision: (workingCurrent.browserRevision ?? 0) + 1,
      workspaces: { ...workingCurrent.workspaces, [wsKey]: { ...workingWorkspace, tabs: { ...workingWorkspace.tabs, [tabKey]: nextTab } } } }
    deps.operations.assertDispatch(signal)
    const saved = await commitBrowserLayoutMutation(deps.layoutPath, deps.tabBrowserStateStore, serializeLayout(next), workingLoaded.version)
    if (!('ok' in saved)) {
      if (openedId) await deps.tabBrowser.destroyForAssociation(openedId).catch(() => {})
      throw new Error('error' in saved ? saved.error : 'LAYOUT_CONFLICT')
    }
    if (openedId && !contextMatches()) {
      try { await deps.rollbackOpenedBrowser(expectedContext.workspace, expectedContext.tab, openedId) }
      finally { await deps.tabBrowser.destroyForAssociation(openedId).catch(() => {}) }
      throw new Error('STALE_BROWSER_CONTEXT')
    }
    if (previous.browser && (parsed.type === 'close' || parsed.type === 'designate' || (parsed.type === 'share' && !parsed.sharedWithPi))) deps.tabBrowser.revokePi(previous.browser.id)
    if (browser) deps.tabBrowser.setFullAccess(browser.id, !!browser.fullAccess && !!browser.sharedWithPi)
    if (parsed.type === 'close' && previous.browser) await deps.tabBrowser.destroyForAssociation(previous.browser.id)
    setBrowserForCurrentContext(actor, expectedContext, browser?.id ?? null)
    actor.sendAssociation(expectedContext.workspace, expectedContext.tab, browser as Record<string, unknown> | undefined)
    const result = parsed.type === 'close' ? { closed: true } : browser ? await deps.tabBrowser.command({ type: 'status', id: browser.id }) : { closed: true }
    return attachRemotePresentation(result, actor.remote)
  }
  const loaded = await loadLayoutFile(deps.layoutPath)
  if (!loaded.text || actor.activeWorkspace === null || actor.activeTab === null) throw new Error('NO_ACTIVE_TAB')
  const activeBrowser = parseLayout(loaded.text).workspaces[String(actor.activeWorkspace)]?.tabs[String(actor.activeTab)]?.browser
  const associated = activeBrowser?.id ?? null
  if (associated !== actor.activeBrowserId) throw new Error('STALE_BROWSER_CONTEXT')
  if (parsed.type === 'stopPi' && activeBrowser?.designatedPi) deps.cancelController(activeBrowser.designatedPi)
  if (parsed.type === 'stopPi' && activeBrowser?.fullAccess) {
    const current = parseLayout(loaded.text)
    const wsKey = String(actor.activeWorkspace), tabKey = String(actor.activeTab)
    const tab = current.workspaces[wsKey]!.tabs[tabKey]!
    const nextBrowser = applyBrowserRailAssociation(activeBrowser, { type: 'fullAccess', fullAccess: false })
    const next = { ...current, version: 2, browserRevision: (current.browserRevision ?? 0) + 1,
      workspaces: { ...current.workspaces, [wsKey]: { ...current.workspaces[wsKey]!, tabs: { ...current.workspaces[wsKey]!.tabs, [tabKey]: { ...tab, browser: nextBrowser } } } } }
    const saved = await commitBrowserLayoutMutation(deps.layoutPath, deps.tabBrowserStateStore, serializeLayout(next), loaded.version)
    if (!('ok' in saved)) throw new Error('error' in saved ? saved.error : 'LAYOUT_CONFLICT')
    actor.sendAssociation(actor.activeWorkspace, actor.activeTab, nextBrowser as unknown as Record<string, unknown>)
  }
  const command = bindRendererBrowserCommand(actor.activeBrowserId, parsed)
  const expected = captureBrowserContext(actor)
  if ((command.type === 'hide' || command.type === 'show') && expected.browserId) {
    actor.activeBrowserExpanded = approvalSurfaceDuringPresentationCommand(actor.activeBrowserExpanded, command.type)
    if (command.type === 'hide') deps.tabBrowser.surfaceHidden(expected.browserId)
  }
  const stillAssociated = async (): Promise<boolean> => {
    if (!browserContextMatches(actor, expected)) return false
    const latest = await loadLayoutFile(deps.layoutPath)
    return !!latest.text && parseLayout(latest.text).workspaces[String(expected.workspace)]?.tabs[String(expected.tab)]?.browser?.id === expected.browserId
  }
  const result = await deps.tabBrowser.command(command, signal, stillAssociated)
  if (command.type === 'show' && browserContextMatches(actor, expected) && expected.browserId) actor.activeBrowserExpanded = true
  return attachRemotePresentation(result, actor.remote)
}

export async function dispatchUiRequest(deps: BrowserUiDeps, actor: BrowserUiActor, request: UiRequest, signal: AbortSignal, _connection: UiConnection): Promise<unknown> {
  if (request.kind === 'subscribe') return { subscribed: true }
  if (request.kind === 'context') {
    const result = await applyBrowserUiContext(deps, actor, request.workspace, request.tab, request.collapsed, signal)
    return result
  }
  if (request.kind === 'command') return dispatchBrowserUiCommand(deps, actor, request.command, signal)
  if (request.kind === 'snapshot') return deps.tabBrowser.workspaceSnapshot()
  if (request.kind === 'frame') {
    return deps.tabBrowser.captureFrame(request.id, signal)
  }
  if (request.kind === 'recovery') {
    const raw = request.recovery
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('INVALID_REQUEST')
    const body = raw as Record<string, unknown>
    if (body['action'] === 'list' && Object.keys(body).length === 1) return deps.tabBrowser.recoveryItems()
    if (typeof body['id'] !== 'string' || !isRecoveryId(body['id'])) throw new Error('INVALID_REQUEST')
    const recoveryId = body['id']
    const item = deps.tabBrowser.recoveryItems().find((candidate) => candidate.id === recoveryId)
    if (!item) throw new Error('NO_RECOVERY_ITEM')
    if (body['action'] === 'copy' && Object.keys(body).length === 2) return { safeRestoreUrl: item.safeRestoreUrl }
    if (body['action'] === 'delete' && Object.keys(body).length === 2) {
      await deps.tabBrowser.deleteRecovery(recoveryId)
      return { deleted: true }
    }
    throw new Error('INVALID_REQUEST')
  }
  if (request.kind === 'import') {
    if (actor.activeWorkspace === null || actor.activeTab === null) throw new Error('NO_ACTIVE_TAB')
    const doc = parseWorkspaceFile(request.text)
    const loaded = await loadLayoutFile(deps.layoutPath)
    const current = loaded.text ? parseLayout(loaded.text) : emptyLayout()
    const state = await deps.tabBrowserStateStore.load()
    const prepared = prepareWorkspaceImport({ current, browserState: state, doc, mode: request.mode, activeWorkspace: actor.activeWorkspace, mintId: () => randomUUID().replaceAll('-', '') })
    deps.operations.assertDispatch(signal)
    const committed = await commitPreparedWorkspaceImport({ prepared, layoutPath: deps.layoutPath, expectedLayoutVersion: loaded.version, browserStore: deps.tabBrowserStateStore, browserHost: deps.tabBrowser })
    return { layout: serializeLayout(prepared.next), version: committed.version, plan: prepared.plan }
  }
  throw new Error('INVALID_REQUEST')
}
