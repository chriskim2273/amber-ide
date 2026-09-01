# Native token router — design

**Status:** implemented (2026-09-01). Sections below were corrected after
implementation to describe what actually shipped, not the pre-build plan.

## Context

`~/Projects/token-router` is a working standalone Rust proxy (~3.4k LOC): one
OpenAI-compatible endpoint in front of many free-tier providers, with
ordered failover, per-key health (cooldown / dead), and an SSE first-frame gate
so a stream only commits after the upstream proves it isn't an error. It has
**no persistence, no config write-back, no hot reload, and no GUI** — it reads
one TOML at startup and dies with the process.

Amber is where the user's agents actually run. Bringing the router in natively
gives it what it lacks — a boot-managed service, an editable/reorderable
provider list, live status — and gives amber a first-class "point my agents at
my own routing table" capability.

Decisions locked with the user:

- **Port:** 7719 (`routerctl::DEFAULT_PORT`, matching the shipped units).
- **Runtime:** vendor token-router as a **third binary** in the amber workspace,
  keeping tokio/axum/reqwest-rustls. Rewriting the failover + SSE gate std-only
  was rejected as needless risk.
- **Hosting:** boot-managed unit (systemd/launchd), **127.0.0.1 only**. No
  tailnet surface in v1.
- **Slot model:** a slot **is** a provider (name, base_url, api key, model), and
  **slot order is the failover order** for one implicit global chain. The
  alias/chain data model stays underneath so named routes can be added later
  without a config migration.
- **Agent wiring:** see "Pi wiring" below.

## Non-goals (v1)

Named routes/aliases in the UI; tailnet or phone reach; a mobile/`amber web`
router surface (precedent: preset input slots are desktop-only authority);
cost accounting; usage history across restarts.

## Architecture

### New crate: `crates/amber-router`

Workspace member, its own dep tree (tokio, axum, reqwest w/ rustls,
eventsource-stream, futures-util). Ships as `amber-router` binary alongside
`amber` / `amberd`.

Port `crates/core` (config, registry, health, taxonomy) and `crates/server`
(proxy, selector, sse, upstream, routes) from `~/Projects/token-router`
**verbatim** — including their inline unit tests and the
`crates/server/tests/` integration suite with its scriptable mock provider.
This is the load-bearing rule: any rewrite of `proxy.rs` / `sse.rs` /
`selector.rs` re-opens bugs those 1.6k lines of tests already closed.

Changes made on top of the vendored code:

1. **Config location.** Read `<state-root>/router.toml`, resolved via
   `amber_core::platform::resolve_state_root`, not a `--config` path. Written
   0600 (`platform::write_user_private`) — it holds real provider keys.
2. **Hot reload.** A `Config` swap behind an `ArcSwap`-equivalent
   (`RwLock<Arc<Registry>>` is enough) plus a `POST /admin/reload` on loopback,
   so an edit from the GUI takes effect without dropping in-flight streams.
   Existing leases finish against the old registry; new requests use the new one.
3. **Admin surface** (loopback, bearer-authed, same token as `/stats`):
   `GET /admin/slots` → slots **with keys masked** (`has_key` plus a
   `••••1234` hint); `PUT /admin/slots` → the full list (add / edit / delete /
   reorder are all this one call, so the order on screen is the order on disk
   with no merge to get wrong); `POST /admin/reload`; `GET /admin/status` for
   the pill and dialog. No endpoint ever returns a plaintext key —
   `GET /admin/slots/<name>/key`, behind an explicit user gesture, is the only
   reveal path, matching how `web:url` fetches the web token on demand.
4. **Auth token** in `<state-root>/router-token`, 0600, reusing
   `web::load_or_create_secret` / `web::read_secret` (generalised from the web
   token's own functions rather than reimplementing the platform privacy
   checks), minted the same way as
   `web-token` (`platform::random_bytes` + `base64url` + `ct_eq` + per-IP
   throttle). Copy `web.rs`'s `Auth` discipline; do not leave the proxy open
   even on loopback — it holds externally valuable credentials.

### Slot → config mapping

A slot is one `[[provider]]` with exactly one key and one model, plus a single
implicit `[[alias]]` whose `chain` is the slot list in order. Serialization
keeps the alias explicit in `router.toml` so the file stays a valid
token-router config and named routes are a pure additive change later.

```
id          stable across renames; minted on first save, persisted
name        display + provider name (unique, validated)
base_url    http(s) URL
api_key     secret, 0600 file only; every slot needs one
model       upstream model id
enabled     bool (a disabled slot is skipped, not deleted)
```

`id` is load-bearing and was added during implementation: the dialog only ever
sees a masked key, so a save round-trips a blank one meaning "unchanged". Under
name-matching a rename is indistinguishable from a new slot, so renaming
without retyping would silently drop the key. `store::ensure_ids` migrates a
config written before ids existed, once, on load.

Every slot also gets its own single-entry alias, so a caller can pin one slot
by name — and so a DISABLED slot still has somewhere to keep its model id.

