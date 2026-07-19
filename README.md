# amber

A terminal workspace (Warp/iTerm2-style) whose defining feature is **total
session persistence**: every pane, tab, workspace, and running Claude Code
conversation survives app crashes **and** machine reboots, restored exactly as
they were. For **macOS and Linux**.

## Why

I built this because I used Warp, and every time it crashed I had to manually
restart all of my Claude Code sessions. I also dual-boot Linux and Windows — to
play games I have to reboot into Windows, and rebooting killed every session.
Losing that context, over and over, got old.

So amber is built around one idea: **your sessions are not the app's to lose.**
Close the app, crash the app, reboot the machine — the sessions keep going and
come back where you left them.

## How it works

The app is a disposable window. The real work happens in a long-lived Rust
daemon (`amber`) that owns everything.

- **The `amber` daemon is the single source of truth.** It owns the ptys
  directly (`portable-pty`), holds session names, cwds, scrollback, and
  supervises processes. The Electron app is just a client — it holds zero
  authoritative state. Kill the app and the daemon (plus every session) keeps
  running; reopen and reattach.
- **Every pane is its own daemon session.** One pty, one process. Tabs and
  workspaces are encoded in the session name, so grouping survives a reboot with
  no app-side persistence.
- **Crash survival:** the daemon outlives every client.
- **Reboot survival:** the daemon snapshots session metadata + capped scrollback
  to disk on a timer *and* on `SIGTERM` (the pre-reboot final snapshot), then
  restores every session on start — deterministically, no `send-keys` replay.
- **Claude Code sessions are supervised and resumed precisely.** A Claude pane
  runs `amber run <name>`, which resumes the exact conversation id
  (`claude --resume <id>`), rotating the id as it changes and falling back to a
  shell so a pane never silently dies.

No tmux, no double terminal emulation. Raw pty bytes stream over a unix socket
straight to a single xterm.js emulator.

## Stack

- **Daemon/CLI:** Rust — one dependency-free `amber` binary (static musl on
  Linux, universal on macOS). `portable-pty`, `clap`, `nix`, `signal-hook`.
- **App:** Electron + electron-vite, TypeScript strict, React (chrome only),
  xterm.js + WebGL addon.
- **Protocol:** length-prefixed binary frames over a unix socket — serde control
  messages + raw data frames.

## Repo layout

- `crates/amber-core/` — ring buffer (scrollback), wire codec, atomic state store.
- `crates/amber/` — pty ownership, save/restore manager, socket daemon, attach
  client, Claude supervision, CLI.
- `app/` — the Electron client.
- `infra/daemon/` — systemd user unit, launchd agent, `install.sh`.
- `scripts/dist.sh` — static/universal release builds.
- `docs/superpowers/specs/` — design specs.

## Build

Daemon + CLI:

```bash
cargo build --workspace
cargo test --workspace
```

App:

```bash
cd app
npm install
npm run dev        # dev GUI
npm run dist       # packaged AppImage (Linux) / dmg (macOS)
```

The `amber` CLI also stands alone — attach to any session from a plain terminal:

```bash
amber ls                    # list sessions
amber attach                # attach the newest live session
amber attach <name>         # attach a specific one  (Ctrl-b d to detach)
amber ctl status            # daemon health
```

## Status

Early — `v0.0.1`, single-developer project. The daemon spine, Claude
supervision, reboot restore, and the full Electron IDE surface (tabs,
workspaces, splits, drag-to-rearrange, browser panes, workspace save/load) all
work and have been verified on a live GUI. See the build-status checklist at the
bottom of [`CLAUDE.md`](CLAUDE.md) for the detailed per-slice state.

## License

[GPL-3.0](LICENSE) © 2026 chriskim2273. Use, modify, and redistribute freely —
derivatives must stay open under the same license.

## Out of scope

Windows support (deferred), floating panes, multiplexing inside a session, an
SSH connection manager, an AI chat UI, heavy theming.
