import type { Node } from '../renderer/layout'
import { formatName } from './names'
import { formatEditorName } from './editorName'
import { createBrowserId, safeRestoreUrl, type BrowserId } from './tabBrowser'
import { isDaemonSessionKind, type DaemonSessionKind } from './proto'
import type { LayoutFile, WsLayout, TabLayout, FrozenEntry, BrowserRailLayout, EditorEntry } from './layoutFile'
import { parseBrowserViewport } from './browserViewport'
import { MAX_RAIL_WIDTH, MIN_RAIL_WIDTH } from './browserRail'

// The `.amberws` portable workspace file. Structure (grouping/tree/labels) +
// per-pane scrollback, versioned. Tree leaves are file-local placeholders
// (`p0`, `p1`…) — session names are minted fresh on load.
export const WORKSPACE_VERSION = 2

// Portable workspace files can contain daemon scrollback, so the parser must
// reject hostile input before it allocates the object graph or decodes any
// base64. These are intentionally exported: the Electron main process uses
// the same byte boundary before a native file read/write, and tests can pin the
// accepted maximums without duplicating policy values.
export const WORKSPACE_FILE_MAX_BYTES = 32 * 1024 * 1024
export const WORKSPACE_MAX_WORKSPACES = 32
export const WORKSPACE_MAX_TABS_PER_WORKSPACE = 256
export const WORKSPACE_MAX_PANES_PER_TAB = 256
export const WORKSPACE_MAX_TOTAL_PANES = 4096
export const WORKSPACE_MAX_MAP_ENTRIES = 1024
export const WORKSPACE_MAX_TREE_DEPTH = 64
export const WORKSPACE_MAX_TREE_NODES = 4096
export const WORKSPACE_MAX_STRING_BYTES = 16 * 1024
export const WORKSPACE_MAX_PATH_BYTES = 4096
export const WORKSPACE_MAX_URL_BYTES = 8192
export const WORKSPACE_MAX_NOTE_BYTES = 4096
export const WORKSPACE_SCROLLBACK_MAX_BYTES = 2 * 1024 * 1024
export const WORKSPACE_TOTAL_SCROLLBACK_MAX_BYTES = 16 * 1024 * 1024
export const WORKSPACE_MAX_RECOVERY_ITEMS = 100
// Four base64 characters encode three bytes. Permit the normal padded form and
// the final partial quantum, with one extra quantum for harmless padding.
export const WORKSPACE_SCROLLBACK_MAX_CHARS = Math.ceil(WORKSPACE_SCROLLBACK_MAX_BYTES / 3) * 4
export const WORKSPACE_TOTAL_SCROLLBACK_MAX_CHARS = Math.ceil(WORKSPACE_TOTAL_SCROLLBACK_MAX_BYTES / 3) * 4

export function utf8ByteLength(value: string, stopAfter = Number.MAX_SAFE_INTEGER): number {
  let bytes = 0
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length
      && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i += 1 }
    else bytes += 3
    if (bytes > stopAfter) return bytes
  }
  return bytes
}

export function assertWorkspaceFileBytes(text: string): void {
  if (utf8ByteLength(text, WORKSPACE_FILE_MAX_BYTES) > WORKSPACE_FILE_MAX_BYTES) throw new Error('WORKSPACE_FILE_LIMIT')
}

export type AppLocalPaneKind = 'browser' | 'editor'
export type WorkspacePaneKind = DaemonSessionKind | AppLocalPaneKind

function isWorkspacePaneKind(kind: string): kind is WorkspacePaneKind {
  return isDaemonSessionKind(kind) || kind === 'browser' || kind === 'editor'
}