The file is written **tmp + rename**, not in place: `write_user_private`
truncates, so a crash mid-write would leave a partial TOML holding every
provider key the user configured.

### CLI: `crates/amber/src/routerctl.rs`

Clone `webctl.rs` exactly: **pure** render/argv functions, all IO in `main.rs`.

- `include_str!` new `infra/daemon/amber-router.service` and
  `com.amber-ide.router.plist.in`.
- **Structural** rewriting of `ExecStart=` and of the `<string>` positionally
  following `<string>--port</string>` — never exact-string replace
  (`webctl.rs` documents why: a reformat silently no-ops it).
- `amber ctl router status|start|stop|restart|enable|disable|url`, all `--json`.
  plus `slots` / `set-slots` (JSON on stdin) / `key <name>` /
  `install-pi-provider`. `status` returns port / uptime / unit state / slots
  with keys masked / per-key health, and **never a token or key**.

  The app drives slot editing through these commands rather than calling the
  admin API itself, so the router's bearer token never enters the desktop
  process or an IPC trace.
- Add `install.sh` hooks next to `install_web_linux` / `install_web_macos`.

`status` talks to the router over loopback in the hand-rolled
`fetch_web_status` style (`main.rs:1108`) — plaintext HTTP to 127.0.0.1, no new
client dep in the `amber` crate.

### App

Follow the Remote-access recipe end to end:

- `app/src/shared/routerStatus.ts` — `RouterStatus` + `RouterSlot` types, with
  the `managed: boolean` flag from day one (the web build shipped a permanently
  red pill last time because the shim returned an error string).
- `app/src/main/routerService.ts` — CLI-shaped helpers only:
  `routerCtlArgv(action, port)` and a `parseRouterStatus(stdout)` that never
  throws. Everything the renderer needs (`slotFromWire` / `slotToWire` /
  `moveSlot` / `routerDot`) lives in `shared/`, because a VALUE import from
  `main/` would pull main-process module code into the renderer bundle and the
  browser build.
- `app/src/main/index.ts` — `router:status` / `router:action` (action
  **allowlist**, the argv-splicing boundary) / `router:slots` /
  `router:saveSlots` / `router:revealKey` / `router:logTail`, registered beside
  the `web:*` block. The slot IPC maps snake_case wire to camelCase UI shape in
  BOTH directions; passing the raw object through left `hasKey` undefined, and
  a save would have sent `baseUrl`, which the router rejects.
- `app/src/preload/index.ts` (~:95) + `window.amber` typings in
  `main.tsx` (~:121).
- `app/src/web/amber.ts` (~:536) — stubs returning `managed: false`.
- Toolbar pill in the top-right cluster (`main.tsx:1863` neighbourhood),
  `router` label, dot tones off/local/serving/error, reusing `.web-pill` CSS
  shape under a `.router-pill` class.
- `app/src/renderer/RouterPanel.tsx` on `.help-overlay` / `.help-card` /
  `.dialog-card` (never invented classes — that mistake cost a cycle on the
  Remote-access pass), with the pure `diagnosticRows`-style helper exported for
  vitest.
- **Reorder with ↑/↓ buttons, not drag** — 26 px targets, keyboard-reachable,
  testable. Pure `moveSlot(list, from, to)` in `app/src/shared/`, TDD'd, the
  same shape as `moveTab` in `layoutFile.ts`.

Keys are entered in a password-type field, displayed as `••••1234`, and the
plaintext value is only ever fetched by an explicit Reveal gesture.

## Pi wiring (registration only)

**Pi ignores `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`** — verified against the
installed pi 0.84.4 bundle: the only base-URL env vars it reads are the Azure
trio (`dist/cli/args.js:378-425`), and every request passes `model.baseUrl`
explicitly. Env injection is therefore not an option; a provider entry is the
only mechanism.

Amber writes **only its own key** in `~/.pi/agent/models.json` (honoring
`PI_CODING_AGENT_DIR`, as `crates/amber/src/pi.rs:64-73` already does), merging
into `providers` and never touching another provider — the same ownership
discipline as the Codex hook and the Pi extension installer:

```json
"amber-router": {
  "baseUrl": "http://127.0.0.1:<port>/v1",
  "api": "openai-completions",
  "authHeader": true,
  "apiKey": "!sh -c 'cat \"$AMBER_STATE_DIR/router-token\"'",
  "models": ["<alias>"]
}
```

The `!`-prefix shell escape is pi's documented value resolver
(`dist/core/resolve-config-value.js:114-125`) and is already used by the user's
own `workbuddy` entry — so **the router token is never copied into pi's config
and rotation needs no re-registration**. Note `baseUrl` itself is *not*
env-templated by pi, so the port is written literally and the entry is
rewritten when the port or the slot list changes.

`models` is refreshed from the router's alias list. Schema:
`ModelsConfigSchema` / `ProviderConfigSchema` at
`.../pi-coding-agent/dist/core/model-config.js:169-183`; a provider defining
custom models must carry `baseUrl` (`provider-composer.js:53-55`).

