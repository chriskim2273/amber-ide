import type { SessionInfo } from '../shared/proto'
import type { BrowserEntry } from '../shared/layoutFile'
import { parseName } from '../shared/names'

export interface AppState {
  sessions: SessionInfo[]
  dead: Record<string, number>
  error: string | null
  // Background-activity tracking. `seq` is a monotonic event counter (no wall
  // clock needed — arrival order is all that matters). `lastActivity[name]` is
  // the `seq` of a session's most recent output Activity; `lastSeen[name]` is
  // the `seq` up to which its tab was last visible/active. A pane has UNSEEN
  // activity when lastActivity > lastSeen.
  lastActivity: Record<string, number>
  lastSeen: Record<string, number>
  seq: number
  // Per-session child-tree memory from the daemon monitor (Slice 1): resident
  // KiB + a sustained-growth flag. Keyed by session name; pruned with the live
  // set. Display-only — never affects lifecycle.
  mem: Record<string, { rssKb: number; growing: boolean }>
  pressure: null | {
    level: 'normal' | 'warning' | 'critical'
    currentKb: number
    budgetKb: number
    blocked: boolean
  }
}
export type DaemonEvent =
  | { kind: 'Sessions'; sessions: SessionInfo[] }
  | { kind: 'SessionsChanged'; added: SessionInfo[]; removed: string[] }
  | { kind: 'Exit'; name: string; code: number }
  | { kind: 'Error'; msg: string }
  // Daemon: a session produced output (rate-limited to ~2/s/session).
  | { kind: 'Activity'; name: string }
  // Daemon: periodic per-session memory reading (child-tree RSS KiB + growth).
  | { kind: 'Memory'; name: string; rssKb: number; growing: boolean }
  | { kind: 'MemoryPressure'; level: 'normal' | 'warning' | 'critical'; currentKb: number; budgetKb: number; blocked: boolean }
  // UI-originated: the visible tab's panes have been seen (active tab/ws change,
  // or activity for the already-visible tab) — mark their activity as seen.
  | { kind: 'MarkSeen'; names: string[] }
  // UI-originated: the user dismissed the daemon-error banner.
  | { kind: 'ClearError' }
export interface PaneModel { name: string; cwd: string; kind: string; alive: boolean; ord: number; deadCode: number | null; runState?: string | undefined; claudeId?: string | undefined; slot?: number | undefined }
export interface TabModel { tab: number; panes: PaneModel[] }
export interface WorkspaceModel { ws: number; tabs: TabModel[] }

export function initialState(): AppState {
  return { sessions: [], dead: {}, error: null, lastActivity: {}, lastSeen: {}, seq: 0, mem: {}, pressure: null }
}

// Keep only the keys present in `live` (prunes per-session state for removed
// sessions so the maps don't grow without bound in a long-lived renderer).
function keepLive<T>(map: Record<string, T>, live: Set<string>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [n, v] of Object.entries(map)) if (live.has(n)) out[n] = v
  return out
}

export function reduce(state: AppState, ev: DaemonEvent): AppState {
  switch (ev.kind) {
    case 'Sessions': {
      const names = new Set(ev.sessions.map((x) => x.name))
      return {
        ...state,
        sessions: [...ev.sessions],
        dead: keepLive(state.dead, names),
        error: null,
        lastActivity: keepLive(state.lastActivity, names),
        lastSeen: keepLive(state.lastSeen, names),
        mem: keepLive(state.mem, names),
      }
    }
    case 'SessionsChanged': {
      const removed = new Set(ev.removed)
      const byName = new Map<string, SessionInfo>()
      for (const x of state.sessions) if (!removed.has(x.name)) byName.set(x.name, x)
      for (const x of ev.added) byName.set(x.name, x)
      const live = new Set(byName.keys())
      return {
        ...state,
        sessions: [...byName.values()],
        dead: keepLive(state.dead, live),
        lastActivity: keepLive(state.lastActivity, live),
        lastSeen: keepLive(state.lastSeen, live),
        mem: keepLive(state.mem, live),
      }
    }
    case 'Activity': {
      const seq = state.seq + 1
      return { ...state, seq, lastActivity: { ...state.lastActivity, [ev.name]: seq } }
    }
    case 'Memory': {
      const prev = state.mem[ev.name]
      // No-op identical readings so a stable pane doesn't re-render every poll.
      if (prev && prev.rssKb === ev.rssKb && prev.growing === ev.growing) return state
      return { ...state, mem: { ...state.mem, [ev.name]: { rssKb: ev.rssKb, growing: ev.growing } } }
    }
    case 'MemoryPressure': {
      const pressure = { level: ev.level, currentKb: ev.currentKb, budgetKb: ev.budgetKb, blocked: ev.blocked }
      const prev = state.pressure
      if (prev && prev.level === pressure.level && prev.currentKb === pressure.currentKb
        && prev.budgetKb === pressure.budgetKb && prev.blocked === pressure.blocked) return state
      return { ...state, pressure }
    }
    case 'MarkSeen': {
      let changed = false
      const lastSeen = { ...state.lastSeen }
      for (const n of ev.names) if (lastSeen[n] !== state.seq) { lastSeen[n] = state.seq; changed = true }
      return changed ? { ...state, lastSeen } : state
    }
    case 'Exit':
      return { ...state, dead: { ...state.dead, [ev.name]: ev.code } }
    case 'Error':
      return { ...state, error: ev.msg }
    case 'ClearError':
      return state.error === null ? state : { ...state, error: null }
  }
}

