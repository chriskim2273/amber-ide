import { describe, it, expect } from 'vitest'
import { remaining, tone, resetLabel, tightest, pillLabel } from './usageView'
import type { Gauge, ProviderUsage } from './proto'

const g = (over: Partial<Gauge> = {}): Gauge => ({
  kind: 'session', label: '5h window', percent: 15, resets_at: null, stale: false, ...over,
})
const row = (over: Partial<ProviderUsage> = {}): ProviderUsage => ({
  provider: 'claude', plan: 'pro', gauges: [g()], updated: 0, state: 'ok', detail: null, ...over,
})

describe('usageView', () => {
  it('reports remaining, not used', () => {
    expect(remaining(g({ percent: 15 }))).toBe(85)
    expect(remaining(g({ percent: 0 }))).toBe(100)
  })

  it('clamps a nonsense percent instead of rendering it', () => {
    expect(remaining(g({ percent: 140 }))).toBe(0)
    expect(remaining(g({ percent: -5 }))).toBe(100)
  })

  it('tones on used, at the documented thresholds', () => {
    expect(tone(69)).toBe('normal')
    expect(tone(70)).toBe('warning')
    expect(tone(89)).toBe('warning')
    expect(tone(90)).toBe('danger')
  })

  it('labels a reset as a countdown, and a rolled window as words', () => {
    expect(resetLabel(g({ resets_at: 3600 }), 0)).toBe('in 1h 0m')
    expect(resetLabel(g({ resets_at: 6 * 86400 }), 0)).toBe('in 6d')
    expect(resetLabel(g({ resets_at: null }), 0)).toBe('')
    expect(resetLabel(g({ stale: true, resets_at: 5 }), 100)).toBe('window rolled')
  })

  it('picks the tightest live gauge across providers', () => {
    const rows = [
      row({ provider: 'claude', gauges: [g({ percent: 15 })] }),
      row({ provider: 'codex', gauges: [g({ percent: 82 })] }),
    ]
    expect(tightest(rows, 0)?.row.provider).toBe('codex')
    expect(tightest(rows, 0)?.gauge.percent).toBe(82)
  })

  it('ignores stale gauges and non-ok providers when picking', () => {
    const rows = [
      row({ provider: 'claude', gauges: [g({ percent: 20 })] }),
      row({ provider: 'codex', gauges: [g({ percent: 99, stale: true })] }),
      row({ provider: 'grok', state: 'unavailable', gauges: [] }),
    ]
    expect(tightest(rows)?.row.provider).toBe('claude')
  })

  it('never promotes an old Codex sample to the live pill', () => {
    expect(pillLabel([row({ provider: 'codex', updated: 1000 })], 1300)).toBeNull()
    expect(pillLabel([row({ provider: 'codex', updated: 1000 })], 1100)).toBe('85% left')
  })

  it('hides the pill entirely when nothing is known', () => {
    expect(pillLabel([])).toBeNull()
    expect(pillLabel([row({ state: 'unavailable', gauges: [] })])).toBeNull()
    expect(pillLabel([row({ gauges: [g({ percent: 15 })] })])).toBe('85% left')
  })
})
