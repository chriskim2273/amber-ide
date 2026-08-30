import type { RecoveryEvent, SessionInfo } from '../shared/proto'
import type { NotificationPreferences, SessionBookmark } from '../shared/productivity'
import { parseName } from '../shared/names'
import { isAgentKind, type AppState } from './store'

export type SearchScope = 'all' | 'workspace' | 'tab'
export function searchScopeNames(sessions: SessionInfo[], scope: SearchScope, ws: number, tab: number): string[] {
  if (scope === 'all') return []
  return sessions.filter((session) => {
    const parsed = parseName(session.name)
    return parsed !== null && parsed.ws === ws && (scope === 'workspace' || parsed.tab === tab)
  }).map((session) => session.name)
}

export type RecoveryFilter = 'all' | 'errors' | 'lifecycle' | 'snapshots'
export function filterRecovery(events: RecoveryEvent[], filter: RecoveryFilter, query = ''): RecoveryEvent[] {
  const needle = query.trim().toLowerCase()
  return [...events].reverse().filter((event) => {
    if (filter === 'errors' && event.level !== 'error') return false
    if (filter === 'lifecycle' && !event.event.startsWith('session.')) return false
    if (filter === 'snapshots' && !event.event.startsWith('snapshot.')) return false
    return needle === '' || `${event.event} ${event.session ?? ''} ${event.detail}`.toLowerCase().includes(needle)
  })
}

export type NotificationKind = 'activity' | 'exit' | 'retry' | 'fallback' | 'pressure'
export interface NotificationCandidate { kind: NotificationKind; session?: string; ws?: number; title: string; body: string }
export function shouldNotify(
  candidate: NotificationCandidate,
  prefs: NotificationPreferences,
  visible: { focused: boolean; ws: number; tab: number },
  now: number,
  last: Map<string, number>,
): boolean {
  if (!prefs[candidate.kind]) return false
  if (candidate.ws !== undefined && prefs.mutedWorkspaces.includes(candidate.ws)) return false
  if (visible.focused && candidate.ws === visible.ws && candidate.session) {
    const parsed = parseName(candidate.session)
    if (parsed?.tab === visible.tab) return false
  }
  const key = `${candidate.kind}:${candidate.session ?? ''}`
  if (now - (last.get(key) ?? -Infinity) < 30_000) return false
  last.set(key, now)
  return true
}

export interface ActivitySummary {
  total: number; alive: number; exited: number; agents: number; retrying: number
  fallback: number; suspended: number; rssKb: number; unseen: number
}
export function activitySummary(sessions: SessionInfo[], state: Pick<AppState, 'dead' | 'mem' | 'lastActivity' | 'lastSeen'>): ActivitySummary {
  return sessions.reduce<ActivitySummary>((out, session) => {
    out.total += 1
    if (session.alive && !(session.name in state.dead)) out.alive += 1; else out.exited += 1
    if (isAgentKind(session.kind)) out.agents += 1
    if (session.run_state === 'claude-retrying') out.retrying += 1
    if (session.run_state === 'shell-fallback') out.fallback += 1
    if (session.run_state?.includes('suspended')) out.suspended += 1
    out.rssKb += state.mem[session.name]?.rssKb ?? 0
    if ((state.lastActivity[session.name] ?? 0) > (state.lastSeen[session.name] ?? 0)) out.unseen += 1
    return out
  }, { total: 0, alive: 0, exited: 0, agents: 0, retrying: 0, fallback: 0, suspended: 0, rssKb: 0, unseen: 0 })
}

export function makeBookmark(id: string, excerpt: string, now: number): SessionBookmark {
  const clean = excerpt.replace(/\r/g, '').split('\n').map((line) => line.trimEnd()).filter(Boolean).slice(-3).join('\n').slice(0, 500)
  const label = (clean.split('\n').find(Boolean) ?? 'Terminal position').slice(0, 120)
  return { id, createdAt: now, label, excerpt: clean }
}

export function bookmarkNeedle(bookmark: SessionBookmark): string {
  return bookmark.excerpt.split('\n').map((line) => line.trim()).find((line) => line.length >= 3) ?? bookmark.label
}
