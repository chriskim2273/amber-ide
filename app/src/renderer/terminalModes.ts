import type { Terminal } from '@xterm/xterm'

/**
 * Disable every mouse protocol a replayed window may have re-enabled.
 *
 * Replaying raw scrollback re-executes its escape codes, so a mouse-tracking
 * enable left behind by a TUI that exited (or by history the user scrolled
 * past) comes back to life — and a shell then echoes encoded reports
 * (`ESC [ < … M`) on every pointer move. `amber attach`'s `TERM_RESTORE`
 * fights the same hazard at detach.
 */
export const MOUSE_RESET = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l'

/**
 * Settle a terminal's application-owned input modes after a scrollback replay.
 *
 * The rule is the alt screen, not the session kind:
 *
 * - **Normal buffer → reset.** Whatever mouse mode the replayed bytes set
 *   belongs to a program that is no longer painting the screen; a shell prompt
 *   must never receive mouse reports.
 * - **Alternate buffer → leave it alone.** A full-screen TUI owns the screen,
 *   has no scrollback of its own, and is the one case where the wheel has to
 *   reach the application. xterm.js routes wheel events to the app only while
 *   a mouse protocol is active; with none, it falls back to converting the
 *   wheel into up/down arrows (see `CoreBrowserTerminal`'s wheel listener,
 *   "Convert wheel events into up/down events when the buffer does not have
 *   scrollback"). Pi enables its protocol ONCE, at TUI start, and never
 *   re-asserts it — so clearing that mode here leaves the pane's wheel bound
 *   to the editor's prompt history until Pi restarts. That is the reported
 *   "scrolling goes up and down the input history instead of the
 *   conversation".
 *
 * This is why the reset may be applied after a replay that a full-screen app
 * answered: the daemon's mode preamble (`amber_core::modes`) has already put
 * the terminal into that app's real modes, and those must survive.
 */
export function settleReplayedModes(term: Terminal): void {
  if (term.buffer.active.type === 'alternate') return
  term.write(MOUSE_RESET)
}
