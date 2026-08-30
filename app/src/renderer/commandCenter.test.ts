import { describe, expect, it } from 'vitest'
import { commandCenterModel } from './commandCenter'
import { initialState, type AppState, type PaneModel, type WorkspaceModel } from './store'

const pane = (name: string, overrides: Partial<PaneModel> = {}): PaneModel => ({
  name,
  cwd: '/home/u/project',
  kind: 'shell',
  alive: true,
  ord: 0,
  deadCode: null,
  slot: 1,
  ...overrides,
})

const workspaces = (...panes: PaneModel[]): WorkspaceModel[] => [{
  ws: 2,
  tabs: [{ tab: 3, panes }],
}]

const state = (overrides: Partial<AppState> = {}): AppState => ({
  ...initialState(),
  ...overrides,
})

const names = (model: ReturnType<typeof commandCenterModel>, group: string): string[] =>
  model.groups.find((candidate) => candidate.id === group)?.items.map((item) => item.pane.name) ?? []

describe('commandCenterModel', () => {
  it('classifies only states Amber can prove', () => {
    const model = commandCenterModel({
      workspaces: workspaces(
        pane('dead', { alive: false }),
        pane('retry', { kind: 'claude', runState: 'claude-retrying', slot: 2 }),
        pane('fallback', { kind: 'grok', runState: 'shell-fallback', slot: 3 }),
        pane('suspend-failed', { kind: 'codex', runState: 'suspend-failed', slot: 4 }),
        pane('agent', { kind: 'pi', runState: 'claude', slot: 5 }),
        pane('active-shell', { slot: 6 }),
        pane('parked', { kind: 'claude', runState: 'memory-suspended', slot: 7 }),
        pane('quiet-shell', { slot: 8 }),
      ),
      state: state({
        seq: 9,
        lastActivity: { 'active-shell': 9, 'quiet-shell': 4 },
        lastSeen: { 'active-shell': 8, 'quiet-shell': 4 },
      }),
      frozen: new Set(),
    })

    expect(names(model, 'needs-you')).toEqual(['dead', 'retry', 'fallback', 'suspend-failed'])
    expect(names(model, 'working')).toEqual(['active-shell', 'agent'])
    expect(names(model, 'parked')).toEqual(['parked'])
    expect(names(model, 'quiet')).toEqual(['quiet-shell'])
    expect(model.groups.flatMap((group) => group.items).every((item) => item.ws === 2 && item.tab === 3)).toBe(true)
  })

  it('uses strict precedence: exit, then parked, then activity', () => {
    const model = commandCenterModel({
      workspaces: workspaces(
        pane('dead-frozen', { alive: false, kind: 'claude' }),
        pane('frozen-active', { kind: 'claude', runState: 'claude', slot: 2 }),
      ),
      state: state({ seq: 10, lastActivity: { 'dead-frozen': 10, 'frozen-active': 10 } }),
      frozen: new Set(['dead-frozen', 'frozen-active']),
    })

    expect(names(model, 'needs-you')).toEqual(['dead-frozen'])
    expect(names(model, 'parked')).toEqual(['frozen-active'])
    expect(model.groups.find((group) => group.id === 'parked')?.items[0]?.stateLabel).toBe('Frozen by you')
    expect(names(model, 'working')).toEqual([])
  })

  it('orders urgent states deterministically, then uses newest activity and stable slot order', () => {
    const model = commandCenterModel({
      workspaces: workspaces(
        pane('fallback', { kind: 'claude', runState: 'shell-fallback', slot: 8 }),
        pane('retry-b', { kind: 'claude', runState: 'claude-retrying', slot: 3 }),
        pane('retry-a', { kind: 'claude', runState: 'claude-retrying', slot: 2 }),
        pane('dead', { alive: false, slot: 9 }),
        pane('working-old', { slot: 6 }),
        pane('working-new', { slot: 7 }),
      ),
      state: state({
        seq: 20,
        lastActivity: { 'working-old': 11, 'working-new': 19 },
        lastSeen: { 'working-old': 0, 'working-new': 0 },
      }),
      frozen: new Set(),
    })

    expect(names(model, 'needs-you')).toEqual(['dead', 'retry-a', 'retry-b', 'fallback'])
    expect(names(model, 'working')).toEqual(['working-new', 'working-old'])
  })

  it('filters by workspace without changing authoritative grouping', () => {
    const model = commandCenterModel({
      workspaces: [
        { ws: 1, tabs: [{ tab: 1, panes: [pane('ws-one')] }] },
        { ws: 2, tabs: [{ tab: 1, panes: [pane('ws-two', { slot: 2 })] }] },
      ],
      state: state(),
      frozen: new Set(),
      workspace: 2,
    })

    expect(model.count).toBe(1)
    expect(model.groups.flatMap((group) => group.items).map((item) => item.pane.name)).toEqual(['ws-two'])
  })

  it('keeps app-local browser and editor panes out of the mobile terminal command center', () => {
    const model = commandCenterModel({
      workspaces: workspaces(
        pane('browser-2-3-0-x', { kind: 'browser' }),
        pane('editor-2-3-1-y', { kind: 'editor', slot: 2 }),
        pane('amber-2-3-2-z', { slot: 3 }),
      ),
      state: state(),
      frozen: new Set(),
    })

    expect(model.groups.flatMap((group) => group.items).map((item) => item.pane.name))
      .toEqual(['amber-2-3-2-z'])
  })

  it('surfaces critical pressure as global truth instead of blaming an arbitrary session', () => {
    const model = commandCenterModel({
      workspaces: workspaces(pane('one')),
      state: state({
        pressure: { level: 'critical', currentKb: 8_000, budgetKb: 7_000, blocked: true },
        resourcePressure: { level: 'critical', causes: ['cpu', 'io'], blocked: false },
      }),
      frozen: new Set(),
    })

    expect(model.alerts).toEqual([
      { id: 'memory', level: 'critical', text: 'Memory pressure is critical. Close or freeze active work.' },
      { id: 'resources', level: 'critical', text: 'CPU and I/O pressure is critical. Amber may park idle agents.' },
    ])
    expect(names(model, 'needs-you')).toEqual([])
    expect(names(model, 'quiet')).toEqual(['one'])
  })

  it('returns honest operational labels for each row', () => {
    const model = commandCenterModel({
      workspaces: workspaces(
        pane('retry', { kind: 'codex', runState: 'claude-retrying' }),
        pane('parked', { kind: 'pi', runState: 'resource-suspended', slot: 2 }),
        pane('shell', { slot: 3 }),
      ),
      state: state(),
      frozen: new Set(),
    })
    const byName = new Map(model.groups.flatMap((group) => group.items).map((item) => [item.pane.name, item]))

    expect(byName.get('retry')?.stateLabel).toBe('Codex retrying')
    expect(byName.get('parked')?.stateLabel).toBe('Parked to protect system resources')
    expect(byName.get('shell')?.stateLabel).toBe('Quiet shell')
  })
})
