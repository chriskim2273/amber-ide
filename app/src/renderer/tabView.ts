// Pure per-tab render derivation, split out of main.tsx so it's unit-testable
// (main.tsx calls createRoot at module scope — importing it in the node test env
// would crash). Both the active-tab effects and every keep-alive layer render go
// through deriveTab, so no two consumers can compute divergent trees.
import { reconcile, type Node } from './layout'
import type { PaneModel } from './store'
import { normalizeFriendlyTitle } from '../shared/layoutFile'
import type { PaneMeta } from './SplitView'

export function shortCwd(cwd: string, home: string): string {
  return home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd
}

// Leading brand token Pi puts on its OSC title (`π - ` / `Pi - ` / `pi - `,
// including caps and unicode dashes). Keep this Pi-only — shells keep OSC.
const PI_BRAND = /^(?:π|pi)\s*[-–—:|]\s*/i

// A Pi pane's OSC title is "<app> - <sessionName> - <cwdBasename>" (or
// "<app> - <cwdBasename>" when the session is unnamed). Both the brand and the
// trailing cwd token are redundant with the header's kind suffix and the cwd the
// daemon already shows, so the header reads a bare session name. Conservative:
// only the pane's own cwd basename is dropped from the tail, so a legitimately
// dash-separated name survives untouched. Non-Pi panes are never rewritten.
export function cleanOscTitle(osc: string, kind: string, cwd: string): string {
  if (kind !== 'pi') return osc
  let t = osc.trim().replace(PI_BRAND, '')
  const base = cwd.split('/').filter(Boolean).pop() ?? ''
  if (base && t.endsWith(` - ${base}`)) {
    t = t.slice(0, -(base.length + 3)) // drop ' - <base>'
  }
  return t.trim()
}

export function paneIdentityLead(
  pane: Pick<PaneModel, 'title' | 'kind' | 'cwd'>,
  osc: string | undefined,
  home: string,
): string {
  const friendly = normalizeFriendlyTitle(pane.title)
  if (friendly) return friendly // renamed title always beats live OSC / cwd
  const cleaned = osc && osc.trim().length > 0 ? cleanOscTitle(osc, pane.kind, pane.cwd) : ''
  if (cleaned) return cleaned
  if (pane.kind === 'editor') return pane.cwd ? shortCwd(pane.cwd, home) : 'untitled'
  return shortCwd(pane.cwd, home)
}

export function paneDisplayLabel(
  pane: Pick<PaneModel, 'title' | 'kind' | 'cwd' | 'slot'>,
  osc: string | undefined,
  home: string,
): string {
  return `${paneSlotPrefix(pane.slot)}${paneIdentityLead(pane, osc, home)}`
}

export function paneSlotPrefix(slot: number | undefined): string {
  return slot ? `#${slot} ` : ''
}

/** Option labels for the tab-browser designated-Pi picker. Slot + renamed title
 *  (then cleaned OSC / cwd) so two Pi panes in one tab are distinguishable. */
export function piControllerOptions(
  panes: readonly PaneModel[],
  titles: Record<string, string>,
  home: string,
): { name: string; label: string }[] {
  return panes.filter((pane) => pane.kind === 'pi').map((pane) => ({
    name: pane.name,
    label: paneDisplayLabel(pane, titles[pane.name], home),
  }))
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
    // A durable friendly title outranks live OSC/file titles. OSC remains the
    // useful fallback for shells whose title changes with the current command;
    // blank OSC 2 (some prompts) falls back to cwd.
    const lead = paneIdentityLead(p, titles[p.name], home)
    const friendly = normalizeFriendlyTitle(p.title)
    // An agent pane that fell back to a shell is labelled as such, not by its
    // kind (`shell (claude exited)` / `shell (grok exited)`).
    const suffix = p.runState === 'shell-fallback' ? `shell (${p.kind} exited)` : p.kind
    // Raw absolute cwd (not shortCwd) so the context-menu "copy cwd" resolves.
    const m = mem[p.name]
    // The daemon owns this number (`SessionInfo.slot`) — the app must never
    // derive one of its own, or the header would disagree with `amber attach`.
    // App-local panes and older daemons report none: show no prefix, never a
    // guess.
    paneMeta[p.name] = {
      kind: p.kind, title: `${paneSlotPrefix(p.slot)}${lead} · ${suffix}`, cwd: p.cwd,
      alive: p.alive, friendlyTitle: friendly, runState: p.runState,
      rssKb: m?.rssKb, growing: m?.growing, claudeId: p.claudeId,
    }
  })
  const liveIds = panes.map((p) => p.name).filter((n) => !(n in pending))
  return { tree: reconcile(storedTree, liveIds), paneMeta, deadCodes, liveIds }
}
