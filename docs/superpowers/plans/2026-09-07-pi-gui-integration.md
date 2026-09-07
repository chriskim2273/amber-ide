# Pi GUI integration and deferred activation

Integrated `feat/pi-gui-pane` with main at `f221a6d` on 2026-09-07.

## Merge decisions

- Preserve current browser-host APIs, friendly session titles, and renderer lifecycle controls.
- Keep the current exact-session-file start/quit reporting in the Pi extension. Initialize the semantic sideband separately inside that same extension; do not restore the obsolete duplicate session-ID hook.
- Preserve the exact legacy extension payload used by installer ownership checks.
- Release semantic ports as well as terminal ports when the resident desktop UI hides. Added a regression test, observed failure before the fix and success afterward.

## Validation

- App: 1141 passed, 1 skipped; TypeScript typecheck passed.
- Rust: 902 passed, 2 ignored in the complete workspace/all-targets rerun. Initial run had one failure in `agent_rename_keeps_memory_suspension_resumable_on_focus` (session disappeared); unchanged test passed in isolation and in the complete rerun. No manager code was changed.
- Clippy workspace/all-targets with warnings as errors passed.
- Generated combined extension compiled and loaded with the installed Pi runtime; existing browser-extension verification passed, including all 31 browser tools and security checks.
- `npm run dist` built static-musl Amber/router binaries, desktop and web bundles, and the Linux AppImage.
- No live feature activation performed: user explicitly requested no daemon restart. Existing live Pi extensions remain untouched until later activation.

Build logs are stored outside the repository under `/home/poyto/worktrees/amber-ide/pi-gui-evidence/`.
