# Project: Persistent Terminal Workspace

You are building an Electron-based terminal workspace app (Warp/iTerm2-style UI) for **macOS and Linux** whose defining feature is total session persistence: every pane, tab, workspace, and running Claude Code conversation survives app crashes AND machine reboots, restored exactly as they were.

This file is the project constitution. Keep it in the repo root, keep the status checklist at the bottom updated, and re-read it at the start of every session.

## Core architecture (never violate without asking first)

1. **tmux is the single source of truth.** Panes = tmux panes, tabs = tmux windows, workspaces = tmux sessions. The app is a disposable client; it holds zero authoritative state. Require tmux >= 3.2 (check at startup, refuse to run below).
2. **One-way data flow.** User gestures are translated into tmux commands; tmux control-mode events are the only thing that mutates UI layout state. Never optimistically update layout locally.
3. **No persistence logic in the app** (Phases 1-6). Crash survival is the tmux server; reboot survival is tmux-resurrect + tmux-continuum. We only replace them in Phase 7, which is explicitly deferred.
4. **Terminal bytes never touch the Electron main process.** The tmux control-mode client runs in a dedicated `utilityProcess` ("tmux-host") connected to the renderer via MessagePort. Main process does window management only.
5. **Rendering:** xterm.js + `@xterm/addon-webgl` only (never the DOM renderer; handle WebGL context loss with a canvas fallback). xterm instances live outside React reconciliation — imperative writes via refs. React renders chrome only. Never a React state update per output chunk.
6. **Language:** TypeScript strict everywhere. No Rust, no native modules. tmux is the PTY layer, so node-pty is not needed.

## Out of scope — do not build

Windows support; floating/overlapping panes (rectangular tmux tiling only); SSH connection manager; AI chat UI; themes/settings beyond minimal; the custom snapshot daemon (Phase 7).

## Stack

Electron (current stable) + electron-vite, TypeScript strict, React (chrome only), xterm.js + webgl addon, vitest. tmux driven exclusively through control mode (`tmux -C`).

## Phase plan

Execute strictly in order. Each phase ends with an exit test. **Do not start phase N+1 until exit test N passes** — stop, demonstrate, and report instead.

### Phase 1 — Persistence spine (no app code)

Deliverables in `infra/`: `tmux.conf`, vendored or tpm-managed tmux-resurrect + tmux-continuum, boot autostart (launchd plist for macOS, systemd user unit for Linux), an install script, and a README documenting the torture test.

Config requirements:
- resurrect: `set -g @resurrect-capture-pane-contents 'on'`; restore rule for Claude: `set -g @resurrect-processes '"~claude->claude --continue"'`
- continuum: `set -g @continuum-save-interval '5'` (minutes; go lower if supported), `set -g @continuum-restore 'on'`, boot start enabled
- Sensible baseline: `set -g history-limit 50000`, `set -g window-size latest`

**Exit test:** Build 2 sessions / 3 windows / 4+ panes with distinct cwds; run `claude` in 2 panes in *different* directories with real conversation history. (a) Kill the terminal app -> reattach -> everything intact. (b) Reboot the machine -> layout, cwds, scrollback, and both Claude conversations restored with zero manual steps.

### Phase 2 — Walking skeleton

- Repo layout: `src/main/` (window mgmt), `src/tmux-host/` (utility process), `src/renderer/` (React + xterm).
- tmux-host spawns `tmux -C new-session -A -s main` on the default socket (so a plain terminal can attach to the same server) and implements the control-mode protocol:
  - Command queue with FIFO correlation of `%begin` / `%end` / `%error` reply blocks.
  - Notification line parser (`%output`, `%layout-change`, etc.).
  - `%output` payloads are octal-escaped (`\NNN`) — unescape before forwarding.
- MessagePort channel renderer <-> tmux-host. Batch pane output into ~16 ms frames (one transfer per pane per frame) from day one — do not forward per-chunk.
- One pane rendered in xterm/WebGL. Keystrokes via `send-keys -l` with special-key mapping; large pastes via `load-buffer` + `paste-buffer -p`, never send-keys. Report client size with `refresh-client -C <cols>x<rows>` on window resize and font change.
- Unit tests (vitest) for the protocol parser and unescaper using captured fixtures.

**Exit test:** Typing feels native; kill the app -> relaunch -> lossless reattach; parser tests green.

### Phase 3 — Full state mirror

