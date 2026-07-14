# `amber attach` session indicator (title + status bar) + nesting refusal

**Date:** 2026-07-14
**Status:** design, pending implementation
**Scope:** CLI `amber attach` client (`crates/amber/src/attach.rs`,
`crates/amber/src/main.rs`). No daemon or app changes.

## Motivation

Coming from tmux, two conveniences are expected when driving a session over
SSH: a visible marker that you are *inside* a managed session, and protection
against accidentally nesting sessions. This adds three things to the CLI
attach client:

1. An **OSC 2 terminal title** (`amber: <name>`) — robust, survives everything.
2. A **best-effort bottom status bar** — tmux-style, with documented limits.
3. A **nesting refusal** when attaching from inside an amber pane.

The Electron app is untouched; it has its own chrome and its own attach path.

## Accepted tradeoff (core-rule interaction)

The bottom bar reserves the terminal's last row by sizing the session's child
to `rows-1`. **A pty has one winsize shared by every subscriber** (`pty.rs`
resizes the single master; `daemon.rs` keys `Resize` by session name), so while
an SSH client shows the bar, the GUI app attached to the *same* session also
sees `rows-1`, and the size can flap when both are attached. This is in tension
with core rules #1/#3 (the daemon owns one authoritative pty size). The user
was shown this cost explicitly and accepted it. The bar is therefore:

- **opt-out** via `--no-status` (and off automatically when stdin is not a tty);
- **best-effort** — see limits below.

The **title** has none of this cost (it sends no resize) and is the primary,
always-on indicator.

## Feature 1 — OSC 2 title

On attach (tty only): push the terminal's title on its stack, then set it.

```
ESC [ 22 ; 2 t      (XTPUSHTITLE — save current title, if supported)
ESC ] 2 ; amber: <name> BEL
```

On detach / exit / error: pop the title back.

```
ESC [ 23 ; 2 t      (XTPOPTITLE)
```

Unsupported terminals ignore the push/pop and simply keep the last title — a
harmless degradation. Written to stdout. No configuration; always on for a tty
(a titled terminal is strictly more informative and cannot corrupt output).

## Feature 2 — best-effort bottom status bar

Enabled when stdin is a tty and `--no-status` is not given.

**Reserve the row.** The client's initial `Resize` (and every SIGWINCH resize)
sends `rows - 1` instead of `rows`. The physical last row is the bar's.

**Confine output.** Set the scroll region to the top area so ordinary output
never scrolls through the bar:

```
ESC [ 1 ; <rows-1> r      (DECSTBM)
```

**Draw the bar** on the last row, preserving the child's cursor:

```
ESC 7                     (DECSC save cursor)
ESC [ <rows> ; 1 H        (move to last row)
ESC [ 7 m                 (reverse video)
<text padded/truncated to cols>
ESC [ 0 m
ESC 8                     (DECRC restore cursor)
```

Bar text: `amber: <name> · <key> d detach` where `<key>` is the resolved prefix
name (`Ctrl-b`); when the prefix is disabled the trailing hint is omitted.
`render_status_line(name, cols, hint) -> String` returns the padded/truncated
visible text (no escapes) and is unit-tested.

**Alt-screen awareness (the correctness-critical part).** A full-screen TUI
(claude, vim, less) switches to the alternate screen, which the client must not
draw over — doing so would paint `amber: …` across the TUI. The client tracks
alt-screen state by parsing DEC private-mode sets/resets in the *output* stream:

```
ESC [ ? <params> h    -> if params include 1049 / 1047 / 47, alt-screen ON
ESC [ ? <params> l    -> the same modes: alt-screen OFF
```

This is a small, bounded CSI-parameter scanner — **not** a general emulator. It
handles parameters combined with `;`, and sequences split across reads (a
carried tail). It is implemented as `AltScreenTracker::feed(&[u8]) -> bool`
(returns current state) and unit-tested against combined and split inputs.

Bar behavior driven by the tracker:

- While **alt-screen is on**: draw nothing on the last row; the TUI owns the
  full (reduced) screen. The bar simply isn't shown.
- After each output batch while **alt-screen is off**: redraw the bar (it may
  have scrolled off if the child reset the scroll region), so it self-heals.
- On an **alt→primary transition**: re-assert DECSTBM and redraw the bar.
- On **SIGWINCH** while primary: recompute size, resize child to `rows-1`,
  re-assert DECSTBM, redraw.

