# Tab Browser Host — Phase 0 Decision Record

**Status:** Linux substrate evidence complete with physical-input exception; macOS remains a blocking pre-merge/manual gate
**Date:** 2026-09-01
**Branch:** `feat/tab-browser-host`
**Approved plan commits:** `afca111`, amendment `9046c33`

## Gate interpretation

This worker is on Linux (`node -p process.platform` → `linux`). Linux Phase-0 evidence gates implementation on this host. Equivalent macOS native `WebContentsView` geometry, focus, IME, accessibility, lifecycle, profile, and bundle-launcher evidence remains required before merge/default enablement, but unavailable macOS hardware does not block portable implementation.

No macOS verification is claimed in this report.

## Isolation contract

All dependencies, Electron `userData`/`sessionData`, browser profiles, caches, sockets, daemon state, fixtures, build products, and artifacts must remain under `/tmp/amber-tab-browser-validation`. Tests must use recorded child PIDs and private paths. Production Amber state, profile, socket, daemon, and service-manager units are out of bounds.

## Initial environment evidence

```text
$ uname -a
Linux teapot-dev 7.0.0-30-generic #30~24.04.1-Ubuntu SMP PREEMPT_DYNAMIC Fri Aug  7 13:27:52 UTC 2 x86_64 x86_64 x86_64 GNU/Linux

$ node -p 'process.platform'
linux
```

## Linux prototype results

A standalone Electron 43.1.0 fixture ran against a loopback hostile page with private userData/sessionData/profile/artifacts. It proved hardened preferences (no Node/Electron/Amber globals), default permission denial, popup denial, screenshot capture through the target-scoped debugger, debugger evaluation confined to the owned `WebContentsView`, detach/reattach, and window replacement while retaining the page.

The prototype selects Electron's target-scoped `webContents.debugger` adapter: it requires no listening CDP endpoint or extra Chromium/Playwright dependency and exposes no target enumeration through the product contract. Electron is pinned exactly at 43.1.0.

One physical-XTest assertion remained inconclusive on this host: the dev Electron binary needed a GPU-sandbox diagnostic switch to capture a painted frame, and the window manager delivered XTest to the top-level Electron X window while no DOM pointer/key event reached the child view. Programmatic child focus, debugger access, screenshot, detach/reparent, and page continuity all succeeded. This is recorded as a Linux live/manual acceptance item rather than claimed green; product integration remains feature-gated and portable work proceeds under orchestrator direction. It must be rerun against the packaged artifact with the repository's production physical-input smoke harness before default enablement.

Latest artifact: `/tmp/amber-tab-browser-validation/phase0/run-1788297704/artifacts/result.json`. No production daemon was involved.

## macOS pre-merge checklist

- [ ] hardened native-view renderer and copied-profile probe
- [ ] physical pointer/keyboard/IME/focus/accessibility
- [ ] geometry/occlusion across scale factors and monitors
- [ ] close/reopen resident ownership and explicit Quit
- [ ] canonical app-bundle registration/repair
- [ ] packaged hostile-fixture smoke