- Handle the full event set: `%output`, `%layout-change`, `%window-add`, `%window-close`, `%unlinked-window-close`, `%window-renamed`, `%session-changed`, `%session-renamed`, `%sessions-changed`, `%exit` (consult tmux(1) CONTROL MODE for the complete list).
- Layout-string parser (checksum prefix + nested `{}`/`[]` structure) -> layout tree -> pixel rects via measured cell size. Test against real layout strings captured from tmux.
- Always address by stable IDs: panes `%N`, windows `@N`, sessions `$N` — never indexes.
- UI: all panes rendered, tab bar = windows, workspace switcher = sessions, active-pane focus tracking.

**Exit test (mirror test):** Run a plain `tmux attach` side by side with the app. Any change made in either (split, kill pane, rename, new window, switch session) appears in the other within ~100 ms. No divergence after 5 minutes of mixed use. This test is the sync-bug catcher — automate what you can, script the rest as a manual checklist.

### Phase 4 — Direct manipulation

- **Resize:** divider drag renders a ghost divider; commit `resize-pane -t %id -x/-y` on mouseup (optional live mode throttled to <=10 Hz). Never send per-mousemove. px <-> cells via measured font metrics.
- **Move:** drag pane over another with N/S/E/W drop-zone hit-testing -> `move-pane -h/-v [-b] -s %src -t %dst`; modifier-drag -> `swap-pane`; drag onto tab bar -> `break-pane`; double-click header -> `resize-pane -Z`.
- **Create:** UI actions for `split-window -h/-v -c '#{pane_current_path}'`, `new-window`, `new-session`.

**Exit test:** Every gesture round-trips through tmux (verified via the mirror test) and survives a reboot **with zero new persistence code**.

### Phase 5 — Performance gate

- **Flow control:** enable tmux control-mode flow control (the `pause-after` client flag; handle `%pause` / `%continue` — verify exact flag syntax against tmux(1) for the pinned version) plus xterm write-buffer watermarks that pause/resume the MessagePort producer. `cat` of a 1 GB file must never balloon app memory.
- **Mute invisible panes:** toggle per-pane output off for this client (`refresh-client -A`) for anything not on screen; on tab/workspace switch, re-enable and trigger a redraw. Background agents must cost ~zero render/IPC.
- **Scrollback:** xterm cap 5-10k lines; deep history stays in tmux (`history-limit`).
- **Benchmarks as npm scripts**, run and recorded from this phase on: (a) `yes` for 10 s in a visible pane, (b) `cat` a 1 GB file, (c) 10 background panes streaming while typing in the focused pane.

**Exit test:** p99 keypress-to-glyph < 30 ms during all three benchmarks; flat memory during (b).

### Phase 6 — Precision Claude resume

Phase 1's `--continue` rule resumes the most recent conversation per directory — it breaks with two Claude panes in the same repo. Fix:

- Launch Claude panes through a wrapper that injects a per-pane settings file: `claude --settings <generated.json>` containing a `SessionStart` hook that records `{stable pane key -> session_id, cwd}` to a state file. The hook must re-record on every fire — session IDs rotate on resume, /clear, and compaction, so the last write wins.
- Give panes a stable identity across reboots (resurrect restores by position: key on session name + window index + pane index, or set a pane environment variable that the wrapper reads).
- Restore path: run `claude --resume <recorded-id>` from the recorded cwd (resume is scoped to the project directory); fall back to `--continue` if no ID is on file.

**Exit test:** Two Claude panes in the *same* repo directory holding different conversations -> reboot -> each pane resumes its own conversation.

### Phase 7 — Custom snapshot daemon: DEFERRED. Do not build.

## Gotchas

- Pin the tmux version in docs; plan to bundle a build eventually. Control-mode details and flow control vary across versions — when unsure about flag syntax, check `man tmux` for the pinned version rather than guessing.
- launchd/systemd units start the tmux **server** at login; continuum handles the restore.
- WebGL context loss happens in real life (GPU resets, sleep/wake) — test the fallback path.
- Multiple control-mode clients on one server is legal; that is exactly what the mirror test exercises.

## Working agreements

- One phase at a time; demonstrate the exit test before moving on, and check it off below.
- Unit-test the pure parts (protocol parser, layout parser, px/cell math); fixtures over mocks.
- Conventional commits at each milestone.
- If anything you want to do conflicts with the core architecture rules, **stop and ask** instead of deviating.

## Status

- [ ] Phase 1 — persistence spine (reboot torture test passed)
- [ ] Phase 2 — walking skeleton (lossless reattach)
- [ ] Phase 3 — full state mirror (mirror test passed)
- [ ] Phase 4 — direct manipulation (gestures survive reboot)
- [ ] Phase 5 — performance gate (p99 < 30 ms under load)
- [ ] Phase 6 — precision Claude resume (same-dir dual resume)

