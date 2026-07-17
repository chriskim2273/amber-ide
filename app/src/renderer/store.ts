import type { SessionInfo } from '../shared/proto'
import { parseName } from '../shared/names'

export interface AppState { sessions: SessionInfo[]; dead: Record<string, number>; error: string | null }
export type DaemonEvent =
  | { kind: 'Sessions'; sessions: SessionInfo[] }
  | { kind: 'SessionsChanged'; added: SessionInfo[]; removed: string[] }
  | { kind: 'Exit'; name: string; code: number }
  | { kind: 'Error'; msg: string }
  // UI-originated: the user dismissed the daemon-error banner.
  | { kind: 'ClearError' }
export interface PaneModel { name: string; cwd: string; kind: string; alive: boolean; ord: number; deadCode: number | null; runState?: string | undefined }
export interface TabModel { tab: number; panes: PaneModel[] }
export interface WorkspaceModel { ws: number; tabs: TabModel[] }

export function initialState(): AppState {
  return { sessions: [], dead: {}, error: null }
}

export function reduce(state: AppState, ev: DaemonEvent): AppState {
  switch (ev.kind) {
    case 'Sessions': {
      const names = new Set(ev.sessions.map((x) => x.name))
      const dead: Record<string, number> = {}
      for (const [n, c] of Object.entries(state.dead)) if (names.has(n)) dead[n] = c
      return { sessions: [...ev.sessions], dead, error: null }
    }
    case 'SessionsChanged': {
      const removed = new Set(ev.removed)
      const byName = new Map<string, SessionInfo>()
      for (const x of state.sessions) if (!removed.has(x.name)) byName.set(x.name, x)
      for (const x of ev.added) byName.set(x.name, x)
      const dead: Record<string, number> = {}
      for (const [n, c] of Object.entries(state.dead)) if (!removed.has(n) && byName.has(n)) dead[n] = c
      return { sessions: [...byName.values()], dead, error: state.error }
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

// A pane's kind-dot appearance + tooltip, from its kind and claude run_state.
// Shared by the pane header and the tab bar so they downgrade identically:
// amber = claude, pulsing amber = claude-retrying, gray = shell-fallback.
export function paneDot(kind: string, runState: string | undefined): KindDot {
  if (kind !== 'claude') return { cls: 'shell', label: 'shell' }
  switch (runState) {
    case 'claude-retrying': return { cls: 'claude-retrying', label: 'claude (retrying)' }
    case 'shell-fallback': return { cls: 'shell-fallback', label: 'shell (claude exited)' }
    default: return { cls: 'claude', label: 'claude' }
  }
}

// The tab bar's dot, aggregated over a tab's panes: no claude → shell; any
// retrying claude → retrying (most attention-worthy); every claude fallen back
// to a shell → shell-fallback (gray); otherwise → claude.
export function tabDot(panes: PaneModel[]): KindDot {
  const claudes = panes.filter((p) => p.kind === 'claude')
  if (claudes.length === 0) return { cls: 'shell', label: 'shell' }
  if (claudes.some((p) => p.runState === 'claude-retrying')) return { cls: 'claude-retrying', label: 'claude (retrying)' }
  if (claudes.every((p) => p.runState === 'shell-fallback')) return { cls: 'shell-fallback', label: 'shell (claude exited)' }
  return { cls: 'claude', label: 'claude' }
}

export function groupSessions(state: AppState): WorkspaceModel[] {
  const wsMap = new Map<number, Map<number, PaneModel[]>>()
  for (const sess of state.sessions) {
    const p = parseName(sess.name)
    if (!p) continue
    const pane: PaneModel = {
      name: sess.name, cwd: sess.cwd, kind: sess.kind, alive: sess.alive,
      ord: p.ord, deadCode: sess.name in state.dead ? state.dead[sess.name]! : null,
      runState: sess.run_state,
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
