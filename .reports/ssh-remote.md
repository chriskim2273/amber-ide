# SSH remote windows — verification report

Spec: `docs/superpowers/specs/2026-08-23-ssh-remote-windows-design.md`

Driven headless (xvfb + CDP) with a real `ssh` to `localhost` — which is a
genuine remote from the code's point of view: a real sshd, a real tunnel, a
real second client process.

## What was proven

**The protocol survives a tunnel.** With `ssh -N -T -L <local>:<remote>` up,
the CLI talks to the far daemon unchanged:

```
$ amber ls --socket /tmp/amber-tun-live/remote.sock
1  amber-1-1-0-remote  /tmp  shell
```

**A window follows the socket.** The app launched with
`AMBER_SOCKET=<tunnel>` rendered that isolated daemon's pane — the whole of
what makes a window "remote" (spec §2.1).

**`Connect to host…` works end to end.** Calling it opened a **second window**
with **its own ssh tunnel** (`amber-ssh-*` temp dir), and that window showed
the real daemon's 8 sessions while the first stayed on the isolated one:

```
window 0: remoteHost "localhost", 8 panes   <- mirror
window 1: remoteHost "",          1 pane    <- the tunnel-launched local window
```

**The mirror is read-only, enforced in main.** A deliberate
`saveLayout({activeWorkspace: 99})` from the remote window returned ok and left
the real sidecar **byte-identical** (same md5 before and after). The renderer
cannot write another machine's layout even if it tries.

**Option injection is refused.** `connectHost('-oProxyCommand=touch /tmp/pwned')`
was rejected by `isValidHost` before reaching ssh; no file was created. This is
the sharp edge of the feature — ssh reads a leading `-` as a flag wherever it
appears, so a "host" can otherwise execute an arbitrary LOCAL command.

## Two real bugs this pass caught

**1. `window.prompt` does not exist in Electron.** The first version of
"Connect to host…" asked for the destination with `window.prompt` via
`executeJavaScript`. Electron does not implement it, so the menu item would
have silently done nothing. Replaced with a real in-app dialog.

**2. A GUI-launched app can have no ssh agent.** Measured: the app process had
**no `SSH_AUTH_SOCK` at all**, so every host failed with "Permission denied
(publickey)" however well ssh worked in a terminal. This is the same class as
the 2026-07-29 display-env bug, and it has the same fix — recover the value
from `systemctl --user show-environment`, per call, never cached. When it still
cannot be found, the error names the missing agent instead of parroting ssh's
misleading "permission denied".

A third, smaller: the read-only marker's first edit silently no-opped (its
anchor had moved and that one `replace` lacked an assert), so the window ran
without the badge until a live check caught it.

## Not verified

- **A genuinely remote host over a network.** `localhost` exercises the code
  paths but not latency, an unreachable host mid-session, or ssh dropping.
- Tunnel relaunch after ssh dies mid-session (the capped-backoff path).
- macOS (no `systemctl` there; `sshEnv` deliberately no-ops off Linux).
- A remote whose daemon is a different protocol version — recorded in spec §5
  as unsolved, not handled.
