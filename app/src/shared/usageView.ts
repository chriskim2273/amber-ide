// Pure display model for agent plan quota (design 2026-09-01 §4).
//
// In `shared/` for the same reason as `routerStatus`/`webStatus`: the daemon
// produces the numbers, the renderer renders them, and the web build must
// answer the same calls without importing from `main/`.
//
// The wire carries USED percent. Everything user-facing is REMAINING, because
// "how much do I have left" is the question this feature exists to answer.

import type { Gauge, ProviderUsage } from './proto'

/** Percent of the window still available, clamped. */
export function remaining(g: Gauge): number {
  return Math.min(100, Math.max(0, 100 - g.percent))
}

/** Tone from USED percent. */
export function tone(percentUsed: number): 'normal' | 'warning' | 'danger' {
  if (percentUsed >= 90) return 'danger'
  if (percentUsed >= 70) return 'warning'
  return 'normal'
}

/**
 * "in 4h 12m" / "in 6d" / "window rolled" / ''. A stale gauge never shows a
 * countdown OR its number — the window it measured no longer exists.
 */
export function resetLabel(g: Gauge, now: number): string {
  if (g.stale) return 'window rolled'
  if (g.resets_at === null) return ''
  const secs = g.resets_at - now
  if (secs <= 0) return ''
  if (secs >= 86400) return `in ${Math.floor(secs / 86400)}d`
  return `in ${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
}

/** Never keep presenting a disconnected Codex snapshot as a live reading. */
export function quotaStale(row: ProviderUsage, now: number): boolean {
  return row.provider === 'codex' && now - row.updated > 180
}

/** The most-consumed live gauge across every ok provider, or null. */
export function tightest(rows: ProviderUsage[], now = Math.floor(Date.now() / 1000)): { row: ProviderUsage; gauge: Gauge } | null {
  let best: { row: ProviderUsage; gauge: Gauge } | null = null
  for (const row of rows) {
    if (row.state !== 'ok' || quotaStale(row, now)) continue
    for (const gauge of row.gauges) {
      if (gauge.stale || (gauge.resets_at !== null && gauge.resets_at <= now)) continue
      if (!best || gauge.percent > best.gauge.percent) best = { row, gauge }
    }
  }
  return best
}

/**
 * Pill text, or null to HIDE the pill. Null rather than a dead badge: the web
 * build once shipped a permanently-red remote pill by rendering an error state
 * where it should have hidden an unmanaged one.
 */
export function pillLabel(rows: ProviderUsage[], now?: number): string | null {
  const best = tightest(rows, now)
  return best ? `${Math.round(remaining(best.gauge))}% left` : null
}
