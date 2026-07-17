// App keyboard chords. Cross-platform collision problem: on Linux, Ctrl+T/W/D
// are readline/tty control chars (Ctrl+D = EOF), so an app must NOT bind bare
// Ctrl there. Convention: mac uses Cmd, Linux/others use Ctrl+Shift. The SAME
// parser gates both the action handlers (App/SplitView) and the xterm veto
// (Pane) so a chord is never also sent to the pty.

export type Chord =
  | { type: 'new-tab' }
  | { type: 'new-pane' }
  | { type: 'close' }
  | { type: 'prev-tab' }
  | { type: 'next-tab' }
  | { type: 'focus-left' }
  | { type: 'focus-right' }
  | { type: 'focus-up' }
  | { type: 'focus-down' }
  | { type: 'help' }
  | { type: 'font-bigger' }
  | { type: 'font-smaller' }
  | { type: 'font-reset' }
  | { type: 'tab'; n: number }

// A single non-parametric chord action (everything except the 1–9 tab jump,
// which is range-matched separately below).
export type ChordAction = Exclude<Chord['type'], 'tab'>

const isMac = (): boolean =>
  typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac')

interface KeyLike { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }

// Single source of truth for the chord set: consumed by `appChord` (matching)
// AND the cheatsheet overlay (display). `keys` are lowercased `e.key` values
// that trigger the action (multiple where Shift renames the key — e.g. '/'→'?').
// `label` is the platform-independent key portion; `chordLabel` prefixes the
// platform modifier. NOT computed at module scope — isMac() must be read per
// call so tests can swap navigator.platform after import.
export interface ChordEntry {
  action: ChordAction
  label: string
  keys: string[]
  desc: string
}

export const CHORD_TABLE: ChordEntry[] = [
  { action: 'new-tab', label: 'T', keys: ['t'], desc: 'New tab' },
  { action: 'new-pane', label: 'Enter', keys: ['enter'], desc: 'New pane' },
  { action: 'close', label: 'W', keys: ['w'], desc: 'Close focused pane' },
  { action: 'prev-tab', label: '[', keys: ['['], desc: 'Previous tab' },
  { action: 'next-tab', label: ']', keys: [']'], desc: 'Next tab' },
  { action: 'focus-left', label: '←', keys: ['arrowleft'], desc: 'Focus pane left' },
  { action: 'focus-right', label: '→', keys: ['arrowright'], desc: 'Focus pane right' },
  { action: 'focus-up', label: '↑', keys: ['arrowup'], desc: 'Focus pane up' },
  { action: 'focus-down', label: '↓', keys: ['arrowdown'], desc: 'Focus pane down' },
  { action: 'help', label: '/', keys: ['/', '?'], desc: 'Keyboard shortcuts' },
  // Font size. Linux holds Shift for the modifier, so the key arrives renamed
  // ('=' -> '+', '-' -> '_', '0' -> ')') — accept both forms (mirrors help).
  { action: 'font-bigger', label: '=', keys: ['=', '+'], desc: 'Increase font size' },
  { action: 'font-smaller', label: '-', keys: ['-', '_'], desc: 'Decrease font size' },
  { action: 'font-reset', label: '0', keys: ['0', ')'], desc: 'Reset font size' },
]

export function appChord(e: KeyLike): Chord | null {
  if (e.altKey) return null
  const mod = isMac() ? (e.metaKey && !e.ctrlKey) : (e.ctrlKey && e.shiftKey && !e.metaKey)
  if (!mod) return null
  const k = e.key.toLowerCase()
  if (k >= '1' && k <= '9') return { type: 'tab', n: Number(k) }
  const entry = CHORD_TABLE.find((c) => c.keys.includes(k))
  return entry ? { type: entry.action } : null
}

// Platform modifier prefix + a key label. Used by `chordLabel` and directly by
// the overlay for the parametric 1–9 tab-jump row (not a CHORD_TABLE entry).
export function modLabel(key: string): string {
  return isMac() ? `⌘${key}` : `Ctrl+Shift+${key}`
}

// Human-readable label for a chord action, matching the platform branch above
// (mac Cmd, else Ctrl+Shift). Used by the empty-state CTA and the cheatsheet.
export function chordLabel(action: ChordAction): string {
  const entry = CHORD_TABLE.find((c) => c.action === action)
  return modLabel(entry?.label ?? '')
}