**Cleanup on every exit** (detach, EOF, socket close, session exit): reset the
scroll region (`ESC [ r`), clear the last row, and pop the title. `run_client`
is refactored so its event loop `break`s with a `ClientEnd` and a single
cleanup block runs before returning, covering all exit paths.

**Documented limits** (best-effort by design):
- The bar is hidden during any alt-screen TUI (accepted; matches the preview
  the user approved).
- A program that resets the scroll region and scrolls in the *primary* screen
  can momentarily push the bar up; the post-batch redraw restores it.
- The reserved row shrinks the shared pty for all clients (accepted tradeoff).

## Feature 3 — nesting refusal

`amber attach` run from inside an amber pane inherits `AMBER_SESSION` (set on
every pane child in `manager.rs` / `supervisor.rs`). On attach:

- If `AMBER_SESSION` is set and neither `--force` nor `AMBER_ALLOW_NEST=1` is
  present, print to stderr and exit non-zero:
  `[amber] already inside amber session '<x>'; refusing to nest (use --force or AMBER_ALLOW_NEST=1 to override)`
- Otherwise proceed.

Nesting a raw-byte attach inside a pane is almost always a mistake: two raw
streams stack and the detach prefix collides between layers. Refusal (tmux's
default) is safer than a warning. The decision is a pure function
`nest_refusal(amber_session: Option<&str>, force: bool) -> Option<String>`
(`Some(message)` = refuse), unit-tested. `--force` is a new `Attach` flag;
`AMBER_ALLOW_NEST` is read in `main.rs`.

## CLI surface

```
amber attach [--no-prefix] [--no-status] [--force] [--socket <path>] [<name>]
```

## Testing (TDD)

Pure units (no tty/daemon), in `attach.rs`:
- `render_status_line`: pads to `cols`; truncates when `name`/hint overflow;
  omits the hint when none.
- `AltScreenTracker`: `\e[?1049h` -> on, `\e[?1049l` -> off; combined
  `\e[?1049;1h` -> on; `?1047`/`?47` recognized; an unrelated `\e[?25h` (cursor)
  -> unchanged; a sequence split across two `feed` calls still toggles.
- `nest_refusal`: `None` env -> ok; `Some` + not forced -> refuse; `Some` +
  forced -> ok.

Integration (existing socketpair `Harness`, extended):
- With the bar enabled, the initial `Resize` carries `rows-1` (harness asserts
  the reserved row).
- Cleanup: on a session-exit frame the client emits the scroll-region reset.

Real-pty smoke (scripted, like the detach verification): attach a shell,
confirm the title + bar are written and the bar text appears; run a command
that enters the alt-screen and confirm no `amber:` bytes are written to the
last row while alt-screen is active (no TUI corruption); confirm nesting is
refused when `AMBER_SESSION` is set.

## Revisions after code review

A review (advisor + self-review) surfaced correctness gaps that changed the
bar's behavior from the original draft:

- **Shell-only gate.** The bar is drawn only for `kind == "shell"` sessions.
  Attaching to a full-screen TUI session (claude) that is *already* on the alt
  screen is the primary SSH case; since `raw_client` skips the alt backlog, the
  `AltScreenTracker` never observes the `?1049h` and would treat claude as
  primary, injecting bar escapes into its live output. `run_attach` resolves the
  target's kind (via the same `ListSessionsDetailed` used for the no-name
  lookup) and passes `want_bar = !no_status && is_shell`. A bar over a
  full-screen session is pointless anyway.
- **No per-batch redraw.** The bar is redrawn only on init, SIGWINCH, and the
  alt→primary transition — never after every output batch. The daemon batches
  raw pty bytes with no escape-sequence awareness, so a mid-stream redraw could
  inject between the two halves of one of the child's own sequences. Cost: a
  child that resets the scroll region in the primary screen may push the bar off
  until the next redraw trigger (documented best-effort).
- **Teardown on all exits.** Unwinding the scroll region + title moved out of
  `run_client` into `attach` (`teardown_decoration`), which runs on both `Ok`
  and `Err` returns through a fresh stdout handle — so a mid-loop `?` error can
  no longer strand a scroll region on the user's shell (mirrors how
  `RawModeGuard` covers raw mode on all paths).
- **Empty `AMBER_SESSION`** is treated as unset for the nesting check.

## Out of scope

Making the bar survive alt-screen TUIs (needs a full emulator — core rule #4);
a per-client pty size (needs a protocol/daemon redesign); configurable bar
content or colors beyond the single default.
