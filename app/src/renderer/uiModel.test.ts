import { describe, expect, it } from 'vitest'
import {
  DAEMON_PANE_KIND_OPTIONS,
  PANE_KIND_OPTIONS,
  continuityView,
  machineWindowTitle,
  paneHeaderPresentation,
  type SnapshotState,
} from './uiModel'

describe('continuityView', () => {
  const sessions = [
    { alive: true },
    { alive: true },
    { alive: false },
  ]

  it('reports daemon-owned live and retained session truth', () => {
    expect(continuityView(true, sessions, { kind: 'idle' })).toEqual({
      tone: 'healthy',
      compact: '2 live',
      heading: 'Daemon connected',
      detail: '2 live · 1 exited, retained',
      snapshot: 'Automatic snapshots are managed by the daemon.',
      canSnapshot: true,
    })
  })

  it('does not invent a last-snapshot timestamp before confirmation', () => {
    const view = continuityView(true, [], { kind: 'idle' })
    expect(view.snapshot).not.toMatch(/ago|just now|last/i)
    expect(view.snapshot).toBe('Automatic snapshots are managed by the daemon.')
  })

  it('shows pending and confirmed snapshot states only from explicit state', () => {
    expect(continuityView(true, sessions, { kind: 'pending' }).snapshot).toBe('Saving snapshot…')
    const confirmed: SnapshotState = { kind: 'confirmed', at: 123 }
    expect(continuityView(true, sessions, confirmed).snapshot).toBe('Snapshot saved just now.')
  })

  it('makes snapshot unavailable when disconnected', () => {
    expect(continuityView(false, sessions, { kind: 'pending' })).toEqual({
      tone: 'offline',
      compact: 'offline',
      heading: 'Daemon disconnected',
      detail: 'Reconnecting to preserved sessions…',
      snapshot: 'Snapshot unavailable while disconnected.',
      canSnapshot: false,
    })
  })
})

describe('pane kind picker', () => {
  it('contains every supported pane kind once with human-readable detail', () => {
    expect(PANE_KIND_OPTIONS.map((option) => option.kind)).toEqual([
      'shell', 'claude', 'grok', 'codex', 'opencode', 'hermes', 'pi', 'browser', 'editor',
    ])
    expect(new Set(PANE_KIND_OPTIONS.map((option) => option.kind)).size).toBe(PANE_KIND_OPTIONS.length)
    expect(PANE_KIND_OPTIONS.every((option) => option.label.length > 0 && option.detail.length > 0)).toBe(true)
  })

  it('derives the daemon-backed mobile picker from the shared metadata', () => {
    expect(DAEMON_PANE_KIND_OPTIONS.map((option) => option.kind)).toEqual([
      'shell', 'claude', 'grok', 'codex', 'opencode', 'hermes', 'pi',
    ])
    expect(DAEMON_PANE_KIND_OPTIONS.every((option) =>
      PANE_KIND_OPTIONS.some((candidate) => candidate === option))).toBe(true)
  })
})

describe('machineWindowTitle', () => {
  it('uses the remote host when present and otherwise the local machine', () => {
    expect(machineWindowTitle('teapot-dev', '')).toBe('Amber · teapot-dev')
    expect(machineWindowTitle('teapot-dev', 'buildbox')).toBe('Amber · buildbox')
  })
})

describe('paneHeaderPresentation', () => {
  it('shows one primary state and suppresses competing memory telemetry', () => {
    expect(paneHeaderPresentation({ frozen: true, runState: 'memory-suspended', zoomed: true, rssKb: 800_000, growing: true, width: 900 })).toEqual({
      state: { kind: 'frozen', label: 'Frozen by you', title: 'Manually frozen in Amber' },
      showMemory: false,
    })
    expect(paneHeaderPresentation({ frozen: false, runState: 'memory-suspended', zoomed: false, rssKb: 800_000, growing: false, width: 900 }).state?.label).toBe('Parked for memory')
    expect(paneHeaderPresentation({ frozen: false, runState: null, zoomed: true, rssKb: 800_000, growing: false, width: 900 }).state?.label).toContain('Zoomed')
  })

  it('keeps ordinary memory secondary to width unless it is growing', () => {
    expect(paneHeaderPresentation({ frozen: false, runState: null, zoomed: false, rssKb: 100_000, growing: false, width: 420 }).showMemory).toBe(false)
    expect(paneHeaderPresentation({ frozen: false, runState: null, zoomed: false, rssKb: 100_000, growing: false, width: 520 }).showMemory).toBe(true)
    expect(paneHeaderPresentation({ frozen: false, runState: null, zoomed: false, rssKb: 100_000, growing: true, width: 320 }).showMemory).toBe(true)
  })
})
