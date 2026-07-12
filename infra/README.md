# Phase 1 — Persistence Spine

tmux + tmux-resurrect + tmux-continuum, wired so that every session, window,
pane, cwd, scrollback, and running Claude Code conversation survives both app
crashes (tmux server keeps running) and machine reboots (continuum autosaves
every minute; restore fires automatically on server start at boot/login).

No app code is involved. The tmux server on the **default socket** is the
single source of truth; anything — a plain terminal or the future Electron
client — attaches to the same server.

## Requirements

- tmux **>= 3.2** (developed and tested against **tmux 3.4**; the installer
  refuses to run below 3.2). Control-mode and flow-control details vary across
  versions — consult `man tmux` for the pinned version before relying on flag
  syntax.
- git (used to vendor the plugins).
- Linux: systemd user session. macOS: launchd.

## Install

```sh
infra/install.sh
```

Idempotent, and it never kills or restarts a running tmux server. It:

1. Checks tmux >= 3.2.
2. Aborts if `~/.tmux.conf` exists (it would shadow the installed config —
   merge or remove it first).
3. Vendors the plugins at pinned commits into
   `~/.local/share/amber-ide/plugins/`:
   - tmux-resurrect @ `cff343cf9e81983d3da0c8562b01616f12e8d548`
   - tmux-continuum @ `0698e8f4b17d6454c71bf5212895ec055c578da0`
4. Installs `infra/tmux.conf` to `~/.config/tmux/tmux.conf` (backing up any
   existing file).
5. Installs boot autostart:
   - Linux: `amber-tmux.service` systemd user unit, enabled, plus
     `loginctl enable-linger` so the server starts at boot (before login) and
     survives logout.
   - macOS: `com.amber-ide.tmux` launchd agent (`RunAtLoad`).
6. If a tmux server is already running, sources the config into it (activates
   the autosave timer; existing sessions untouched). Otherwise starts the
   server with a bootstrap session `main`.

### Design note: boot start

`@continuum-boot` is deliberately **off**. On macOS it opens a visible,
maximized Terminal.app window at login; our launchd/systemd units start the
server headless on both platforms instead. Continuum's restore still runs —
restore is triggered by tmux **server start** (and only by that), regardless
of who started the server.

## How the pieces fit

| Concern | Mechanism |
|---|---|
| Crash survival | tmux server outlives any client/app |
| Reboot survival | continuum autosave (1 min) + restore on server start |
| Scrollback | `history-limit 50000` + `@resurrect-capture-pane-contents 'on'` |
| Claude resume | `@resurrect-processes '"~claude->claude --continue"'` — any pane whose command matches `claude` is relaunched as `claude --continue` in its saved cwd |
| Boot start | systemd user unit (Linux) / launchd agent (macOS) |

Known limitation (fixed in Phase 6): `claude --continue` resumes the most
recent conversation *per directory*, so two Claude panes in the same directory
would resume the same conversation after a reboot.

Resurrect save files live in `~/.tmux/resurrect/` (default; `last` symlink
points at the newest snapshot).

Continuum's autosave timer piggybacks on tmux's `status-right`; the status
line must stay on (tmux default) and nothing may later overwrite
`status-right`, or autosaving silently stops.

## Torture test (Phase 1 exit test)

Setup — `infra/torture-setup.sh` builds the layout for you (2 sessions,
3 windows, 4+ panes with distinct cwds), or build it by hand:

1. Run `infra/torture-setup.sh`. It creates sessions `torture-a`
   (windows `edit` + `build`, 3 panes in `edit` with distinct cwds) and
   `torture-b` (window `misc`, 2 panes), each pane in a different directory.
2. In **two panes in different directories**, start `claude` and have a real
   conversation in each (a few exchanges, so history is unmistakable).
3. Wait >= 1 minute for a continuum autosave (or force one:
   `~/.local/share/amber-ide/plugins/tmux-resurrect/scripts/save.sh`).

Part A — app-crash survival:

4. Kill the terminal app entirely (not just the window).
5. Open a new terminal, `tmux attach`.
6. **Pass:** all sessions/windows/panes, cwds, scrollback, and both live
   Claude processes exactly as they were (the server never died).

Part B — reboot survival:

7. Reboot the machine. Log in. Open a terminal, `tmux attach`
   (give the restore a few seconds on first login).
8. **Pass, zero manual steps:** layout identical (sessions, windows, panes,
   sizes), every pane in its original cwd, pane scrollback contents restored,
   and both Claude panes running with their respective conversations resumed
   (`claude --continue` fired per pane in its own directory).

## Uninstall

```sh
# Linux
systemctl --user disable amber-tmux.service
rm ~/.config/systemd/user/amber-tmux.service
# macOS
launchctl unload ~/Library/LaunchAgents/com.amber-ide.tmux.plist
rm ~/Library/LaunchAgents/com.amber-ide.tmux.plist
# both
rm ~/.config/tmux/tmux.conf          # or restore the .bak
rm -rf ~/.local/share/amber-ide/plugins ~/.tmux/resurrect
```