export interface WsPane {
  id: string // placeholder referenced by tree leaves (p0, p1…)
  kind: WorkspacePaneKind
  cwd: string
  ord: number
  frozenNote?: string // presence (incl. '') = frozen; the value is the note
  scrollback: string // base64; '' when no dump was captured (always '' for browser/editor)
  url?: string // browser panes only: the saved address
  // Editor panes only: the file PATH. Contents are NEVER embedded — a loaded
  // editor pane re-reads the file from disk. null = unsaved scratch buffer.
  path?: string | null
}
export interface WsBrowser {
  mode: 'preview' | 'browse'
  safeRestoreUrl: string
  viewport?: { width: number; height: number }
  collapsed?: boolean
  width?: number
}
export interface WsTab {
  tab: number
  label?: string
  tree: Node | null // placeholder-leaf layout tree (null → equal splits on load)
  panes: WsPane[]
  browser?: WsBrowser
  /** Extra v1 browser leaves retained for explicit recovery, never serialized in v2. */
  browserRecovery?: WsBrowser[]
}
export interface WsWorkspace {
  label?: string
  tabOrder?: number[]
  tabs: WsTab[]
}
export interface WorkspaceDoc {
  version: number
  scope: 'one' | 'all'
  workspaces: WsWorkspace[]
}

