# Shared browser viewport addendum

User reports shared browser beside chat does not respond to pane size and explicitly requests mobile viewport testing. This extends task 3 of the Pi chat upgrades; no production rollout.

## Evidence and scope

Parent inspected base sources: BrowserRail already has Desktop/Tablet/Mobile presets and custom width/height in its Viewport popup, but `responsiveViewport` defaults false and is only local state. ResizeObserver always sends `show(bounds)`; only the local responsive flag sends a viewport command. TabBrowserHost.thaw unconditionally restores a fixed CDP device-metrics override. Host.show/setBounds only change native view bounds. These are a concrete hypothesis for the mismatch: resizing the native view does not remove/update the fixed page-layout viewport. Reproduce via tests/private page before accepting root cause; do not merely turn the React boolean on (that would fight agent viewport overrides).

## Implementation intent

One authoritative viewport mode per shared browser: `fit` or `fixed`, owned in the existing browser host/state, not an independent renderer boolean. New/migrated records without an explicit mode default to fit; retain valid saved dimensions for fixed testing but do not infer fixed mode from the legacy always-present dimensions. Explicit user or agent `setViewport` selects fixed mode. Fit mode clears device-metrics overrides and follows actual native content bounds; reset emulated device scale tracking and invalidate screenshot coordinate leases so old observations cannot drive input after mode changes. No silent page zoom, no UA spoofing, no permission changes.

Reuse existing Viewport UI rather than building a second picker. Make current mode/dimensions obvious in the toolbar; Fit pane is the default and one-click reset. Offer existing Mobile 390x844, Tablet 768x1024, Desktop 1280x800 and custom bounded dimensions, plus rotate width/height. Label these 'viewport size' simulation, not real-device/browser/OS/IME testing. Preserve native focus/input and page trust/approval surfaces. Fixed-size mode remains fixed across rail resize and app/host restore; fit follows show/resize/thaw. Existing agent browser_set_viewport must select fixed and remain effective until user chooses Fit pane.

Respect existing serialized browser operation/context checks; introduce only an explicit renderer-owned fitViewport command through the normal IPC/service parser, never an arbitrary CDP tunnel. Revalidate context/page lease and clear emulation through BrowserAutomation's public internal method. Do not trust renderer-authored bounds outside existing checked window path. Persist mode with existing browser state serializer and expose in BrowserRuntimeStatus. Avoid persisting every pixel on resize; native bounds are transient. If fitting below the tool viewport's minimum, use native bounds rather than sending an invalid emulated viewport. Do not expand mobile emulation/touch/UA feature scope.

Files allowed in task 3 in addition to chat: BrowserRail.tsx/.css/.test.ts, browserRailModel.ts/.test.ts, shared/browserViewport.ts/.test.ts if required, tabBrowserHost/service/stateStore and their existing state/IPC type/parser files and tests, browserAutomation.ts/.test.ts; minimal shared DTO changes. No Rust browser-host/auth permission modifications. Contact parent if another architecture or new dependency is required.

## Acceptance

Failing tests before fixes: fit default, legacy migration, fit clears a previously fixed override and tracked DPR, fixed dimensions survive native bounds changes, user preset and agent tool both switch fixed, return-to-fit persists and restores, screenshot leases invalidate, invalid custom sizes rejected, rotation swaps dimensions, UI receipt/error handling, late resize responses cannot overwrite newer mode. Existing browser input/security/approval tests remain green.

Private Electron fixture with a responsive page showing innerWidth/innerHeight and CSS breakpoint marker: rail widths 420/700 produce changed viewport/breakpoint in fit; Mobile reports 390x844 despite rail resize; rotation reports 844x390; return-to-fit follows bounds again. Screenshots and DOM measurements in persistent evidence, no live user site input or production restart. Full app tests/typecheck/build and generated Pi browser verifier are regression gates.
