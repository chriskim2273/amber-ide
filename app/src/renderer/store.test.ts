import { describe, it, expect } from 'vitest'
import { initialState, reduce, groupSessions, paneDot, tabDot, hasActivity, type PaneModel } from './store'
import type { SessionInfo } from '../shared/proto'

const s = (name: string, alive = true): SessionInfo => ({ name, cwd: '/w', kind: 'shell', alive })
const claude = (name: string, runState?: string): SessionInfo => ({ name, cwd: '/w', kind: 'claude', alive: true, run_state: runState })
const pane = (kind: string, runState?: string): PaneModel => ({ name: 'x', cwd: '/w', kind, alive: true, ord: 0, deadCode: null, runState })

describe('store', () => {
  it('Sessions replaces the set', () => {
    let st = initialState()
    st = reduce(st, { kind: 'Sessions', sessions: [s('amber-1-1-0-a')] })
    expect(st.sessions.map((x) => x.name)).toEqual(['amber-1-1-0-a'])
  })
  it('SessionsChanged adds and removes', () => {
    let st = reduce(initialState(), { kind: 'Sessions', sessions: [s('amber-1-1-0-a')] })
    st = reduce(st, { kind: 'SessionsChanged', added: [s('amber-1-1-1-b')], removed: [] })
    expect(st.sessions).toHaveLength(2)
    st = reduce(st, { kind: 'SessionsChanged', added: [], removed: ['amber-1-1-0-a'] })
    expect(st.sessions.map((x) => x.name)).toEqual(['amber-1-1-1-b'])
  })
  it('Exit marks dead; groupSessions surfaces the code', () => {
    let st = reduce(initialState(), { kind: 'Sessions', sessions: [s('amber-2-3-0-a')] })
    st = reduce(st, { kind: 'Exit', name: 'amber-2-3-0-a', code: 7 })
    const ws = groupSessions(st)
    expect(ws[0]!.tabs[0]!.panes[0]!.deadCode).toBe(7)
  })
  it('groupSessions buckets ws->tab and sorts by ord', () => {
    const st = reduce(initialState(), { kind: 'Sessions', sessions: [
      s('amber-1-1-1-b'), s('amber-1-1-0-a'), s('amber-1-2-0-c'), s('amber-2-1-0-d'), s('not-a-pane'),
    ] })
    const ws = groupSessions(st)
    expect(ws.map((w) => w.ws)).toEqual([1, 2])
    expect(ws[0]!.tabs.map((t) => t.tab)).toEqual([1, 2])
    expect(ws[0]!.tabs[0]!.panes.map((p) => p.name)).toEqual(['amber-1-1-0-a', 'amber-1-1-1-b'])
  })
  // Fix 4 dead-pane close: a process-exited pane is marked dead but stays in
  // the session set (overlay: "close to remove"). Closing it Kills the session;
  // the daemon broadcasts SessionsChanged{removed}, which must prune BOTH the
  // session and its dead-code entry so groupSessions no longer yields the pane.
  it('SessionsChanged removal prunes a dead session and its dead-code entry', () => {
    let st = reduce(initialState(), { kind: 'Sessions', sessions: [s('amber-1-1-0-a')] })
    st = reduce(st, { kind: 'Exit', name: 'amber-1-1-0-a', code: 3 })
    expect(st.dead['amber-1-1-0-a']).toBe(3)
    st = reduce(st, { kind: 'SessionsChanged', added: [], removed: ['amber-1-1-0-a'] })
    expect(st.sessions).toHaveLength(0)
    expect(st.dead['amber-1-1-0-a']).toBeUndefined()
    expect(groupSessions(st)).toHaveLength(0)
  })
  it('Error sets error; a later Error replaces it', () => {
    let st = reduce(initialState(), { kind: 'Error', msg: 'boom' })
    expect(st.error).toBe('boom')
    st = reduce(st, { kind: 'Error', msg: 'rename unsupported' })
    expect(st.error).toBe('rename unsupported')
  })
  it('ClearError resets error to null', () => {
    let st = reduce(initialState(), { kind: 'Error', msg: 'boom' })
    st = reduce(st, { kind: 'ClearError' })
    expect(st.error).toBeNull()
  })
  it('SessionsChanged preserves an unread error', () => {
    let st = reduce(initialState(), { kind: 'Error', msg: 'boom' })
    st = reduce(st, { kind: 'SessionsChanged', added: [s('amber-1-1-0-a')], removed: [] })
    expect(st.error).toBe('boom')
  })
  // A claude session's run_state must flow through SessionsChanged upsert into
  // the grouped pane model (the daemon reports it via ReportRunState).
  it('groupSessions surfaces a claude pane run_state', () => {
    let st = reduce(initialState(), { kind: 'Sessions', sessions: [claude('amber-1-1-0-c')] })
    st = reduce(st, { kind: 'SessionsChanged', added: [claude('amber-1-1-0-c', 'claude-retrying')], removed: [] })
    expect(groupSessions(st)[0]!.tabs[0]!.panes[0]!.runState).toBe('claude-retrying')
  })
})

