import type { Node } from '../renderer/layout'
import { clampStoredRailWidth } from './browserRail'

export const LAYOUT_VERSION = 1
export const TAB_BROWSER_LAYOUT_VERSION = 2

// The sidecar is normally only a few KB, but it is also read by the resident
// main process and by the Rust web client. Bound both the file and its object
// graph before any recursive renderer helper can see it.
export const LAYOUT_FILE_MAX_BYTES = 8 * 1024 * 1024
export const LAYOUT_MAX_WORKSPACES = 256
export const LAYOUT_MAX_TABS_PER_WORKSPACE = 1024
export const LAYOUT_MAX_MAP_ENTRIES = 4096
export const LAYOUT_MAX_TREE_DEPTH = 64
export const LAYOUT_MAX_TREE_NODES = 4096
export const LAYOUT_MAX_STRING_BYTES = 16 * 1024
export interface BrowserRailLayout { id: string; width: number; collapsed: boolean; designatedPi?: string; sharedWithPi?: boolean }
// `label` is app-owned display metadata ONLY (never touches daemon session
// names). All added fields are OPTIONAL — old sidecars parse fine (missing →
// undefined) and old readers ignore unknown-but-additive keys.
export interface TabLayout { tree: Node | null; label?: string; browser?: BrowserRailLayout }
export interface WsLayout { activeTab: number; tabs: Record<string, TabLayout>; label?: string; tabOrder?: number[] }
// `fontSize` is an app-owned top-level display preference (optional — old
// sidecars omit it → undefined → the renderer's default).
// `frozen` parks panes (display-only, never touches the daemon): a map keyed by
// SESSION NAME → optional note. Session names are stable across reboots, so
// parking survives restart; stale entries are pruned on load-reconcile.
export interface FrozenEntry { note?: string }
// Decode-only v1 browser-pane payload. Startup migration consumes this field;
// v2 writers never emit it and runtime code must not create or preserve it.
export interface BrowserEntry { ws: number; tab: number; ord: number; url: string }
// `editors` are app-local file-editor panes, keyed by an
// `editor-<ws>-<tab>-<ord>-<id>` paneId. This map is the pane's entire
// existence: grouping (ws/tab/ord) + the file path + per-pane view prefs.
// `path: null` = an unsaved scratch buffer. Buffer TEXT never lives here (the
// sidecar is small and rewritten often — drafts go to <state>/drafts/).
export interface EditorEntry {
  ws: number
  tab: number
  ord: number
  path: string | null
  view?: 'code' | 'split' | 'preview'
  outline?: boolean
  wrap?: boolean
}
export const RECENT_FILES_MAX = 20
export interface LayoutFile {
  version: number
  activeWorkspace: number
  workspaces: Record<string, WsLayout>
  fontSize?: number
  frozen?: Record<string, FrozenEntry>
  browsers?: Record<string, BrowserEntry>
  editors?: Record<string, EditorEntry>
  recentFiles?: string[] // most-recent-first, deduped, capped at RECENT_FILES_MAX
  browserRevision?: number
  /** In-memory guard only: an unknown future on-disk version must never be overwritten. */
  readOnly?: true
}

// Shape-guard the frozen map (Task 4 lesson): reject a non-object/array top
// level → undefined; drop non-object entries; coerce a non-string note away.
export function layoutUtf8ByteLength(value: string, stopAfter = Number.MAX_SAFE_INTEGER): number {
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
function utf8Bytes(value: string): number { return layoutUtf8ByteLength(value) }
function layoutString(value: string, limit = LAYOUT_MAX_STRING_BYTES): string {
  if (utf8Bytes(value) > limit) throw new Error('LAYOUT_STRING_LIMIT')
  return value
}
function safeMapKey(value: string): string {
  if (value === '__proto__' || value === 'constructor' || value === 'prototype') throw new Error('LAYOUT_MAP_KEY')
  return value
}
function mapEntries(value: object, code: string, max = LAYOUT_MAX_MAP_ENTRIES): [string, unknown][] {
  const entries = Object.entries(value)
  if (entries.length > max) throw new Error(code)
  return entries
}

function parseFrozen(v: unknown): Record<string, FrozenEntry> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const out: Record<string, FrozenEntry> = {}
  for (const [rawName, entry] of mapEntries(v, 'LAYOUT_MAP_LIMIT')) {
    const name = safeMapKey(layoutString(rawName))
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const note = (entry as { note?: unknown }).note
    out[name] = typeof note === 'string' ? { note: layoutString(note) } : {}
  }
  return out
}

