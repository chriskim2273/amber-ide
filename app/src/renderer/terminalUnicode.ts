import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import type { Terminal } from '@xterm/xterm'

/**
 * Keep xterm's cell widths aligned with modern TUIs such as Freebuff/OpenTUI.
 *
 * xterm's built-in Unicode 6 provider treats an emoji-presentation sequence
 * such as U+2764 U+FE0F (❤️) as one cell. Modern width implementations treat
 * that grapheme as two cells. A TUI that positions incremental updates with
 * the modern width then leaves stale characters on xterm's screen.
 */
export function installTerminalUnicode(term: Terminal): void {
  term.loadAddon(new UnicodeGraphemesAddon())
}
