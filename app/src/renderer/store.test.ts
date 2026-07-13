import { describe, it, expect } from 'vitest'
import { initialState, reduce, groupSessions } from './store'
import type { SessionInfo } from '../shared/proto'

const s = (name: string, alive = true): SessionInfo => ({ name, cwd: '/w', kind: 'shell', alive })

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
  it('Error sets error', () => {
    const st = reduce(initialState(), { kind: 'Error', msg: 'boom' })
    expect(st.error).toBe('boom')
  })
})
