# Project: Persistent Terminal Workspace

An Electron terminal workspace app (Warp/iTerm2-style) for **macOS and Linux**
whose defining feature is total session persistence: every pane, tab,
workspace, and running Claude Code conversation survives app crashes AND
machine reboots, restored exactly as they were.

This file is the project constitution. Keep it in the repo root, keep the
status checklist at the bottom updated, and re-read it at the start of every
session.

> **History (2026-07-13):** the original spine was tmux + tmux-resurrect +
> tmux-continuum. It was replaced by an **owned Rust session daemon** because,
> for a distributable cross-platform product, an external tmux dependency +
> double terminal emulation + the control-mode tax were long-term liabilities,
> and tmux gives almost nothing on the reboot problem (reboot kills processes
> regardless; "restore" is just save-metadata → re-run). Full rationale and
> design: `docs/superpowers/specs/2026-07-12-amber-session-daemon-design.md`.

## Core architecture (never violate without asking first)

1. **The `amber` daemon is the single source of truth** for session existence,
   naming, cwd, scrollback, and process supervision. It owns the ptys directly
   (`portable-pty`; ConPTY-ready for a future Windows port). One long-lived
   daemon; the app is a **disposable client** holding zero authoritative state.
   Any client (the app, or the `amber attach` CLI) connects over the daemon's
   unix socket.
2. **Every app pane is its own daemon session** — one pty running exactly one
   process (`$SHELL`, or `amber run <name>` which supervises `claude`). Tabs and
   workspaces are app-level groupings encoded in the **session name**
   (`amber-<ws>-<tab>-<ord>-<id>`), so grouping survives reboot with no app
   persistence.
3. **One-way data flow.** User gestures → socket control messages
   (`Create`/`Attach`/`Kill`/`Rename`/`Resize`/`Input`); daemon events
   (`Output`/`SessionList`/`Exit`/…) are the only thing that mutates
   pane-existence/grouping state in the UI. Never optimistically
   create/destroy/rename locally. Split geometry is the one app-owned bit — a
   small atomic-write sidecar JSON; grouping must still be reconstructable from
   session names alone if the sidecar is missing (geometry falls back to equal
   splits).
4. **Raw bytes, one emulator.** The daemon streams raw pty bytes over the socket
   (length-prefixed frames, no escaping) straight to **xterm.js**. There is no
   second terminal emulator and no control-mode layer. Terminal bytes never
   touch the Electron main process — a dedicated client `utilityProcess` talks
   to the daemon socket and forwards to the renderer via MessagePort; the main
   process does window management only.
5. **Rendering:** xterm.js + `@xterm/addon-webgl` (never the DOM renderer;
   handle WebGL context loss with a canvas fallback). xterm instances live
   outside React reconciliation — imperative writes via refs. React renders
   chrome only. Never a React state update per output chunk.
6. **Persistence is the daemon's job, not the app's.** Crash survival: the
   daemon outlives every client. Reboot survival: the daemon snapshots session
   metadata + capped raw-byte scrollback to a state store
   (`$XDG_STATE_HOME/amber-ide/`) on a config-driven timer **and** on `SIGTERM`
   (the pre-reboot final snapshot), and restores every session on start —
   deterministically, with **no send-keys**. There is no tmux, resurrect, or
   continuum.
7. **Claude is supervised, resumed precisely.** A `claude` session's pty runs
   `amber run <name>`, which loops `claude --dangerously-skip-permissions
   --resume <recorded-id>` (falling back to `--continue`, then to a shell after
   bounded retries so a pane never silently dies). The recorded id comes from a
   generated per-session `SessionStart` hook (`amber hook`) that rewrites it on
   every fire (ids rotate on resume/clear/compaction). Claude is resolved via
   the **login shell** and cached in config — never the daemon's own PATH (the
   original bug).
8. **Languages:** **Rust** for the daemon and all infra binaries (one
   dependency-free `amber` binary, static musl on Linux / universal on macOS);
   **TypeScript strict** for the Electron app. No native Node addons.

## Out of scope — do not build

Windows support (deferred, though `portable-pty` keeps the door open — do not
add a Windows target without asking); floating/overlapping panes; multiplexing
inside a session (every session stays one pty running one process); SSH
connection manager; AI chat UI; themes/settings beyond minimal.

## Stack

- **Daemon/CLI:** Rust, Cargo workspace (`amber-core` lib + `amber` bin),
  `portable-pty`, `clap`, `nix`, `signal-hook`. No external runtime deps.
- **App:** Electron (current stable) + electron-vite, TypeScript strict, React
  (chrome only), xterm.js + webgl addon, vitest.
- **Protocol:** length-prefixed binary frames over a unix socket
  (`amber-core::proto`) — control messages (serde) + raw `Data` frames.

## Repo layout

- `crates/amber-core/` — `ring` (scrollback), `proto` (wire codec), `state`
  (atomic store + config). Pure/testable.
- `crates/amber/` — `pty` (owned child + fan-out), `manager` (save/restore),
  `daemon` (socket server), `attach` (raw-mode client), `claude` + `supervisor`
  (resume/continue supervision), `main` (CLI).
- `infra/daemon/` — systemd user unit, launchd agent, `install.sh`, reboot
  torture-test doc.