describe('activity', () => {
  const p = (name: string): PaneModel => ({ name, cwd: '/w', kind: 'shell', alive: true, ord: 0, deadCode: null })

  it('a pane with activity newer than lastSeen has unseen activity', () => {
    let st = reduce(initialState(), { kind: 'Sessions', sessions: [s('amber-1-1-0-a')] })
    expect(hasActivity(st, [p('amber-1-1-0-a')])).toBe(false)
    st = reduce(st, { kind: 'Activity', name: 'amber-1-1-0-a' })
    expect(hasActivity(st, [p('amber-1-1-0-a')])).toBe(true)
  })

  it('MarkSeen clears the pane it names', () => {
    let st = reduce(initialState(), { kind: 'Sessions', sessions: [s('amber-1-1-0-a')] })
    st = reduce(st, { kind: 'Activity', name: 'amber-1-1-0-a' })
    st = reduce(st, { kind: 'MarkSeen', names: ['amber-1-1-0-a'] })
    expect(hasActivity(st, [p('amber-1-1-0-a')])).toBe(false)
  })

  it('MarkSeen on the visible tab does not clear a background pane', () => {
    let st = reduce(initialState(), { kind: 'Sessions', sessions: [s('vis'), s('bg')] })
    st = reduce(st, { kind: 'Activity', name: 'bg' })
    // The visible tab (vis) is marked seen; the background pane (bg) keeps its dot.
    st = reduce(st, { kind: 'MarkSeen', names: ['vis'] })
    expect(hasActivity(st, [p('bg')])).toBe(true)
    expect(hasActivity(st, [p('vis')])).toBe(false)
  })

  it('activity after MarkSeen re-lights the pane', () => {
    let st = reduce(initialState(), { kind: 'Sessions', sessions: [s('a')] })
    st = reduce(st, { kind: 'Activity', name: 'a' })
    st = reduce(st, { kind: 'MarkSeen', names: ['a'] })
    expect(hasActivity(st, [p('a')])).toBe(false)
    st = reduce(st, { kind: 'Activity', name: 'a' })
    expect(hasActivity(st, [p('a')])).toBe(true)
  })

  it('a frozen pane never reports activity (suppressed via the frozen set)', () => {
    let st = reduce(initialState(), { kind: 'Sessions', sessions: [s('amber-1-1-0-a')] })
    st = reduce(st, { kind: 'Activity', name: 'amber-1-1-0-a' })
    expect(hasActivity(st, [p('amber-1-1-0-a')])).toBe(true)
    expect(hasActivity(st, [p('amber-1-1-0-a')], new Set(['amber-1-1-0-a']))).toBe(false)
    // A non-frozen pane in the same tab still lights the dot.
    expect(hasActivity(st, [p('amber-1-1-0-a')], new Set(['other']))).toBe(true)
  })

  it('a removed session drops its activity state', () => {
    let st = reduce(initialState(), { kind: 'Sessions', sessions: [s('a')] })
    st = reduce(st, { kind: 'Activity', name: 'a' })
    st = reduce(st, { kind: 'SessionsChanged', added: [], removed: ['a'] })
    expect(st.lastActivity['a']).toBeUndefined()
    expect(st.lastSeen['a']).toBeUndefined()
  })
})

describe('reduce Memory', () => {
  it('records rss + growing, and no-ops an identical reading (referential stability)', () => {
    let st = reduce(initialState(), { kind: 'Sessions', sessions: [s('a')] })
    st = reduce(st, { kind: 'Memory', name: 'a', rssKb: 512_000, growing: false })
    expect(st.mem['a']).toEqual({ rssKb: 512_000, growing: false })
    const same = reduce(st, { kind: 'Memory', name: 'a', rssKb: 512_000, growing: false })
    expect(same).toBe(st) // unchanged reading => same object (skips a re-render)
    const changed = reduce(st, { kind: 'Memory', name: 'a', rssKb: 700_000, growing: true })
    expect(changed.mem['a']).toEqual({ rssKb: 700_000, growing: true })
  })

  it('drops a removed session\'s memory reading', () => {
    let st = reduce(initialState(), { kind: 'Sessions', sessions: [s('a')] })
    st = reduce(st, { kind: 'Memory', name: 'a', rssKb: 100_000, growing: false })
    st = reduce(st, { kind: 'SessionsChanged', added: [], removed: ['a'] })
    expect(st.mem['a']).toBeUndefined()
  })
})

describe('paneDot', () => {
  it('shell kind is always the shell dot', () => {
    expect(paneDot('shell', undefined)).toEqual({ cls: 'shell', label: 'shell' })
    expect(paneDot('shell', 'claude-retrying')).toEqual({ cls: 'shell', label: 'shell' })
  })
  it('claude maps run_state to dot + label', () => {
    expect(paneDot('claude', undefined)).toEqual({ cls: 'claude', label: 'claude' })
    expect(paneDot('claude', 'claude')).toEqual({ cls: 'claude', label: 'claude' })
    expect(paneDot('claude', 'claude-retrying')).toEqual({ cls: 'claude-retrying', label: 'claude (retrying)' })
    expect(paneDot('claude', 'shell-fallback')).toEqual({ cls: 'shell-fallback', label: 'shell (claude exited)' })
  })
})

describe('tabDot', () => {
  it('no claude pane → shell', () => {
    expect(tabDot([pane('shell'), pane('shell')]).cls).toBe('shell')
  })
  it('a running claude → claude', () => {
    expect(tabDot([pane('shell'), pane('claude', 'claude')]).cls).toBe('claude')
  })
  it('any retrying claude wins (most attention-worthy)', () => {
    expect(tabDot([pane('claude', 'shell-fallback'), pane('claude', 'claude-retrying')]).cls).toBe('claude-retrying')
  })
  it('all claude panes fallen back → gray shell-fallback', () => {
    expect(tabDot([pane('claude', 'shell-fallback'), pane('claude', 'shell-fallback')])).toEqual({ cls: 'shell-fallback', label: 'shell (claude exited)' })
  })
  it('a mix of fallen-back and running claude → claude', () => {
    expect(tabDot([pane('claude', 'shell-fallback'), pane('claude', 'claude')]).cls).toBe('claude')
  })
})
