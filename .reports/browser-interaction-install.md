# Final browser interaction installation — 2026-09-07

- User explicitly approved main integration, artifact/extension backup and installation, and a GUI-only restart.
- Integrated code: `dbc6132` (including newer Pi GUI main `5ede542` and native fixes `d678394`).
- Installed AppImage SHA256: `ff2407aebe956483637a7b00ead3be49a9b55d4596d8ba491cbb10963199fd09`.
- The combined v9 extension was installed using the current installed CLI and matched the private validated extension byte-for-byte. The CLI itself was not replaced.
- Backup and machine-readable receipt: `/home/poyto/recovery/amber-ide/interaction-final-20260907T090303Z/`.
- Post-restart verification: browser host **Ready**; daemon/web/router PIDs unchanged (**2385 / 2387 / 2384**); **23 previously listed pane sessions preserved**; installed image, extension and unchanged CLI hashes matched the receipt. Input preflight was healthy; no IBus repair was needed.
- Main's unrelated untracked files were preserved. The feature worktree remains at `/home/poyto/worktrees/amber-ide/browser-interaction`.

## Remaining user-owned activation / acceptance

The production tab no longer had its former browser association when checked after the final restart. A fresh browser rail was created through the registered `browser_open` tool; it returned `CREATION_AWAITING_USER`. No sharing flag or controller assignment was silently granted. The user must select this Pi pane as controller and enable **Share with Pi** in the desktop rail before production-profile automation can continue.

Existing live Pi processes were not restarted. Reload extensions in the current Pi session to acquire the combined tool definitions/GUI bridge. The fresh-loaded public tool definitions were separately exercised against real Google with the final package in a private profile; see `browser-interaction-rollout.md`.

The final complete Mac matrix still needs the Mac awake/reachable. The latest SSH attempt timed out. Real physical keyboard/IME and human approval gestures are not certified by the automated runs.