// Shape-guard the browsers map (same lesson as parseFrozen): reject a
// non-object/array top level; drop entries missing/mistyping any field. A
// malformed entry is silently dropped so a hand-edited sidecar never throws.
function parseBrowsers(v: unknown): Record<string, BrowserEntry> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const out: Record<string, BrowserEntry> = {}
  for (const [rawName, e] of mapEntries(v, 'LAYOUT_MAP_LIMIT')) {
    const name = safeMapKey(layoutString(rawName))
    if (typeof e !== 'object' || e === null || Array.isArray(e)) continue
    const { ws, tab, ord, url } = e as Record<string, unknown>
    if (typeof ws === 'number' && typeof tab === 'number' && typeof ord === 'number' && typeof url === 'string'
        && Number.isFinite(ws) && Number.isFinite(tab) && Number.isFinite(ord)) {
      out[name] = { ws, tab, ord, url: layoutString(url) }
    }
  }
  return out
}

// Shape-guard the editors map (same lesson as parseBrowsers). Note `path` is
// `string | null` — null is the legitimate unsaved-scratch case, NOT a malformed
// entry. Optional view/outline/wrap are dropped individually when mistyped so a
// hand-edited pref never costs the user the pane.
function parseEditors(v: unknown): Record<string, EditorEntry> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const out: Record<string, EditorEntry> = {}
  for (const [rawName, e] of mapEntries(v, 'LAYOUT_MAP_LIMIT')) {
    const name = safeMapKey(layoutString(rawName))
    if (typeof e !== 'object' || e === null || Array.isArray(e)) continue
    const { ws, tab, ord, path, view, outline, wrap } = e as Record<string, unknown>
    if (typeof ws !== 'number' || typeof tab !== 'number' || typeof ord !== 'number') continue
    if (!Number.isFinite(ws) || !Number.isFinite(tab) || !Number.isFinite(ord)) continue
    if (typeof path !== 'string' && path !== null) continue
    out[name] = {
      ws, tab, ord, path: typeof path === 'string' ? layoutString(path) : path,
      ...(view === 'code' || view === 'split' || view === 'preview' ? { view } : {}),
      ...(typeof outline === 'boolean' ? { outline } : {}),
      ...(typeof wrap === 'boolean' ? { wrap } : {}),
    }
  }
  return out
}

// Most-recent-first, deduped, capped. The invariant lives in the parser too so a
// hand-edited sidecar can't grow the list without bound.
function parseRecentFiles(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  if (v.length > LAYOUT_MAX_MAP_ENTRIES) throw new Error('LAYOUT_ARRAY_LIMIT')
  const out: string[] = []
  const seen = new Set<string>()
  for (const candidate of v) {
    if (typeof candidate !== 'string' || seen.has(candidate)) continue
    seen.add(candidate)
    out.push(layoutString(candidate))
    if (out.length === RECENT_FILES_MAX) break
  }
  return out
}

// Add a path to the recents list (most-recent-first, deduped, capped).
export function pushRecent(list: string[] | undefined, path: string): string[] {
  return [path, ...(list ?? []).filter((p) => p !== path)].slice(0, RECENT_FILES_MAX)
}

