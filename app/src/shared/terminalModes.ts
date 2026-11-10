// Settle terminal modes after a scrollback replay.
//
// Replaying raw scrollback re-executes its escape codes, including a prior
// program's mouse-tracking enables and its alt-screen enter. When that program
// is dead (a killed Pi, a rebooted daemon), the fresh xterm inherits both:
// hover/click motion events arrive as shell input ("35;12;8M: command not
// found") and the shell renders inside the alt buffer with no scrollback.
//
// The settle must NOT fire while a live agent TUI owns the terminal: a running
// TUI enabled those modes at its own startup and never re-asserts them, so a
// reset would silently kill its mouse (and an alt-exit would hide its screen).
// Buffer type cannot tell a dead TUI from a live one. Supervised run_state
// identifies live and stopped agents; existing shell panes have no reliable
// liveness signal, so callers must guard unknown alternate-screen state.

// Every mouse/focus tracking mode xterm.js implements. Each `l` is a no-op
// when its mode is already off. ?1004 (focus reports) is included: a stale
// enable turns every pane click into `I`/`O` garbage input the same way.
export const MOUSE_RESET =
  '\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l'

// Leave the alternate screen (no-op when already on normal). Agent TUIs enter
// via 1049; a dead one never emits the matching exit.
export const ALT_SCREEN_EXIT = '\x1b[?1049l'

// run_state values that mean an agent TUI is alive RIGHT NOW and owns the
// terminal modes. Callers must handle absent or unknown state before using
// this helper on an existing pane: a shell may run an unsupervised TUI.
// Must stay in lockstep with the daemon's allowlist in
// `SessionManager::set_run_state_report` (`crates/amber/src/manager.rs`).
const LIVE_TUI_RUN_STATES = new Set(['claude', 'suspend-failed'])

/** True when an agent TUI is alive RIGHT NOW and owns the terminal's modes. */
export function isLiveTuiRunState(runState: string | undefined): boolean {
  return LIVE_TUI_RUN_STATES.has(runState ?? '')
}

/** True unless a live agent TUI owns the terminal's modes. */
export function shouldSettleReplayedModes(runState: string | undefined): boolean {
  return !isLiveTuiRunState(runState)
}

type WritableTerminal = { write(data: string): void }

/**
 * After a backlog replay, return a TUI-less terminal to known-good modes:
 * out of a stale alt screen, mouse/focus tracking off. Skips live agent TUIs
 * (see `shouldSettleReplayedModes`). Unknown state is safe here only when the
 * caller has established that no application owns the terminal.
 */
export function settleReplayedModes(
  term: WritableTerminal,
  runState: string | undefined,
): void {
  if (!shouldSettleReplayedModes(runState)) return
  term.write(ALT_SCREEN_EXIT)
  term.write(MOUSE_RESET)
}
