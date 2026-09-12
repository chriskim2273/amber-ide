# Prompt-enhance deployment receipt (2026-09-11)

Feature: toolbar enhance button + command palette entry → modal that rewrites
a prompt through `amber ctl router complete` (router `auto` alias).
Commits: `2b0e77b` (feature), `0c2cb7e` (stale-bridge guard).

## Staged artifacts (active on NEXT restart, nothing restarted today)

- `~/.local/bin/amber` → `ae0cc1e8…` (glibc release build from tree).
  Backup: `~/recovery/amber-ide/amber.before-enhance-20260911` (+ `.sha256`,
  old sha `6b710df7…`). Daemon keeps the old inode until restarted.
- `~/Applications/amber-ide.AppImage` → `81e04d0c…` (was `3dd2cfcc…`).
  Backup: `~/worktrees/amber-ide/enhance-deploy/amber-ide.before.AppImage`.
  Running app keeps the old mount until relaunched. Workdir with all
  evidence: `~/worktrees/amber-ide/enhance-deploy/`.

## What the AppImage patch contains (and does NOT)

- ASAR: 707 files compared, file list identical, exactly 4 changed, all
  patched in place (filenames kept, no chunk renames):
  `out/main/index.js` (+23-line validators, +10-line `router:enhance`
  handler), `out/preload/index.cjs` (+1 bridge line),
  `out/renderer/assets/index-B7uwbDps.js` (piDraft event block, PiPane
  listener effect, PromptEnhancer component, toolbar/palette/render wiring),
  `out/renderer/assets/index-DEx3h5nZ.css` (+2 rules).
  Receipt: `asar-verification.json`. Every bundle re-parsed with babel.
- `resources/bin/amber` → fresh static-pie musl build (`6b6faf19…`,
  old `c15599d0…`). This is REQUIRED, not optional: the packaged app shells
  to the bundled binary, so the old one would have answered
  "unrecognized subcommand". `resources/bin/amber-router` untouched.
- Deliberately NOT shipped: the tree's newer attach-replay rework, Muse-kind
  UI, and browser-host work (installed app is newer than the tree in some of
  those regions and vice versa — whole-file replacement would have regressed
  one side or the other). Filesystem compare of the repacked image: 97 files,
  only `app.asar` + `bin/amber` differ, modes preserved (bin/amber 775).
  Receipt: `filesystem-verification.json`.

## Verification

- App suite 1261 passed / 1 skipped; Rust `amber` lib 563 passed; clippy
  clean except pre-existing doubled `#[test]`; typecheck clean except the two
  pre-existing browser-host files.
- Private Playwright smoke on the patched AppImage (Xvfb, fixture daemon,
  live state untouched) — 5/5: boots + renders pane; toolbar button opens the
  modal; modal lists the live pi session; the no-token error surfaces honestly
  in the modal, proving modal → bridge → main → bundled-CLI chain
  (`Error: no router token yet — start the router once …`); zero renderer
  errors. Evidence: `smoke-ikq6Gp/result.json`.
- Offline CLI proofs on both binaries (glibc + musl): blank prompt rejected
  by validation; valid prompt reaches the router dial.

## Still manual

- Live provider round-trip (needs router up + keys + quota).
- The actual restart (user's call): relaunch app, restart daemon when ready.
- `/app` web bundle is stale and lacks the `routerEnhance` stub — the modal
  now reports "prompt enhancement needs the desktop app" there instead of
  throwing. Rebuild/redeploy web assets if the button should work from phones.