// Shape-guard each workspace's hand-editable display fields (same lesson as
// parseFrozen): a non-array `tabOrder` would throw in `orderTabs` on every
// render, a non-string `label` renders garbage. Drop `tabOrder` unless it's an
// array (filtered to finite numbers); drop `label` unless it's a string. Other
// fields (activeTab, tabs) pass through — malformed non-objects are skipped.
function parseBrowserRail(v: unknown): BrowserRailLayout | undefined {
  if (!isPlainObj(v) || typeof v['id'] !== 'string' || !/^browser-[0-9a-f]{32}$/.test(v['id'])) return undefined
  if (typeof v['width'] !== 'number' || !Number.isFinite(v['width']) || typeof v['collapsed'] !== 'boolean') return undefined
  return {
    id: v['id'], width: clampStoredRailWidth(v['width']), collapsed: v['collapsed'],
    ...(typeof v['designatedPi'] === 'string' ? { designatedPi: layoutString(v['designatedPi']) } : {}),
    ...(typeof v['sharedWithPi'] === 'boolean' ? { sharedWithPi: v['sharedWithPi'] } : {}),
  }
}

interface LayoutParseBudget { treeNodes: number }

// Validate tree shape iteratively. Returning the original JSON object is safe
// after this pass because every object is JSON-created and every child has
// already passed the bounded shape checks.
function parseTree(v: unknown, budget: LayoutParseBudget): Node | null | false {
  if (v === null) return null
  if (!isPlainObj(v)) return false
  const stack: Array<{ value: unknown; depth: number }> = [{ value: v, depth: 1 }]
  while (stack.length > 0) {
    const current = stack.pop()!
    if (++budget.treeNodes > LAYOUT_MAX_TREE_NODES || current.depth > LAYOUT_MAX_TREE_DEPTH) return false
    if (!isPlainObj(current.value)) return false
    if (current.value['kind'] === 'leaf') {
      if (typeof current.value['paneId'] !== 'string' || utf8Bytes(current.value['paneId']) > LAYOUT_MAX_STRING_BYTES
        || current.value['paneId'] === '__proto__' || current.value['paneId'] === 'constructor' || current.value['paneId'] === 'prototype') return false
      continue
    }
    if (current.value['kind'] !== 'split' || (current.value['dir'] !== 'h' && current.value['dir'] !== 'v')
      || typeof current.value['ratio'] !== 'number' || !Number.isFinite(current.value['ratio'])
      || current.value['ratio'] < 0 || current.value['ratio'] > 1 || !('a' in current.value) || !('b' in current.value)) return false
    stack.push({ value: current.value['b'], depth: current.depth + 1 }, { value: current.value['a'], depth: current.depth + 1 })
  }
  return v as Node
}

function parseTabs(v: unknown, budget: LayoutParseBudget): Record<string, TabLayout> {
  if (!isPlainObj(v)) return {}
  const out: Record<string, TabLayout> = {}
  for (const [rawKey, value] of mapEntries(v, 'LAYOUT_TAB_LIMIT', LAYOUT_MAX_TABS_PER_WORKSPACE)) {
    const key = safeMapKey(layoutString(rawKey))
    if (!isPlainObj(value)) continue
    const rawTree = value['tree']
    const tree = rawTree === undefined ? null : parseTree(rawTree, budget)
    if (tree === false) throw new Error('LAYOUT_TREE_LIMIT')
    const browser = parseBrowserRail(value['browser'])
    out[key] = {
      tree,
      ...(typeof value['label'] === 'string' ? { label: layoutString(value['label']) } : {}),
      ...(browser ? { browser } : {}),
    }
  }
  return out
}

