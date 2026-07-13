import type { SessionInfo } from '../shared/proto'
import { parseName } from '../shared/names'

export interface AppState { sessions: SessionInfo[]; dead: Record<string, number>; error: string | null }
export type DaemonEvent =
  | { kind: 'Sessions'; sessions: SessionInfo[] }
  | { kind: 'SessionsChanged'; added: SessionInfo[]; removed: string[] }
  | { kind: 'Exit'; name: string; code: number }
  | { kind: 'Error'; msg: string }
export interface PaneModel { name: string; cwd: string; kind: string; alive: boolean; ord: number; deadCode: number | null }
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
  }
}

export function groupSessions(state: AppState): WorkspaceModel[] {
  const wsMap = new Map<number, Map<number, PaneModel[]>>()
  for (const sess of state.sessions) {
    const p = parseName(sess.name)
    if (!p) continue
    const pane: PaneModel = {
      name: sess.name, cwd: sess.cwd, kind: sess.kind, alive: sess.alive,
      ord: p.ord, deadCode: sess.name in state.dead ? state.dead[sess.name]! : null,
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
