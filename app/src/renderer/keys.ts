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
  | { type: 'tab'; n: number }

const isMac = (): boolean =>
  typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac')

interface KeyLike { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }

export function appChord(e: KeyLike): Chord | null {
  if (e.altKey) return null
  const mod = isMac() ? (e.metaKey && !e.ctrlKey) : (e.ctrlKey && e.shiftKey && !e.metaKey)
  if (!mod) return null
  const k = e.key.toLowerCase()
  if (k === 't') return { type: 'new-tab' }
  if (k === 'enter') return { type: 'new-pane' }
  if (k === 'w') return { type: 'close' }
  if (k === '[') return { type: 'prev-tab' }
  if (k === ']') return { type: 'next-tab' }
  if (k >= '1' && k <= '9') return { type: 'tab', n: Number(k) }
  return null
}

// Human-readable label for a chord, matching the platform branch above (mac
// Cmd, else Ctrl+Shift). Used by the empty-state CTA to hint the new-pane key.
const CHORD_KEYS: Record<Exclude<Chord['type'], 'tab'>, string> = {
  'new-tab': 'T',
  'new-pane': 'Enter',
  'close': 'W',
  'prev-tab': '[',
  'next-tab': ']',
}

export function chordLabel(action: Exclude<Chord['type'], 'tab'>): string {
  const k = CHORD_KEYS[action]
  return isMac() ? `⌘${k}` : `Ctrl+Shift+${k}`
}
