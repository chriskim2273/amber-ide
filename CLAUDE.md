# Project: Persistent Terminal Workspace

You are building an Electron-based terminal workspace app (Warp/iTerm2-style UI) for **macOS and Linux** whose defining feature is total session persistence: every pane, tab, workspace, and running Claude Code conversation survives app crashes AND machine reboots, restored exactly as they were.

This file is the project constitution. Keep it in the repo root, keep the status checklist at the bottom updated, and re-read it at the start of every session.

## Core architecture (never violate without asking first)

1. **Every app pane is its own tmux session** (exactly one window with one pane inside), on the default socket. Tabs and workspaces are app-level groupings, encoded in the tmux session name (naming schema fixed in Phase 2, e.g. `amber-<ws>-<tab>-<ord>-<id>`), so grouping survives reboots through resurrect with no app persistence. tmux is the single source of truth for pane existence, naming, cwd, and content. The app is a disposable client; it holds zero authoritative state. Require tmux >= 3.2 (check at startup, refuse to run below). Any plain terminal can attach any single pane with `tmux attach -t <name>`.
2. **One-way data flow.** User gestures are translated into tmux commands (`new-session`, `kill-session`, `rename-session`, `send-keys`); tmux control-mode events are the only thing that mutates pane-existence/grouping state in the UI. Never optimistically create/destroy/rename panes locally. (Split geometry is app-owned — see rule 3.)
3. **No terminal persistence logic in the app** (Phases 1-6). Crash survival is the tmux server; reboot survival is tmux-resurrect + tmux-continuum. The single allowed exception: a small layout sidecar JSON (atomic-write) mapping session names -> workspace/tab grouping details and split geometry, because tmux cannot carry app-only geometry. Pane existence and grouping must still be reconstructable from session names alone if the sidecar is missing (geometry then falls back to equal splits). We only replace the tmux-based persistence in Phase 7, which is explicitly deferred.
4. **Terminal bytes never touch the Electron main process.** The tmux control-mode layer runs in a dedicated `utilityProcess` ("tmux-host") connected to the renderer via MessagePort. Main process does window management only. tmux-host runs **one root control client** attached to a private `_amber-ctl` session for global lifecycle events, plus **one control client per visible pane-session** for output (verified 2026-07-12: `%output` is delivered only for the attached session; `%session-renamed`/`%sessions-changed` arrive on every control client).
5. **Rendering:** xterm.js + `@xterm/addon-webgl` only (never the DOM renderer; handle WebGL context loss with a canvas fallback). xterm instances live outside React reconciliation — imperative writes via refs. React renders chrome only. Never a React state update per output chunk.
6. **Language:** TypeScript strict everywhere. No Rust, no native modules. tmux is the PTY layer, so node-pty is not needed.

## Out of scope — do not build

Windows support; floating/overlapping panes; tmux window/pane multiplexing inside a session (every session stays 1 window x 1 pane; the app never calls `split-window`, `move-pane`, `swap-pane`, `break-pane`); SSH connection manager; AI chat UI; themes/settings beyond minimal; the custom snapshot daemon (Phase 7).

## Stack

Electron (current stable) + electron-vite, TypeScript strict, React (chrome only), xterm.js + webgl addon, vitest. tmux driven exclusively through control mode (`tmux -C`).

## Phase plan

Execute strictly in order. Each phase ends with an exit test. **Do not start phase N+1 until exit test N passes** — stop, demonstrate, and report instead.

### Phase 1 — Persistence spine (no app code)

Deliverables in `infra/`: `tmux.conf`, vendored tmux-resurrect + tmux-continuum, boot autostart (launchd plist for macOS, systemd user unit for Linux), an install script, and a README documenting the torture test.

