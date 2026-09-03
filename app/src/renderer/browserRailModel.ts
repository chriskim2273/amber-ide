import { railWidthMetrics, MIN_RAIL_WIDTH, MAX_RAIL_WIDTH, MIN_TERMINAL_WIDTH } from '../shared/browserRail'
import { parseBrowserViewport } from '../shared/browserViewport'
export { railWidthMetrics, MIN_RAIL_WIDTH, MAX_RAIL_WIDTH, MIN_TERMINAL_WIDTH }

export interface BrowserLastAction { action: string; phase: string; error?: string }
export const BROWSER_VIEWPORT_PRESETS = [
  { id: 'responsive', label: 'Responsive', viewport: null },
  { id: 'desktop', label: 'Desktop 1280 × 800', viewport: { width: 1280, height: 800 } },
  { id: 'tablet', label: 'Tablet 768 × 1024', viewport: { width: 768, height: 1024 } },
  { id: 'mobile', label: 'Mobile 390 × 844', viewport: { width: 390, height: 844 } },
] as const

export function secondsRemaining(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000))
}

export function formatLastPiAction(action: BrowserLastAction): string {
  return `Pi ${action.action}: ${action.phase}${action.error ? ` (${action.error})` : ''}`
}

export function clampRailWidth(requested: number, availableWidth: number): number {
  return railWidthMetrics(requested, availableWidth).width
}

export function reclampedRailWidth(requested: number, availableWidth: number): number | null {
  const rendered = railWidthMetrics(requested, availableWidth).width
  return rendered === requested ? null : rendered
}

interface RailPageStatus { id: string; pageIncarnation: string; generation: number; lifecycle: 'live' | 'frozen' }
interface RailBounds { x: number; y: number; width: number; height: number }
export function railStopCommand(status: RailPageStatus): { type: 'stop'; id: string; pageIncarnation: string; expectedGeneration: number } {
  return { type: 'stop', id: status.id, pageIncarnation: status.pageIncarnation, expectedGeneration: status.generation }
}
export function railReloadCommand(status: RailPageStatus, bounds: RailBounds): { type: 'reload'; id: string; pageIncarnation: string; expectedGeneration: number } | { type: 'show'; id: string; bounds: RailBounds } {
  return status.lifecycle === 'frozen'
    ? { type: 'show', id: status.id, bounds }
    : { type: 'reload', id: status.id, pageIncarnation: status.pageIncarnation, expectedGeneration: status.generation }
}

export function keyboardRailWidth(current: number, key: string, availableWidth: number): number | null {
  if (key === 'Home') return clampRailWidth(MIN_RAIL_WIDTH, availableWidth)
  if (key === 'End') return clampRailWidth(MAX_RAIL_WIDTH, availableWidth)
  // The divider sits on the rail's left edge: moving it left grows the rail.
  if (key === 'ArrowLeft') return clampRailWidth(current + 20, availableWidth)
  if (key === 'ArrowRight') return clampRailWidth(current - 20, availableWidth)
  return null
}

export function railSecurity(rawUrl: string): { level: 'secure' | 'local' | 'insecure' | 'neutral'; label: string } {
  if (rawUrl === 'about:blank' || rawUrl.length === 0) return { level: 'neutral', label: 'Blank page' }
  try {
    const url = new URL(rawUrl)
    if (url.protocol === 'https:') return { level: 'secure', label: 'Secure HTTPS' }
    if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1')) return { level: 'local', label: 'Local HTTP' }
    if (url.protocol === 'http:') return { level: 'insecure', label: 'Not secure' }
  } catch { /* invalid transient URL is neutral */ }
  return { level: 'neutral', label: 'Unknown security' }
}

export function validateCustomViewport(widthText: string, heightText: string): { width: number; height: number } | null {
  if (!/^\d{1,4}$/.test(widthText) || !/^\d{1,4}$/.test(heightText)) return null
  return parseBrowserViewport({ width: Number(widthText), height: Number(heightText) })
}

export interface RailStatusInput {
  lifecycle: 'live' | 'frozen'
  loading: boolean
  capacityWaiting: boolean
  restoredAfterFreeze: boolean
  restoreError?: string
  focused: boolean
  diagnostics: { consoleIssues: number; networkFailures: number }
  sharedWithPi: boolean
}

export function railStatusLines(input: RailStatusInput): string[] {
  const lines: string[] = []
  if (input.lifecycle === 'frozen') lines.push('Frozen · reload to continue')
  else if (input.loading) lines.push('Loading')
  if (input.capacityWaiting) lines.push('Waiting for browser capacity')
  if (input.restoredAfterFreeze) lines.push('Reloaded after background freeze')
  if (input.restoreError) lines.push(`Restore issue: ${input.restoreError.slice(0, 1024)}`)
  if (input.diagnostics.consoleIssues > 0) lines.push(`Console issues: ${input.diagnostics.consoleIssues}`)
  if (input.diagnostics.networkFailures > 0) lines.push(`Network failures: ${input.diagnostics.networkFailures}`)
  if (input.sharedWithPi) lines.push('Shared with Pi')
  if (input.focused) lines.push('Browser page focused')
  return lines
}

export function shouldOccludeBrowser(input: { externalOverlay: boolean; externalMenu: boolean; terminalZoom: boolean }): boolean {
  return input.externalOverlay || input.externalMenu || input.terminalZoom
}
