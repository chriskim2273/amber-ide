# Native token router — verification report (2026-09-01)

Branch `feat/token-router`. Everything below was run against an **isolated**
private daemon, private state root, private router port and a fake upstream —
the user's real daemon (`systemctl --user is-active amber` → `active`) and
running AppImage were never touched, and every test process was cleaned up.

## What shipped

- `crates/router-core` + `crates/amber-router` — token-router vendored
  near-verbatim (proxy, selector, SSE gate, health, taxonomy) plus: state-root
  config, a stable-id slot model, atomic 0600 writes, hot reload, a bearer-authed
  admin API, and a loopback-only service entry point.
- `crates/amber/src/routerctl.rs` + `infra/daemon/amber-router.{service,plist.in}` —
  boot units, rendered structurally.
- `amber ctl router status|start|stop|restart|enable|disable|url|rotate-token|
  slots|set-slots|key|install-pi-provider`, all `--json`.
- `crates/amber/src/router_pi.rs` — amber-owned provider entry in Pi's
  `models.json`.
- App: `shared/routerStatus.ts`, `main/routerService.ts`, IPC + preload,
  toolbar pill, `renderer/RouterPanel.tsx`, web-build stubs.
- `scripts/dist.sh` + `app/scripts/dist.sh` ship `amber-router` beside `amber`.

## Live-verified (Rust / CLI)

| Claim | Evidence |
| --- | --- |
| Request reaches slot 1 | `{"who":"alpha","auth":"Bearer sk-alpha-1111"}` |
| Failover past a 429 | `x-router-attempts: beta#0:cooldown:429,alpha#0:success:200` |
| SSE streams incrementally | frames observed at 00.330 / 00.727 / 01.125 s, not one blob |
| Reorder takes effect with no restart | PUT then next request hit the new slot 1 |
| Blank key = unchanged | reveal after a blank-key edit returned the stored key |
| Rename keeps its key | id-matched merge; verified on real files after migration |
| Secrets are 0600 | `stat` → `600 router.toml`, `600 router-token` |
| Status mints nothing | `has_token:false` before first start, no token file created |
| No key/token in status | grepped the real payload for both — absent |
| Unauthenticated admin is refused | `401` on `/admin/slots` |
| Pi registration preserves other providers | `workbuddy` byte-identical after install |
| Pi config never holds the token | grep for the token in `models.json` — absent |
| **Pi → router → upstream** | `pi --provider amber-router --model alpha -p "say PONG"` → `PONG from alpha` |

## Live-verified (GUI, xvfb + CDP)

Pill renders (`btn web-pill router-pill web-pill-off`, `aria-label="Model
router: off"`); dialog opens on the real `.help-overlay`/`.help-card` shell with
the router's real slots and five computed check rows; key fields show
`••••1111 (unchanged)` and no key appears anywhere in the DOM; **↑ in the dialog
reordered `router.toml` on disk**; Reveal shows the plaintext key with its
warning; no toolbar overflow at 1024 / 1100 / 1400 px.

## Bugs found by testing, and fixed

1. **A disabled slot lost its model and its position** — caught by the TOML
   round-trip test. Order now comes from the provider list; every slot gets its
   own alias.
2. **Pi rejects `models` as id strings** ("must be object") and discards the
   whole file — caught by a real `pi --list-models`. My earlier reading of the
   user's config had been flattened by my own redaction script.
3. **Legacy configs have no slot id**, silently disarming the rename
   protection — caught live. `store::ensure_ids` migrates once, on load.
4. **`has_key` never reached the UI** (wire snake_case vs UI camelCase), so every
   stored key rendered as "no key yet" — caught in the GUI.
5. **A save would have sent `baseUrl`**, which the router's deserializer
   rejects — same root cause, fixed with tested mappers both ways.
6. **`rotate-token` claimed success when the restart did not happen**, leaving a
   router serving the old token while Pi read the new one — now reported.
7. **`router.toml` was written in place**, so a crash mid-write would truncate
   the file holding every provider key — now tmp + rename.

## Gates

Rust `--workspace`: all suites green (430 lib + every integration suite);
`cargo clippy --workspace --all-targets` clean. App: **711 tests**, 1 skipped;
`typecheck`; `build`; `build:web`.

## Open

- **Static-musl release is unverified and currently cannot build here.**
  `amber-router` links `ring` (via rustls), which needs a musl C toolchain;
  this box has no `musl-gcc` (`musl-tools` is not installed). `scripts/dist.sh`
  now exports `CC_x86_64_unknown_linux_musl=musl-gcc` when present, and
  `app/scripts/dist.sh` asserts both artifacts are static — but neither has been
  exercised. **`sudo apt install musl-tools`, then run `npm run dist`.**
- macOS/Windows unit install paths are rendered and unit-tested, never run.
- `enable`/`disable` write a real unit into `~/.config/systemd/user/`; not run.
- No `amber web`/mobile router surface by design (desktop-only authority).
