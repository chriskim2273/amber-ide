# Background browser verification — todo #3

Status: implemented and verified in isolated worktree; not merged or deployed.

## User-approved behavior
The designated agent can keep navigating, observing, taking screenshots and entering input while the user changes Amber tabs or unfocuses the application. Ordinary work must not switch the user's tab or take native focus. Approval, navigation, generation and controller checks remain enforced. Existing live-page capacity limits are unchanged; this does not promise preservation after explicit freeze, capacity eviction, shutdown, or system sleep.

## Implementation
- `ElectronTabBrowserPage` separates the presentation owner from its actual rendering window. Hidden live pages are reparented into one non-focusable, taskbar-excluded, off-desktop rendering window per live background browser, following the existing remote-surface pattern. No second browser page, profile, listener, or agent process is created.
- Surfaces are released on reveal and teardown. Position follows display changes and surface resizes; event listeners are removed when the surface closes. Content uses `backgroundThrottling:false`, with sandbox, context isolation and navigation restrictions unchanged.
- Tab presentation changes invalidate unseen approval/dialog UI but no longer abort ordinary broker/navigation work. Explicit close, Stop/unshare and window shutdown cancellation paths remain intact.
- Hidden screenshots use the normal adapter path, replacing the earlier fail-fast mitigation.
- Background approval requests remain `APPROVAL_REQUIRED`; instead of automatic foreground/tab switching, local windows receive taskbar attention. No permission is silently granted. Users must reveal the relevant browser before retrying actions needing approval.

## Evidence
Private Electron version: 43.1.0, Linux/Xvfb. Persistent evidence root:
`/home/poyto/worktrees/amber-ide/browser-experiments-evidence/`.

1. Initial real-adapter regression failed with `ACTION_TIMEOUT` after detaching the view: `background-red/lifecycle-eknZ8z`.
2. Successful final real lifecycle regression: `background-focus-proof/lifecycle-ajczaB/results.json`. It positively establishes a foreground window before checking focus preservation. It covers hidden screenshot + native fill, return to the same WebContents/input value, screenshot + fill with the owner covered by a separate foreground window, repeated hide/show with stable window count, non-focusable/off-desktop host bounds, background navigation followed by capture, and destruction while parked. Native and renderer-initiated guest close cleanup and real image encoding also pass.
3. Service regressions cover in-flight broker navigation and snapshot survival, FIFO preservation on tab hide, hidden host capture without revealing the page, and retained exact approval denial and explicit stop/revocation cases.
4. Full app suite: **1252 passed / 1 skipped** (`background-tests.log`). Typecheck, desktop build, web build and diff checks passed (`background-typecheck.log`, `background-build.log`, `background-build-web.log`). Web build emits its existing bundle-size advisory.
5. Existing real native-input matrix: **43/43 passed** (`background-native/fixture-nbw2gs/results.json`).

## Limits and review notes
No production app/daemon/profile was replaced. The actual connected browser still runs its installed version until an approved deployment. Xvfb verifies native Electron mechanics but is not real macOS, Wayland, multiple-DPI monitor hotplug, window-manager overview, or hardware IME certification. Display repositioning is implemented; physical hotplug is not certified. Background capacity eviction and reopening already-frozen browsers remain the existing lifecycle contract, not part of this change.

Self-review checked actual-versus-presentation owner teardown, listener/surface lifetime, initial focus establishment, approval denial on hidden surfaces, explicit cancellation, and preventing generic UI commands from selecting off-desktop hosts. No Rust changes were made for todo #3.
