# Linux desktop input health hardening

**Date:** 2026-08-30

**Status:** implemented and live-verified

## Problem

After an AppImage replacement, the new Electron process rendered terminals and
received daemon output but dropped every physical keyboard event. Synthetic CDP
input still worked, so the renderer → MessagePort → daemon path initially looked
healthy.

The GNOME IBus service was alive, but its registry named
`~/.cache/ibus/dbus-D9WaWxcK`, which no longer existed. Existing applications
retained old open connections; newly launched Chromium clients logged:

```text
Unable to connect to ibus: No such file or directory
Events queue growing too big, will start to drop.
```

The installed GNOME unit uses `Restart=on-abnormal`. Unlinking the socket does
not kill `ibus-daemon`, so systemd has no failure to restart. The local `ibus(1)`
contract provides the two operations needed here: `ibus address` exposes the
D-Bus address, and `ibus restart --type=systemd` is the documented GNOME repair.

## Design

### App startup guard

On Linux with an X display, Electron main first repairs a common launch-context
gap: if all input-method markers are absent, it reads the systemd user manager's
`XMODIFIERS`/`GTK_IM_MODULE`/`QT_IM_MODULE` values through a strict allowlist,
without `eval`, and applies them before Chromium creates its first input context.
An explicit process-level input-method choice is never overridden. This covers
raw AppImage restarts from non-graphical automation while keeping non-IBus
sessions a no-op.

When the effective environment selects IBus, Electron checks `ibus address`
before creating a window. Filesystem addresses must resolve to a live unix
socket; abstract unix addresses need no filesystem check.

A stale address opens a native dialog with three explicit choices:

1. **Restart input service** — restart through IBus's systemd path and poll
   until the replacement socket is proven live before creating the first app
   window.
2. **Continue anyway** — preserve user authority when IBus is intentionally
   unusual.
3. **Quit Amber**.

Repair never restarts or signals the Amber daemon. A stale explicit
`IBUS_ADDRESS` is removed only after it has been proven broken, otherwise it
would override the newly generated registry after restart. Repair occurs before
the first `BrowserWindow`, so the process continues with a fresh Chromium input
context instead of relying on a brittle AppImage self-relaunch.

### Deployment relaunch helper

`scripts/relaunch-app-linux.sh` is the supported repository-driven AppImage
relaunch path. It imports a narrow graphical-session environment allowlist from
the systemd user manager without `eval`, preflights/repairs IBus, terminates only
AppImage main processes, and launches the stable AppImage with logs under the
Amber state directory. `AMBER_RELAUNCH_DRY_RUN=1` performs only the preflight.

### Real input smoke

`scripts/smoke-desktop-input-x11.sh` starts an isolated private daemon and shell,
opens an isolated AppImage window on the real X display, and sends a key through
XTest. CDP observes xterm but never injects the key. The test clears its private
shell line and removes the app, daemon, session, state, and window on every exit.
This specifically prevents a CDP false green from recurring.

## Boundaries

- Linux/X11-focused; macOS and explicit non-IBus environments are no-ops.
- No daemon, protocol, PTY, or renderer changes.
- Amber does not silently restart a desktop-wide input service; repair requires
  the native-dialog choice, except in the explicit deploy helper.
- Disk-pressure prevention remains a separate system-health concern.
