import type { Node } from '../renderer/layout'
import { formatName } from './names'
import { formatBrowserName } from './browserName'
import { formatEditorName } from './editorName'
import type { LayoutFile, WsLayout, TabLayout, FrozenEntry, BrowserEntry, EditorEntry } from './layoutFile'

// The `.amberws` portable workspace file. Structure (grouping/tree/labels) +
// per-pane scrollback, versioned. Tree leaves are file-local placeholders
// (`p0`, `p1`…) — session names are minted fresh on load.
export const WORKSPACE_VERSION = 1

export interface WsPane {
  id: string // placeholder referenced by tree leaves (p0, p1…)
  kind: string // 'shell' | 'claude' | 'browser' | 'editor' (app-local kinds stored verbatim)
  cwd: string
  ord: number
  frozenNote?: string // presence (incl. '') = frozen; the value is the note
  scrollback: string // base64; '' when no dump was captured (always '' for browser/editor)
  url?: string // browser panes only: the saved address
  // Editor panes only: the file PATH. Contents are NEVER embedded — a loaded
  // editor pane re-reads the file from disk. null = unsaved scratch buffer.
  path?: string | null
}
export interface WsTab {
  tab: number
  label?: string
  tree: Node | null // placeholder-leaf layout tree (null → equal splits on load)
  panes: WsPane[]
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
  let bin = ''
  const CHUNK = 0x8000 // chunk the fromCharCode spread so a 2 MiB dump can't overflow the arg stack
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}
function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// ---- parse (throw on structural breakage, drop malformed optionals) ---------
function isNode(v: unknown): v is Node {
  if (typeof v !== 'object' || v === null) return false
  const n = v as { kind?: unknown }
  if (n.kind === 'leaf') return typeof (v as { paneId?: unknown }).paneId === 'string'
  if (n.kind === 'split') {
    const s = v as { dir?: unknown; ratio?: unknown; a?: unknown; b?: unknown }
    return (s.dir === 'h' || s.dir === 'v') && typeof s.ratio === 'number' && Number.isFinite(s.ratio) && isNode(s.a) && isNode(s.b)
  }
  return false
}

function fail(msg: string): never {
  throw new Error(`invalid workspace file: ${msg}`)
}

function parsePane(v: unknown): WsPane {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail('pane is not an object')
  const p = v as Record<string, unknown>
  if (typeof p['id'] !== 'string') fail('pane.id must be a string')
  if (typeof p['kind'] !== 'string') fail('pane.kind must be a string')
  if (typeof p['cwd'] !== 'string') fail('pane.cwd must be a string')
  if (typeof p['ord'] !== 'number' || !Number.isFinite(p['ord'])) fail('pane.ord must be a number')
  if (typeof p['scrollback'] !== 'string') fail('pane.scrollback must be a string')
  return {
    id: p['id'],
    kind: p['kind'],
    cwd: p['cwd'],
    ord: p['ord'],
    scrollback: p['scrollback'],
    // frozenNote is optional; drop it unless a string ('' is valid = frozen, no note).
    ...(typeof p['frozenNote'] === 'string' ? { frozenNote: p['frozenNote'] } : {}),
    ...(typeof p['url'] === 'string' ? { url: p['url'] } : {}),
    // `path` is string | null; anything else (incl. missing) loads as a scratch
    // buffer rather than failing the whole file.
    ...('path' in p ? { path: typeof p['path'] === 'string' ? p['path'] : null } : {}),
  }
}

function parseTab(v: unknown): WsTab {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail('tab is not an object')
  const t = v as Record<string, unknown>
  if (typeof t['tab'] !== 'number' || !Number.isFinite(t['tab'])) fail('tab.tab must be a number')
  if (!Array.isArray(t['panes'])) fail('tab.panes must be an array')
  const tree = t['tree']
  if (tree !== null && tree !== undefined && !isNode(tree)) fail('tab.tree is a malformed layout node')
  return {
    tab: t['tab'],
    tree: (tree ?? null) as Node | null,
    panes: t['panes'].map(parsePane),
    ...(typeof t['label'] === 'string' ? { label: t['label'] } : {}),
  }
}