Config requirements:
- resurrect: `set -g @resurrect-capture-pane-contents 'on'`; restore rule for Claude: `set -g @resurrect-processes '"~claude->claude --dangerously-skip-permissions --continue"'`
- continuum: `set -g @continuum-save-interval '1'`, `set -g @continuum-restore 'on'`; boot start via our own headless units (`@continuum-boot` off — it opens a Terminal.app window on macOS); Linux unit saves a final snapshot in `ExecStop` (continuum's timer only ticks while a client is attached)
- Sensible baseline: `set -g history-limit 50000`, `set -g window-size latest`

**Exit test:** Build 4 single-pane sessions with distinct cwds (`infra/torture-setup.sh`); run `claude` in 2 of them in *different* directories with real conversation history. (a) Kill the terminal app -> reattach -> everything intact. (b) Reboot the machine -> sessions, cwds, scrollback, and both Claude conversations restored with zero manual steps (and no leftover `_amber-boot` session).

### Phase 2 — Walking skeleton

- Repo layout: `src/main/` (window mgmt), `src/tmux-host/` (utility process), `src/renderer/` (React + xterm).
- Fix the session naming schema (workspace/tab/order/id encoded; must survive `rename-session` for regrouping and never collide with `_amber-boot`/`_amber-ctl`).
- tmux-host: root control client `tmux -C new-session -A -s _amber-ctl` on the default socket (so a plain terminal can attach the same server); per-pane control clients `tmux -C attach -t <session>`; implements the control-mode protocol:
  - Command queue with FIFO correlation of `%begin` / `%end` / `%error` reply blocks (per client connection).
  - Notification line parser (`%output`, `%session-renamed`, `%sessions-changed`, `%exit`, etc.).
  - `%output` payloads are octal-escaped (`\NNN`) — unescape before forwarding.
- MessagePort channel renderer <-> tmux-host. Batch pane output into ~16 ms frames (one transfer per pane per frame) from day one — do not forward per-chunk.
- One pane-session rendered in xterm/WebGL. Keystrokes via `send-keys -l` with special-key mapping; large pastes via `load-buffer` + `paste-buffer -p`, never send-keys. Report client size with `refresh-client -C <cols>x<rows>` on the pane's control client on resize and font change.
- Unit tests (vitest) for the protocol parser and unescaper using captured fixtures.

**Exit test:** Typing feels native; kill the app -> relaunch -> lossless reattach; parser tests green.

### Phase 3 — Full state mirror

- Mirror the full session list: handle `%sessions-changed`, `%session-renamed`, `%exit`, `%output`, and window/pane events only as they pertain to each single-pane session (consult tmux(1) CONTROL MODE for the complete list). Reconcile with `list-sessions -F` on (re)connect.
- Grouping decoder: session name -> {workspace, tab, order}; sidecar JSON supplies geometry; missing/stale sidecar entries fall back to equal splits. Unit-test the decoder + fallback.
- Always address sessions by stable IDs (`$N`) once resolved; names are for grouping/restore only.
- UI: all pane-sessions of the active tab rendered in the app grid, tab bar + workspace switcher driven from decoded names, active-pane focus tracking.

**Exit test (mirror test):** Run plain `tmux` commands side by side with the app: `tmux new-session`/`kill-session`/`rename-session` from a terminal appear correctly in the app within ~100 ms, and app actions appear in `tmux ls`. No divergence after 5 minutes of mixed use. Automate what you can, script the rest as a manual checklist.

### Phase 4 — Direct manipulation

- **Create:** UI actions create a pane -> `new-session -d -s <encoded-name> -c <cwd>` (+ attach a control client); new tab / new workspace = same, new grouping in the name.
- **Close:** close pane -> `kill-session`.
- **Move:** dragging a pane between grid slots / tabs / workspaces -> `rename-session` to the new encoded grouping + sidecar update. Modifier-drag swap = two renames.
- **Resize:** divider drag renders a ghost divider; on mouseup update the sidecar and re-report each affected pane's size via `refresh-client -C` on its control client (optional live mode throttled to <=10 Hz; never per-mousemove).
- px <-> cells via measured font metrics.

**Exit test:** Every gesture round-trips through tmux (verified via the mirror test); after a reboot, grouping is fully reconstructed from session names alone and geometry from the sidecar — **zero new persistence code beyond the sidecar**.

### Phase 5 — Performance gate

- **Flow control:** enable tmux control-mode flow control (the `pause-after` client flag; handle `%pause` / `%continue` — verify exact flag syntax against tmux(1) for the pinned version) plus xterm write-buffer watermarks that pause/resume the MessagePort producer. `cat` of a 1 GB file must never balloon app memory.
- **Mute invisible panes:** detach (or suspend) the per-pane control client of anything not on screen; on tab/workspace switch, re-attach and trigger a redraw. Background agents must cost ~zero render/IPC.
- **Scrollback:** xterm cap 5-10k lines; deep history stays in tmux (`history-limit`).
- **Benchmarks as npm scripts**, run and recorded from this phase on: (a) `yes` for 10 s in a visible pane, (b) `cat` a 1 GB file, (c) 10 background pane-sessions streaming while typing in the focused pane.

**Exit test:** p99 keypress-to-glyph < 30 ms during all three benchmarks; flat memory during (b).

### Phase 6 — Precision Claude resume

Phase 1's `--continue` rule resumes the most recent conversation per directory — it breaks with two Claude panes in the same directory. Fix:

- Launch Claude panes through a wrapper that injects a per-pane settings file: `claude --settings <generated.json>` containing a `SessionStart` hook that records `{session name -> claude session_id, cwd}` to a state file. The hook must re-record on every fire — session IDs rotate on resume, /clear, and compaction, so the last write wins.
- Pane identity across reboots is simply the tmux session name (resurrect restores it verbatim) — no positional keying needed.
- Restore path: run `claude --dangerously-skip-permissions --resume <recorded-id>` from the recorded cwd (resume is scoped to the project directory); fall back to `--continue` if no ID is on file.

**Exit test:** Two Claude pane-sessions in the *same* repo directory holding different conversations -> reboot -> each resumes its own conversation.

### Phase 7 — Custom snapshot daemon: DEFERRED. Do not build.

## Gotchas

- Pin the tmux version in docs (currently 3.4); plan to bundle a build eventually. Control-mode details and flow control vary across versions — when unsure about flag syntax, check `man tmux` for the pinned version rather than guessing.
- Control-mode event scoping (verified 2026-07-12): `%output` only flows for the session a control client is attached to; session lifecycle events broadcast to all control clients. Hence root client + per-pane clients.
- resurrect **merges** restored panes into an existing session of the same name — never pre-create a session that might be in a snapshot. `_amber-boot` (self-destructing via `boot-hold.sh`) exists precisely for this; `_amber-ctl` must be excluded from snapshots or tolerated as a trivial 1-pane session.
- continuum's autosave only ticks while a client is attached and rides on `status-right` (don't overwrite it; keep `status` on). It also refuses to autosave when a *second tmux server* is running — don't leave stray `tmux -L test` servers alive.
- Restored pane cwds silently fall back to `$HOME` if the directory no longer exists (e.g. anything under `/tmp`).
- launchd/systemd units start the tmux **server** at login; continuum handles the restore. The Linux unit also snapshots on `ExecStop`.
- WebGL context loss happens in real life (GPU resets, sleep/wake) — test the fallback path.
- Multiple control-mode clients on one server is legal and is the core of this design.

## Working agreements

- One phase at a time; demonstrate the exit test before moving on, and check it off below.
- Unit-test the pure parts (protocol parser, name-grouping decoder, px/cell math); fixtures over mocks.
- Conventional commits at each milestone.
- If anything you want to do conflicts with the core architecture rules, **stop and ask** instead of deviating.

## Status

- [ ] Phase 1 — persistence spine (reboot torture test passed)
- [ ] Phase 2 — walking skeleton (lossless reattach)
- [ ] Phase 3 — full state mirror (mirror test passed)
- [ ] Phase 4 — direct manipulation (gestures survive reboot)
- [ ] Phase 5 — performance gate (p99 < 30 ms under load)
- [ ] Phase 6 — precision Claude resume (same-dir dual resume)
