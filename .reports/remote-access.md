# Remote access control plane — verification report (Phase A)

Spec: `docs/superpowers/specs/2026-08-22-mobile-web-experience-design.md` §9
Plan: `docs/superpowers/plans/2026-08-22-remote-access-control-plane.md`

Everything below ran against an **isolated** instance — private state root
(`/tmp/amber-rt.2ZF9`), private daemon socket, non-default port **7919** — so
the user's real daemon, sessions and tailnet configuration were never touched.

```
amber daemon --root $R --socket $R/s
amber web    --root $R --socket $R/s --port 7919
```

## 1. `status --json` reaches the live server

```
$ amber ctl web status --json --root $R --port 7919
{"clients":[],"error":null,"has_token":true,
 "host":"teapot-dev.tail3d57b4.ts.net","port":7919,"sessions":0,
 "tailscale":"serve-not-mapped","unit":"active","uptime_secs":2,
 "url":"http://127.0.0.1:7919/app"}
```

`uptime_secs` and `sessions` are only obtainable through the token → cookie →
`GET /api/status` exchange, so their presence proves the whole two-step auth
path, not just the unit probe.

Creating a session moves the count, so the number is live rather than cached:

```
$ amber create probe1 --cwd /tmp --socket $R/s
created probe1
$ amber ctl web status --json … | jq '{sessions, clients: (.clients|length)}'
sessions: 1 | clients: 0
```

## 2. The auth boundary holds

```
$ curl -o /dev/null -w '%{http_code}' -H 'Cookie: amber_web=deadbeef' \
       http://127.0.0.1:7919/api/status
401
$ curl -o /dev/null -w '%{http_code}' http://127.0.0.1:7919/api/status
401
```

## 3. Status polling does not lock the phone out

The throttle (`AUTH_MAX_FAILS = 8` per IP per 60 s) buckets every client at
127.0.0.1 behind `tailscale serve`, so a CLI that retried a rejected auth would
lock out a real device. Twelve consecutive status polls, then a genuine auth:

```
$ for i in $(seq 1 12); do amber ctl web status --json … >/dev/null; done
$ curl -o /dev/null -w '%{http_code}' -X POST --data "$TOKEN" \
       http://127.0.0.1:7919/api/auth
204
```

A **wrong** token is reported after exactly one attempt, and a good token still
authenticates immediately afterwards — the budget was not burned:

```
$ printf 'wrong' > $R/web-token && chmod 600 $R/web-token
$ amber ctl web status --json … | jq .error
"server unreachable"
$ # token restored
$ curl -o /dev/null -w '%{http_code}' -X POST --data "$TOKEN" … /api/auth
204
```

## 4. The token never leaves the `url` subcommand

`status --json` is polled every 3 s by the desktop dialog. Checking every field
of the payload against the real token:

```
leaked fields: []
url: http://127.0.0.1:7919/app
has_token: True
```

The tokenised URL exists only where it is asked for:

```
$ amber ctl web url --root $R --port 7919
http://127.0.0.1:7919/app#t=<redacted>
```

`status --json` also does not MINT a token: run against a fresh root, no
`web-token` file is created (`ctl_web.rs::status_does_not_mint_a_token`).

## 5. Bug found and fixed by this verification

The first implementation reported `https://<tailnet-host>/app` whenever a
tailnet existed **at all**, ignoring whether `tailscale serve` maps *this*
port. On this box the tailnet maps 7717 while the test instance ran on 7919, so
the CLI advertised an address that reaches a different service — the user would
have chased a phantom server fault.

Fixed: `public_url()` claims the tailnet host only for
`TailState::Serving`, otherwise the local address. Re-verified:

```
tailscale: serve-not-mapped | url: http://127.0.0.1:7919/app
```

Human output:

```
unit:      active
port:      7919
tailscale: serve-not-mapped teapot-dev.tail3d57b4.ts.net
url:       http://127.0.0.1:7919/app  (login url: `amber ctl web url`)
server:    up 30335s, 1 sessions, 0 clients
```

## Not verified

- **`unit:` is machine-global, not per-instance.** It reports
  `systemctl --user is-active amber-web.service`, which is the user's REAL unit
  — the private test instance has no unit of its own. So `active` above says
  nothing about the instance under test; the live rows (`uptime_secs`,
  `sessions`) are what prove that.
- `enable` / `disable` were **not** run: they write a real unit file into
  `~/.config/systemd/user/` and run `tailscale serve --bg`, both of which
  change the user's actual machine. The unit rendering is unit-tested
  (`webctl.rs`), the argv is unit-tested, and the write path is a plain
  `std::fs::write` to `webctl::unit_path`.
- macOS: no launchd verification (no Mac available). The plist template, its
  `__HOME__` log-path substitution and the port rewrite are unit-tested.
- A real tailnet round trip from a phone.
- The packaged AppImage path.

## 6. GUI pass (xvfb + CDP)

The dialog, the pill and the five IPC handlers were driven in a real Electron
window. Findings and fixes:

- **The pill renders**, class `web-pill web-pill-serving`.
- **The dialog rendered unstyled in the top-left corner.** It invented
  `.overlay`/`.dialog`/`.dialog-head`/`.dialog-note`, none of which exist in
  `theme.css`. The repo's dialogs (Sessions, save/load) use
  `.help-overlay` / `.help-card dialog-card` / `.help-head` / `.dialog-body` /
  `.dialog-text`. Rewritten onto those; now a centred 640px card over a dimmed
  overlay, click-outside and Escape both close it. Typecheck and vitest were
  both green while it was broken — only rendering it caught this.
- **Check rows compute live**: `✓ service up 0s`, `✓ tailscale serving
  teapot-dev…`, `✗ daemon server unreachable`, `✓ token present (0600)`.
- **Reveal** puts the token in the fragment only: `has_fragment_token: true`,
  43-char token, nothing hex-shaped before the `#`, and the warning banner
  ("Anyone with this link or code has full control of your sessions") appears
  with it. Address renders token-free until pressed.
- **QR renders** — 220×220 `data:image/png` `<img>`, so Electron's CSP allows
  the data URI.
- **Log tail** returns 22,227 characters of real `journalctl` output and the
  button flips to "Refresh log".
- **The action allowlist holds**: `webAction('bogus-action')` →
  `{ok: false, error: "unknown action bogus-action"}`, no spawn.
- **Rotate token moved to its own "danger" section.** It had been sitting in
  the same row as "Load log"; a destructive control beside a benign one invites
  a misclick.

### The web build would have shipped a permanently red pill

Not a GUI finding but caught in the same review: the web shim's `webStatus()`
returned an error string, and `webDot` maps a non-null `error` to `'error'`. So
every phone and browser client would have shown a red "remote" pill opening a
dialog whose every button fails — on the exact surface this work exists to
improve. Fixed with an explicit `managed: false` flag that hides the control
where the host cannot manage the service, rather than overloading `error`.
`WebStatus` also moved to `app/src/shared/`, where `proto`/`layoutFile`/
`socketPath` already live; renderer and web had been importing from `main/`.

### Caveat on this GUI pass

The `AMBER_SOCKET` override did not take, so the window attached to the
**real** daemon rather than the private one (`XDG_STATE_HOME` did apply, so the
layout sidecar written was the private one and the user's was untouched; no
session was created or killed). Consequence: the reveal/QR steps displayed the
**user's real production token**, and it is visible in a screenshot captured
during this pass. Recommend `amber ctl web rotate-token`.
