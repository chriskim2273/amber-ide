# amber web — mobile browser access to live sessions

**Date:** 2026-07-19
**Status:** implemented + live-verified 2026-07-19. Deviation: `/` and the static assets serve without a cookie (a fragment token is only readable by JS on the served page); the auth boundary is `/api/sessions` + `/ws`.
**Depends on:** the session daemon (shipped) — multi-client fan-out, `Attach`/`Detach`/
`Input`, raw-byte `Data` frames, `WatchSessions`/`Sessions`.

Read `CLAUDE.md` first. This spec obeys it: the daemon keeps its unix socket and
never touches the network. `amber web` is a **new daemon client** that also
happens to speak HTTP/WebSocket — the same shape the collab spec gives its
`amber share` bridge (`2026-07-14-amber-collab-saas-auth-design.md` §2).

## 0. Goal

From a phone browser on the owner's tailnet: list live amber sessions, open one
full-screen, read its scrollback, and type into it — including driving a running
claude conversation.

**Not this feature** (explicitly deferred to the collab spec): the Fly relay,
Noise E2E, device keys, accounts/SaaS, sharing with another person, public
internet access without a VPN. `amber web` is single-owner, single-tenant.

## 1. Settled decisions (user, 2026-07-19)

| Question | Decision |
|---|---|
| Reachability | **Tailscale/VPN only.** Bind `127.0.0.1` and front it with `tailscale serve`. Never `0.0.0.0`, never a LAN IP. |
| Auth | **Token via QR.** `amber web` prints a QR + URL carrying a 32-byte random token; the phone exchanges it for a cookie. |
| Capability | **Full input.** The phone can type into any session (it is a remote terminal — same power as sitting at the machine). |
| UI | **Flat session list → one full-screen terminal.** No splits on a phone. |

## 2. Architecture

```
 phone browser ──https(tailnet)──► tailscale serve ──http──► 127.0.0.1:7717
                                                                │  amber web
                                                                │  (daemon CLIENT)
                                                                ▼
                                                       unix socket 0600
                                                          amber daemon
```

- `amber web` holds ONE daemon connection, multiplexing every browser tab over it
  exactly like the Electron client does (`Attach` per session, `Data` frames
  tagged by session name).
- Browser ⇄ `amber web`: one WebSocket per open terminal, plus a plain `GET /api/sessions`
  poll-free `SessionsChanged` push on a control WebSocket.
- TLS is **not** implemented in-process: WireGuard (tailnet) already encrypts the
  hop, and `tailscale serve` terminates real HTTPS so `Secure` cookies work.
  Binding `127.0.0.1` means the port is unreachable from anywhere else.

## 3. Security model

The token is equivalent to a shell on the machine. It is protected by:

1. **Bind `127.0.0.1` only.** No flag exposes another interface in v1; reaching
   the port at all requires being on the machine or coming through
   `tailscale serve` (i.e. authenticated onto the tailnet).
2. **Token:** 32 random bytes (`getrandom`), base64url. Stored in the state dir
   `0600` (`web-token`), regenerated on `amber web --new-token`. Compared in
   **constant time**.
3. **Fragment → POST → cookie.** The QR/URL carries the token in the URL
   **fragment** (`/#t=<token>`), which browsers never send to the server and
   which stays out of access logs. The page POSTs it to `/api/auth`; the server
   replies `Set-Cookie: amber_web=<session>; HttpOnly; SameSite=Strict; Path=/`
   (plus `Secure` when served over https), and the page calls
   `history.replaceState` to strip the fragment.
4. **Every other route requires the cookie**, including the WebSocket upgrade.
5. **Origin check** on the WebSocket upgrade (defence in depth against a
   malicious page on the phone driving the socket via the cookie).
6. **Rate limit:** failed `/api/auth` attempts are throttled (fixed delay +
   per-IP counter), so the token is not brute-forceable through the endpoint.
7. **Control whitelist (§5).**

## 4. Shared-winsize rule (important)

A pty has ONE winsize shared by every subscriber (CLAUDE.md, attach-status
tradeoff). If the phone sent `Resize`, it would reflow the desktop app's pane and
could corrupt a full-screen claude TUI mid-render.

> **The phone NEVER sends `Resize`.** `amber web` drops any resize intent.

The mobile terminal renders at the session's current geometry and scales to fit
(CSS transform + horizontal scroll), so a narrow screen shows the real pty
content unreflowed. Phone-native sizing is a later feature, and would have to be
gated on the phone being the only subscriber.

## 5. Control whitelist

`amber web` is a transparent pump for `Data` frames, but it **never forwards a
browser-originated control frame verbatim**. The browser protocol is its own
small JSON message set, and only these map onto daemon control messages:

| Browser message | Daemon control | Notes |
|---|---|---|
| `{t:'open', name}` | `Attach { name }` | only for a name currently in the live session list |
| `{t:'input', data}` | `Input { name, bytes }` | full input, per §1 |
| `{t:'close'}` | `Detach { name }` | |
| (implicit) | `WatchSessions` / `ListSessionsDetailed` | one per `amber web` process, not per browser |

`Create`, `Kill`, `Rename`, `Resize`, `Suspend`, `Resume`, `DumpBacklog`,
`Snapshot` are **not reachable from the browser** in v1. The phone can drive a
session; it cannot change which sessions exist.

## 6. Process & lifecycle

- New subcommand: `amber web [--port 7717] [--new-token] [--print-url]`.
- Long-lived service, independent of the Electron app (the point is to check on
  claude when the desktop app is closed). Ships a systemd user unit +
  launchd agent alongside the existing daemon units in `infra/`, installed by
  `amber ctl install --web`.
- Self-healing: if the daemon socket is missing/refuses, `amber web` keeps
  serving a "daemon unreachable" state and retries with backoff (the app's
  reconnect discipline).

## 7. Front-end

Deliberately tiny and dependency-frozen:

- `xterm.js` + its CSS are **vendored** (prebuilt UMD) into `crates/amber/assets/`
  and embedded in the binary with `include_bytes!`. No CDN (must work offline),
  no node build step in the Rust build (`scripts/vendor-web-assets.sh` refreshes
  them from `app/node_modules`).
- Hand-written `index.html` + `app.js` (no framework, no bundler): session list,
  terminal view, reconnect banner, on-screen key bar for the keys a phone
  keyboard lacks (Esc, Tab, Ctrl, arrows, Ctrl-C) — claude and shells are
  unusable on mobile without them.
- The WebGL addon is NOT used (mobile GPU variance); xterm's DOM renderer is fine
  at phone sizes.

## 8. Testing

- **Rust unit:** token generate/compare (constant-time), cookie parse, the
  browser-message → daemon-control mapping (including that `Resize`/`Kill`/
  `Create` have no mapping), HTTP request parse, WebSocket accept-key derivation.
- **Rust integration:** against a live private daemon — `GET /` unauthenticated
  is refused; `POST /api/auth` with a bad token is refused and throttled; with
  the right token yields a cookie; `GET /api/sessions` lists the daemon's
  sessions; a WS `open` + `input` reaches the pty and its output comes back.
- **Live:** phone-sized headless browser against a private daemon+web instance,
  then a real phone over the tailnet (manual, user).

## 9. Out of scope for v1

Multi-user/sharing, accounts, the relay, in-process TLS, phone-driven session
create/kill, splits, workspace management, file upload/download, push
notifications, and phone-native pty sizing.