function parseWorkspaces(v: unknown, budget: LayoutParseBudget): Record<string, WsLayout> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {}
  const out: Record<string, WsLayout> = {}
  for (const [rawKey, ws] of mapEntries(v, 'LAYOUT_WORKSPACE_LIMIT', LAYOUT_MAX_WORKSPACES)) {
    const k = safeMapKey(layoutString(rawKey))
    if (typeof ws !== 'object' || ws === null || Array.isArray(ws)) continue
    const w = ws as Partial<WsLayout> & { label?: unknown; tabOrder?: unknown }
    if (Array.isArray(w.tabOrder) && w.tabOrder.length > LAYOUT_MAX_TABS_PER_WORKSPACE) throw new Error('LAYOUT_TAB_LIMIT')
    out[k] = {
      activeTab: typeof w.activeTab === 'number' ? w.activeTab : 1,
      tabs: parseTabs(w.tabs, budget),
      ...(typeof w.label === 'string' ? { label: layoutString(w.label) } : {}),
      ...(Array.isArray(w.tabOrder)
        ? { tabOrder: w.tabOrder.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)) }
        : {}),
    }
  }
  return out
}

// Pure display-order reconcile: listed ids keep `order`'s sequence (skipping any
// that no longer exist); every unlisted id appends in numeric order. Missing or
// empty `order` → pure numeric order.
export function orderTabs(ids: number[], order?: number[]): number[] {
  const present = new Set(ids)
  const listed = (order ?? []).filter((id) => present.has(id))
  const seen = new Set(listed)
  const rest = ids.filter((id) => !seen.has(id)).sort((a, b) => a - b)
  return [...listed, ...rest]
}

// Pure reorder: move `from` to `to`'s slot within `order`. Standard drag
// semantics — left→right lands after the target, right→left lands before it.
// No-op if either id is absent or from === to.
export function moveTab(order: number[], from: number, to: number): number[] {
  const fi = order.indexOf(from)
  const ti = order.indexOf(to)
  if (fi < 0 || ti < 0 || fi === ti) return order
  const next = [...order]
  next.splice(fi, 1)
  next.splice(ti, 0, from)
  return next
}

export function emptyLayout(): LayoutFile {
  return { version: LAYOUT_VERSION, activeWorkspace: 1, workspaces: {} }
}

// ---- CAS (compare-and-swap) types, shared by main/index.ts, preload,
// main.tsx and the web shim (spec 2026-08-01 §6). `version` is the sidecar
// file's exact previous content, not a derived digest (mtimeMs + byte length
// — the spec's first idea — collides trivially: two writes landing in the
// same host millisecond, or two edits of identical byte length, e.g. a split
// ratio's last digit flipping, e.g. `0.500000` -> `0.500001`. A false version
// match there is a silent clobber, exactly what CAS exists to prevent. The
// sidecar is a few KB (~3.2 KB measured on a real install), so comparing full
// content costs nothing a hash would meaningfully save, and content equality
// cannot false-positive. Each writer only ever compares ITS OWN token against
// its own re-read, so the two independent implementations (this file's
// Node-side IO and `crates/amber/src/layout_cas.rs`'s Rust IO) never need to
// agree on an algorithm — only on the wire shape below.
export type LayoutVersion = string | null
export interface LoadLayoutResult { text: string | null; version: LayoutVersion; error?: string }
export type SaveLayoutResult =
  | { ok: true; version: LayoutVersion }
  | { conflict: true; text: string | null; version: LayoutVersion }
  | { error: string }

function isPlainObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// Order-independent structural equality (JSON.stringify would false-positive
// on same-content-different-key-order objects, which would wrongly reject a
// remote edit during a merge below — see merge3).
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  }
  if (isPlainObj(a) && isPlainObj(b)) {
    const ak = Object.keys(a)
    return ak.length === Object.keys(b).length && ak.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]))
  }
  return false
}

/**
 * Generic 3-way JSON merge (spec §6: "re-apply the mutation against the fresh
 * tree, not blindly re-write the stale one"). `base` is what the edit started
 * from, `local` is that edit applied, `remote` is what's on disk now (the
 * other writer's change since `base`). Recurses into plain objects key by
 * key; arrays and primitives are leaves.
 *
 * Per key: if `local` didn't change it since `base`, take `remote`'s value
 * (including a deletion) — accepting the other writer's edit. Otherwise keep
 * `local`'s, recursing one level deeper when both sides are still plain
 * objects — so e.g. the browser editing workspace 2's tree and the desktop
 * editing workspace 1's tree both survive even though they share the
 * top-level `workspaces` key, and this is schema-agnostic (works the same
 * for `editors`/`frozen`/anything added later), which is what
 * makes it safe against silently dropping a desktop-only pane.
 *
 * ponytail: a genuine double-edit of the exact same leaf (rare — two clients
 * dragging the same divider inside one retry window) resolves to `local` —
 * good enough for a bounded, rare race; escalate to a finer-grained merge
 * only if that's observed to bite in practice.
 */