**Not done in v1:** no change to `pi_argv()` (`crates/amber/src/pi.rs:38-44`)
and no change to supervisor env — a Pi pane launches exactly as today, and the
user selects the provider inside Pi (Ctrl+P, `--provider`, or `defaultProvider`
in `settings.json`). Claude / Codex / Grok / OpenCode are out of scope; wiring
them means env injection through `manager.rs:487-592`'s spawn env, a much
larger blast radius, and each honors different variables.

Surfaced in the router dialog: a "Register with Pi" row showing installed /
stale / not-installed, a re-register action, and the exact `pi --provider
amber-router --model <alias>` invocation to copy. A repair path
(`amber ctl router install-pi-provider`) mirrors
`amber ctl install-pi-extension`.

## Risks / invariants

- The router must **never** share the daemon's control socket or threads. A
  wedged upstream must not be able to backpressure a pty — the repo's history is
  a catalogue of exactly that bug class.
- `router.toml` and `router-token` are 0600 and live in the state root. **Never**
  in `ui-layout.json` — SSH-remote windows mirror that sidecar across machines
  over ssh, which would be a live key-exfiltration path.
- Bind 127.0.0.1 in exactly one place; no flag may reach another interface.
- `amber-router` depends on the `amber` crate for the 0600 private-file helpers
  (`write_user_private`'s Windows reparse/DACL checks and the race-safe
  create). That links the daemon crate into the router binary — a deliberate
  tradeoff, taken because reimplementing security-critical file handling is
  worse than a larger artifact.
- The router binary must be installed BESIDE `amber`: `sibling_binary` resolves
  it relative to the running exe, so `install.sh` and the packaged first-run
  install both place it in `~/.local/bin/`.
- Static-musl release: rustls is pure Rust, so `scripts/dist.sh`'s
  static-linkage assertion should still hold — **verify this early**, it gates
  packaging.

## Files

New: `crates/amber-router/**` (vendored + the four changes above),
`crates/amber/src/routerctl.rs`, `infra/daemon/amber-router.service`,
`infra/daemon/com.amber-ide.router.plist.in`,
`app/src/shared/routerStatus.ts`, `app/src/main/routerService.ts`,
`app/src/renderer/RouterPanel.tsx`.

Modified: root `Cargo.toml` (workspace member), `crates/amber/src/main.rs`
(clap `Command::Router` + `CtlAction::Router` + dispatch),
`crates/amber/src/lib.rs`, `infra/daemon/install.sh`,
`scripts/dist.sh` + `app/scripts/dist.sh` (ship the third binary),
`app/src/main/index.ts`, `app/src/preload/index.ts`,
`app/src/renderer/main.tsx`, `app/src/renderer/theme.css`,
`app/src/web/amber.ts`.

## Verification

- **Rust unit/integration:** the vendored suites must pass unchanged
  (failover order, 400-no-cascade, 401-kills-key, SSE gate pre-commit failover,
  keep-alives not resetting the gate). New tests for config write-back
  round-trip, slot reorder, key masking, and `routerctl` render/argv.
- **Gates:** `cargo clippy --workspace --all-targets -D warnings`, full Rust
  suite twice, app tests + typecheck + `build` + `build:web`, static-musl
  linkage assertion.
- **Live (isolated):** private state root + private router port + a fake
  upstream `TcpListener`. Prove: a request reaches slot 1; slot 1 returning 429
  fails over to slot 2; an SSE response streams **incrementally** rather than
  arriving whole; `ctl router status --json` contains no key and no token;
  reorder via the admin API changes which slot is hit first without a restart;
  the unit survives a daemon restart.
- **Pi:** register into a **private** `PI_CODING_AGENT_DIR`, assert other
  providers in the file are byte-identical afterwards, assert the token is
  absent from `models.json`, and run a real `pi --provider amber-router
  --model <alias> -p "hi"` against a fake upstream.
- **GUI (xvfb + CDP):** pill renders and reflects real state; dialog opens on
  the real overlay classes; add / edit / ↑↓ / delete round-trips to
  `router.toml` and survives a router restart; Reveal shows the key only after
  the gesture; **no toolbar overflow at 1024 px and 1100 px** — the 2026-08-30
  pass added that exact check and this adds a pill to a toolbar just
  deliberately de-cluttered.

## Sequencing

0. Create a git worktree (global rule: non-trivial work is worktree work).
1. Write + commit `docs/superpowers/specs/2026-09-01-token-router-design.md`
   (this plan's content, as the repo's architectural process requires), then
   `superpowers:writing-plans` for the task-level plan.
2. Vendor the crate; get the existing suites green in-tree; confirm musl.
3. Config write-back + reload + admin API + token.
4. `routerctl` + units + install/dist wiring.
5. App: service module → IPC → preload → pill → dialog → CSS.
6. Pi provider registration + repair command + dialog row.
7. Live + GUI verification.
