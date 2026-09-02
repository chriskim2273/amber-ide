import { describe, it, expect } from 'vitest'
import { panelRows } from './UsagePanel'
import type { ProviderUsage } from '../shared/proto'

const ok: ProviderUsage = {
  provider: 'claude', plan: 'pro', updated: 0, state: 'ok', detail: null,
  gauges: [
    { kind: 'session', label: '5h window', percent: 15, resets_at: 3600, stale: false },
    { kind: 'weekly', label: 'weekly', percent: 2, resets_at: 6 * 86400, stale: false },
  ],
}

describe('panelRows', () => {
  it('renders remaining plus a countdown per gauge', () => {
    const [row] = panelRows([ok], 0)
    expect(row?.plan).toBe('pro')
    expect(row?.lines[0]).toMatchObject({ label: '5h window', tone: 'normal', percentUsed: 15 })
    expect(row?.lines[0]?.text).toContain('85% left')
    expect(row?.lines[0]?.text).toContain('in 1h 0m')
  })

  it('states a non-ok provider in words, with no bar', () => {
    const rows = panelRows(
      [{ ...ok, provider: 'grok', state: 'unavailable', gauges: [], plan: null,
         detail: 'grok exposes no quota data' }],
      0,
    )
    expect(rows[0]?.lines).toEqual([
      { label: '', text: 'grok exposes no quota data', tone: 'muted', percentUsed: null },
    ])
  })

  it('states needs-auth as an action, not a number', () => {
    const rows = panelRows(
      [{ ...ok, state: 'needs-auth', gauges: [], detail: 'claude token expired — run claude to refresh' }],
      0,
    )
    expect(rows[0]?.lines[0]?.percentUsed).toBeNull()
    expect(rows[0]?.lines[0]?.text).toContain('run claude')
  })

  it('states a rolled window instead of its number', () => {
    const rows = panelRows(
      [{ ...ok, gauges: [{ kind: 'session', label: '5h window', percent: 88, resets_at: 5, stale: true }] }],
      1000,
    )
    expect(rows[0]?.lines[0]?.text).toBe('window rolled')
    expect(rows[0]?.lines[0]?.percentUsed).toBeNull()
    expect(JSON.stringify(rows)).not.toContain('88')
  })

  it('tones a nearly-exhausted window as danger', () => {
    const rows = panelRows(
      [{ ...ok, gauges: [{ kind: 'weekly', label: 'weekly', percent: 93, resets_at: null, stale: false }] }],
      0,
    )
    expect(rows[0]?.lines[0]?.tone).toBe('danger')
    expect(rows[0]?.lines[0]?.text).toBe('7% left')
  })
})