export interface KindDot { cls: string; label: string }

// A supervised coding-agent pane — one whose daemon session runs `amber run`
// and reports a run_state. The daemon's `SessionKind::is_agent`, mirrored: all
// agents share every run_state behaviour (dots, freeze/suspend, tab label), and
// the run_state vocabulary stays spelled `claude*` for all of them because it
// names the supervision phase, not the binary.
export function isAgentKind(kind: string): boolean {
  return kind === 'claude' || kind === 'grok' || kind === 'codex'
}

// Daemon Focus is a recent-use hint, so only a real interaction in the active
// terminal earns one. Callers separately identify an xterm target.
export function shouldHintTerminalFocus(active: boolean, terminalTarget: boolean): boolean {
  return active && terminalTarget
}

// A pane's kind-dot appearance + tooltip, from its kind and agent run_state.
// Shared by the pane header and the tab bar so they downgrade identically:
// amber = claude, pulsing amber = claude-retrying, gray = shell-fallback.
export function paneDot(kind: string, runState: string | undefined): KindDot {
  if (kind === 'browser') return { cls: 'browser', label: 'browser' }
  if (kind === 'editor') return { cls: 'editor', label: 'editor' }
  if (!isAgentKind(kind)) return { cls: 'shell', label: 'shell' }
  switch (runState) {
    case 'claude-retrying': return { cls: `${kind}-retrying`, label: `${kind} (retrying)` }
    case 'shell-fallback': return { cls: 'shell-fallback', label: `shell (${kind} exited)` }
    case 'memory-suspended': return { cls: 'memory-suspended', label: `${kind} (parked for memory)` }
    // Slice 3: parked by a freeze grace — the agent killed to free RAM, resumable.
    case 'suspended': return { cls: 'suspended', label: 'suspended (RAM freed)' }
    default: return { cls: kind, label: kind }
  }
}

// The tab bar's dot, aggregated over a tab's panes: no agent → shell; any
// retrying agent → retrying (most attention-worthy); every agent fallen back
// to a shell → shell-fallback (gray); otherwise → the agent. A tab whose agents
// are all the same kind uses that kind; a mixed tab is labelled "claude".
export function tabDot(panes: PaneModel[]): KindDot {
  const agents = panes.filter((p) => isAgentKind(p.kind))
  if (agents.length === 0) return { cls: 'shell', label: 'shell' }
  const kinds = new Set(agents.map((p) => p.kind))
  const k = kinds.size === 1 ? agents[0]!.kind : 'claude'
  if (agents.some((p) => p.runState === 'claude-retrying')) return { cls: `${k}-retrying`, label: `${k} (retrying)` }
  if (agents.every((p) => p.runState === 'shell-fallback')) return { cls: 'shell-fallback', label: `shell (${k} exited)` }
  if (agents.some((p) => p.runState === 'memory-suspended')
    && agents.every((p) => (p.runState === 'memory-suspended' || p.runState === 'shell-fallback'))) {
    return { cls: 'memory-suspended', label: `${k} (parked for memory)` }
  }
  return { cls: k, label: k }
}

