import { describe, it, expect } from 'vitest'
import { sessionRows } from './sessionRows'
import type { SessionInfo } from '../shared/proto'

const s = (o: Partial<SessionInfo> & { name: string }): SessionInfo =>
  ({ cwd: '/home/u', kind: 'shell', alive: true, ...o })

describe('sessionRows', () => {
  it('places an amber-named session at its workspace/tab', () => {
    const [row] = sessionRows([s({ name: 'amber-2-3-1-abc', slot: 7 })], {})
    expect(row).toMatchObject({ name: 'amber-2-3-1-abc', slot: 7, ws: 2, tab: 3, inPane: true })
  })

  it('flags a session that no pane can show', () => {
    // Grouping is name-encoded, so a name the grammar rejects (a hand-made
    // `amber create work`) is live but reachable from no workspace — exactly
    // the leftover the cleanup view exists to surface.
    const [row] = sessionRows([s({ name: 'work' })], {})
    expect(row).toMatchObject({ name: 'work', inPane: false, ws: null, tab: null })
  })

  it('labels a claude session with its conversation', () => {
    const rows = sessionRows(
      [s({ name: 'amber-1-1-0-a', kind: 'claude', claude_id: 'uuid-1' })],
      { 'uuid-1': 'Fix the daemon freeze' },
    )
    expect(rows[0]!.claudeName).toBe('Fix the daemon freeze')
  })

  it('leaves claudeName empty when the transcript yielded nothing', () => {
    const rows = sessionRows([s({ name: 'amber-1-1-0-a', kind: 'claude', claude_id: 'uuid-x' })], {})
    expect(rows[0]!.claudeName).toBe('')
  })

  it('sorts by slot, unslotted last, and never by name', () => {
    const rows = sessionRows(
      [s({ name: 'amber-1-1-0-a', slot: 3 }), s({ name: 'work' }), s({ name: 'amber-1-1-1-b', slot: 1 })],
      {},
    )
    expect(rows.map((r) => r.name)).toEqual(['amber-1-1-1-b', 'amber-1-1-0-a', 'work'])
  })

  it('carries alive through so a dead-but-unreaped session is visibly dead', () => {
    const rows = sessionRows([s({ name: 'amber-1-1-0-a', alive: false })], {})
    expect(rows[0]!.alive).toBe(false)
  })
})
