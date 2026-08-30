import { describe, expect, it } from 'vitest'
import { filterPalette, type PaletteEntry } from './commandPalette'
import { activitySummary, bookmarkNeedle, filterRecovery, makeBookmark, searchScopeNames, shouldNotify } from './productivityModels'
import { emptyProductivity } from '../shared/productivity'
import type { SessionInfo } from '../shared/proto'

const noop = (): void => {}
const sessions: SessionInfo[] = [
  { name: 'amber-1-2-0-a', cwd: '/one', kind: 'shell', alive: true, slot: 3 },
  { name: 'amber-2-1-0-b', cwd: '/two', kind: 'codex', alive: true, run_state: 'claude-retrying' },
]

describe('productivity models', () => {
  it('ranks exact and prefix palette matches ahead of fuzzy matches', () => {
    const entries: PaletteEntry[] = [
      { id: 'a', label: 'Recovery center', detail: '', keywords: 'history', run: noop },
      { id: 'b', label: '#3 /one', detail: '', keywords: 'shell', run: noop },
      { id: 'c', label: 'Search all scrollback', detail: '', keywords: 'global', run: noop },
    ]
    expect(filterPalette(entries, '#3')[0]?.id).toBe('b')
    expect(filterPalette(entries, 'reco')[0]?.id).toBe('a')
  })

  it('scopes global search only to daemon session names', () => {
    expect(searchScopeNames(sessions, 'all', 1, 2)).toEqual([])
    expect(searchScopeNames(sessions, 'workspace', 1, 9)).toEqual(['amber-1-2-0-a'])
    expect(searchScopeNames(sessions, 'tab', 1, 2)).toEqual(['amber-1-2-0-a'])
  })

  it('filters newest recovery events by stable category', () => {
    const events = [
      { at: 1, sequence: 1, level: 'info', event: 'snapshot.completed', detail: 'ok' },
      { at: 2, sequence: 2, level: 'error', event: 'session.restore_failed', session: 's', detail: 'bad' },
    ]
    expect(filterRecovery(events, 'errors').map((e) => e.event)).toEqual(['session.restore_failed'])
    expect(filterRecovery(events, 'snapshots').map((e) => e.event)).toEqual(['snapshot.completed'])
  })

  it('suppresses noisy, visible, muted, and duplicate notifications', () => {
    const prefs = emptyProductivity().notifications
    const last = new Map<string, number>()
    const visible = { focused: false, ws: 1, tab: 1 }
    const candidate = { kind: 'exit' as const, session: 'amber-2-1-0-b', ws: 2, title: 'Exited', body: 'Pane exited' }
    expect(shouldNotify(candidate, prefs, visible, 100_000, last)).toBe(true)
    expect(shouldNotify(candidate, prefs, visible, 100_001, last)).toBe(false)
    expect(shouldNotify({ ...candidate, session: 'amber-1-1-0-x', ws: 1 }, prefs, { focused: true, ws: 1, tab: 1 }, 200_000, last)).toBe(false)
  })

  it('summarizes daemon telemetry and creates semantic bookmarks', () => {
    const summary = activitySummary(sessions, {
      dead: {}, mem: { 'amber-1-2-0-a': { rssKb: 100, growing: false } },
      lastActivity: { 'amber-1-2-0-a': 2 }, lastSeen: { 'amber-1-2-0-a': 1 },
    })
    expect(summary).toMatchObject({ total: 2, alive: 2, agents: 1, retrying: 1, rssKb: 100, unseen: 1 })
    const bookmark = makeBookmark('bookmark-123', '\nfirst\nneedle line\n', 5)
    expect(bookmark.label).toBe('first')
    expect(bookmarkNeedle(bookmark)).toBe('first')
  })
})
