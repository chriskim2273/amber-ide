const META_ENTER = '\x1b\r'
const SHIFT_ENTER_CSI_U = '\x1b[13;2u'

/**
 * Encode the browser's Shift+Enter event for the program running in the pty.
 *
 * Pi binds newline to a real Shift+Enter key event and decodes the standard
 * CSI-u form even when the surrounding xterm.js emulator cannot negotiate the
 * full Kitty keyboard protocol. Claude Code instead needs its negotiation-free
 * Meta+Enter fallback, which Amber historically sent for every pane.
 */
export function shiftEnterSequence(kind: string): string {
  return kind === 'pi' ? SHIFT_ENTER_CSI_U : META_ENTER
}
