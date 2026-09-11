# Pane scrollback and mode repair (replay + wheel)

Status: implemented on `fix/pane-scrollback-replay-modes`, based on `6ca598e`
(`origin/main`). **Not deployed** — the user asked to commit/push and wait
before installing to this machine. No daemon, binary, AppImage or boot unit on
the box was touched; the main checkout's unrelated dirty/untracked browser work
was not modified (the work was done in a separate worktree).

Two reported symptoms, both about a pane's scrollback after it is reloaded /
re-rendered:

1. "Occasionally the scrollback gets corrupted and I lose all the context."
2. "When I re-render/reload the terminal (or pane), scrolling goes up and down
   the Pi input message history instead of up the conversation."

## Root causes

Both are the same architectural gap seen from two sides: **every amber client
renders a session by writing the daemon's capped raw byte ring into a terminal
emulator, but a ring of bytes cannot express the terminal state a cold client
needs.** Four concrete defects followed from it.

### 1. A fresh pane was answered with the *previous* terminal's delta

`Router.attach()` (the path taken on every Pane mount: pane refresh, workspace
switch, renderer reload) called `sendAttach()` with the watermark of the
terminal that had just been destroyed. The daemon therefore served
`full: false` — only the bytes past an arbitrary offset — into a terminal that
held nothing.

`router.ts`'s own comment already claimed a fresh mount sends
`{epoch:'0'}`; the code did not, and `router.test.ts` only asserted the comment
in prose. Consequence: the pane lost every line it should have shown, and — more
importantly — never received the live application's startup modes (next point).

### 2. A full replay strips a live full-screen app's mouse protocol

