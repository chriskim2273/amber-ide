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
// Buffer type cannot tell the two apart — a dead TUI's replay leaves the alt
// screen entered exactly like a live one — so the gate is the daemon's
// run_state, which names a live TUI and nothing else. Shell panes (no
// run_state) and parked/retrying/fallback agents (TUI dead; a relaunch
// re-enables what it needs) always settle.

// Every mouse/focus tracking mode xterm.js implements. Each `l` is a no-op
// when its mode is already off. ?1004 (focus reports) is included: a stale
// enable turns every pane click into `I`/`O` garbage input the same way.
export const MOUSE_RESET =
  '\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l'

// Leave the alternate screen (no-op when already on normal). Agent TUIs enter
// via 1049; a dead one never emits the matching exit.
export const ALT_SCREEN_EXIT = '\x1b[?1049l'

// run_state values that mean an agent TUI is alive RIGHT NOW and owns the
// terminal modes. Every other state — including absent (shells, and agents
// whose supervisor has not reported yet) — means nothing alive can own them:
// a TUI that starts later emits its own enables after this settle lands.
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
 * (see `shouldSettleReplayedModes`).
 */
export function settleReplayedModes(
  term: WritableTerminal,
  runState: string | undefined,
): void {
  if (!shouldSettleReplayedModes(runState)) return
  term.write(ALT_SCREEN_EXIT)
  term.write(MOUSE_RESET)
}
