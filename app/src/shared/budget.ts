// Pure helpers for the memory-budget dialog. The daemon owns the truth
// (`BudgetApplied`); this module only parses what the user typed and formats
// what the daemon reported.

export interface BudgetView {
  /** Configured budget in MiB; null = auto (half of physical RAM). */
  configuredMb: number | null
  /** What the guardian actually uses right now; 0 = none/parking disabled. */
  effectiveKb: number
  /** The live amber.service MemoryHigh cap; 0 = none. */
  cgroupLimitKb: number
  /** Each pane leaf's soft ceiling. */
  sessionHighKb: number
}

/** What the user asked for in the input box. */
export type BudgetRequest = { kind: 'auto' } | { kind: 'mib'; mb: number }

/**
 * Parse `20G` / `1536M` / `20480` / `auto` into MiB (binary units). Returns
 * null for anything malformed — the caller keeps the dialog open and shows
 * the problem; nothing is sent.
 */
export function parseBudgetInput(text: string): BudgetRequest | null {
  const trimmed = text.trim()
  if (trimmed.toLowerCase() === 'auto') return { kind: 'auto' }
  const match = /^(\d+)\s*([kmg]?)$/i.exec(trimmed)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value)) return null
  const unit = (match[2] ?? '').toLowerCase()
  if (unit === 'g') return { kind: 'mib', mb: value * 1024 }
  if (unit === 'k') return value === 0 ? { kind: 'mib', mb: 0 } : { kind: 'mib', mb: Math.max(1, Math.floor(value / 1024)) }
  return { kind: 'mib', mb: value }
}

/** "8 GiB" for whole GiB, else MiB. Mirrors the CLI's renderer. */
export function formatKb(kb: number): string {
  if (kb > 0 && kb % (1024 * 1024) === 0) return `${kb / (1024 * 1024)} GiB`
  return `${Math.floor(kb / 1024)} MiB`
}
