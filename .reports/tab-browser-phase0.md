# Tab Browser Host — Phase 0 Decision Record

**Status:** Linux evidence pending; macOS is a pre-merge/manual gate
**Date:** 2026-09-01
**Branch:** `feat/tab-browser-host`
**Approved plan commits:** `afca111`, amendment pending

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

## Results

Pending Linux Gates A–E. Exact commands, adapter/version decision, profile decision, fixture evidence, and measurements will be appended as each gate runs.

## macOS pre-merge checklist

- [ ] hardened native-view renderer and copied-profile probe
- [ ] physical pointer/keyboard/IME/focus/accessibility
- [ ] geometry/occlusion across scale factors and monitors
- [ ] close/reopen resident ownership and explicit Quit
- [ ] canonical app-bundle registration/repair
- [ ] packaged hostile-fixture smoke