// True if any of `panes` has output activity newer than it was last seen —
// drives the tab-bar activity dot on non-active tabs. A frozen (parked) pane
// is excluded: its activity must never light the dot (that's the point of
// parking). The reducer stays pure — the frozen set is app-owned (sidecar) and
// passed in from main.tsx.
export function hasActivity(state: AppState, panes: PaneModel[], frozen?: Set<string>): boolean {
  return panes.some((p) => !frozen?.has(p.name) && (state.lastActivity[p.name] ?? 0) > (state.lastSeen[p.name] ?? 0))
}

// Inject app-local browser panes (sidecar-owned, no daemon session) into the
// grouped model so they flow through deriveTab exactly like a daemon pane. A
// browser pane's {ws,tab} may be a grouping that has no daemon session at all,
// so ws/tab entries are created on demand. Result stays sorted by ord.
export function mergeBrowsers(workspaces: WorkspaceModel[], browsers: Record<string, BrowserEntry>): WorkspaceModel[] {
  return mergeLocalPanes(workspaces, browsers, 'browser')
}

// Editor panes (spec 2026-07-19) are the same class as browser panes: app-local,
// sidecar-owned, no daemon session. `cwd` carries the file's directory so the
// pane header/title can show something useful; an unsaved scratch pane has none.
export function mergeEditors(
  workspaces: WorkspaceModel[],
  editors: Record<string, { ws: number; tab: number; ord: number; path: string | null }>,
): WorkspaceModel[] {
  return mergeLocalPanes(workspaces, editors, 'editor')
}

// Shared body of the two merges above: fold sidecar-owned panes into the grouped
// model so they flow through deriveTab exactly like a daemon pane. Such a pane's
// {ws,tab} may be a grouping with no daemon session at all, so ws/tab entries are
// created on demand. Result stays sorted by ord.
function mergeLocalPanes(
  workspaces: WorkspaceModel[],
  entriesMap: Record<string, { ws: number; tab: number; ord: number; path?: string | null }>,
  kind: string,
): WorkspaceModel[] {
  const entries = Object.entries(entriesMap)
  if (entries.length === 0) return workspaces
  const wsMap = new Map<number, Map<number, PaneModel[]>>()
  for (const w of workspaces) {
    const tabs = new Map<number, PaneModel[]>()
    for (const t of w.tabs) tabs.set(t.tab, [...t.panes])
    wsMap.set(w.ws, tabs)
  }
  for (const [name, b] of entries) {
    if (!wsMap.has(b.ws)) wsMap.set(b.ws, new Map())
    const tabs = wsMap.get(b.ws)!
    if (!tabs.has(b.tab)) tabs.set(b.tab, [])
    const cwd = typeof b.path === 'string' ? b.path.slice(0, b.path.lastIndexOf('/') + 1) : ''
    tabs.get(b.tab)!.push({ name, cwd, kind, alive: true, ord: b.ord, deadCode: null })
  }
  return [...wsMap.entries()].sort((a, b) => a[0] - b[0]).map(([ws, tabs]) => ({
    ws,
    tabs: [...tabs.entries()].sort((a, b) => a[0] - b[0]).map(([tab, panes]) => ({
      tab, panes: panes.sort((a, b) => a.ord - b.ord),
    })),
  }))
}

export function groupSessions(state: AppState): WorkspaceModel[] {
  const wsMap = new Map<number, Map<number, PaneModel[]>>()
  for (const sess of state.sessions) {
    const p = parseName(sess.name)
    if (!p) continue
    const pane: PaneModel = {
      name: sess.name, cwd: sess.cwd, kind: sess.kind, alive: sess.alive,
      ord: p.ord, deadCode: sess.name in state.dead ? state.dead[sess.name]! : null,
      runState: sess.run_state, claudeId: sess.claude_id, slot: sess.slot,
    }
    if (!wsMap.has(p.ws)) wsMap.set(p.ws, new Map())
    const tabs = wsMap.get(p.ws)!
    if (!tabs.has(p.tab)) tabs.set(p.tab, [])
    tabs.get(p.tab)!.push(pane)
  }
  return [...wsMap.entries()].sort((a, b) => a[0] - b[0]).map(([ws, tabs]) => ({
    ws,
    tabs: [...tabs.entries()].sort((a, b) => a[0] - b[0]).map(([tab, panes]) => ({
      tab, panes: panes.sort((a, b) => a.ord - b.ord),
    })),
  }))
}
