// Pure relaunch policy for the client utilityProcess (the process that owns the
// daemon socket). The Electron wiring in main/index.ts is not unit-testable here;
// these pure helpers are, and hold the two decisions that must not regress:
// capped-exponential backoff, and an uptime-gated attempt counter that prevents a
// fork-then-instantly-die child from hammering relaunches every base interval.

export interface BackoffConfig {
  /** Delay for attempt 0. */
  baseMs: number
  /** Upper bound on any single delay. */
  maxMs: number
}

/** Capped exponential backoff for the Nth (0-based) relaunch attempt. */
export function backoffDelay(attempt: number, cfg: BackoffConfig): number {
  const a = Math.max(0, Math.floor(attempt))
  return Math.min(cfg.maxMs, cfg.baseMs * 2 ** a)
}

/** Next attempt counter after a child exit. Reset to 0 only when the child
 *  stayed up at least `stableMs` (a genuine run — the failure was transient);
 *  otherwise grow it so backoff widens on a crash loop. */
export function nextAttempt(prevAttempt: number, uptimeMs: number, stableMs: number): number {
  return uptimeMs >= stableMs ? 0 : Math.max(0, prevAttempt) + 1
}
