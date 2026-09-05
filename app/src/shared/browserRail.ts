export const MIN_RAIL_WIDTH = 280
export const MAX_RAIL_WIDTH = 900
export const MIN_TERMINAL_WIDTH = 240

export interface RailWidthMetrics { min: number; max: number; width: number }

/** The sole width calculation for rendered size, divider input, and ARIA. */
export function railWidthMetrics(requested: number, availableWidth: number): RailWidthMetrics {
  const available = Number.isFinite(availableWidth) ? Math.max(0, Math.floor(availableWidth)) : MIN_RAIL_WIDTH + MIN_TERMINAL_WIDTH
  const max = Math.min(MAX_RAIL_WIDTH, Math.max(MIN_RAIL_WIDTH, available - MIN_TERMINAL_WIDTH))
  const rounded = Number.isFinite(requested) ? Math.round(requested) : MIN_RAIL_WIDTH
  return { min: MIN_RAIL_WIDTH, max, width: Math.min(max, Math.max(MIN_RAIL_WIDTH, rounded)) }
}

export function clampStoredRailWidth(requested: number): number {
  return railWidthMetrics(requested, MAX_RAIL_WIDTH + MIN_TERMINAL_WIDTH).width
}