function merge3(base: unknown, local: unknown, remote: unknown): unknown {
  if (deepEqual(local, remote)) return local
  if (isPlainObj(base) && isPlainObj(local) && isPlainObj(remote)) {
    const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])
    const out: Record<string, unknown> = {}
    for (const k of keys) {
      const changedLocally = !deepEqual(local[k], base[k])
      if (!changedLocally) {
        if (Object.hasOwn(remote, k)) out[k] = remote[k]
        continue // remote also lacks the key -> stays absent
      }
      if (!Object.hasOwn(local, k)) continue // local deleted this key -> respect the deletion
      out[k] = merge3(base[k], local[k], remote[k])
    }
    return out
  }
  return local // leaf-level: this changed locally and the three-way check above already ruled out local === remote
}

/**
 * Reconcile a CAS conflict. `base` is the tree the in-flight edit started
 * from, `local` is that edit applied, `remote` is what's on disk now. Runs
 * the generic merge then re-validates through `parseLayout`'s shape guards —
 * never trust a merged object's shape blindly.
 */
export function mergeLayout(base: LayoutFile, local: LayoutFile, remote: LayoutFile): LayoutFile {
  return parseLayout(JSON.stringify(merge3(base, local, remote)))
}

export function parseLayout(text: string): LayoutFile {
  if (layoutUtf8ByteLength(text, LAYOUT_FILE_MAX_BYTES) > LAYOUT_FILE_MAX_BYTES) return emptyLayout()
  try {
    const v = JSON.parse(text) as Partial<LayoutFile>
    if (v.version !== LAYOUT_VERSION && v.version !== TAB_BROWSER_LAYOUT_VERSION) {
      return { ...emptyLayout(), readOnly: true }
    }
    if (typeof v.workspaces !== 'object' || v.workspaces === null || Array.isArray(v.workspaces)) return emptyLayout()
    const budget: LayoutParseBudget = { treeNodes: 0 }
    return {
      version: v.version,
      activeWorkspace: typeof v.activeWorkspace === 'number' ? v.activeWorkspace : 1,
      workspaces: parseWorkspaces(v.workspaces, budget),
      // Conditional spread so a missing fontSize stays absent (not `undefined`)
      // under exactOptionalPropertyTypes.
      ...(typeof v.fontSize === 'number' ? { fontSize: v.fontSize } : {}),
      ...((): { frozen?: Record<string, FrozenEntry> } => {
        const f = parseFrozen(v.frozen)
        return f ? { frozen: f } : {}
      })(),
      ...((): { browsers?: Record<string, BrowserEntry> } => {
        if (v.version === TAB_BROWSER_LAYOUT_VERSION) return {}
        const b = parseBrowsers(v.browsers)
        return b ? { browsers: b } : {}
      })(),
      ...((): { editors?: Record<string, EditorEntry> } => {
        const e = parseEditors(v.editors)
        return e ? { editors: e } : {}
      })(),
      ...((): { recentFiles?: string[] } => {
        const r = parseRecentFiles(v.recentFiles)
        return r ? { recentFiles: r } : {}
      })(),
      ...(typeof v.browserRevision === 'number' && Number.isFinite(v.browserRevision) ? { browserRevision: v.browserRevision } : {}),
    }
  } catch {
    return emptyLayout()
  }
}

export function serializeLayout(l: LayoutFile): string {
  const { readOnly: _readOnly, browsers: _legacyBrowsers, ...serializable } = l
  return JSON.stringify(serializable)
}
