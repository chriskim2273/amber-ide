# Amber Session Daemon — boot integration & reboot torture test

The `amber` daemon replaces the tmux + tmux-resurrect + tmux-continuum spine
(old `infra/`). It owns ptys directly (`portable-pty`), persists session
metadata + scrollback to a state store, and restores everything on start.
There is **no external dependency** — a single `amber` binary.

## Install

```sh
infra/daemon/install.sh
```

Builds `--release`, installs the binary to `~/.local/bin/amber` (override with
`AMBER_BIN_DIR`), and installs the boot unit:

- **Linux:** `~/.config/systemd/user/amber.service`, enabled + started, with
  `loginctl enable-linger` so the daemon starts at boot **before login** and
  survives logout. `KillSignal=SIGTERM` + `TimeoutStopSec=10` give the daemon's
  final-snapshot handler time to flush before SIGKILL.
- **macOS:** `~/Library/LaunchAgents/com.amber-ide.daemon.plist`, `RunAtLoad` +
  `KeepAlive`. launchd sends `SIGTERM` at unload/shutdown → final snapshot.

## How persistence works (vs the old tmux spine)

| Concern | Old (tmux) | New (amber daemon) |
|---|---|---|
| Crash survival | tmux server outlives client | daemon outlives every client |
| Reboot survival | continuum autosave + resurrect restore | daemon snapshot timer + restore on start |
| Scrollback | `capture-pane-contents` | per-session capped raw-byte ring → `scrollback/<name>.bin` |
| Claude relaunch | `@resurrect-processes` **send-keys** (fragile) | `amber run <name>` supervisor exec — **no send-keys** |
| Claude resume | `--continue` per dir (collides) | `--resume <recorded-id>` per session (precise) |
| Boot start | systemd/launchd starts tmux server | systemd/launchd starts `amber daemon` |
| Pre-reboot gap | `ExecStop` final save (Linux only) | `SIGTERM` → final snapshot (both OSes) |

Snapshot cadence is `config.snapshot_interval_secs` (default 10s) plus a final
snapshot on `SIGTERM`. State lives under `$XDG_STATE_HOME/amber-ide/`.

## Reboot torture test (Slice 3 exit test)

Requires a real reboot; run it by hand.

1. `infra/daemon/install.sh`, confirm the daemon is up:
   `systemctl --user status amber.service` (Linux) / `launchctl list | grep amber` (macOS).
2. Create sessions in reboot-safe cwds (not `/tmp`, which is wiped at boot):
   ```sh
   mkdir -p ~/amber-torture/{a,b,c,d}
   amber create t-a --cwd ~/amber-torture/a --kind shell
   amber create t-b --cwd ~/amber-torture/b --kind shell
   amber create t-c --cwd ~/amber-torture/c --kind claude
   amber create t-d --cwd ~/amber-torture/d --kind claude
   ```
3. `amber attach t-a`, run a few commands (leave visible scrollback), detach
   (Ctrl-\\ or close the terminal). For the two `claude` sessions, attach and
   hold a real conversation in each so `claude/<name>.json` records distinct
   session ids.
4. Wait ≥ `snapshot_interval_secs` (default 10s) for an autosnapshot, or force
   one: `amber ctl snapshot-now` *(Slice: ctl subcommand pending — until then a
   clean `systemctl --user stop amber.service` triggers the SIGTERM final
   snapshot)*.
5. **Reboot.** Log in.
6. `amber ls` → all four sessions present. `amber attach t-a` → original cwd +
   scrollback restored. `amber attach t-c` and `t-d` → **each claude session
   resumes its own conversation** (`--resume <id>`), zero manual steps.

**Pass:** every session back with cwd + scrollback; both claude panes resumed
their own conversation; no orphan/bootstrap sessions.

## Uninstall

```sh
# Linux
systemctl --user disable --now amber.service
rm ~/.config/systemd/user/amber.service
# macOS
launchctl unload ~/Library/LaunchAgents/com.amber-ide.daemon.plist
rm ~/Library/LaunchAgents/com.amber-ide.daemon.plist
# both (optional: wipe state)
rm -rf ~/.local/state/amber-ide
```