function parseWorkspace(v: unknown): WsWorkspace {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail('workspace is not an object')
  const w = v as Record<string, unknown>
  if (!Array.isArray(w['tabs'])) fail('workspace.tabs must be an array')
  return {
    tabs: w['tabs'].map(parseTab),
    ...(typeof w['label'] === 'string' ? { label: w['label'] } : {}),
    ...(Array.isArray(w['tabOrder'])
      ? { tabOrder: w['tabOrder'].filter((n): n is number => typeof n === 'number' && Number.isFinite(n)) }
      : {}),
  }
}

export function parseWorkspaceFile(text: string): WorkspaceDoc {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    fail('not valid JSON')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('top level is not an object')
  const d = raw as Record<string, unknown>
  if (d['version'] !== WORKSPACE_VERSION) throw new Error('unsupported version')
  if (d['scope'] !== 'one' && d['scope'] !== 'all') fail('scope must be "one" or "all"')
  if (!Array.isArray(d['workspaces'])) fail('workspaces must be an array')
  return {
    version: WORKSPACE_VERSION,
    scope: d['scope'],
    workspaces: d['workspaces'].map(parseWorkspace),
  }
}

export function serializeWorkspaceFile(doc: WorkspaceDoc): string {
  return JSON.stringify(doc)
}