// ---- base64 (no Node Buffer — works in renderer + vitest node env) ----------
function toBase64(bytes: Uint8Array): string {
  if (bytes.byteLength > WORKSPACE_SCROLLBACK_MAX_BYTES) throw new Error('WORKSPACE_SCROLLBACK_LIMIT')
  let bin = ''
  const CHUNK = 0x8000 // chunk the fromCharCode spread so a 2 MiB dump can't overflow the arg stack
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}
function fromBase64(b64: string): Uint8Array {
  if (b64.length > WORKSPACE_SCROLLBACK_MAX_CHARS) throw new Error('WORKSPACE_SCROLLBACK_LIMIT')
  let bin: string
  try { bin = atob(b64) } catch { throw new Error('WORKSPACE_SCROLLBACK_INVALID') }
  if (bin.length > WORKSPACE_SCROLLBACK_MAX_BYTES) throw new Error('WORKSPACE_SCROLLBACK_LIMIT')
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

interface ParseBudget { panes: number; scrollbackChars: number; treeNodes: number; recovery: number }
function utf8Bytes(value: string): number { return utf8ByteLength(value) }
function boundedString(value: unknown, limit: number, code: string): string {
  if (typeof value !== 'string') fail(code)
  if (utf8Bytes(value) > limit) fail(code)
  return value
}
function safeMapKey(value: string, code: string): string {
  if (value === '__proto__' || value === 'constructor' || value === 'prototype') fail(code)
  return value
}
function fail(msg: string): never {
  throw new Error(msg)
}

// Validate without recursive calls. A malicious split chain must not consume
// the JS call stack before the depth/node limits reject it.
function isNode(v: unknown, budget: ParseBudget): v is Node {
  if (v === null) return true
  if (typeof v !== 'object' || Array.isArray(v)) return false
  const stack: Array<{ value: unknown; depth: number }> = [{ value: v, depth: 1 }]
  while (stack.length > 0) {
    const current = stack.pop()!
    if (++budget.treeNodes > WORKSPACE_MAX_TREE_NODES || current.depth > WORKSPACE_MAX_TREE_DEPTH) return false
    if (typeof current.value !== 'object' || current.value === null || Array.isArray(current.value)) return false
    const node = current.value as Record<string, unknown>
    if (node['kind'] === 'leaf') {
      if (typeof node['paneId'] !== 'string' || utf8Bytes(node['paneId']) > WORKSPACE_MAX_STRING_BYTES
        || node['paneId'] === '__proto__' || node['paneId'] === 'constructor' || node['paneId'] === 'prototype') return false
      continue
    }
    if (node['kind'] !== 'split' || (node['dir'] !== 'h' && node['dir'] !== 'v') || typeof node['ratio'] !== 'number'
      || !Number.isFinite(node['ratio']) || node['ratio'] < 0 || node['ratio'] > 1 || !('a' in node) || !('b' in node)) return false
    stack.push({ value: node['b'], depth: current.depth + 1 }, { value: node['a'], depth: current.depth + 1 })
  }
  return true
}

function parsePane(v: unknown, budget: ParseBudget): WsPane {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail('WORKSPACE_PANE_SHAPE')
  const p = v as Record<string, unknown>
  const id = safeMapKey(boundedString(p['id'], WORKSPACE_MAX_STRING_BYTES, 'WORKSPACE_PANE_STRING_LIMIT'), 'WORKSPACE_PANE_KEY')
  const kind = p['kind']
  if (typeof kind !== 'string' || !isWorkspacePaneKind(kind)) fail('WORKSPACE_PANE_KIND: pane.kind is unsupported')
  const cwd = boundedString(p['cwd'], WORKSPACE_MAX_PATH_BYTES, 'WORKSPACE_PATH_LIMIT')
  if (typeof p['ord'] !== 'number' || !Number.isFinite(p['ord'])) fail('WORKSPACE_PANE_ORD')
  const scrollback = boundedString(p['scrollback'], WORKSPACE_SCROLLBACK_MAX_CHARS, 'WORKSPACE_SCROLLBACK_LIMIT')
  budget.panes += 1
  if (budget.panes > WORKSPACE_MAX_TOTAL_PANES) fail('WORKSPACE_PANE_LIMIT')
  budget.scrollbackChars += scrollback.length
  if (budget.scrollbackChars > WORKSPACE_TOTAL_SCROLLBACK_MAX_CHARS) fail('WORKSPACE_SCROLLBACK_LIMIT')
  if (scrollback !== '' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(scrollback)) fail('WORKSPACE_SCROLLBACK_INVALID')
  const frozenNote = typeof p['frozenNote'] === 'string'
    ? boundedString(p['frozenNote'], WORKSPACE_MAX_NOTE_BYTES, 'WORKSPACE_NOTE_LIMIT') : undefined
  const url = kind === 'browser' && typeof p['url'] === 'string'
    ? safeRestoreUrl(boundedString(p['url'], WORKSPACE_MAX_URL_BYTES, 'WORKSPACE_URL_LIMIT')) : undefined
  const path = 'path' in p
    ? (p['path'] === null ? null : typeof p['path'] === 'string' ? boundedString(p['path'], WORKSPACE_MAX_PATH_BYTES, 'WORKSPACE_PATH_LIMIT') : null)
    : undefined
  return {
    id,
    kind,
    cwd,
    ord: p['ord'],
    scrollback,
    ...(frozenNote !== undefined ? { frozenNote } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(path !== undefined ? { path } : {}),
  }
}

function parseWsBrowser(v: unknown): WsBrowser {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail('WORKSPACE_BROWSER_SHAPE')
  const b = v as Record<string, unknown>
  if (b['mode'] !== 'preview' && b['mode'] !== 'browse') fail('WORKSPACE_BROWSER_MODE')
  const safeUrl = boundedString(b['safeRestoreUrl'], WORKSPACE_MAX_URL_BYTES, 'WORKSPACE_URL_LIMIT')
  const viewport = b['viewport'] === undefined ? undefined : parseBrowserViewport(b['viewport'])
  if (b['viewport'] !== undefined && !viewport) fail('WORKSPACE_BROWSER_VIEWPORT: browser viewport is invalid')
  const width = b['width']
  if (width !== undefined && (typeof width !== 'number' || !Number.isSafeInteger(width) || width < MIN_RAIL_WIDTH || width > MAX_RAIL_WIDTH)) fail('WORKSPACE_BROWSER_WIDTH')
  return {
    mode: b['mode'], safeRestoreUrl: safeRestoreUrl(safeUrl),
    ...(viewport ? { viewport } : {}),
    ...(typeof b['collapsed'] === 'boolean' ? { collapsed: b['collapsed'] } : {}), ...(typeof width === 'number' ? { width } : {}),
  }
}

function parseTab(v: unknown, version: 1 | 2, budget: ParseBudget): WsTab {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail('WORKSPACE_TAB_SHAPE')
  const t = v as Record<string, unknown>
  if (typeof t['tab'] !== 'number' || !Number.isFinite(t['tab'])) fail('WORKSPACE_TAB_NUMBER')
  if (!Array.isArray(t['panes'])) fail('WORKSPACE_PANE_ARRAY')
  if (t['panes'].length > WORKSPACE_MAX_PANES_PER_TAB) fail('WORKSPACE_PANE_LIMIT')
  const tree = t['tree']
  if (tree !== null && tree !== undefined && !isNode(tree, budget)) fail('WORKSPACE_TREE_LIMIT')
  const parsedPanes = t['panes'].map((pane) => parsePane(pane, budget))
  if (version === 2 && parsedPanes.some((pane) => pane.kind === 'browser')) fail('v2 browser must be tab-owned')
  const ids = new Set<string>()
  for (const pane of parsedPanes) { if (ids.has(pane.id)) fail('duplicate pane placeholder'); ids.add(pane.id) }
  const browserPanes = version === 1 ? parsedPanes.filter((pane) => pane.kind === 'browser').sort((a, b) => a.ord - b.ord || a.id.localeCompare(b.id)) : []
  budget.recovery += Math.max(0, browserPanes.length - 1)
  if (budget.recovery > WORKSPACE_MAX_RECOVERY_ITEMS) fail('WORKSPACE_RECOVERY_LIMIT')
  const panes = version === 1 ? parsedPanes.filter((pane) => pane.kind !== 'browser') : parsedPanes
  const browserIds = new Set(browserPanes.map((pane) => pane.id))
  const removeBrowsers = (node: Node | null): Node | null => {
    if (!node) return null
    if (node.kind === 'leaf') return browserIds.has(node.paneId) ? null : node
    const a = removeBrowsers(node.a); const b = removeBrowsers(node.b)
    if (!a) return b; if (!b) return a
    return { ...node, a, b }
  }
  const cleanTree = version === 1 ? removeBrowsers((tree ?? null) as Node | null) : (tree ?? null) as Node | null
  const referenced = new Set<string>()
  const visit = (node: Node | null): void => { if (!node) return; if (node.kind === 'leaf') referenced.add(node.paneId); else { visit(node.a); visit(node.b) } }
  visit(cleanTree)
  if (version === 2 && [...referenced].some((id) => !ids.has(id))) fail('tree references unknown placeholder')
  const legacyBrowsers = browserPanes.map((pane) => ({ mode: 'browse' as const, safeRestoreUrl: safeRestoreUrl(pane.url ?? '') }))
  return {
    tab: t['tab'], tree: cleanTree, panes,
    ...(typeof t['label'] === 'string' ? { label: boundedString(t['label'], WORKSPACE_MAX_STRING_BYTES, 'WORKSPACE_STRING_LIMIT') } : {}),
    ...(version === 2 && t['browser'] !== undefined ? { browser: parseWsBrowser(t['browser']) } : {}),
    ...(legacyBrowsers[0] ? { browser: legacyBrowsers[0] } : {}),
    ...(legacyBrowsers.length > 1 ? { browserRecovery: legacyBrowsers.slice(1) } : {}),
  }
}

function parseWorkspace(v: unknown, version: 1 | 2, budget: ParseBudget): WsWorkspace {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail('WORKSPACE_WORKSPACE_SHAPE')
  const w = v as Record<string, unknown>
  if (!Array.isArray(w['tabs'])) fail('WORKSPACE_TAB_ARRAY')
  if (w['tabs'].length > WORKSPACE_MAX_TABS_PER_WORKSPACE) fail('WORKSPACE_TAB_LIMIT')
  const label = typeof w['label'] === 'string' ? boundedString(w['label'], WORKSPACE_MAX_STRING_BYTES, 'WORKSPACE_STRING_LIMIT') : undefined
  if (Array.isArray(w['tabOrder']) && w['tabOrder'].length > WORKSPACE_MAX_TABS_PER_WORKSPACE) fail('WORKSPACE_TAB_ORDER_LIMIT')
  const tabOrder = Array.isArray(w['tabOrder'])
    ? w['tabOrder'].filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    : undefined
  return {
    tabs: w['tabs'].map((tab) => parseTab(tab, version, budget)),
    ...(label !== undefined ? { label } : {}),
    ...(tabOrder ? { tabOrder } : {}),
  }
}

export function parseWorkspaceFile(text: string): WorkspaceDoc {
  assertWorkspaceFileBytes(text)
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    fail('WORKSPACE_JSON_INVALID')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('WORKSPACE_TOP_LEVEL')
  const d = raw as Record<string, unknown>
  // Check the version before touching any collection. A future file is opaque
  // data, not an empty document that may later be rewritten by a save path.
  if (d['version'] !== 1 && d['version'] !== WORKSPACE_VERSION) throw new Error('WORKSPACE_UNSUPPORTED_VERSION: unsupported version')
  if (d['scope'] !== 'one' && d['scope'] !== 'all') fail('WORKSPACE_SCOPE')
  if (!Array.isArray(d['workspaces'])) fail('WORKSPACE_WORKSPACE_ARRAY: workspaces must be an array')
  if (d['workspaces'].length > WORKSPACE_MAX_WORKSPACES) fail('WORKSPACE_WORKSPACE_LIMIT')
  const budget: ParseBudget = { panes: 0, scrollbackChars: 0, treeNodes: 0, recovery: 0 }
  return {
    version: WORKSPACE_VERSION,
    scope: d['scope'],
    workspaces: d['workspaces'].map((workspace) => parseWorkspace(workspace, d['version'] as 1 | 2, budget)),
  }
}

export function serializeWorkspaceFile(doc: WorkspaceDoc): string {
  const text = JSON.stringify({
    version: WORKSPACE_VERSION, scope: doc.scope,
    workspaces: doc.workspaces.map((workspace) => ({ ...workspace, tabs: workspace.tabs.map(({ browserRecovery: _recovery, ...tab }) => tab) })),
  })
  assertWorkspaceFileBytes(text)
  return text
}

// ---- placeholder tree rewrites (pure, both directions) ----------------------
// Rewrite each leaf's paneId through `map`. A leaf with no mapping is DROPPED
// (write-clean: never leak a stale name/placeholder into the output) and its
// split collapses so the sibling takes the space — same discipline as
// layout.removeLeaf. A tree that maps to nothing → null.
function rewriteLeaves(tree: Node | null, map: Record<string, string>): Node | null {
  if (tree === null) return null
  if (tree.kind === 'leaf') {
    const mapped = Object.hasOwn(map, tree.paneId) ? map[tree.paneId] : undefined
    return mapped === undefined ? null : { kind: 'leaf', paneId: mapped }
  }
  const a = rewriteLeaves(tree.a, map)
  const b = rewriteLeaves(tree.b, map)
  if (a === null) return b
  if (b === null) return a
  return { ...tree, a, b }
}
export function treeToPlaceholders(tree: Node | null, nameToId: Record<string, string>): Node | null {
  return rewriteLeaves(tree, nameToId)
}
export function treeFromPlaceholders(tree: Node | null, idToName: Record<string, string>): Node | null {
  return rewriteLeaves(tree, idToName)
}

// ---- assemble a save doc from live groupings + sidecar + dumps --------------
// Narrow structural inputs (superset-compatible with store.ts's WorkspaceModel/
// TabModel/PaneModel) so this module stays pure and never imports the renderer
// store.
export type WorkspaceBrowserSnapshots = Record<string, { mode: 'preview' | 'browse'; safeRestoreUrl: string; viewport: { width: number; height: number } }>
export function requireWorkspaceBrowserSnapshots(reply: { ok?: boolean; result?: WorkspaceBrowserSnapshots }, expectedIds: readonly string[] = []): WorkspaceBrowserSnapshots {
  if (!reply.ok) throw new Error('browser snapshot unavailable')
  const result = reply.result ?? {}
  if (expectedIds.some((id) => !Object.hasOwn(result, id))) throw new Error('browser snapshot incomplete')
  return result
}

export interface SavePane { name: string; cwd: string; kind: string; ord: number; path?: string | null }
export interface SaveTab { tab: number; panes: SavePane[]; browser?: WsBrowser }
export interface SaveWorkspace { ws: number; tabs: SaveTab[] }

// Precondition: `live` and `sidecar` derive from the same reconciled state —
// each sidecar tab tree's leaves name the live sessions in that tab. A leaf
// naming a session absent from live panes is dropped (rewriteLeaves), never
// leaked into the file.
export function assembleSave(
  scope: 'one' | 'all',
  live: SaveWorkspace[],
  sidecar: LayoutFile,
  dumps: Record<string, Uint8Array>,
): WorkspaceDoc {
  const frozen = sidecar.frozen ?? {}
  const workspaces: WsWorkspace[] = live.map((ws) => {
    const wsSide = sidecar.workspaces[String(ws.ws)]
    const tabs: WsTab[] = ws.tabs.map((tab) => {
      const tabSide = wsSide?.tabs[String(tab.tab)]
      // Placeholder per pane, in ord order (live groupings already sort by ord).
      const nameToId: Record<string, string> = {}
      const panes: WsPane[] = tab.panes.map((p, i) => {
        if (!isWorkspacePaneKind(p.kind) || p.kind === 'browser') throw new Error(`unsupported live pane kind: ${p.kind}`)
        const id = `p${i}`
        nameToId[p.name] = id
        const dump = dumps[p.name]
        const fz = frozen[p.name]
        return {
          id,
          kind: p.kind,
          cwd: p.cwd,
          ord: p.ord,
          // Editor panes are app-local and have no daemon scrollback.
          scrollback: p.kind === 'editor' ? '' : (dump ? toBase64(dump) : ''),
          // Frozen presence must survive even with no note → encode '' so the
          // pane still round-trips as frozen (presence, not truthiness).
          ...(fz ? { frozenNote: fz.note ?? '' } : {}),
          ...(p.kind === 'editor' ? { path: p.path ?? null } : {}),
        }
      })
      return {
        tab: tab.tab,
        tree: treeToPlaceholders(tabSide?.tree ?? null, nameToId),
        panes,
        ...(typeof tabSide?.label === 'string' ? { label: tabSide.label } : {}),
        ...(tab.browser ? { browser: { ...tab.browser, safeRestoreUrl: safeRestoreUrl(tab.browser.safeRestoreUrl) } } : {}),
      }
    })
    return {
      tabs,
      ...(typeof wsSide?.label === 'string' ? { label: wsSide.label } : {}),
      ...(wsSide?.tabOrder ? { tabOrder: wsSide.tabOrder } : {}),
    }
  })
  return { version: WORKSPACE_VERSION, scope, workspaces }
}

// ---- build a load plan (pure; name minting injected for deterministic tests) -
export type LoadOptions =
  | { mode: 'new'; nextWs: number; mintId: () => string; mintBrowserId?: () => BrowserId; existingBrowserIds?: Set<string> }
  | { mode: 'replace'; ws: number; mintId: () => string; mintBrowserId?: () => BrowserId; existingBrowserIds?: Set<string> }

export interface LoadCreate { name: string; cwd: string; kind: DaemonSessionKind }
export interface BrowserLoadIntent { id: BrowserId; ws: number; tab: number; browser: WsBrowser; rail: BrowserRailLayout }
export interface BrowserRecoveryIntent { ws: number; tab: number; browser: WsBrowser }
export interface LoadPlan {
  creates: LoadCreate[]
  workspaces: Record<string, WsLayout> // sidecar mutations, keyed by ws-number string
  frozen: Record<string, FrozenEntry> // keyed by minted session name
  scrollback: Record<string, Uint8Array> // keyed by minted session name
  browserRails: BrowserLoadIntent[]
  browserRecovery: BrowserRecoveryIntent[]
  editors: Record<string, EditorEntry> // app-local editor panes, keyed by minted editor id
  targetWorkspaces: number[] // ws numbers used, in doc order
}

export function buildLoadPlan(doc: WorkspaceDoc, opts: LoadOptions): LoadPlan {
  const base = opts.mode === 'new' ? opts.nextWs : opts.ws
  const creates: LoadCreate[] = []
  const workspaces: Record<string, WsLayout> = {}
  const frozen: Record<string, FrozenEntry> = {}
  const scrollback: Record<string, Uint8Array> = {}
  let totalScrollbackBytes = 0
  const editors: Record<string, EditorEntry> = {}
  const browserRails: BrowserLoadIntent[] = []
  const browserRecovery: BrowserRecoveryIntent[] = []
  const usedBrowserIds = new Set(opts.existingBrowserIds ?? [])
  const mintBrowser = (): BrowserId => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const id = opts.mintBrowserId ? opts.mintBrowserId() : createBrowserId()
      if (!usedBrowserIds.has(id)) { usedBrowserIds.add(id); return id }
    }
    throw new Error('browser id collision limit exceeded')
  }
  const targetWorkspaces: number[] = []

  doc.workspaces.forEach((ws, wsIdx) => {
    const targetWs = base + wsIdx
    targetWorkspaces.push(targetWs)
    const tabs: Record<string, TabLayout> = {}
    for (const tab of ws.tabs) {
      const idToName: Record<string, string> = {}
      for (const pane of tab.panes) {
        // Browser pane placeholders are a v1 wire concern. Parsed documents
        // migrate them to tab.browser before planning and v2 rejects them.
        if (pane.kind === 'browser') continue
        // Editor panes are app-local too (same class as browser): sidecar entry,
        // no daemon session. Only the path is restored; contents come from disk.
        if (pane.kind === 'editor') {
          const ename = formatEditorName({ ws: targetWs, tab: tab.tab, ord: pane.ord, id: opts.mintId() })
          idToName[pane.id] = ename
          editors[ename] = { ws: targetWs, tab: tab.tab, ord: pane.ord, path: pane.path ?? null }
          continue
        }
        const name = formatName({ ws: targetWs, tab: tab.tab, ord: pane.ord, id: opts.mintId() })
        idToName[pane.id] = name
        creates.push({ name, cwd: pane.cwd, kind: pane.kind })
        if (pane.frozenNote !== undefined) frozen[name] = pane.frozenNote === '' ? {} : { note: pane.frozenNote }
        if (pane.scrollback !== '') {
          const bytes = fromBase64(pane.scrollback)
          totalScrollbackBytes += bytes.byteLength
          if (totalScrollbackBytes > WORKSPACE_TOTAL_SCROLLBACK_MAX_BYTES) throw new Error('WORKSPACE_SCROLLBACK_LIMIT')
          scrollback[name] = bytes
        }
      }
      // A saved null tree stays null — the renderer reconciles it to equal
      // splits at mount (core rule #3: grouping reconstructable from names).
      const tree = tab.tree ? treeFromPlaceholders(tab.tree, idToName) : null
      let rail: BrowserRailLayout | undefined
      if (tab.browser) {
        const id = mintBrowser()
        rail = { id, width: tab.browser.width ?? 420, collapsed: tab.browser.collapsed ?? false }
        browserRails.push({ id, ws: targetWs, tab: tab.tab, browser: tab.browser, rail })
      }
      for (const browser of tab.browserRecovery ?? []) browserRecovery.push({ ws: targetWs, tab: tab.tab, browser })
      tabs[String(tab.tab)] = { tree, ...(typeof tab.label === 'string' ? { label: tab.label } : {}), ...(rail ? { browser: rail } : {}) }
    }
    const firstTab = ws.tabs[0]?.tab ?? 1
    workspaces[String(targetWs)] = {
      activeTab: firstTab,
      tabs,
      ...(typeof ws.label === 'string' ? { label: ws.label } : {}),
      ...(ws.tabOrder ? { tabOrder: ws.tabOrder } : {}),
    }
  })

  return { creates, workspaces, frozen, scrollback, browserRails, browserRecovery, editors, targetWorkspaces }
}