`Pane.tsx` wrote `MOUSE_RESET` after **every** backlog replay (and again from
the two reconnect nudges), and xterm's `MOUSE_RESET` sets `activeProtocol =
'NONE'` (`InputHandler` DECRST 1000/1002/1003). Pi negotiates mouse reporting
**once**, in `beforeTerminalStart` (`ENTER_ALT_SCREEN + … + ENABLE_ALL_MOTION_MOUSE`,
`pi-tui` chunk `chunk-JVUZSMYM.js`), and never re-asserts it — so the reset was
permanent for that pane.

With no mouse protocol, xterm.js handles the wheel itself, and in a buffer
without scrollback it converts wheel events into **up/down arrows**
(`CoreBrowserTerminal`'s wheel listener: "Convert wheel events into up/down
events when the buffer does not have scrollback"). A TUI's editor reads up/down
as prompt history. That is symptom 2, exactly.

### 3. The ring no longer contains the modes, so a cold replay cannot rebuild them

Measured on the live daemon (`DumpBacklog` of a running Pi pane, 2026-09-11,
2 MiB ring): the retained window held

- `ESC [ ? 1049 h` (alt-screen enter): **0** occurrences,
- `ESC [ ? 1000/1002/1003/1006 h` (mouse): **0** occurrences,
- while holding `ESC [ ? 2026 l`, `ESC [ ? 25 h`, `ESC [ 17;1H` … frames.

The enables are written once, at TUI start; 2 MiB of frames evicts them within
minutes. So a full replay painted a TUI's cursor-addressed frames into the
**normal** buffer (junk stacked in the scrollback, wrong buffer) with no mouse
mode and no bracketed paste — symptom 1's "corrupted", plus the loss of paste
framing that `terminalClipboard.ts` was working around. The same dump showed the
ring's head cut mid-UTF-8 (`\x94\x80` = the tail of `─`), i.e. a replayed window
can begin anywhere.

### 4. An empty replay frame was never sent, leaving the client's tag armed

The daemon skipped the replay `Data` frame whenever the backlog was empty
(`!sub.backlog.is_empty()`). The app's router arms "the next `Data` frame is the
replay" when it sends the Attach, so that arm survived and tagged the next
**live** frame as scrollback — the renderer then `term.reset()`s a live pane
(the blank-pane failure described in `Pane.tsx`) or duplicates history.

## The fix

- **`crates/amber-core/src/modes.rs` (new).** A bounded, split-safe streaming
  recognizer for the private modes an application owns: alt screen
  (47/1047/1049), mouse/focus (1000/1002/1003/1004/1006/1015/1016), bracketed
  paste (2004), cursor visibility (25). `replay_preamble()` returns the bytes a
  cold terminal needs, in a documented order (alt screen first, then ascending
  reporting modes — xterm's `activeProtocol` is last-writer-wins — then `?25l`),
  and is deliberately **empty unless the alt screen is on**: a mode left behind
  by a crashed TUI must never be re-asserted into a shell.
- **`crates/amber/src/pty.rs`.** `PtySession` owns a `TerminalModes`, fed the
  same bytes as the ring in the same critical section (ring → modes, matching
  `subscribe_from`'s lock order) and at `preload` on restore. `Subscription`
  carries `preamble`, computed only for a `full` replay.
- **`crates/amber/src/daemon.rs`.** A full replay is sent as
  `preamble + window`. An opt-in attach (`resume` present) is now **always**
  answered with exactly one replay frame, even when it is empty; legacy attaches
  keep the old shape byte-for-byte.
- **`app/src/client/router.ts`.** `attach()` (a new terminal) always presents
  `{epoch:'0'}`; only `reattachAll()` (terminals that survived a socket drop)
  presents the tracked watermark.
- **`app/src/renderer/terminalModes.ts` (new).** `settleReplayedModes(term)` is
  the alt-aware replacement for the unconditional reset: normal buffer → clear
  stale mouse modes (unchanged hygiene), alternate buffer → leave a live TUI's
  modes alone. `Pane.tsx` uses it for backlog replays, keeps the unconditional
  reset only for the workspace-load staged replay (always a cold terminal whose
  app bytes are still to come), and no longer touches modes from the reconnect
  nudges.
- **`crates/amber/assets/app.js`** (the hand-written phone client, served by
  `amber web`) had the same unconditional post-replay reset; it now applies the
  same alt-aware rule. Its `ws.onopen` still resets the terminal and asks for a
  full replay, so the daemon's preamble lands first.
- **`Pane.tsx`** also treats an empty tagged replay as "nothing to replay":
  it consumes the tag but neither resets nor draws, so a live pane with no
  scrollback to hand back is left as it is.

No wire-format change: the preamble rides inside the existing replay `Data`
frame, so a client that always asks for a full replay gets the same repair
without a protocol bump. That includes the embedded phone client
(`crates/amber/assets/app.js`, served by `amber web`), which applies the same
alt-aware rule to its own post-replay `MOUSE_RESET`.

## Evidence

Persistent artifacts: `~/worktrees/amber-ide/fix-pane-scrollback-replay-modes/`.

- Diagnostic ring dump: control-frame client against the live daemon
  (`DumpBacklog`), 2 MiB, scanned for mode sequences (numbers above).
- `cargo test --workspace`: **43 test binaries, all ok** (Rust regression suites
  untouched: `resume_attach` 6/6, `pty::tests` 27/27, `amber` lib 545/545,
  `amber-core` 157/157).
- `cargo clippy --workspace --all-targets`: no warnings/errors.
- `npm run typecheck`: clean. `npx vitest run` in `app/`: **1246 passed**
  (1 pre-existing skip).
- New tests fail against the pre-fix code and pass after it:
  - `router.test.ts`: "a fresh mount presents no stale watermark…" — fails on
    `origin/main`'s router (sent the stored watermark), passes now.
  - `terminalModes.test.ts` (real xterm 6 parser): with the old unconditional
    `MOUSE_RESET`, `term.modes.mouseTrackingMode` was `'none'` after a Pi-shaped
    replay; now `'any'`, with `bracketedPasteMode` restored and the alt buffer
    still active. A normal-buffer replay still ends at `'none'`.
  - `resume_attach.rs`: preamble-led full replay, one-frame answer for an
    empty replay, and no preamble on a delta — all three fail with the daemon
    reverted to `origin/main` behaviour (verified by temporarily restoring it).
  - `pty::tests`: a cold subscription is led by modes the 64-byte ring has
    already evicted; a delta never repeats them.
  - `web::tests`: the embedded phone client's reset stays alt-aware
    (`node --check crates/amber/assets/app.js` also passes).

## Residual risk / not verified

- No GUI/desktop verification: the app and daemon on this machine still run the
  old build (deployment was deferred at the user's request). The pane-level
  behaviour is proven by unit tests, a real xterm parser and a real pty+daemon
  harness, not by a mounted Electron window.
- The tracker is best-effort across a daemon restart that restores a session
  whose retained tail predates the modes (it is fed the persisted ring at
  `preload`). A resumed child re-asserts its own modes at start, which restores
  the exact state.
- `amber attach` (raw CLI) behaviour is unchanged: `suppress_backlog` still
  governs it, and `replay_preamble()` is empty when the alt screen is off, so no
  shell can have mouse modes re-asserted by a replay.
- An app/daemon version skew is safe in both directions: a new app against an
  old daemon still keeps a live TUI's modes (no preamble, but no clobber); an
  old app against a new daemon simply gets a few extra bytes at the head of a
  full replay.
- Deploy plan (not executed): `amber ctl install` for the daemon, then the
  desktop client build, then a pane refresh to observe the wheel; the same
  recipe as the previous clipboard repair.
