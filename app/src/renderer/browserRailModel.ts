export interface BrowserLastAction { action: string; phase: string; error?: string }

export function secondsRemaining(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000))
}

export function formatLastPiAction(action: BrowserLastAction): string {
  return `Pi ${action.action}: ${action.phase}${action.error ? ` (${action.error})` : ''}`
}
