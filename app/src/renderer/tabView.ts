// Pure per-tab render derivation, split out of main.tsx so it's unit-testable
// (main.tsx calls createRoot at module scope — importing it in the node test env
// would crash). Both the active-tab effects and every keep-alive layer render go
// through deriveTab, so no two consumers can compute divergent trees.
import { reconcile, type Node } from './layout'
import type { PaneModel } from './store'
import type { PaneMeta } from './SplitView'

export function shortCwd(cwd: string, home: string): string {
  return home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd
}

export interface DerivedTab {
  tree: Node | null
  paneMeta: Record<string, PaneMeta>
  deadCodes: Record<string, number>
  liveIds: string[]
}

// Derive a tab's render inputs from its live panes + persisted tree. `pending`
// splits are held out of `liveIds` so reconcile can't append them as columns
// before they're placed with their requested direction.
export function deriveTab(
  panes: PaneModel[],
  storedTree: Node | null,
  pending: Record<string, unknown>,
  titles: Record<string, string>,
  home: string,
  mem: Record<string, { rssKb: number; growing: boolean }> = {},
): DerivedTab {
  const deadCodes: Record<string, number> = {}
  const paneMeta: Record<string, PaneMeta> = {}
  panes.forEach((p) => {
    if (p.deadCode !== null) deadCodes[p.name] = p.deadCode
    // Prefer a live OSC title over cwd; blank OSC 2 (some prompts) falls back.
    const osc = titles[p.name]
    const lead = osc && osc.trim().length > 0 ? osc : shortCwd(p.cwd, home)
    // A claude pane that fell back to a shell is labelled as such, not "claude".
    const suffix = p.runState === 'shell-fallback' ? 'shell (claude exited)' : p.kind
    // Raw absolute cwd (not shortCwd) so the context-menu "copy cwd" resolves.
    const m = mem[p.name]
    paneMeta[p.name] = {
      kind: p.kind, title: `${lead} · ${suffix}`, cwd: p.cwd, runState: p.runState,
      rssKb: m?.rssKb, growing: m?.growing,
    }
  })
  const liveIds = panes.map((p) => p.name).filter((n) => !(n in pending))
  return { tree: reconcile(storedTree, liveIds), paneMeta, deadCodes, liveIds }
}
