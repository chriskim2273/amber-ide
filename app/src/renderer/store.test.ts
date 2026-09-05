import { describe, it, expect } from 'vitest'
import { initialState, reduce, groupSessions, mergeBrowserRailTabs, mergeEditors, isAgentKind, paneDot, tabDot, hasActivity, shouldHintTerminalFocus, shouldResumeMemoryParked, parkedOverlayText, resourcePressureMessage, type PaneModel, type WorkspaceModel } from './store'
import type { SessionInfo } from '../shared/proto'

describe('mergeBrowserRailTabs', () => {
  it('unions browser-only layout workspaces and tabs without inventing panes', () => {
    const out = mergeBrowserRailTabs([], { '2': { activeTab: 1, tabs: { '1': { tree: null, browser: { id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', width: 420, collapsed: false } } } } })
    expect(out).toEqual([{ ws: 2, tabs: [{ tab: 1, panes: [] }] }])
  })
  it('carries app-local titles through editor reconciliation', () => {
    const editor = mergeEditors([], {
      'editor-1-1-0-e': { ws: 1, tab: 1, ord: 0, path: null },
    }, { 'editor-1-1-0-e': 'Notes' })
    expect(editor[0]!.tabs[0]!.panes[0]!.title).toBe('Notes')
  })
  it('retains daemon tabs and adds only missing rail tabs', () => {
    const ws: WorkspaceModel[] = [{ ws: 1, tabs: [{ tab: 1, panes: [] }] }]
    const out = mergeBrowserRailTabs(ws, { '1': { activeTab: 1, tabs: { '1': { tree: null }, '2': { tree: null, browser: { id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', width: 420, collapsed: false } } } } })
    expect(out[0]!.tabs.map((tab) => tab.tab)).toEqual([1, 2])
  })
})

describe('Pi agent panes', () => {
  it('treats Pi as an agent and gives its retry state a Pi-specific label and class', () => {
    expect(isAgentKind('pi')).toBe(true)
    expect(paneDot('pi', 'claude-retrying')).toEqual({ cls: 'pi-retrying', label: 'pi (retrying)' })
  })
})

describe('terminal focus hint', () => {
  it('only allows an active terminal interaction to hint focus', () => {
    expect(shouldHintTerminalFocus(true, true, true)).toBe(true)
    expect(shouldHintTerminalFocus(true, true, false)).toBe(false)
    expect(shouldHintTerminalFocus(false, true, true)).toBe(false)
    expect(shouldHintTerminalFocus(true, false, true)).toBe(false)
  })

  it('resumes a parked pane only for direct trusted focus in the active tab', () => {
    expect(shouldResumeMemoryParked(true, true, true)).toBe(true)
    expect(shouldResumeMemoryParked(true, true, false)).toBe(false) // unarmed programmatic mount focus
    expect(shouldResumeMemoryParked(true, false, true)).toBe(false) // child button focus
    expect(shouldResumeMemoryParked(false, true, true)).toBe(false) // hidden keep-alive tab
    expect(shouldResumeMemoryParked(true, true, true, true)).toBe(false) // paired pointer focus already sent
  })
})

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

describe('reduce MemoryPressure', () => {
  it('stores aggregate pressure and no-ops identical refreshes', () => {
    const first = reduce(initialState(), {
      kind: 'MemoryPressure', level: 'critical', currentKb: 7_000_000,
      budgetKb: 8_000_000, blocked: false,
    })
    expect(first.pressure).toEqual({ level: 'critical', currentKb: 7_000_000, budgetKb: 8_000_000, blocked: false })
    expect(reduce(first, {
      kind: 'MemoryPressure', level: 'critical', currentKb: 7_000_000,
      budgetKb: 8_000_000, blocked: false,
    })).toBe(first)
  })

  it('clears stale pressure on disconnect and no-ops when already clear', () => {
    const critical = reduce(initialState(), {
      kind: 'MemoryPressure', level: 'critical', currentKb: 7_000_000,
      budgetKb: 8_000_000, blocked: false,
    })
    const cleared = reduce(critical, { kind: 'ClearMemoryPressure' })
    expect(cleared.pressure).toBeNull()
    expect(reduce(cleared, { kind: 'ClearMemoryPressure' })).toBe(cleared)
  })
})

describe('reduce ResourcePressure', () => {
  it('tracks resource causes separately and no-ops an identical refresh', () => {
    const memory = reduce(initialState(), {
      kind: 'MemoryPressure', level: 'critical', currentKb: 7_000_000,
      budgetKb: 8_000_000, blocked: false,
    })
    const cpu = reduce(memory, {
      kind: 'ResourcePressure', level: 'critical', causes: ['cpu'], blocked: false,
    })
    expect(cpu.pressure).toEqual({ level: 'critical', currentKb: 7_000_000, budgetKb: 8_000_000, blocked: false })
    expect(cpu.resourcePressure).toEqual({ level: 'critical', causes: ['cpu'], blocked: false })
    expect(reduce(cpu, {
      kind: 'ResourcePressure', level: 'critical', causes: ['cpu'], blocked: false,
    })).toBe(cpu)
  })

  it('updates the resource causes when the daemon reports a new pressure source', () => {
    const cpu = reduce(initialState(), {
      kind: 'ResourcePressure', level: 'critical', causes: ['cpu'], blocked: false,
    })
    const io = reduce(cpu, {
      kind: 'ResourcePressure', level: 'critical', causes: ['io'], blocked: false,
    })
    expect(io).not.toBe(cpu)
    expect(io.resourcePressure?.causes).toEqual(['io'])
  })

  it('clears memory and resource pressure on reconnect to an older daemon', () => {
    let state = reduce(initialState(), {
      kind: 'MemoryPressure', level: 'warning', currentKb: 7_000_000,
      budgetKb: 8_000_000, blocked: false,
    })
    state = reduce(state, {
      kind: 'ResourcePressure', level: 'critical', causes: ['memory'], blocked: true,
    })
    const cleared = reduce(state, { kind: 'ClearPressure' })
    expect(cleared.pressure).toBeNull()
    expect(cleared.resourcePressure).toBeNull()
    expect(reduce(cleared, { kind: 'ClearPressure' })).toBe(cleared)
  })
})

describe('resource-pressure presentation', () => {
  it('names every active resource source in the critical banner', () => {
    expect(resourcePressureMessage({ level: 'critical', causes: ['cpu', 'io'], blocked: false }))
      .toBe('Amber CPU and I/O pressure is critical. Idle agent panes may be parked.')
  })

  it('uses the generalized parked copy while retaining the legacy memory copy', () => {
    expect(parkedOverlayText('resource-suspended')).toBe('Parked to protect system resources')
    expect(parkedOverlayText('memory-suspended')).toBe('Parked to protect system memory')
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
    expect(paneDot('claude', 'suspended')).toEqual({ cls: 'suspended', label: 'suspended (RAM freed)' })
  })

  it('renders memory-suspended as a distinct resumable agent state', () => {
    expect(paneDot('claude', 'memory-suspended')).toEqual({
      cls: 'memory-suspended',
      label: 'claude (parked for memory)',
    })
    expect(paneDot('grok', 'memory-suspended').cls).toBe('memory-suspended')
    expect(paneDot('codex', 'memory-suspended').cls).toBe('memory-suspended')
    expect(paneDot('opencode', 'memory-suspended').cls).toBe('memory-suspended')
  })

  it('renders resource-suspended with the generalized parked status', () => {
    expect(paneDot('claude', 'resource-suspended')).toEqual({
      cls: 'memory-suspended',
      label: 'claude (parked for system resources)',
    })
  })
})

describe('paneDot grok', () => {
  // grok is a supervised agent like claude: it reports the SAME run_state
  // vocabulary (the strings name the supervision phase, not the binary), so it
  // must get the full dot treatment rather than falling through to "shell".
  it('maps run_state to dot + label', () => {
    expect(paneDot('grok', undefined)).toEqual({ cls: 'grok', label: 'grok' })
    expect(paneDot('grok', 'claude')).toEqual({ cls: 'grok', label: 'grok' })
    expect(paneDot('grok', 'claude-retrying')).toEqual({ cls: 'grok-retrying', label: 'grok (retrying)' })
    expect(paneDot('grok', 'shell-fallback')).toEqual({ cls: 'shell-fallback', label: 'shell (grok exited)' })
    expect(paneDot('grok', 'suspended')).toEqual({ cls: 'suspended', label: 'suspended (RAM freed)' })
  })
  it('is not treated as an app-local kind', () => {
    expect(paneDot('grok', undefined).cls).not.toBe('shell')
  })
})

describe('paneDot codex', () => {
  it('maps run_state to dot + label', () => {
    expect(paneDot('codex', undefined)).toEqual({ cls: 'codex', label: 'codex' })
    expect(paneDot('codex', 'claude')).toEqual({ cls: 'codex', label: 'codex' })
    expect(paneDot('codex', 'claude-retrying')).toEqual({ cls: 'codex-retrying', label: 'codex (retrying)' })
    expect(paneDot('codex', 'shell-fallback')).toEqual({ cls: 'shell-fallback', label: 'shell (codex exited)' })
    expect(paneDot('codex', 'suspended')).toEqual({ cls: 'suspended', label: 'suspended (RAM freed)' })
  })
})

describe('paneDot opencode', () => {
  it('maps run_state to dot + label', () => {
    expect(paneDot('opencode', undefined)).toEqual({ cls: 'opencode', label: 'opencode' })
    expect(paneDot('opencode', 'claude')).toEqual({ cls: 'opencode', label: 'opencode' })
    expect(paneDot('opencode', 'claude-retrying')).toEqual({ cls: 'opencode-retrying', label: 'opencode (retrying)' })
    expect(paneDot('opencode', 'shell-fallback')).toEqual({ cls: 'shell-fallback', label: 'shell (opencode exited)' })
    expect(paneDot('opencode', 'suspended')).toEqual({ cls: 'suspended', label: 'suspended (RAM freed)' })
  })
})

describe('paneDot hermes', () => {
  it('maps run_state to dot + label', () => {
    expect(paneDot('hermes', undefined)).toEqual({ cls: 'hermes', label: 'hermes' })
    expect(paneDot('hermes', 'claude-retrying')).toEqual({ cls: 'hermes-retrying', label: 'hermes (retrying)' })
    expect(paneDot('hermes', 'shell-fallback')).toEqual({ cls: 'shell-fallback', label: 'shell (hermes exited)' })
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
  it('a retrying agent still wins over a memory-parked agent', () => {
    expect(tabDot([pane('claude', 'memory-suspended'), pane('claude', 'claude-retrying')]).cls).toBe('claude-retrying')
  })
  it('a running agent keeps the normal dot beside a memory-parked agent', () => {
    expect(tabDot([pane('claude', 'memory-suspended'), pane('claude', 'claude')]).cls).toBe('claude')
  })
  it('all memory-parked agents use the memory-suspended dot', () => {
    expect(tabDot([pane('claude', 'memory-suspended'), pane('claude', 'memory-suspended')])).toEqual({
      cls: 'memory-suspended', label: 'claude (parked for memory)',
    })
  })
  it('all resource-parked agents use the generalized parked dot', () => {
    expect(tabDot([pane('claude', 'resource-suspended'), pane('claude', 'resource-suspended')])).toEqual({
      cls: 'memory-suspended', label: 'claude (parked for system resources)',
    })
  })
  it('a memory-parked agent remains parked beside a shell fallback', () => {
    expect(tabDot([pane('claude', 'memory-suspended'), pane('claude', 'shell-fallback')])).toEqual({
      cls: 'memory-suspended', label: 'claude (parked for memory)',
    })
  })
  it('a shell fallback alone keeps the fallback dot', () => {
    expect(tabDot([pane('claude', 'shell-fallback')])).toEqual({ cls: 'shell-fallback', label: 'shell (claude exited)' })
  })
  it('an all-grok tab reads grok', () => {
    expect(tabDot([pane('shell'), pane('grok', 'claude')])).toEqual({ cls: 'grok', label: 'grok' })
    expect(tabDot([pane('grok', 'claude-retrying')]).cls).toBe('grok-retrying')
  })
  it('a grok pane still counts toward the tab dot in a mixed tab', () => {
    expect(tabDot([pane('claude', 'shell-fallback'), pane('grok', 'claude')]).cls).toBe('claude')
  })
  it('an all-codex tab reads codex', () => {
    expect(tabDot([pane('shell'), pane('codex', 'claude')])).toEqual({ cls: 'codex', label: 'codex' })
    expect(tabDot([pane('codex', 'claude-retrying')]).cls).toBe('codex-retrying')
  })
  it('an all-opencode tab reads opencode', () => {
    expect(tabDot([pane('shell'), pane('opencode', 'claude')])).toEqual({ cls: 'opencode', label: 'opencode' })
    expect(tabDot([pane('opencode', 'claude-retrying')]).cls).toBe('opencode-retrying')
  })
})

describe('groupSessions slot', () => {
  it('carries the daemon-assigned slot onto the pane model', () => {
    const st = reduce(initialState(), { kind: 'Sessions', sessions: [
      { name: 'amber-1-1-0-a', cwd: '/x', kind: 'shell', alive: true, slot: 4 } as unknown as SessionInfo,
    ] })
    expect(groupSessions(st)[0]!.tabs[0]!.panes[0]!.slot).toBe(4)
  })
})
