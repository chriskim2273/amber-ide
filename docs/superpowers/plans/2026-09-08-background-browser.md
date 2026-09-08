# Background Browser Implementation Plan

> **For the executing agent:** Use executing-plans to implement and verify directly. No subagents requested.

**Goal:** Keep the designated agent's browser usable across tab switches and application blur without changing the user's foreground tab/focus.

**Approved design:** The user approved bounded, non-focusable rendering windows outside the virtual desktop, omitted from the taskbar, following Amber's existing remote-surface pattern. Keep the same WebContents/partition, no extra page or browser session. A background surface exists only while its live browser is not presented; destroy it when presented again or disposed. Live-browser capacity still bounds page/surface counts. Host visibility continues to mean user presentation, not presence of a rendering surface.

**Evidence:** Private Electron 43.1.0 probes show detached/invisible/covered views can stall screenshots even with backgroundThrottling=false. A non-focusable off-desktop window allowed screenshot and native typing without changing the focused window. External evidence directory: /home/poyto/worktrees/amber-ide/browser-experiments-evidence/; successful probe background-probe-IuHm1w/results.json.

**Constraints:** Preserve sandbox, partition, navigation/download policy, designated-controller authorization and generation checks. No production deployment. Do not auto-switch tabs or foreground Amber for approval; background consequential actions return APPROVAL_REQUIRED and dialogs remain fail-closed until the user reveals the correct surface. Explicit Stop, unshare, close and shutdown still cancel work. App hide/shutdown rules are distinct from mere OS blur and tab presentation changes.

## Steps
- [x] Extend the private Electron lifecycle runner to exercise `page.hide()`, screenshot and semantic fill, `page.show()`, then assert the same WebContents and input value survive; assert the current foreground window is unchanged. Observe failure on the old detached path.
- [x] Implement lazy background surface ownership in `electronTabBrowserPage.ts`: retain the actual host window separately from the desired presentation window; reparent at identical dimensions, use non-focusable off-desktop showInactive surfaces, clean them up on show/destroy, and never focus the foreground window from background input. Enable backgroundThrottling=false in `tabBrowserPolicy.ts` for live browser content.
- [x] Replace the temporary hidden-screenshot rejection test/guard in `tabBrowserHost.test.ts`/`.ts`. A hidden snapshot must be allowed while status remains visible=false and the page identity is preserved.
- [x] Add service tests showing a tab-hide does not abort in-flight benign automation or navigation. Separate presentation invalidation from explicit work revocation in `tabBrowserService.ts`; retain pending approval invalidation, explicit window shutdown and Stop/unshare cancellation tests.
- [x] Replace automatic approval foreground/tab switching in `index.ts` with taskbar attention only. Keep approval coordinators' exact-visible-surface checks. Test the attention helper with a surface exposing only flashFrame so it cannot activate a window.
- [x] Run focused tests, private Electron background/lifecycle and full native-interaction suites, typecheck, full app tests, desktop/web builds and diff checks. Record limits: Xvfb is not real macOS/window-manager certification. Update AGENTS.md and commit the verified milestone separately from checkpoints 86b50b5/450586f.