// ---- placeholder tree rewrites (pure, both directions) ----------------------
// Rewrite each leaf's paneId through `map`. A leaf with no mapping is DROPPED
// (write-clean: never leak a stale name/placeholder into the output) and its
// split collapses so the sibling takes the space — same discipline as
// layout.removeLeaf. A tree that maps to nothing → null.
function rewriteLeaves(tree: Node | null, map: Record<string, string>): Node | null {
  if (tree === null) return null
  if (tree.kind === 'leaf') {
    const mapped = map[tree.paneId]
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
export interface SavePane { name: string; cwd: string; kind: string; ord: number; url?: string; path?: string | null }
export interface SaveTab { tab: number; panes: SavePane[] }
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
        const id = `p${i}`
        nameToId[p.name] = id
        const dump = dumps[p.name]
        const fz = frozen[p.name]
        return {
          id,
          kind: p.kind,
          cwd: p.cwd,
          ord: p.ord,
          // Browser panes have no daemon scrollback; they carry a URL instead.
          // Browser/editor panes are app-local: no daemon scrollback. They carry
          // a URL / a file path instead.
          scrollback: p.kind === 'browser' || p.kind === 'editor' ? '' : (dump ? toBase64(dump) : ''),
          // Frozen presence must survive even with no note → encode '' so the
          // pane still round-trips as frozen (presence, not truthiness).
          ...(fz ? { frozenNote: fz.note ?? '' } : {}),
          ...(p.kind === 'browser' ? { url: p.url ?? '' } : {}),
          ...(p.kind === 'editor' ? { path: p.path ?? null } : {}),
        }
      })
      return {
        tab: tab.tab,
        tree: treeToPlaceholders(tabSide?.tree ?? null, nameToId),
        panes,
        ...(typeof tabSide?.label === 'string' ? { label: tabSide.label } : {}),
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
  | { mode: 'new'; nextWs: number; mintId: () => string }
  | { mode: 'replace'; ws: number; mintId: () => string }

export interface LoadCreate { name: string; cwd: string; kind: string }
export interface LoadPlan {
  creates: LoadCreate[]
  workspaces: Record<string, WsLayout> // sidecar mutations, keyed by ws-number string
  frozen: Record<string, FrozenEntry> // keyed by minted session name
  scrollback: Record<string, Uint8Array> // keyed by minted session name
  browsers: Record<string, BrowserEntry> // app-local browser panes, keyed by minted browser id
  editors: Record<string, EditorEntry> // app-local editor panes, keyed by minted editor id
  targetWorkspaces: number[] // ws numbers used, in doc order
}

export function buildLoadPlan(doc: WorkspaceDoc, opts: LoadOptions): LoadPlan {
  const base = opts.mode === 'new' ? opts.nextWs : opts.ws
  const creates: LoadCreate[] = []
  const workspaces: Record<string, WsLayout> = {}
  const frozen: Record<string, FrozenEntry> = {}
  const scrollback: Record<string, Uint8Array> = {}
  const browsers: Record<string, BrowserEntry> = {}
  const editors: Record<string, EditorEntry> = {}
  const targetWorkspaces: number[] = []

  doc.workspaces.forEach((ws, wsIdx) => {
    const targetWs = base + wsIdx
    targetWorkspaces.push(targetWs)
    const tabs: Record<string, TabLayout> = {}
    for (const tab of ws.tabs) {
      const idToName: Record<string, string> = {}
      for (const pane of tab.panes) {
        // Browser panes are app-local: mint a browser id, record a sidecar entry,
        // and DO NOT create a daemon session (no `creates` push).
        if (pane.kind === 'browser') {
          const bname = formatBrowserName({ ws: targetWs, tab: tab.tab, ord: pane.ord, id: opts.mintId() })
          idToName[pane.id] = bname
          browsers[bname] = { ws: targetWs, tab: tab.tab, ord: pane.ord, url: pane.url ?? '' }
          continue
        }
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
        if (pane.scrollback !== '') scrollback[name] = fromBase64(pane.scrollback)
      }
      // A saved null tree stays null — the renderer reconciles it to equal
      // splits at mount (core rule #3: grouping reconstructable from names).
      const tree = tab.tree ? treeFromPlaceholders(tab.tree, idToName) : null
      tabs[String(tab.tab)] = { tree, ...(typeof tab.label === 'string' ? { label: tab.label } : {}) }
    }
    const firstTab = ws.tabs[0]?.tab ?? 1
    workspaces[String(targetWs)] = {
      activeTab: firstTab,
      tabs,
      ...(typeof ws.label === 'string' ? { label: ws.label } : {}),
      ...(ws.tabOrder ? { tabOrder: ws.tabOrder } : {}),
    }
  })

  return { creates, workspaces, frozen, scrollback, browsers, editors, targetWorkspaces }
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
  opts: { mode: 'new' | 'replace'; currentWs: number; liveWs: number[]; mintId: () => string },
): LoadPlan {
  const free = nextFreeWs(opts.liveWs)
  if (opts.mode === 'new' || doc.workspaces.length === 0) {
    return buildLoadPlan(doc, { mode: 'new', nextWs: free, mintId: opts.mintId })
  }
  const [first, ...rest] = doc.workspaces
  const firstPlan = buildLoadPlan({ ...doc, workspaces: [first!] }, { mode: 'replace', ws: opts.currentWs, mintId: opts.mintId })
  if (rest.length === 0) return firstPlan
  const restPlan = buildLoadPlan({ ...doc, workspaces: rest }, { mode: 'new', nextWs: free, mintId: opts.mintId })
  return {
    creates: [...firstPlan.creates, ...restPlan.creates],
    workspaces: { ...firstPlan.workspaces, ...restPlan.workspaces },
    frozen: { ...firstPlan.frozen, ...restPlan.frozen },
    scrollback: { ...firstPlan.scrollback, ...restPlan.scrollback },
    browsers: { ...firstPlan.browsers, ...restPlan.browsers },
    editors: { ...firstPlan.editors, ...restPlan.editors },
    targetWorkspaces: [...firstPlan.targetWorkspaces, ...restPlan.targetWorkspaces],
  }
}