- `scripts/dist.sh` — static/universal release builds.
- `docs/superpowers/specs/` — the design spec.

## Build status

- [x] Slice 0 — daemon spine: pty ownership, ring, proto, state, save/restore,
  socket daemon + `attach`/`ls`/`create`. Proven: restart → sessions restored.
- [x] Slice 1 — full control protocol + multi-client fan-out (folded into 0).
- [x] Slice 2 — claude supervision (`amber run`/`hook`, resume/continue,
  login-shell resolution).
- [x] Slice 3 — snapshot timer + SIGTERM final snapshot + systemd/launchd boot
  units + `install.sh` + reboot torture doc.
- [x] Slice 4 — subscriber backpressure (flat memory under fast producers);
  static musl / universal release builds. (True ~16 ms output batching: TODO.)
- [x] Slice 5 — `amber ctl doctor`/`status`/`install`/`snapshot-now`; old tmux
  infra deleted; this constitution rewritten.
- [x] Hardening pass (2026-07-13) — attach SIGWINCH + socket-close/Exit
  teardown (poll loop); per-subscriber backpressure isolation; child-exit
  lifecycle (Exit frames, subscriber close, session reaping); subscription
  release on client disconnect + `Detach`; live-socket steal guard; frame
  length cap; session-name validation; spawn-error child cleanup. `Rename`
  returns an explicit error (unsupported until supervisor rebind exists).
- [x] App Slice 1 — daemon protocol extension: `SessionInfo`,
  `WatchSessions`/`ListSessionsDetailed`/`Sessions`/`SessionsChanged`, watcher
  registry + create/kill/reap broadcast. Spec:
  `docs/superpowers/specs/2026-07-13-amber-ide-app-design.md`.
- [x] App Slices 2–3 — Electron walking skeleton: electron-vite + TS strict +
  React scaffold, byte-compatible `proto.ts`, self-healing daemon boot,
  multiplexed utilityProcess (`connection`/`router`), per-pane MessagePort
  brokered main→preload→renderer, `Pane.tsx` xterm+webgl. **Proven end-to-end on
  a live GUI**: real daemon → utilityProcess → MessagePort → xterm render, and
  keystrokes → daemon → pty, 1× each direction. Plan:
  `docs/superpowers/plans/2026-07-13-amber-ide-app-slices-1-3.md`. (Headless
  proof: `app/test/realDaemon.test.ts`. Env note: kernel 6.17 needs
  `AMBER_NO_SANDBOX=1 AMBER_SOFTWARE_GL=1` — see the design spec / env memory.)
- [x] App Slice 4 — reducer (`store`) + `names`; tabbed multi-pane UI; create/kill.
- [x] App Slice 5 — binary split tree (`layout`) + geometry sidecar
  (`layoutFile`, atomic IO); interactive split/resize/close; persist + restore.
- [x] App Slice 6 — workspace switcher; claude panes (`kind=claude`); reconnect
  (auto-backoff, re-subscribe + reattach, banner). **Full IDE surface working on
  a live GUI** (kernel-6.17 box needs `AMBER_SOFTWARE_GL=1 AMBER_NO_SANDBOX=1`).
  Fixes shipped: claude fresh-start for new sessions; deferred split placement;
  per-pane ResizeObserver; DOM renderer under software GL; layout-load gate.
- [x] App Slice 7 — packaging: electron-builder (AppImage/dmg), bundled `amber`
  resolver, `scripts/dist.sh`. **AppImage built with amber bundled.** Packaged
  first-run does a cargo-free install (copies amber to `~/.local/bin/amber` +
  writes the systemd user unit directly — the ephemeral AppImage mount can't
  back a boot unit). macOS launchd-agent install + running the installed app
  end-to-end (needs the user's normal-hardware machine; this box's kernel 6.17
  forces the software-GL flags) remain to verify.

## Gotchas (learned)

- portable-pty: drop the local `slave` after `spawn_command` so the reader sees
  EOF on child exit; keep `master` alive; the reader is a **blocking**
  `std::io::Read` (dedicated thread); `take_writer()` is one-shot;
  `clone_killer()` for out-of-band kill.
- A TUI (claude) respawned **detached at boot** must get a real pty size (never
  0×0) and the reader must drain even with zero subscribers — else it can exit.
  This is the failure mode that plausibly broke the old tmux relaunch.
- Subscriber queues are **bounded** — when ALL subscribers are saturated the
  pty is backpressured (flat memory); a lone laggard among healthy subscribers
  is disconnected after a bounded grace instead of freezing the session. Bytes
  are never skipped for a live subscriber.
- Restored pane cwds fall back to `$HOME` if the dir no longer exists — keep
  torture dirs out of `/tmp` (wiped at boot).
- `PtySession` must stay `Send + Sync` (all fields mutex/atomic-guarded) — the
  daemon shares it across connection threads.

## Working agreements

- **TDD**: write the failing test first, watch it fail, then minimal code.
  Unit-test the pure parts (ring, proto, state, claude argv/hook); integration
  tests for the daemon/supervisor use fake stubs, not mocks.
- Work in a git worktree; conventional commits at each milestone; keep
  `cargo clippy --workspace --all-targets` clean.
- If anything conflicts with these core rules, **stop and ask** instead of
  deviating.
