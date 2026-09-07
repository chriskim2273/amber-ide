# Browser interaction follow-up and rollout — 2026-09-07

## Integration

The initial browser change `f221a6d` was fast-forwarded and installed with explicit user authorization, backing up the AppImage and legacy Pi extension under `/home/poyto/recovery/amber-ide/interaction-install-20260907T042427Z/`. Only the GUI was restarted; daemon/web/router PIDs remained unchanged then.

While validation continued, main advanced to `5ede542` (Pi graphical-view integration), another AppImage was installed, and the machine rebooted at 04:13:55 EDT. This changed service PIDs independently of this task. The native browser fixes were committed as `d678394`, then the newer main was merged into the isolated branch (`14314f1`) rather than overwritten. The final package preserves the graphical Pi view and its combined extension.

## Native fixes

- **Retina cursor:** Chromium's Overlay domain multiplies the native display DPR again. A dedicated Mac probe measured a quad at CSS (100,100) appearing at (200,200) in a DPR-1 screenshot on the Retina display. Compensation now divides only the marker geometry by native display DPR. Input coordinates are unchanged. A regression checks DPR changes and native screenshots verified the corrected marker.
- **macOS editing:** CDP does not perform Cocoa key-binding translation. Command-A did not select existing text, so fill produced `old valuepotatoes`. Fixed, internal editing-command mappings now support safe selection/undo/navigation without exposing arbitrary commands, clipboard operations, kill-ring operations or evaluation. Key-up cleanup clears commands to prevent replay. Real Mac tests verified selection and replacement after failing with the old implementation.
- **Failed semantic drag:** removing its destination after mouse-down caused the catch block to release over the source and generate a click. A real native fixture reproduced that activation. The failure now uses the shared outside-content owned-input cleanup.
- **Test corrections:** use Command on macOS, account for native capture pixel dimensions, recognize the uniquely green fixture region across sRGB/Display-P3 encodings, and allow a bounded read-only wait for the cursor's compositor frame rather than assuming 60 ms. These do not retry input or alter production color profiles.

Upstream references: [CDP Overlay](https://chromedevtools.github.io/devtools-protocol/tot/Overlay/) (including the DPR issue noted for rectangle highlighting), and Playwright's public Chromium keyboard implementation and macOS editing-command definitions. The native probe, not assumed private-agent behavior, established the quad compensation.

## Combined verification

Evidence root: `/home/poyto/recovery/amber-ide/browser-interaction/`.

- App: **1144 passed, 1 skipped**; typecheck passed (`combined-app-package.log`).
- Rust workspace/all-targets: **902 passed, 2 ignored**, zero failures; Clippy with warnings as errors and private CLI build passed (`combined-rust.log`).
- Combined generated extension: all **31 browser tools** compile/load and binary/approval/no-rollback checks pass against the actual installed **Pi 0.85.1** (`combined-pi-current.log`). The previous Pi 0.81 pin cannot typecheck the newer GUI integration's context/events; its failed log is retained, not declared passing.
- Linux final matrix: **40 cases ×20 consecutive runs = 800/800**, plus **40/40** on the real Linux display (`matrix-platform-final/`, `native-linux-display.log`). Software rendering and test-only `--no-sandbox` were used. These are not hardware-IME or OS-sandbox certification.
- Real Mac: early runs exposed the bugs above. The fixed Command-A/fill cases passed; the corrected cursor and fractional-DPR targeting were also verified natively. The last complete run still used the too-short cursor timing oracle. The final 40-case rerun could not execute because SSH subsequently timed out. Do not present this as a complete green Mac matrix.
- A before/after OS-pointer sample changed during the real-display run; operator activity was not controlled, so it proves neither pointer isolation nor a product defect. No OS mouse-dispatch code was introduced.

## Real Google and package proof

Final receipt: `/home/poyto/recovery/amber-ide/bg1/final-evidence.json`; screenshot: `google-result.png` in that directory.

The exact final AppImage was run with a private daemon/profile. The installed Pi 0.85.1 loader invoked the registered `browser_navigate`, `browser_snapshot`, `browser_fill`, `browser_press`, `browser_status` and `browser_screenshot` definitions. It navigated only to Google's homepage, typed **potatoes**, submitted through an actual visible approval dialog, and observed **potatoes - Google Search** and the rendered results. No hand-built search URL and **zero input retries**. The final run needed zero read-only screenshot refreshes. Approval was clicked by the private QA harness, not represented as human approval or a production-profile test. No Google-page evaluation was used.

The same package run passed sharing/refusal/revocation, coordinate approve-once previews, raw binary images and refreshed tokens, focused typing, resident hide/reopen, and real Quit-menu handler/tunnel cleanup. Its inherited `sandbox:true` evidence label means Node/context-isolation checks, not Chromium OS sandbox enabled.

Earlier harness failures are retained: missing fixture environment, using a global extension that changed during the reboot, a stale read-only Google screenshot, and a repeated-run startup-context race. The final clean-profile harness avoids issuing duplicate open gestures and distinguishes read-only refresh from activation replay.

Final AppImage SHA256: `ff2407aebe956483637a7b00ead3be49a9b55d4596d8ba491cbb10963199fd09`.

## Activation and external limits

The production shared browser reported frozen/hidden after restart. The user was asked to reveal/restore its desktop rail; a successful production-profile thaw was not observed. The private-profile Google proof does not substitute for that fact.

After the intervening reboot the global Pi extension was the exact legacy payload again. The current installed CLI was tested in an explicitly private agent directory and generated the correct combined v9 payload. The writer responsible for the legacy reappearance was not identified; final activation must restore and hash-check the current combined extension, without replacing an unrelated newer payload.

Current live Pi processes require an extension reload to acquire the new tool definitions/GUI sideband. They must not be silently killed or restarted. Final full Mac validation still needs the Mac awake/reachable; physical keyboard/IME and human gestures remain manual.

The final installation receipt is recorded separately after the guarded install. No daemon/web/router restart is authorized or required for these browser-only native fixes.
