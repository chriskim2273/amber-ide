# Browser-host local integration

## Authorization and scope

The user explicitly requested local merge and cleanup after being told that external release/platform acceptance remained open. This authorizes integrating the code **with its existing disabled-by-default gates**, not deployment or production enablement. `mergeReady:false` in the feature ledger remains the full product acceptance verdict, not a statement that the user-authorized local integration did not happen.

- Main parent: `75c84ee722615efe0e559bfbb23bda6e2a5014e9`.
- Feature parent: `87c87bd4d36a3144cddd2a8ec7f6fffcdc7da916`.
- Merge was assembled and tested on persistent isolated `integrate/tab-browser-host`, not in the user's main checkout.
- Main's unrelated untracked files and all other worktrees are preserved.

## Conflict reconciliation

Retained main's daemon/editor friendly titles, title-bearing create acknowledgements, pane picker, usage reporting, atomic concurrent tree merge, staged-binary ignore rule, musl compiler discovery, and esbuild >=0.28.2 fix. Combined these with native tab browser rails, bounded workspace parsing, v2 browser intents/recovery, and configurable Cargo output paths. Legacy browser **pane** title tests were migrated to editor titles plus a separate tab-browser intent, not used to resurrect the removed browser pane kind.

## Combined-result validation

- App: **1074 passed, 1 intentional skip**. First run exposed an obsolete legacy-browser-title test and a transient Electron module load failure; the migrated title+rail test and full rerun pass.
- Rust workspace/all-targets: **876 passed, 1 intentional ignore**, 37 suites.
- Typecheck, warnings-as-errors Clippy, Electron/web builds and static-musl AppImage packaging: PASS.
- Pi v7 verifier using the **newly bundled static Amber** and installed pinned Pi0.81: PASS, 27 tools, exact no-rollback fields and fatal token/frame checks.
- Private packaged smoke: native fixture isolation/unsafe navigation refusal; broker unshared refusal/designation/share/snapshot/visible approval/approved click/generation/revocation; resident hide/five activation requests/one window; actual Quit MenuItem callback exits 0, kills fake SSH child, removes forwarding socket, writes inhibit. Test driver waits for main's persisted initial tab context before opening the browser. Physical menu/IME is not claimed.

Persistent logs: `/home/poyto/recovery/amber-ide/merge-browser-host/`.

**Merged-code AppImage:** `/home/poyto/recovery/amber-ide/live-merge/amber-ide.AppImage`

SHA-256: `103841545015c897011494a2b0233c45252ab0f4dc5349b23ecccf796fc048fd`

This supersedes the feature-only package for deployment planning. Its release version remains 0.0.2; choose a new release version before publishing rather than silently replacing existing public assets.

## Deployment sequence (not executed)

1. **Prepare a reader release first.** Publish reviewed Linux/macOS artifacts containing the v2-capable Rust reader under a new version. Upgrade the daemon/CLI and restart any `amber web` process that still runs an older reader. Verify the actual old-to-new release channel before asserting `AMBER_TAB_BROWSER_V2_READER_DEPLOYED=1`. The current public v0.0.2 assets are Windows-only.
2. **Back up production state.** Export important workspaces and snapshot the daemon; retain a private backup of the complete Amber state directory (layout, browser-state, sessions, journals and profile as applicable). Plan a daemon restart window: clients survive daemon loss, but terminal processes are killed/restarted and supervised agents resume; arbitrary shell processes are not magically checkpointed. Do not restart during active unsaved work.
3. **Install the matching application at a stable pathname.** On Linux, explicitly Quit the old Amber application (not merely close the window), retain the old AppImage as rollback, and stage/atomically rename the tested new artifact to `~/Applications/amber-ide.AppImage`. Ensure the stable executable has safe ownership/permissions; use the application's desktop-shortcut installation to register the launcher. macOS needs its native DMG/application gate before distribution.
4. **Enable only after the reader gate and platform acceptance.** Launch the new app with both `AMBER_TAB_BROWSER_HOST=1` and `AMBER_TAB_BROWSER_V2_READER_DEPLOYED=1` in its launch environment. Neither is set in production by this work. Keep the environment consistent for resident-host startup. Compatibility/software-GL fallback disables browser hosting; it is not a way to validate native hosting.
5. **Use the proven Pi baseline initially.** Pinned Pi0.81 passes the generated extension verifier; published Pi0.85 currently fails loading its own missing `pi-server` dependency. Install the bundled Amber-owned Pi extension using `amber ctl install-pi-extension`, then open/restart the intended Pi session. Open a tab's Browser rail, designate its Pi pane and explicitly enable Share with Pi. Verify approve/reject/revoke and close/reopen on real hardware.
6. **Check readiness and rollback.** `amber ctl browser-host status` reports host readiness; `enable` clears an explicit-stop inhibit and `ensure` starts the registered host when allowed. These commands do not waive the environment/reader gate. After migration, rollback must restore a matched pre-migration layout+browser-state/profile backup with the old app, not send an old writer at new v2 data.

No systemd/launchd units, production executables, credentials, profiles, release assets, or production feature flags were changed. Remaining external gates are listed in `tab-browser-host-direct-final.md`.
