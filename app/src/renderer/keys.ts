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
  | { type: 'find' }
  | { type: 'font-bigger' }
  | { type: 'font-smaller' }
  | { type: 'font-reset' }
  | { type: 'zoom' }
  | { type: 'freeze' }
  | { type: 'insert-skip-perms' }
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
  // Mac-only: require Cmd+Shift (not plain Cmd) so the chord dodges a native
  // menu accelerator on plain Cmd+key. Ignored on Linux (Shift is already the
  // modifier). See `zoom` — plain Cmd+M is the windowMenu Minimize.
  macShift?: true
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
  { action: 'find', label: 'F', keys: ['f'], desc: 'Find in pane' },
  { action: 'help', label: '/', keys: ['/', '?'], desc: 'Keyboard shortcuts' },
  // Font size. Linux holds Shift for the modifier, so the key arrives renamed
  // ('=' -> '+', '-' -> '_', '0' -> ')') — accept both forms (mirrors help).
  { action: 'font-bigger', label: '=', keys: ['=', '+'], desc: 'Increase font size' },
  { action: 'font-smaller', label: '-', keys: ['-', '_'], desc: 'Decrease font size' },
  { action: 'font-reset', label: '0', keys: ['0', ')'], desc: 'Reset font size' },
  // Zoom the focused pane to fill the stage (M avoids the Z=undo collision).
  // Mac uses Cmd+Shift+M: plain Cmd+M is the windowMenu Minimize accelerator,
  // which consumes the key before the renderer sees it. Linux: Ctrl+Shift+M.
  { action: 'zoom', label: 'M', keys: ['m'], desc: 'Zoom / restore focused pane', macShift: true },
  // Park (freeze) the focused pane — display-only, input-locked; toggles off.
  { action: 'freeze', label: 'P', keys: ['p'], desc: 'Freeze / unfreeze focused pane' },
  // Type ' --dangerously-skip-permissions' into the focused pane's pty (appends
  // to whatever's on the line — e.g. after `claude`). Just types it; no Enter.
  { action: 'insert-skip-perms', label: 'Y', keys: ['y'], desc: 'Type --dangerously-skip-permissions' },
]

export function appChord(e: KeyLike): Chord | null {
  if (e.altKey) return null
  const mac = isMac()
  const mod = mac ? (e.metaKey && !e.ctrlKey) : (e.ctrlKey && e.shiftKey && !e.metaKey)
  if (!mod) return null
  const k = e.key.toLowerCase()
  if (k >= '1' && k <= '9') return { type: 'tab', n: Number(k) }
  const entry = CHORD_TABLE.find((c) => c.keys.includes(k))
  if (!entry) return null
  // A macShift entry requires Cmd+Shift on mac (see ChordEntry.macShift): plain
  // Cmd+key would collide with a native accelerator, and without this it would
  // also fire on the plain form. Linux already holds Shift, so no extra gate.
  if (mac && entry.macShift && !e.shiftKey) return null
  return { type: entry.action }
}

// Platform modifier prefix + a key label. Used by `chordLabel` and directly by
// the overlay for the parametric 1–9 tab-jump row (not a CHORD_TABLE entry).
// `macShift` adds ⇧ to the mac prefix (Linux is Ctrl+Shift regardless).
export function modLabel(key: string, macShift = false): string {
  return isMac() ? `⌘${macShift ? '⇧' : ''}${key}` : `Ctrl+Shift+${key}`
}

// Human-readable label for a chord action, matching the platform branch above
// (mac Cmd, else Ctrl+Shift). Used by the empty-state CTA and the cheatsheet.
export function chordLabel(action: ChordAction): string {
  const entry = CHORD_TABLE.find((c) => c.action === action)
  return modLabel(entry?.label ?? '', entry?.macShift ?? false)
}
