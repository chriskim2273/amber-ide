// Soft-keyboard discrimination (spec 2026-08-22 §3).
//
// Extracted from `Pane.tsx` so the rule is testable: a renderer component
// cannot be unit-tested in this repo, and this is the one mobile rule whose
// failure is invisible until a real phone taps into a pane.

/**
 * How much viewport a browser overlay must eat before it counts as the soft
 * keyboard. Small deltas (a collapsing URL bar) are not worth pinning rows for.
 */
export const KEYBOARD_MIN_PX = 120

/**
 * Bottom edge covered by the soft keyboard. `offsetTop` matters when browser
 * chrome has shifted the visual viewport: the visible bottom is
 * `offsetTop + height`, not just `height`.
 */
export function keyboardInset(
  innerHeight: number,
  visualHeight: number | null,
  offsetTop = 0,
): number {
  if (visualHeight === null) return 0
  const covered = Math.max(0, innerHeight - (visualHeight + offsetTop))
  return covered > KEYBOARD_MIN_PX ? covered : 0
}

/**
 * Whether the visible viewport shrank because a keyboard opened.
 *
 * `visualViewport.height` shrinks when the on-screen keyboard opens while
 * `innerHeight` does not, so the gap between them is the signal. A real
 * ORIENTATION change moves both, which is exactly why it must still re-fit:
 * the terminal genuinely has a new shape then.
 */
export function keyboardOpen(
  innerHeight: number,
  visualHeight: number | null,
  offsetTop = 0,
): boolean {
  return keyboardInset(innerHeight, visualHeight, offsetTop) > 0
}

export interface TerminalLiftInput {
  /** Host top in layout-viewport coordinates. */
  hostTop: number
  /** Zero-based cursor row in xterm's active viewport. */
  cursorRow: number
  cellHeight: number
  /** `visualViewport.offsetTop + visualViewport.height`. */
  visibleBottom: number
  /** On-screen terminal key bar occupying the visible viewport bottom. */
  dockHeight: number
  gap?: number
}

/**
 * Visual-only upward translation needed to keep the cursor above the keyboard
 * and key bar. This intentionally changes no layout dimension, so the pane's
 * ResizeObserver cannot mistake a keyboard transition for a real PTY resize.
 */
export function terminalLift({
  hostTop,
  cursorRow,
  cellHeight,
  visibleBottom,
  dockHeight,
  gap = 8,
}: TerminalLiftInput): number {
  if (![hostTop, cursorRow, cellHeight, visibleBottom, dockHeight, gap].every(Number.isFinite)) return 0
  if (cursorRow < 0 || cellHeight <= 0 || visibleBottom <= hostTop || dockHeight < 0 || gap < 0) return 0
  const cursorBottom = hostTop + (cursorRow + 1) * cellHeight
  const unobscuredBottom = visibleBottom - dockHeight - gap
  return Math.max(0, Math.ceil(cursorBottom - unobscuredBottom))
}
