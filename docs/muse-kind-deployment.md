# Muse-kind deployment receipt (2026-09-11)

Feature: `kind:"muse"` supervised Muse Code CLI panes (`muse --yolo` fresh,
`muse resume <uuid> --yolo` on relaunch, hand-started promotion).
Commits: `16c6bfc` (feature), `7a43ea7` (merge to main).
Spec: `docs/superpowers/specs/2026-09-11-muse-session-kind-design.md`.

## Staged artifacts (active on NEXT restart, nothing restarted today)

- `~/.local/bin/amber` → `2fd30c85…` (glibc release build from the merge
  tree). Backup: `~/recovery/amber-ide/amber.before-muse-kind-20260911T205024`
  (old sha `ae0cc1e8…`, the enhance build). Daemon (PID 2424, up 17h) keeps
  the old inode until restarted; 27 live sessions untouched and verified
  (`amber ls` still 28 lines against the old daemon — protocol unchanged).
- `~/Applications/amber-ide.AppImage` → `46259c84…` (was `81e04d0c…`).
  Backup: `~/worktrees/amber-ide/muse-deploy/amber-ide.before.AppImage`.
  Running app keeps the old mount until relaunched. Workdir with all
  evidence: `~/worktrees/amber-ide/muse-deploy/`.

## What the AppImage patch contains (and does NOT)

- ASAR: renderer chunks swapped for the merge-tree build — removed
  `index-B7uwbDps.js` / `index-DEx3h5nZ.css` / `Editor-SxHNWN2i.js`, added
  `index-BRVSIq_3.js` / `index-Dcss9aiG.css` / `Editor-B5JQ8xyM.js`, plus
  `index.html` (chunk refs). Receipt: `asar-verification.json`. The Editor
  chunk rename is import-shuffle only: statement-set compare over all 13105
  statements shows exactly ONE differing line (the cross-chunk import of the
  renamed index file) — zero feature divergence, so no editor regression.
  `main/` and `preload/` deliberately untouched (installed app is newer
  there); `out/web/` untouched (stale by design, kind-agnostic anyway).
- `resources/bin/amber` → fresh static-pie musl build WITH muse support
  (`02638e49…`, old `6b6faf19…`, mode preserved 775). REQUIRED, not optional:
  a cold app start installs the bundled binary over `~/.local/bin/amber`,
  which would otherwise revert tonight's daemon deploy to a build that
  rejects `kind:"muse"`. `resources/bin/amber-router` untouched.
- Filesystem compare of the repacked image: file lists identical and zero
  content differences outside `app.asar` + `bin/amber`.
  Receipt: `filesystem-verification.json`.

## Verification

- Private Playwright smoke on the patched AppImage (Xvfb, fixture daemon
  socket, live state untouched) — 4/4: boots + renders pane; split picker
  offers Muse with its kind dot; picking Muse sends
  `Create{sessionKind:'muse'}` (auto-named `amber-1-1-1-*`) down the socket;
  zero renderer errors. Evidence: `smoke-Lnjw7v/result.json`.
  Harness: `smoke-muse.cjs` (modeled on the enhance smoke).
- Daemon-side lifecycle proven earlier on an isolated private daemon: fresh
  pane → UUID recorded; `kill -9` → `resume <same-id>` with one conversation
  across three PIDs and a daemon restart; hand-started muse → flag +
  recording → restart promotes to muse; rename moves the recording.
- Gates on the merged main: Rust lib 562 + core 157 green, app 1267 passed /
  1 skipped, clippy clean except the pre-existing doubled `#[test]`,
  typecheck clean except the two pre-existing `web/amber.ts` errors (broken
  at main's HEAD, repaired by concurrent uncommitted work — untouched here).

## Still manual

- The actual restart (user's call): relaunch app, restart daemon when ready.
  Until the daemon restarts, `kind:"muse"` creates are rejected (old daemon)
  while everything else runs as before.
- Detached muse TUIs exit on unanswered terminal queries (spec §5) —
  expected, degrades to shell fallback with the id retained.
