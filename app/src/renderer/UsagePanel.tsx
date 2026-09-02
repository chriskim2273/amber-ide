// Agent plan-quota dialog (design 2026-09-01 §4).
//
// Built on the repo's own .help-overlay / .help-card / .dialog-card shell —
// inventing CSS classes here is the mistake the remote-access dialog shipped
// and had to undo.

import type { ProviderUsage } from '../shared/proto'
import { remaining, resetLabel, tone } from '../shared/usageView'

export interface PanelLine {
  label: string
  text: string
  tone: 'normal' | 'warning' | 'danger' | 'muted'
  /** USED percent for the bar, or null when there is no number to draw. */
  percentUsed: number | null
}

export interface PanelRow {
  provider: string
  plan: string | null
  lines: PanelLine[]
}

/**
 * Pure props → rows. Every non-`ok` state, and every rolled window, renders as
 * words: a percentage is shown only when the provider itself still stands
 * behind it.
 */
export function panelRows(rows: ProviderUsage[], now: number): PanelRow[] {
  return rows.map((row) => {
    if (row.state !== 'ok') {
      return {
        provider: row.provider,
        plan: row.plan,
        lines: [{ label: '', text: row.detail ?? row.state, tone: 'muted' as const, percentUsed: null }],
      }
    }
    return {
      provider: row.provider,
      plan: row.plan,
      lines: row.gauges.map((g) =>
        g.stale
          ? { label: g.label, text: 'window rolled', tone: 'muted' as const, percentUsed: null }
          : {
              label: g.label,
              text: `${Math.round(remaining(g))}% left  ${resetLabel(g, now)}`.trimEnd(),
              tone: tone(g.percent),
              percentUsed: g.percent,
            },
      ),
    }
  })
}

export function UsagePanel({
  rows,
  now,
  onClose,
}: {
  rows: ProviderUsage[]
  now: number
  onClose: () => void
}) {
  const model = panelRows(rows, now)
  return (
    <div className="help-overlay" onClick={onClose}>
      <div
        className="help-card dialog-card usage-dialog"
        role="dialog"
        aria-label="Agent plan usage"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="help-head">
          <div className="help-title">Plan usage</div>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="dialog-body">
          <p className="dialog-text">
            How much of each agent plan is left, as the provider itself reports it. Amber never
            estimates a percentage it was not given.
          </p>
          {model.length === 0 && <div className="usage-empty">No usage reported yet.</div>}
          {model.map((row) => (
            <section className="usage-row" key={row.provider}>
              <div className="usage-provider">
                {row.provider}
                {row.plan ? <span className="usage-plan"> · {row.plan}</span> : null}
              </div>
              {row.lines.map((line, i) => (
                <div className="usage-line" key={`${row.provider}-${i}`}>
                  <span className="usage-label">{line.label}</span>
                  {line.percentUsed === null ? (
                    <span className="usage-bar-gap" aria-hidden="true" />
                  ) : (
                    <span className={`usage-bar usage-bar-${line.tone}`} aria-hidden="true">
                      <span style={{ width: `${Math.min(100, Math.max(0, line.percentUsed))}%` }} />
                    </span>
                  )}
                  <span className={line.tone === 'muted' ? 'usage-muted' : 'usage-text'}>{line.text}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
