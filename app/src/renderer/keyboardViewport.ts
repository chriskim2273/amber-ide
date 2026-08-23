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
 * Whether the visible viewport shrank because a keyboard opened.
 *
 * `visualViewport.height` shrinks when the on-screen keyboard opens while
 * `innerHeight` does not, so the gap between them is the signal. A real
 * ORIENTATION change moves both, which is exactly why it must still re-fit:
 * the terminal genuinely has a new shape then.
 */
export function keyboardOpen(innerHeight: number, visualHeight: number | null): boolean {
  if (visualHeight === null) return false
  return innerHeight - visualHeight > KEYBOARD_MIN_PX
}