// Lowest free workspace number: one above the highest live number (gaps are NOT
// reused — always max+1, matching the toolbar "+ ws" button). Empty → 1.
export function nextFreeWs(liveWs: number[]): number {
  return (liveWs.length ? Math.max(...liveWs) : 0) + 1
}

// Policy layer over buildLoadPlan (keeps that pure primitive untouched):
// - new: every file workspace lands at a free number above max live ws.
// - replace: the CURRENT workspace is replaced with the file's FIRST workspace;
//   any remaining file workspaces load as NEW workspaces at free numbers above
//   max live ws. Free allocation always scans ALL live workspaces (nextFreeWs).
export function planLoad(
  doc: WorkspaceDoc,
  opts: { mode: 'new' | 'replace'; currentWs: number; liveWs: number[]; mintId: () => string; mintBrowserId?: () => BrowserId; existingBrowserIds?: Set<string> },
): LoadPlan {
  const free = nextFreeWs(opts.liveWs)
  if (opts.mode === 'new' || doc.workspaces.length === 0) {
    return buildLoadPlan(doc, { mode: 'new', nextWs: free, mintId: opts.mintId, ...(opts.mintBrowserId ? { mintBrowserId: opts.mintBrowserId } : {}), ...(opts.existingBrowserIds ? { existingBrowserIds: opts.existingBrowserIds } : {}) })
  }
  const [first, ...rest] = doc.workspaces
  const firstPlan = buildLoadPlan({ ...doc, workspaces: [first!] }, { mode: 'replace', ws: opts.currentWs, mintId: opts.mintId, ...(opts.mintBrowserId ? { mintBrowserId: opts.mintBrowserId } : {}), ...(opts.existingBrowserIds ? { existingBrowserIds: opts.existingBrowserIds } : {}) })
  if (rest.length === 0) return firstPlan
  const used = new Set([...(opts.existingBrowserIds ?? []), ...firstPlan.browserRails.map((entry) => entry.id)])
  const restPlan = buildLoadPlan({ ...doc, workspaces: rest }, { mode: 'new', nextWs: free, mintId: opts.mintId, ...(opts.mintBrowserId ? { mintBrowserId: opts.mintBrowserId } : {}), existingBrowserIds: used })
  return {
    creates: [...firstPlan.creates, ...restPlan.creates],
    workspaces: { ...firstPlan.workspaces, ...restPlan.workspaces },
    frozen: { ...firstPlan.frozen, ...restPlan.frozen },
    scrollback: { ...firstPlan.scrollback, ...restPlan.scrollback },
    browserRails: [...firstPlan.browserRails, ...restPlan.browserRails],
    browserRecovery: [...firstPlan.browserRecovery, ...restPlan.browserRecovery],
    editors: { ...firstPlan.editors, ...restPlan.editors },
    targetWorkspaces: [...firstPlan.targetWorkspaces, ...restPlan.targetWorkspaces],
  }
}
