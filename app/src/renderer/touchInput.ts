// Key-bar byte sequences and touch-scroll math (spec 2026-08-22 §5).
//
// Ported from `crates/amber/assets/app.js` (the hand-written phone UI), which
// is proven on a real device. Re-deriving these is how you end up sending
// literal escape junk into a claude prompt, so the sequences are copied, not
// reinvented.

/** Direction of an arrow key. */
export type ArrowDir = 'up' | 'down' | 'left' | 'right'

const ARROW_FINAL: Record<ArrowDir, string> = { up: 'A', down: 'B', right: 'C', left: 'D' }

/**
 * Arrows must follow the terminal's cursor-key mode: SS3 (`\x1bO_`) in
 * application mode (claude, vim, readline in some modes), CSI (`\x1b[_`) in
 * normal mode. Sending the wrong one breaks arrows in exactly those apps —
 * which on a phone is every app the user cares about.
 */
export function arrowSeq(dir: ArrowDir, appMode: boolean, ctrl = false): string {
  const f = ARROW_FINAL[dir]
  if (!f) return ''
  // Ctrl+arrow is always the CSI modifier form, in either mode.
  if (ctrl) return `\x1b[1;5${f}`
  return `${appMode ? '\x1bO' : '\x1b['}${f}`
}

/** One key on the bar. `ctrl` is the sticky modifier, handled by the caller. */
export interface KeyBarKey {
  key: string
  label: string
  /** Wider cell for the labels that need it. */
  wide?: boolean
}

/**
 * The bar itself. `shift-tab` is NOT optional: it is claude's mode cycle, and a
 * key bar without it fails the primary use case this whole spec exists for.
 */
export const KEY_BAR: KeyBarKey[] = [
  { key: 'esc', label: 'esc' },
  { key: 'tab', label: 'tab' },
  { key: 'shift-tab', label: '⇧tab', wide: true },
  { key: 'ctrl', label: 'ctrl' },
  // Keep the emergency interrupt and submit keys in the first thumb-width.
  // Arrows remain one horizontal swipe away instead of pushing ^C offscreen.
  { key: 'ctrl-c', label: '^C' },
  { key: 'enter', label: '⏎' },
  { key: 'slash', label: '/' },
  { key: 'left', label: '←' },
  { key: 'down', label: '↓' },
  { key: 'up', label: '↑' },
  { key: 'right', label: '→' },
]

/**
 * Key-bar key → the string to send. `appMode` selects the arrow form; `ctrl` is
 * the sticky modifier, which turns a letter into its control code.
 */
export function keyBytes(key: string, appMode: boolean, ctrl: boolean): string {
  switch (key) {
    case 'esc':
      return '\x1b'
    case 'tab':
      return '\t'
    // CSI Z — the standard back-tab. claude cycles its permission mode on this.
    case 'shift-tab':
      return '\x1b[Z'
    case 'enter':
      return '\r'
    case 'slash':
      return '/'
    case 'ctrl-c':
      return '\x03'
    case 'up':
    case 'down':
    case 'left':
    case 'right':
      return arrowSeq(key, appMode, ctrl)
    // The sticky modifier itself sends nothing; the caller toggles state.
    case 'ctrl':
      return ''
    default:
      // A single printable character with sticky Ctrl held becomes its control
      // code (Ctrl-A … Ctrl-_), matching a real keyboard.
      if (ctrl && key.length === 1) {
        const c = key.toUpperCase().charCodeAt(0)
        if (c >= 64 && c <= 95) return String.fromCharCode(c & 0x1f)
      }
      return key.length === 1 ? key : ''
  }
}

/** Per-frame decay of a flick glide (~1s from a fast flick). */
export const FLICK_DECAY = 0.94
/** Stop gliding once a frame would move less than this many lines. */
export const FLICK_MIN_LINES = 0.15
/** Axis lock threshold, in CSS px. */
export const AXIS_LOCK_PX = 6
/** Cap on the arrow keys one alt-screen gesture may burst. */
export const MAX_ALT_KEYS = 24

/**
 * Whole lines to scroll for an accumulated fractional offset, plus the
 * remainder to carry. Keeping the remainder is what lets a slow drag still move
 * a line eventually instead of stalling forever below 1.0.
 */
export function takeWholeLines(acc: number): { whole: number; rest: number } {
  // `+ 0` normalises `Math.ceil(-0.4)`, which is `-0`. Harmless arithmetically,
  // but it leaks into equality checks and reads as a bug in a test failure.
  const whole = (acc > 0 ? Math.floor(acc) : Math.ceil(acc)) + 0
  return { whole, rest: acc - whole }
}

/**
 * The arrow-key burst standing in for a scroll on the ALT screen. A full-screen
 * TUI has no scrollback of its own, so its pager must do the work — this
 * mirrors xterm's `alternateScrollMode` for the wheel.
 */
export function altScrollKeys(lines: number, appMode: boolean): string {
  if (!lines) return ''
  const seq = arrowSeq(lines > 0 ? 'down' : 'up', appMode)
  return seq.repeat(Math.min(Math.abs(lines), MAX_ALT_KEYS))
}
