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
export interface LayoutFile {
  version: number
  activeWorkspace: number
  workspaces: Record<string, WsLayout>
  fontSize?: number
  frozen?: Record<string, FrozenEntry>
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
      workspaces: v.workspaces as Record<string, WsLayout>,
      // Conditional spread so a missing fontSize stays absent (not `undefined`)
      // under exactOptionalPropertyTypes.
      ...(typeof v.fontSize === 'number' ? { fontSize: v.fontSize } : {}),
      ...((): { frozen?: Record<string, FrozenEntry> } => {
        const f = parseFrozen(v.frozen)
        return f ? { frozen: f } : {}
      })(),
    }
  } catch {
    return emptyLayout()
  }
}

export function serializeLayout(l: LayoutFile): string {
  return JSON.stringify(l)
}
