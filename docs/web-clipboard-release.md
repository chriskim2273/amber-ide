# Web clipboard release

Merged `fix/web-clipboard-consistency` (`bffa1b8`) into main, retaining main's
newer Pi recovery, branch metadata and terminal replay behavior. Includes the
branch prerequisite nested-cgroup cleanup fix. Merge resolution deduplicates
independently landed clipboard code rather than replacing main with the older
feature tree. The original dirty checkout is not part of this release.

The orphaned `browserFrame` callback in the web shim had no declared API,
dependency or caller in committed main. Removed it; TypeScript now passes.

## Verification of merged code

- Rust workspace: 977 passed, 0 failed, 3 ignored.
- Workspace all-target Clippy with warnings denied: pass.
- App: 1290 passed, 1 skipped.
- TypeScript, desktop build, web build: pass.
- Real mounted terminal clipboard fixture: 35/35.
- Static musl release built by `scripts/dist.sh`.
- Installed AppImage repack preserves all files except `resources/bin/amber`;
  extracted replacement verified byte-identical to the musl release.

## Deployment contract

No daemon or web service restart. Atomically replace `~/.local/bin/amber` and
`~/Applications/amber-ide.AppImage`; the running processes retain their existing
inodes. The packaged UI/ASAR remains unchanged, preserving installed browser WIP.
The bundled binary refresh prevents a later packaged boot overwriting the new
stable binary with the old one. `amber-router` is not deployed.

Publish web assets under `~/.local/state/amber-ide/web/`, retaining previous
hashed assets and replacing the entry point last. New browser loads see new
assets immediately; expanded server-side image acceptance starts on the next
**web service** start. Restarting only the session daemon does not upgrade an
already-running web process. No claim that changes are active in either
running service before restart.

Persistent evidence and backups:
`~/worktrees/amber-ide/web-clipboard-evidence/`, particularly `deploy/`.
The deployment receipt there records artifact hashes, HTTP asset checks and
unchanged service start identities after installation.

## Remaining limitations

Pi may copy only to the host clipboard without emitting OSC 52. These changes
do not intercept `/copy` or patch Pi. Native physical macOS gestures and image
attachment inside every third-party agent remain manual checks. Shells receive
a path without Enter; receiving a path does not imply agent image support.
