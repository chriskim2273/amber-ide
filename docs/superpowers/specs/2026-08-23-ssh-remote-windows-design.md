# SSH mode — open a remote machine's amber in its own window

**Date:** 2026-08-23
**Status:** design approved in chat 2026-08-23 (transport / layout / window model
settled by the user); not implemented.
**Related:** `2026-08-22-mobile-web-experience-design.md` (Phase A gave the
machine a *hosted* surface; this gives the desktop app a *remote* one).

Read `CLAUDE.md` first. This proposes **no core-rule change** and **no daemon
or protocol change**.

## 0. The observation

The app's client is one line away from being remote already:

```ts
const conn = new Connection(resolveSocketPath(process.env))   // client/index.ts:6
const socket = net.createConnection({ path: this.path })      // client/connection.ts:30
```

A unix socket path, read from the environment, per forked client. `ssh -L
<local>:<remote>` forwards exactly that. So "open a window onto another
machine's amber" is: forward the socket, fork a client pointed at it, and give
that client its own window.

The pane arrangement is likewise already a file — `ui-layout.json` — which this
repo has taught three different readers to parse (the app, `amber web`, and
`mosaic.rs`).

## 1. Settled decisions (user, 2026-08-23)

| Question | Decision |
|---|---|
| Transport | **`ssh -L` unix-socket forward.** No remote upgrade, no open port, no tailscale requirement; reuses the user's ssh config, keys and agent. |
| Layout | **Read-only mirror** of the remote's `ui-layout.json`. The remote's own app is probably open on that desktop; this window does not fight it for the sidecar. |
| Window model | **One window per host.** `Connect to host…` opens a second `BrowserWindow` with its own client. One window = one daemon. |

## 2. Architecture

```
local app                                  remote machine
┌───────────────────────┐                  ┌──────────────────┐
│ BrowserWindow(remote) │                  │  amber daemon    │
│   └ utilityProcess ───┼── unix socket ───┼──▶ amberd.sock   │
│        (client)       │   (ssh -L tunnel)│                  │
└───────────────────────┘                  └──────────────────┘
```

Nothing new speaks the daemon protocol. The tunnel is transparent: the client
opens a local socket file, ssh carries the bytes, the remote daemon sees an
ordinary local client.

### 2.1 Socket path override

`resolveSocketPath` currently derives the path from `XDG_RUNTIME_DIR` /
`XDG_STATE_HOME` / `HOME` with **no explicit override**. Add one:

```
AMBER_SOCKET=<path>   # wins over every derivation
```

This is required here (a remote window's client must be pointed at the tunnel's
local end) and is independently useful — it is exactly what a verification run
needs to drive an isolated instance, and its absence already cost one live test
in this repo, where an `AMBER_SOCKET` that looked set was silently ignored and
the GUI attached to the user's real daemon.

### 2.2 Finding the remote socket

Deliberately **not** a new remote subcommand: requiring the remote to be
upgraded would defeat "no remote change". A shell probe over the same ssh
connection resolves it the way the daemon itself would:

```sh
ls ${XDG_RUNTIME_DIR:+$XDG_RUNTIME_DIR/amber-ide/amberd.sock} \
   "$HOME/.local/state/amber-ide/amberd.sock" 2>/dev/null | head -1
```

Empty output ⇒ "no amber daemon on that host", reported as such rather than as
a tunnel failure.

### 2.3 The tunnel

```
ssh -N -T \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -L <local.sock>:<remote.sock> <host>
```

- `ExitOnForwardFailure` so a forward that cannot bind is an error we can
  report, not a silently useless tunnel.
- `ServerAlive*` so a dead network drops the child in ~45 s instead of hanging
  forever — the window needs to know.
- `-N -T`: no remote command, no pty.
- The local end lives in a per-window temp dir, unlinked before bind (a stale
  socket file makes ssh refuse the forward) and removed on window close.
- Everything else — user, port, jump hosts, keys, agent — comes from the user's
  own `~/.ssh/config`. amber never parses ssh config and never handles a
  credential.

### 2.4 Layout mirror

`ssh <host> cat <remote-state>/ui-layout.json`, parsed with the **existing**
`parseLayoutFile`. A missing or malformed file falls back to
`LayoutFile.default()` — the same equal-splits fallback core rule #3 already
requires, so a remote with no sidecar still renders its sessions.

**Read-only** means the renderer's persist path is disabled for that window:
`saveLayout` resolves without writing, and the window shows a `read-only`
marker so a divider that snaps back is explained rather than mysterious.
Grouping still comes from session names (rule #2), so the mirror degrades to
"correct panes, default geometry", never to "no panes".

## 3. Lifecycle and failure

| Event | Behaviour |
|---|---|
| ssh exits non-zero at startup | Window shows the ssh stderr verbatim (auth failure, unknown host, forward refused). No retry loop on an auth error — retrying a rejected key is how you get an account locked. |
| ssh dies later | Same disconnected banner the local window already has, plus capped-backoff relaunch of the tunnel (reuse `clientSupervisor`'s `backoffDelay`/`nextAttempt`). |
| Remote daemon not running | Probe returns empty → explicit "no amber daemon on <host>" with the command to start one. |
| Window closed | Tunnel child killed, local socket unlinked, temp dir removed. |
| App quit | Every tunnel killed. A leaked `ssh -N` outliving the app is the failure mode to avoid. |

## 4. Security

The tunnel carries the **daemon protocol**, which is full session control — the
same authority as a shell on that machine. That is already what ssh grants, so
this adds no new authority: if you can ssh to the host, you can already run
`amber attach` there. Worth stating plainly because the *app* now does it
without a visible shell.

- amber never stores, prompts for, or forwards a credential. Auth is ssh's.
- The local socket file is created inside a `0700` per-window temp dir, so
  another local user cannot reach the tunnel.
- Host key verification is ssh's default (`StrictHostKeyChecking` as the user
  configured it). amber never passes `-o StrictHostKeyChecking=no`.

## 5. Scope cuts

- **No write-back.** Rearranging panes in a remote window does not persist.
- **No remote editor/browser panes.** They are app-local by construction
  (`browser-*` / `editor-*` ids live only in the sidecar); the mirror shows the
  remote's *daemon* sessions and prunes app-local leaves, exactly as the mobile
  mosaic already does.
- **No host manager UI.** `Connect to host…` takes a `user@host` string; ssh
  config is the address book.
- **No version negotiation.** A remote daemon far enough behind will fail on an
  unknown control message; the decoder already drops a poisoned connection and
  the banner shows it. Recorded, not solved.

## 6. Testing

**Pure, unit-tested:** `sshTunnelArgv(host, local, remote)` (every flag above,
and that no `StrictHostKeyChecking=no` ever appears), `remoteSocketProbe(host)`,
the `AMBER_SOCKET` precedence in `resolveSocketPath`, and read-only layout
suppression.

**Live:** `ssh localhost` on this box is a real remote from the code's point of
view — a real tunnel, a real second client, a real second window against an
isolated daemon. That covers everything except a genuinely remote network,
which is recorded as unverified.
