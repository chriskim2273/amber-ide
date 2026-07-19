# amber

[![Latest release](https://img.shields.io/github/v/release/chriskim2273/amber-ide)](https://github.com/chriskim2273/amber-ide/releases/latest)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

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

## Why "amber"

Amber is fossilized tree resin — it traps whatever falls into it and preserves
it, perfectly intact, for millions of years. An insect caught in amber looks
exactly as it did the moment it was trapped. That's the whole idea here: your
sessions get frozen in amber and come back exactly as they were, no matter what
happens to the app or the machine.

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

## Features

**Persistence**
- Sessions survive **app crashes** (daemon outlives every client) and **machine
  reboots** (snapshot on a timer + a final one on `SIGTERM`, restored on start —
  no `send-keys` replay).
- Capped raw-byte scrollback preserved and replayed on restore.
- Split geometry, tab/workspace grouping, and pane titles all come back exactly.

**Terminal & panes**
- Real ptys owned by the daemon, raw bytes streamed to a single xterm.js +
  WebGL emulator (DOM-renderer fallback on WebGL context loss).
- Tabs and multiple workspaces, with a workspace switcher.
- Binary split layout — interactive split, drag-to-resize dividers, close.
- **Drag to rearrange panes** — drop on an edge to re-split, on the center to
  swap two panes.
- **Keyboard pane navigation** (Cmd/Ctrl+Shift+arrows) and a chord help overlay (`?`).
- **Pane zoom** (Cmd/Ctrl+Shift+M) and per-pane **scrollback search**
  (Cmd/Ctrl+Shift+F).
- Live OSC pane titles, per-pane font-size chords, header context menu
  (copy cwd, kind override).
- **Freeze/park a pane** with a note — input blocked, blurred, activity
  suppressed (display-only; daemon untouched).
- Background-tab **activity dots**; disconnected/reconnect banners with
  auto-backoff.
- Tab + workspace rename, tab close, drag-to-reorder tabs.

**Claude Code**
- A Claude pane is supervised by `amber run` — it resumes the **exact**
  conversation id across restarts, rotates the id as it changes, and falls back
  to a shell so a pane never silently dies.
- Run-state dots: claude / retrying / shell-fallback.

**Browser pane**
- A web-viewer pane kind (Electron `<webview>` + URL bar); its URL persists and
  survives reboot via the sidecar. Popups open in the system browser.

**Workspaces**
- Save/load a whole workspace (structure + scrollback) to a portable
  `.amberws` JSON file.

**CLI (`amber`)** — works standalone from any terminal
- `ls`, `create`, `attach` (newest or by name), `kill`, `rename`.
- `attach` extras: `Ctrl-b d` tmux-style detach (remappable, `--no-prefix` to
  disable), OSC terminal title, a bottom status bar, and refusal to nest inside
  an existing amber pane.
- `ctl doctor` / `status` / `install` / `uninstall` / `snapshot-now`.

**Phone access — `amber web`**
- `amber web` serves a mobile browser UI for your live sessions: tap a session,
  get a full-screen terminal, type into it — including driving a running claude.
- It is an ordinary daemon **client**; the daemon itself never touches the
  network. The server binds `127.0.0.1` only.
- Reach it from your phone over Tailscale:
  ```sh
  amber web --print-url          # prints http://127.0.0.1:7717/#t=<token>
  amber web &                    # or: amber ctl install --web
  tailscale serve --bg 7717      # real HTTPS, tailnet-only
  ```
  Open the printed URL on the phone (swap the host for your tailnet name). The
  token rides in the URL **fragment**, so it never reaches the server logs; the
  page exchanges it for an HttpOnly cookie and strips it from history.
- The phone can open sessions and type. It **cannot** create, kill, rename or
  resize them — a pty's size is shared with your desktop panes, so a phone-sized
  resize would reflow your live work.

**Platform & packaging**
- Linux AppImage / macOS dmg via electron-builder, with the static `amber`
  binary bundled.
- First run does a **cargo-free install** — copies `amber` to `~/.local/bin`
  and writes a boot unit (systemd user unit on Linux, launchd agent on macOS).
- Linux "Install desktop shortcut" — icon + `.desktop` entry with taskbar-pin
  grouping.

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

## Download

**Linux (x86_64):** grab the latest AppImage from
[Releases](https://github.com/chriskim2273/amber-ide/releases/latest), then:

```bash
chmod +x amber-ide-*.AppImage
./amber-ide-*.AppImage
```

First launch installs the `amber` daemon to `~/.local/bin` and a systemd user
boot unit, so your sessions survive reboots.

**macOS (Apple Silicon + Intel):** grab the matching `.dmg` from
[Releases](https://github.com/chriskim2273/amber-ide/releases/latest) —
`amber-ide-*-arm64.dmg` for Apple Silicon, `amber-ide-*.dmg` for Intel (a
universal standalone `amber` binary is attached too). These builds were built
and added by **inbedby12**. They are unsigned, so on first launch right-click
the app and choose **Open** to get past Gatekeeper.

## Contributing / building from source

### Prerequisites

**1. Rust (stable)** — for the daemon/CLI. Install via [rustup](https://rustup.rs):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup component add clippy          # CI runs clippy -D warnings
```

The workspace tracks the **stable** toolchain (edition 2021). Static release
builds also need the musl target + linker (Linux only):

```bash
rustup target add x86_64-unknown-linux-musl
sudo apt install musl-tools          # provides musl-gcc  (Debian/Ubuntu)
```

**2. Node.js (LTS) + npm** — for the Electron app. CI uses `lts/*`. Recommended
via [nvm](https://github.com/nvm-sh/nvm):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install --lts && nvm use --lts
```

**3. System tools** — `git`, and a C toolchain (`build-essential` on
Debian/Ubuntu; Xcode Command Line Tools on macOS) for native build steps.

> **Odd-kernel note:** on some Linux kernels the dev GUI needs
> `AMBER_NO_SANDBOX=1 AMBER_SOFTWARE_GL=1` to render (documented in `CLAUDE.md`).

### Build

Clone, then build each half:

```bash
git clone https://github.com/chriskim2273/amber-ide.git
cd amber-ide

# Daemon + CLI (Rust)
cargo build --workspace
cargo test  --workspace

# App (Electron)
cd app
npm ci             # or: npm install
npm run dev        # dev GUI
npm run dist       # packaged AppImage (Linux) / dmg (macOS)
```

### Before opening a PR

Mirror what CI checks — all must be green:

```bash
cargo clippy --workspace --all-targets -- -D warnings
cargo test  --workspace
cd app && npm run typecheck && npx vitest run
```

Work in a git worktree, use conventional commits, and follow the working
agreements in [`CLAUDE.md`](CLAUDE.md).

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
