import type { Node } from '../renderer/layout'

export const LAYOUT_VERSION = 1
// `label` is app-owned display metadata ONLY (never touches daemon session
// names). All added fields are OPTIONAL — old sidecars parse fine (missing →
// undefined) and old readers ignore unknown-but-additive keys.
export interface TabLayout { tree: Node | null; label?: string }
export interface WsLayout { activeTab: number; tabs: Record<string, TabLayout>; label?: string; tabOrder?: number[] }
// `fontSize` is an app-owned top-level display preference (optional — old
// sidecars omit it → undefined → the renderer's default).
// `frozen` parks panes (display-only, never touches the daemon): a map keyed by
// SESSION NAME → optional note. Session names are stable across reboots, so
// parking survives restart; stale entries are pruned on load-reconcile.
export interface FrozenEntry { note?: string }
// `browsers` are app-local web-viewer panes (spec 2026-07-18): a synthetic leaf
// with NO daemon session, keyed by a `browser-<ws>-<tab>-<ord>-<id>` paneId.
// This map is the pane's entire existence — grouping (ws/tab/ord) + last URL.
export interface BrowserEntry { ws: number; tab: number; ord: number; url: string }
// `editors` are app-local file-editor panes (spec 2026-07-19): the same class as
// `browsers` — a synthetic leaf with NO daemon session, keyed by an
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
}

// Shape-guard the frozen map (Task 4 lesson): reject a non-object/array top
// level → undefined; drop non-object entries; coerce a non-string note away.
function parseFrozen(v: unknown): Record<string, FrozenEntry> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const out: Record<string, FrozenEntry> = {}
  for (const [name, entry] of Object.entries(v)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const note = (entry as { note?: unknown }).note
    out[name] = typeof note === 'string' ? { note } : {}
  }
  return out
}

// Shape-guard the browsers map (same lesson as parseFrozen): reject a
// non-object/array top level; drop entries missing/mistyping any field. A
// malformed entry is silently dropped so a hand-edited sidecar never throws.
function parseBrowsers(v: unknown): Record<string, BrowserEntry> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const out: Record<string, BrowserEntry> = {}
  for (const [name, e] of Object.entries(v)) {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) continue
    const { ws, tab, ord, url } = e as Record<string, unknown>
    if (typeof ws === 'number' && typeof tab === 'number' && typeof ord === 'number' && typeof url === 'string'
        && Number.isFinite(ws) && Number.isFinite(tab) && Number.isFinite(ord)) {
      out[name] = { ws, tab, ord, url }
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
  for (const [name, e] of Object.entries(v)) {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) continue
    const { ws, tab, ord, path, view, outline, wrap } = e as Record<string, unknown>
    if (typeof ws !== 'number' || typeof tab !== 'number' || typeof ord !== 'number') continue
    if (!Number.isFinite(ws) || !Number.isFinite(tab) || !Number.isFinite(ord)) continue
    if (typeof path !== 'string' && path !== null) continue
    out[name] = {
      ws, tab, ord, path,
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
  return [...new Set(v.filter((p): p is string => typeof p === 'string'))].slice(0, RECENT_FILES_MAX)
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
function parseWorkspaces(v: unknown): Record<string, WsLayout> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {}
  const out: Record<string, WsLayout> = {}
  for (const [k, ws] of Object.entries(v)) {
    if (typeof ws !== 'object' || ws === null || Array.isArray(ws)) continue
    const w = ws as Partial<WsLayout> & { label?: unknown; tabOrder?: unknown }
    out[k] = {
      activeTab: typeof w.activeTab === 'number' ? w.activeTab : 1,
      tabs: (w.tabs ?? {}) as Record<string, TabLayout>,
      ...(typeof w.label === 'string' ? { label: w.label } : {}),
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

export function parseLayout(text: string): LayoutFile {
  try {
    const v = JSON.parse(text) as Partial<LayoutFile>
    if (v.version !== LAYOUT_VERSION || typeof v.workspaces !== 'object' || v.workspaces === null) {
      return emptyLayout()
    }
    return {
      version: LAYOUT_VERSION,
      activeWorkspace: typeof v.activeWorkspace === 'number' ? v.activeWorkspace : 1,
      workspaces: parseWorkspaces(v.workspaces),
      // Conditional spread so a missing fontSize stays absent (not `undefined`)
      // under exactOptionalPropertyTypes.
      ...(typeof v.fontSize === 'number' ? { fontSize: v.fontSize } : {}),
      ...((): { frozen?: Record<string, FrozenEntry> } => {
        const f = parseFrozen(v.frozen)
        return f ? { frozen: f } : {}
      })(),
      ...((): { browsers?: Record<string, BrowserEntry> } => {
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
    }
  } catch {
    return emptyLayout()
  }
}

export function serializeLayout(l: LayoutFile): string {
  return JSON.stringify(l)
}
