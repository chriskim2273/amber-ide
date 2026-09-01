# Tab Browser Host — Implementation Plan

**Design:** `docs/superpowers/specs/2026-09-01-tab-browser-host-design.md`
**Status:** reviewed execution plan; implementation has not started
**Platforms:** macOS and Linux first; Windows compiles with the feature unavailable
**Method:** tests first, narrow milestone commits, Phase-0 evidence before product code

## 1. Purpose and invariants

Implement one main-owned `WebContentsView` browser rail per Amber tab, shared explicitly with one designated Pi pane, while preserving Amber's daemon authority and terminal data path.

The following are non-negotiable throughout implementation:

1. Electron main's exception is limited to native browser presentation, policy, persistence, and local browser automation. Terminal bytes still travel only through the utility client and MessagePorts.
2. Browser records never become daemon sessions or split-tree leaves.
3. All renderer browser commands enter main through one sender-derived `browser:command` seam. No caller supplies trusted window/tab ownership.
4. Pi authorization uses a fresh, metadata-only daemon session view and fails closed when it is unavailable or stale.
5. Browser associations and runtime intent use the crash-consistent two-store transaction from the design.
6. Mutations require browser ID, page incarnation, and generation at enqueue and dispatch. Approvals bind the exact operation digest.
7. At most four browser-record renderers are live. Do not confuse that invariant with Chromium OS process count.
8. Remote pages receive no Node integration, preload, Amber IPC, filesystem, daemon, shell, or raw CDP authority.
9. Compatibility mode disables browser hosting. Windows returns a typed unsupported result until its gates pass.
10. Closing the last GUI window leaves BrowserHost resident. Explicit Quit performs a coordinated drain and writes the durable inhibit.
11. Existing `persist:amber-browser` data is preserved if the profile probe passes. A fallback partition is disclosed, never silent.
12. No product slice proceeds past a failed Phase-0 gate. Do not substitute `<webview>` or a detached browser window.

## 2. Fast-drive and isolation discipline

The worktree is already under `/tmp`; keep every dependency cache, build product, test state, browser profile, socket, and fixture under `/tmp` too. Do not invoke tests from a `/home` checkout and do not touch or restart the production daemon.

Use one shell setup for all validation:

```bash
export REPO=/tmp/amber-ide-tab-browser-host
export AMBER_FAST=/tmp/amber-tab-browser-validation
export CARGO_TARGET_DIR="$AMBER_FAST/cargo-target"
export npm_config_cache="$AMBER_FAST/npm-cache"
export PLAYWRIGHT_BROWSERS_PATH=0
mkdir -p "$AMBER_FAST" "$CARGO_TARGET_DIR" "$npm_config_cache"
cd "$REPO"
```

Install app dependencies only in the `/tmp` worktree:

```bash
cd "$REPO/app"
npm ci --cache "$npm_config_cache"
```

Every Electron/live test gets unique private roots and a private daemon socket:

```bash
RUN="$(mktemp -d "$AMBER_FAST/run.XXXXXX")"
export XDG_STATE_HOME="$RUN/state"
export XDG_RUNTIME_DIR="$RUN/runtime"
export AMBER_SOCKET="$RUN/runtime/amber.sock"
export AMBER_BROWSER_HOST_SOCKET="$RUN/runtime/browser-host.sock"
export AMBER_BROWSER_PROFILE_ROOT="$RUN/profile"
export AMBER_TAB_BROWSER_HOST=1
mkdir -p "$XDG_STATE_HOME" "$XDG_RUNTIME_DIR" "$AMBER_BROWSER_PROFILE_ROOT"
```

The harness must spawn its own daemon binary with the private variables above, record its PID, and clean it with a shell `trap`. It must assert that `AMBER_SOCKET` is under `$RUN` before starting or stopping anything. Never call `systemctl --user`, launchctl, the app's Restart daemon command, or an unscoped `pkill amber` during verification.

## 3. Planned module map

### Shared TypeScript

- `app/src/shared/browserName.ts` — replace coordinate IDs with strict opaque `browser-<128-bit>` IDs; keep a legacy parser only for migration.
- `app/src/shared/browserProtocol.ts` — exact broker request/response/event unions, strict decoders, version checks, and normative limits.
- `app/src/shared/browserPolicy.ts` — URL normalization, safe-restorable URL redaction, consequential-action classification inputs, approval digest inputs, and sensitive-field redaction.
- `app/src/shared/browserState.ts` — versioned browser-state shapes, per-record parser, recovery items, journal transaction shapes, and reconciliation primitives.
- `app/src/shared/browserLayout.ts` — v1 browser-leaf to v2 rail migration and association invariants.
- `app/src/shared/layoutFile.ts` — v1/v2 parse, v2 serialize, `browserRevision`, and `TabLayout.browser`.
- `app/src/shared/workspaceFile.ts` — v1/v2 `.amberws` parse/serialize and tab-owned `WsBrowserV2`.

### Electron main

- `app/src/main/browserStateStore.ts` — bounded parse, fsync-safe atomic browser-state IO, token/private-file helpers, backup, and recovery diagnostics.
- `app/src/main/browserTransaction.ts` — journaled layout/browser-state transaction, CAS conflict handling, startup replay/rollback, and orphan grace.
- `app/src/main/browserCapacity.ts` — four-live LRU/protection state machine and bounded activation queue.
- `app/src/main/browserSecurity.ts` — webPreferences factory, partition permission request/check handlers, navigation/popup/external-protocol policy, download/upload/dialog policy.
- `app/src/main/browserDaemonWatcher.ts` — metadata-only `WatchSessions` connection, full-list freshness state, reconnect, and authorization projection.
- `app/src/main/browserAdapter.ts` — narrow adapter interface; no raw CDP/Playwright object in public contracts.
- `app/src/main/playwrightBrowserAdapter.ts` or `app/src/main/debuggerBrowserAdapter.ts` — exactly one implementation selected by Phase 0.
- `app/src/main/browserBroker.ts` — local framed server, token handshake, strict parsing, limits, authorization, replay/high-water handling, per-browser mutation queues, cancellation, and response redaction.
- `app/src/main/browserHost.ts` — registry, `WebContentsView` ownership, events, navigation/runtime state, freeze/thaw, approvals, recovery, and coordinated drain.
- `app/src/main/browserIpc.ts` — the sole sender-derived renderer command handler and event subscription.
- `app/src/main/browserResident.ts` — singleton activation, app-path registration, inhibit handling, close/reopen/tray behavior, readiness, and quit state machine.
- `app/src/main/index.ts` — composition only: feature/platform/compat gate, host construction, existing `WindowCtx` integration, and removal of old webview policy.
- `app/electron.vite.config.ts` — include any broker/launcher child entry only if Phase 0 demonstrates that it cannot remain safely in main; default is no extra privileged process.

### Preload and renderer

- `app/src/preload/index.ts`, a new shared `app/src/shared/browserBridge.ts`, and the existing renderer `window.amber` declaration in `app/src/renderer/main.tsx` — expose one typed `browserCommand` plus typed browser event subscription; no generic IPC or CDP method.
- `app/src/renderer/BrowserRail.tsx` — tab-level chrome/empty/frozen/restore/share/controller/activity/recovery/approval UI; never embeds remote content.
- `app/src/renderer/BrowserRail.css` — right rail, divider, focus, occlusion, reduced motion, and accessibility states.
- `app/src/renderer/browserRailModel.ts` — pure rail width/visibility/occlusion/controller projections.
- `app/src/renderer/main.tsx` — render a rail beside the active tab stage, report native geometry, consume host events, add tab-level Open browser and recovery surfaces.
- `app/src/renderer/SplitView.tsx` and `app/src/renderer/uiModel.ts` — remove Browser from pane/split creation, rendering, move, close, and capability menus.
- Delete `app/src/renderer/Browser.tsx` and `app/src/renderer/webview.d.ts` after migration is enabled and no imports remain.
- `app/src/renderer/theme.css` — only shared tokens/layout changes that cannot remain in `BrowserRail.css`.
- `app/src/web/amber.ts` — typed unavailable stubs only; Pocket/web never hosts or controls the rail.

### Rust and installed Pi extension

- `crates/amber/src/mosaic.rs` — read layout v1 and v2 before any v2 desktop writer lands; ignore browser/private fields.
- `crates/amber/src/pi.rs` — ownership-safe migration from the single owned hook file to a package directory and existing hook preservation.
- `crates/amber/assets/pi-extension/index.ts`
- `crates/amber/assets/pi-extension/browser-client.ts`
- `crates/amber/assets/pi-extension/schemas.ts`
- `crates/amber/assets/pi-extension/render.ts`
- `crates/amber/assets/pi-extension/VERSION`
- `crates/amber/src/browser_host_ctl.rs` — stable registered-app metadata, private inhibit file, detached argv construction, readiness wait, platform gating.
- `crates/amber/src/main.rs` — `amber ctl browser-host ensure|status|enable` dispatch. This is CLI/app-launch support only; no daemon protocol message.
- `crates/amber/tests/browser_host_ctl.rs` — fake launcher/readiness integration without opening the real app.

### Test and fixture support

- Pure tests adjacent to every shared/main model: `*.test.ts`.
- `app/src/main/browserHost.test.ts`, `browserBroker.test.ts`, `browserTransaction.test.ts`, `browserSecurity.test.ts`, `browserDaemonWatcher.test.ts`, and `browserResident.test.ts`.
- `app/src/renderer/browserRailModel.test.ts`; renderer component behavior in the Electron integration harness rather than a new DOM-test stack.
- `app/e2e/tabBrowser/fixtureServer.ts` — local pages for navigation, forms, permissions, popups, iframes, console/network, downloads, hostile prompt text, and generation races.
- `app/e2e/tabBrowser/phase0.ts` and `app/e2e/tabBrowser/acceptance.ts` — Electron-driven checks with artifacts under `$AMBER_FAST`.
- `app/scripts/verify-tab-browser-host.sh` — private-run wrapper with path guards and cleanup.

## 4. Phase 0 — mandatory prototypes and stop gates

Phase 0 may add prototype tests/harness code but no production BrowserHost behavior, schema writer, migration, or package dependency commit. Keep prototype artifacts under `$AMBER_FAST/phase0`; record exact Electron, Chromium, Node, OS, display server, and candidate Playwright versions in `.reports/tab-browser-phase0.md`.

### 4.1 Gate A: sandbox and profile

Write the hostile fixture and assertions first. Create a standalone `WebContentsView` with the intended production preferences and resolved existing Amber partition.

Prove on Linux and macOS:

- `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true`, `webSecurity:true`;
- no preload, Node globals, Electron APIs, page-accessible IPC, or Amber bridges;
- sandboxed process state and expected renderer process model;
- request and check permission handlers both deny every unsupported permission;
- HTTP(S)/exact `about:blank` policy and redirect/frame/popup/external-scheme denial;
- compatibility mode refuses browser creation rather than weakening the page;
- existing `persist:amber-browser` opens without profile loss/corruption under the hardened handlers, or a documented migration to a fallback profile is required.

**Stop:** any supported launch mode requires relaxing these settings; profile opening corrupts data without a safe migration; or a remote page reaches privileged APIs.

### 4.2 Gate B: Playwright/CDP confinement and target mapping

Use exact Electron `43.1.0` and test candidate `playwright-core` versions from a `/tmp` prototype install. Do not download Playwright Chromium. First attempt loopback CDP; include a hostile page and a second same-user process.

Prove:

- random endpoint binds only loopback on IPv4/IPv6 as intended;
- endpoint details do not enter page APIs, renderer IPC, logs, argv visible to child pages, or model output;
- a hostile page cannot discover/connect to the endpoint;
- broker-side target filtering can map each `WebContentsView` target by DevTools target ID through navigation and detach/reattach;
- Amber host renderer, DevTools, service workers, unrelated targets, and another tab's page cannot be enumerated or controlled through the adapter;
- locator actionability, accessibility snapshot, screenshot, console, network metadata, dialogs, upload/download hooks, frame handling, and viewport work;
- opening DevTools does not remap or expose the wrong target.

If broad same-user CDP reach or reliable target confinement fails, repeat the same adapter contract over `webContents.debugger` and select it. Raw debugger commands stay private to that module.

**Stop:** neither adapter can provide the required safe bounded tool surface; target identity can cross browser records; or the Amber renderer is reachable.

### 4.3 Gate C: native geometry, occlusion, and physical input

Build a minimal rail shell with the native child view. Test real hardware/display sessions, not only synthetic DOM dispatch:

- pointer, wheel, keyboard, key repeat, IME composition, drag/drop, selection, and context menu;
- focus entry/exit and Amber reserved shortcut behavior;
- accessibility traversal between rail chrome and page;
- window move, negative monitor coordinates, device-scale-factor change, multi-monitor transfer, resize, maximize, fullscreen, tab switch, collapse, and rapid out-of-order geometry revisions;
- renderer overlays, menus, approval modal, sheets, and window close never sit behind a still-visible child view;
- detach/reparent/reopen preserves the page and does not leak child contents.

**Stop:** geometry or occlusion cannot be made deterministic on Linux and macOS, physical input/IME is unusable, or accessibility has no acceptable focus path.

### 4.4 Gate D: resident singleton and launcher

Prototype existing single-instance behavior before changing `window-all-closed`:

- last-window close leaves exactly one resident main owner;
- second app launch reopens the local window in that owner;
- `--browser-host` converges on the same owner;
- tray/menu reopen and explicit Quit are distinguishable;
- packaged executable identity can be registered/repaired without shell interpolation;
- explicit Quit inhibit blocks Pi auto-start, while normal launch/Enable clears it;
- stale socket/token/readiness files recover safely;
- compatibility mode and Windows fail closed.

**Stop:** launchers create competing owners, close leaves an unrecoverable process, packaged path repair is unsafe, or explicit stop cannot be honored durably.

### 4.5 Gate E: two-store crash matrix

Write a pure fault-injection prototype around layout/state files. Crash after every journal, temp write, fsync, rename, CAS-conflict, and journal-clear boundary. On next load prove each browser URL/association is either committed, rolled back, or present in durable recovery—never silently lost or duplicated.

**Stop:** any crash point loses the only safe URL, associates one browser to two tabs, deletes a record before grace, or rewrites an unknown future layout.

### 4.6 Phase-0 decision record

Commit the report only after all gates pass. It must name the selected adapter and exact Playwright version, profile partition decision, platform evidence, known limitations, measurements, and every command. Architecture and security reviewers must approve the report before Milestone 1.

Suggested commit:

```text
test: prove tab browser host substrate
```

## 5. Milestone 1 — Rust layout-v2 reader first

This milestone must ship before any TypeScript writer emits layout v2.

### RED

Add `mosaic.rs` fixtures/tests for:

- current v1 layout;
- v2 with `TabLayout.browser`, `browserRevision`, editors, frozen state, labels, tab order, and split ratios;
- v2 containing app-local/private browser metadata that never appears in mosaic JSON;
- malformed v2 fallback;
- unknown future version fallback without write;
- equal-split reconstruction when the sidecar is absent.

Run the focused test from `/tmp` and observe the v2 fixture fail before implementation:

```bash
cd "$REPO"
CARGO_TARGET_DIR="$CARGO_TARGET_DIR" cargo test -p amber --lib mosaic -- --nocapture
```

### GREEN

Update only the Rust read model/version handling required to preserve existing mosaic output. Keep it read-only and session-list-pruned. Do not add browser daemon protocol or browser profile fields.

### REVIEW / COMMIT

Review for core rule 3, serde unknown-field behavior, privacy, and backwards compatibility.

```text
feat(web): read layout v2 sidecars
```

## 6. Milestone 2 — strict shared models, migration, and workspace v2

### RED

Add tests before implementation:

- `browserName.test.ts`: cryptographic opaque IDs, exact grammar, bounded length, legacy IDs accepted only by migration.
- `browserProtocol.test.ts`: every union member, unknown keys/version, frame/result limits, cancellation ownership, sequence/high-water replay behavior, incarnation/generation requirements.
- `browserPolicy.test.ts`: scheme/redirect policy, user-info/fragment/credential-query redaction, non-restorable fallback, password/card/header redaction, approval digest stability.
- `browserState.test.ts`: per-record corruption tolerance, file caps, duplicate IDs, recovery cap, orphan grace, unknown future versions.
- `browserLayout.test.ts`: one rail per tab, legacy leaf collapse, browser-only tab, deterministic first browser, extra recovery, stale coordinate IDs, idempotence.
- extend `layoutFile.test.ts`: v1 read, in-memory migration, v2 write/read, `browserRevision`, unknown future no rewrite, web-writer merge preservation.
- extend `workspaceFile.test.ts`: complete v1/v2 compatibility, `WsBrowserV2`, duplicate browser rejection/recovery, placeholder/tree invariants, no share/controller/credentials, size/depth caps.

Run focused tests and retain the expected failures in the milestone notes:

```bash
cd "$REPO/app"
npx vitest run src/shared/browserName.test.ts src/shared/browserProtocol.test.ts \
  src/shared/browserPolicy.test.ts src/shared/browserState.test.ts \
  src/shared/browserLayout.test.ts src/shared/layoutFile.test.ts \
  src/shared/workspaceFile.test.ts
```

### GREEN

Implement strict parsers and pure migrations. `parseLayout` reads v1/v2; only `serializeLayout` emits v2. Keep `LayoutFile.browsers` represented only inside the v1 input/migration type, not the v2 application model. Replace browser `SavePane` encoding with `WsTabV2.browser`; v1 remains readable.

Do not turn on v2 saves in `main.tsx` yet. No main-owned browser page exists in this milestone.

### REVIEW / COMMIT

Review migration information preservation, URL redaction, schema limits, and TypeScript exhaustive unions.

```text
feat(app): define tab browser persistence models
```

## 7. Milestone 3 — crash-safe stores and association transactions

### RED

Add `browserStateStore.test.ts` and `browserTransaction.test.ts` with temp directories under `/tmp`:

- private token/state file mode and symlink/reparse rejection where supported;
- unique temp, file fsync, rename, parent fsync;
- malformed record isolation and hard file/record caps;
- v1 backup before migration;
- fault after each two-store step;
- layout CAS conflict;
- base/remote/local merge preserving browser fields;
- startup replay and rollback;
- duplicate association recovery;
- missing record recovery;
- orphan retained for 24 hours and two matching commits;
- recovery attach/copy/delete writes;
- safe URL is the only durable navigation value.

Observe failure before adding the modules.

### GREEN

Implement `BrowserStateStore` and `BrowserTransactionCoordinator`. Reuse `loadLayoutFile`/`saveLayoutFile` CAS, but do not weaken its content-token semantics. Browser association commands go through the coordinator; ordinary renderer layout writes continue through the existing merge chain and preserve `browserRevision`/tab browser fields.

Add deterministic injected clock/ID/fsync/fault seams—no production fault flags. Recovery diagnostics are bounded structured values suitable for UI, without raw secrets.

### REVIEW / COMMIT

Concurrency/persistence review must walk the complete crash matrix and two concurrent layout writers.

```text
feat(app): persist browser rails transactionally
```

## 8. Milestone 4 — security policy, daemon metadata watcher, and capacity

### RED

Add tests for:

- `browserSecurity`: exact hardened preferences, no preload, permission request/check default deny, allowed URL parser, redirects/frames/popups/external protocols, origin-scoped grants, download/upload path rules, dialog default deny.
- `browserDaemonWatcher`: no Attach/Input/Resize emission; initial full-list requirement; kind/liveness/rename/removal; disconnect/staleness fail closed; reconnect full-list barrier; stale event epoch ignored.
- `browserCapacity`: four-live invariant, deterministic LRU, all protected, FIFO 8/10-second activation queue, cancellation, one pending activation per browser, no background-noise recency.
- `browserRailModel`: width clamps, minimum terminal stage, active-tab visibility, zoom collapse, monotonic geometry, overlay occlusion.
- `renderCompat`: browser host is disabled whenever compat switches are active.

### GREEN

Implement pure policy/state machines, then thin Electron adapters. Install permission handlers before creating any page. The daemon watcher opens one control-only connection and requests detailed sessions/watch events; it never attaches and never exposes a raw daemon command API.

Compile Windows with `browserHostSupported() === false`; do not create a pipe/token/profile or claim readiness there.

### REVIEW / COMMIT

Security review checks navigation at every Electron event, both permission hooks, remote-window denial, compat denial, and metadata staleness. Performance review checks timer cleanup and bounded queues.

```text
feat(app): enforce browser host policy and capacity
```

## 9. Milestone 5 — adapter and BrowserHost runtime

### RED

Against a fake adapter, add `browserHost.test.ts` for:

- create visible-first record;
- attach/detach native view by active sender-derived tab;
- current URL/title/loading runtime events without optimistic React state;
- page incarnation replacement and generation increments for every invalidating event;
- freeze/thaw and truthful restore disclosure;
- adapter disconnect/remap barrier;
- user input generation signal from the proven Phase-0 mechanism;
- protected operation lifecycle;
- crash backoff and Retry state;
- close confirmation and explicit destruction cleanup;
- recovery-item operations;
- no browser in remote windows, web, compat, or Windows gate.

Run the adapter's Phase-0 contract tests against the selected real implementation as an Electron integration test.

### GREEN

Implement the narrow adapter chosen in Phase 0 and `BrowserHost`. Keep Playwright/debugger types private. The host owns each `WebContentsView` after window detach and destroys it only on close/freeze/quit. Bind listeners once and dispose them explicitly.

Persist only safe restore metadata. Current raw URL/title are transient and redacted before any diagnostics/event that can cross to Pi. Batch console/network summaries; cap their rings exactly as specified.

### REVIEW / COMMIT

Architecture review checks native ownership and no terminal path changes. Security review checks target confinement. Leak review checks every Electron listener, adapter object, view, timer, and queue release.

```text
feat(app): own tab browsers in electron main
```

## 10. Milestone 6 — broker, generation semantics, approvals, and tools

### RED

Add broker socket integration tests with a fake host/watcher:

- user-private socket/token and token rotation disconnect;
- token never in argv/env/URL/renderer/log output;
- bounded frame and malformed JSON/union disconnect;
- unsupported version;
- 8 connections, 32 global requests, 16 mutation queue;
- current tab, designated Pi, live kind `pi`, Share, and fresh watcher all required;
- enqueue and pre-dispatch incarnation/generation checks;
- same-controller FIFO and cross-browser bounded concurrency;
- duplicate in-flight join, completed replay, changed-payload reject, evicted-sequence reject;
- cancellation before queue, in adapter, after non-cancellable boundary, and on revoke/controller loss/quit;
- approval digest changes on origin/target/argument/generation/controller changes;
- approval timeout and visible-window requirement;
- consequential action matrix;
- read result bounds and redaction;
- no raw CDP/arbitrary script/target enumeration action;
- first Pi request returns visible creation/share state and performs no hidden navigation.

### GREEN

Implement `browserProtocol`, framed `BrowserBroker`, authorization, queues, cancellation, approval coordinator, and typed tool dispatch. `browser:command` remains the only renderer command route; Pi uses only the local broker.

Status/observation actions may omit expected generation where they explicitly return the current incarnation/generation. Every mutation and element reference requires both. User input remains enabled; disclose that accepted site effects cannot be rolled back.

### REVIEW / COMMIT

Perform independent protocol/concurrency and security/privacy reviews. Mutation-test the pre-dispatch generation check and approval digest fields.

```text
feat(app): broker shared pi browser control
```

## 11. Milestone 7 — renderer rail and removal of browser split panes

### RED

Add pure model tests and Electron component/acceptance assertions for:

- zero/one rail per tab outside the split tree;
- tab-level Open browser action;
- Browser absent from `PANE_KIND_OPTIONS`, split picker, pane menu, drag/move, `+ ws`, load placement, command center pane kinds, and dump filtering;
- empty, creation requested, loading, live, frozen, restored, failed, capacity waiting, and persistence-warning states;
- address/mode/back/forward/reload/collapse/resize;
- controller picker lists only current-tab Pi panes;
- Share off by default and cross-origin global-profile warning;
- revoke immediate state and audit line;
- Pi activity/Stop Pi;
- exact approval display with secret omission;
- destructive close warning for volatile page state;
- recovery surface attach/copy/delete;
- overlay occlusion and geometry revision ordering;
- keyboard divider, focus entry/exit, live-region restraint, reduced motion, contrast/target sizes;
- remote/web/compat/Windows unavailable states.

### GREEN

Implement `BrowserRail` and wire it beside the active tab's terminal stage. Main derives ownership from `event.sender`; geometry payload is data, not authority. BrowserHost events drive runtime display state.

Remove all legacy browser-pane creation/update/move/close branches from `main.tsx`, `SplitView.tsx`, `store.ts`, and `uiModel.ts`. Delete `Browser.tsx`/`webview.d.ts` and old `setWindowOpenHandler` code that existed solely for `<webview>` guests. Keep editor behavior unchanged.

Turn on v2 serialization only after Milestone 1 compatibility is present and the startup migration transaction succeeds. Remote windows remain read-only/unavailable.

### REVIEW / COMMIT

UX/accessibility review uses real native child views, not screenshots of DOM chrome alone. Code review searches every runtime `kind === 'browser'`, `isBrowserName`, `layout.browsers`, and `<webview>` occurrence and classifies/removes it.

```text
feat(app): replace browser panes with tab rails
```

## 12. Milestone 8 — `.amberws`, recovery, and destructive workflows

### RED

Extend workspace and renderer workflow tests:

- v2 save writes one `WsBrowserV2` per tab and no browser pane/tree leaf;
- v1 load migrates first browser and recovers extras;
- new/replace mint IDs and never restore Share/controller;
- replacement retains old records until transaction commit;
- canceled destructive confirmation changes nothing;
- transaction conflict leaves current workspace/browser intact;
- unsafe URL becomes neutral restore plus notice;
- browser-only tabs round-trip;
- restore point/template consumers either preserve v2 browser intent or explicitly omit it according to their documented schema.

### GREEN

Wire save/load to BrowserHost snapshots/transactions. Ensure dump allowlists include daemon panes only; browser rails never request daemon backlog. Update labels and release-facing copy to say browser intent/profile, not exact page continuation.

### REVIEW / COMMIT

Migration/recovery reviewer opens hand-crafted v1/v2 files, malformed boundaries, multi-workspace replace, and rollback artifacts.

```text
feat(app): round-trip tab browsers in workspaces
```

## 13. Milestone 9 — resident lifecycle, launcher, and explicit Quit

### RED

Add state-machine and fake-process tests before changing app lifecycle:

- second-instance activation reopens one local window;
- last-window close detaches views and closes per-window terminal clients/tunnels without stopping BrowserHost;
- tray/menu reopen;
- normal launch clears inhibit, explicit Quit writes it before closing broker;
- Pi ensure respects inhibit and missing/stale app registration;
- app-path registration canonicalizes, validates, atomically repairs after upgrade, and never uses a shell;
- stale PID/socket/token/readiness cleanup cannot kill an unrelated process;
- quit drains in order, denies approvals, cancels queues, flushes transaction, destroys contents, closes watcher/broker, then exits;
- failed flush/timeout presents Cancel/force choice;
- daemon Quit remains separate;
- Windows unsupported and compat unavailable.

Rust tests use a fake executable and readiness socket under `/tmp`; they do not launch the user's app or service manager.

### GREEN

Implement `browserResident.ts`, app registration, tray/menu behavior, and `browser_host_ctl.rs`. Change `window-all-closed` only through this state machine. Add explicit menu actions **Quit Amber IDE** and **Enable browser host** with unambiguous daemon wording.

The Pi ensure helper may launch only the registered canonical executable with separate arguments. It must never start after explicit inhibit or when registration ownership/permissions fail.

### REVIEW / COMMIT

Operational review covers AppImage mount churn/stable installed path, macOS bundle launch, desktop shortcut upgrades, logout, app update, crash, and stale endpoint recovery. Windows code review confirms no partial activation.

```text
feat(app): keep browser host resident after window close
```

```text
feat(cli): launch the registered browser host
```

Use separate app/CLI commits if review or rollback boundaries benefit.

## 14. Milestone 10 — Pi extension packaging and complete tool surface

### RED

Rust installer tests first:

- fresh package install;
- exact owned legacy `amber-hook.ts` migration;
- session-ID hook remains functional;
- unrelated extension files untouched;
- modified/unowned legacy file preserved with actionable warning;
- partial package repair and atomic VERSION update;
- `PI_CODING_AGENT_DIR` handling;
- browser package failure does not prevent Pi launch.

TypeScript/fixture contract tests cover every `browser_*` tool schema and rendering, `AMBER_SESSION` read at execution, Pi session ID attribution, `ctx.signal` cancellation, 50 KB/2,000-line result cap, unavailable outside Amber, and no token in tool output.

### GREEN

Move the owned extension into the package layout and embed each source with `include_str!`. Keep tool actions mapped one-for-one to the strict broker union. Focused query tools return truncation/cursor metadata; screenshots use bounded temporary artifacts with cleanup.

Sensitive advanced operations remain separately approved or unavailable. Do not add arbitrary JavaScript, Playwright programs, raw CDP, cookie/storage dumps, or broad filesystem browsing.

### REVIEW / COMMIT

Review generated installed files as executable code, not just Rust strings. Run fake Pi fresh/start/crash/resume tests to ensure the existing exact-session hook did not regress.

```text
feat(pi): install shared browser tools
```

## 15. Milestone 11 — packaging, feature rollout, and docs

### Dependencies and bundling

After Phase 0 selects an adapter:

- change Electron from `^43.1.0` to exact `43.1.0`;
- if Playwright wins, add the exact proven `playwright-core` version to production `dependencies` with `--save-exact`;
- keep `PLAYWRIGHT_BROWSERS_PATH=0` and verify no browser download/postinstall artifact;
- if debugger wins, add no Playwright dependency;
- ensure electron-vite does not externalize a runtime dependency that the packaged app cannot resolve;
- inspect AppImage/dmg contents for the adapter, Pi assets, and both Amber binaries;
- record package-size delta, license, idle resident RSS/CPU, and four-live RSS.

### Feature gates

Use one internal gate during development. Before default enablement, require Phase-0 evidence and full acceptance on both macOS and Linux. Windows must render a clear unavailable state and must not create browser socket/token/profile/state files.

Do not retain a production `<webview>` fallback. Rollback disables the rail, preserves `browser-state.json`, v1 backup, v2 layout, and recovery report, and offers safe URLs; it never downgrades/re-writes v2 as v1.

### Documentation

Update:

- `CLAUDE.md` build-status entry and narrow exception cross-reference;
- release notes/help text for close-versus-Quit, global Amber profile, Share boundary, four-live renderer meaning, and restore limitations;
- packaged install/upgrade notes for stable app registration and inhibit;
- supported-platform notes and Windows gate;
- `.reports/tab-browser-host.md` with commands, screenshots, process/memory samples, crash matrix, and manual results.

Suggested commit:

```text
build(app): package the tab browser host
```

```text
docs: record tab browser host verification
```

## 16. Validation gates

Run focused tests after each RED/GREEN cycle, then the full gates from the `/tmp` worktree:

```bash
cd "$REPO"
CARGO_TARGET_DIR="$CARGO_TARGET_DIR" cargo test --workspace --all-targets
CARGO_TARGET_DIR="$CARGO_TARGET_DIR" cargo clippy --workspace --all-targets -- -D warnings

cd "$REPO/app"
npm test
npm run typecheck
npm run build
npm run build:web
```

Then package on each target platform using only `/tmp` outputs. On Linux:

```bash
cd "$REPO/app"
AMBER_DIST_DIR="$AMBER_FAST/dist" npm run package
```

Use the repository's actual packaging variable/script if `AMBER_DIST_DIR` is not supported; first inspect and redirect its output/cache to `$AMBER_FAST`. Do not run a package command that writes to `/home`.

Required automated assertions:

- Rust v1/v2 mosaic compatibility;
- all shared/parser/policy/state-machine tests;
- fault-injected transaction crash matrix;
- broker malformed/auth/replay/cancel/approval tests;
- adapter target-confinement contract;
- Electron fixture acceptance;
- exact dependency/lockfile and no second Chromium;
- web build remains browser-host-unmanaged;
- Windows compile/typecheck with unavailable gate;
- `git diff --check` and no staged files at each review handoff.

Rustfmt remains scoped: format touched Rust files only. Do not bulk-reformat pre-existing drift.

## 17. Electron manual acceptance matrix

Run with a private daemon/state/profile. Save artifacts under `$AMBER_FAST/manual/<platform>`.

### Product and migration

1. Start from a copied v1 layout containing a normal browser leaf, browser-only tab, and two legacy browsers in one tab.
2. Launch; verify deterministic promotion, split collapse, browser-only tab preservation, and visible durable recovery for the extra URL.
3. Verify Browser no longer appears in any pane/split/new-workspace picker.
4. Open one rail from the tab action and one from a Pi request; Pi creation must reveal the GUI before navigation.
5. Save/load v2 `.amberws`; inspect JSON for no credentials/share/controller and no browser tree leaf.

### Sharing and concurrency

1. Put two Pi panes in one tab; designate one and enable Share after reading the cross-origin/global-profile warning.
2. Verify the other Pi, a Pi in another tab, a stale renamed Pi, and a non-Pi session are denied.
3. Take a snapshot, type/click physically as the user, and verify the stale Pi action rejects.
4. Race user input with a dispatched benign Pi action; verify no host crash and honest final generation/result.
5. Queue mutations, Stop Pi, revoke sharing, and verify queued/cancellable work stops and pending approval disappears.
6. Attempt a form submit, password submission, download/upload, permission, and external protocol; verify exact approval, timeout, and secret redaction.

### Native surface

1. Move/resize/maximize/fullscreen across monitors and scale factors; inspect exact bounds and stale revision rejection.
2. Switch/collapse/zoom tabs quickly; only the active rail is visible.
3. Open every Amber overlay/menu/dialog over the rail; native content must be detached/occluded.
4. Exercise physical keyboard, IME composition, mouse, wheel, drag/drop, selection, context menu, accessibility traversal, and focus shortcuts on Linux and macOS.
5. Verify remote SSH window, Pocket/web, compatibility mode, and Windows gate cannot host a local rail.

### Lifecycle and persistence

1. Log into a fixture site in one tab and verify the same dedicated Amber profile in another tab only after explicit sharing for Pi.
2. Close every GUI window; verify the page/Pi tool remains alive, terminal utility clients/tunnels are not leaked, and resident CPU settles.
3. Launch Amber again; verify one resident owner and the window reopens on the same pages.
4. Explicit Quit during load, approval, and queued action; test Cancel and Quit anyway. Verify socket/process/view cleanup and inhibit.
5. Invoke Pi tool after Quit; ensure refuses to auto-start. Normal launch clears inhibit; `ensure` then reaches readiness.
6. Kill the private app process to simulate crash; relaunch and verify safe URL/profile/viewport restore plus truthful reloaded wording, not exact continuation.
7. Inject state-write failure and each crash-matrix point; verify persistent warning/recovery and no silent URL loss.
8. Open five browsers; verify eligible LRU freeze, protected-page queue, timeout, and thaw disclosure. Sample browser-record renderer count, OS process count, RSS, CPU, and profile disk use separately.
9. Clear Amber browser data with confirmation and verify only the dedicated Amber partition is affected.

### Development tools

Against local fixtures, exercise navigation/history/reload/waits, accessibility snapshot/find, inspect DOM/CSS, screenshot, console, failed network, click/hover/fill/type/press/select/check/scroll/drag, viewport, iframe, denied popup, and adapter reconnect. Verify truncation/cursors and no raw auth/cookie/password data.

## 18. Review checkpoints

Do not combine these into one final glance:

1. **After Phase 0:** architecture + Electron security reviewers approve substrate and adapter choice.
2. **After Milestones 1–3:** persistence/migration reviewer approves Rust-first rollout and crash matrix.
3. **After Milestones 4–6:** security/privacy + concurrency reviewers approve policy, watcher freshness, broker protocol, replay, cancellation, and approvals.
4. **After Milestones 7–8:** product/UX/accessibility reviewer approves native rail behavior, migration/recovery, and workspace files.
5. **After Milestones 9–10:** operability/packaging reviewer approves resident lifecycle, inhibit, launcher, extension ownership, and platform gates.
6. **Before default enablement:** performance/leak review and independent full-diff correctness review; rerun tests after every valid finding fix.

At each checkpoint record findings and disposition in `.reports/tab-browser-host.md`. Any unresolved high-severity finding blocks the next phase.

## 19. Rollback and recovery

Rollback is feature disablement, not schema downgrade:

1. Stop accepting new browser commands and drain safely.
2. Leave `ui-layout.json` v2, `browser-state.json`, profile, v1 backup, journal, and recovery entries intact.
3. Show browser rails unavailable plus copy-safe-URL/recovery guidance.
4. Do not restore `<webview>`, recreate legacy split leaves, or write v1.
5. A fixed forward version replays the journal and re-enables records.
6. If a package downgrade cannot read v2, release notes instruct users to retain files and upgrade; no automatic destructive conversion.
7. If the selected adapter alone regresses, disable automation while preserving user browsing only if the hardened `WebContentsView` substrate itself still passes. Otherwise disable the entire host.
8. Explicit Quit inhibit remains honored across rollback and upgrades.

## 20. Stop conditions during implementation

Stop and return to design/review rather than patching around any of these:

- a remote page needs privileged preload/Node/IPC or sandbox relaxation;
- compatibility mode would host authenticated remote content;
- Playwright/CDP or debugger cannot confine targets to authorized browser records;
- physical input/IME/accessibility/native geometry fails on Linux or macOS;
- a renderer-supplied window/tab/browser identity must be trusted;
- Pi authorization needs terminal bytes, renderer cache, or stale daemon state;
- a crash point can silently lose the only safe URL or duplicate an association;
- generation/incarnation cannot be checked immediately before dispatch;
- a consequential operation cannot be bound to a precise approval digest;
- the four-live invariant requires killing protected work or unbounded queueing;
- resident singleton, packaged launcher, or explicit-stop inhibit is unreliable;
- Windows cannot be kept completely fail-closed while unsupported;
- the Rust daemon would need browser lifecycle authority;
- tests require the production daemon, default user profile, `/home` build outputs, or service-manager mutation;
- implementation requires a final `<webview>` or detached-window substitute;
- any new product, security, architecture, or scope decision is required beyond the approved design.

## 21. Planned commit sequence

Keep commits conventional, reviewable, and independently green where possible:

1. `test: prove tab browser host substrate`
2. `feat(web): read layout v2 sidecars`
3. `feat(app): define tab browser persistence models`
4. `feat(app): persist browser rails transactionally`
5. `feat(app): enforce browser host policy and capacity`
6. `feat(app): own tab browsers in electron main`
7. `feat(app): broker shared pi browser control`
8. `feat(app): replace browser panes with tab rails`
9. `feat(app): round-trip tab browsers in workspaces`
10. `feat(app): keep browser host resident after window close`
11. `feat(cli): launch the registered browser host`
12. `feat(pi): install shared browser tools`
13. `build(app): package the tab browser host`
14. `docs: record tab browser host verification`

Tests should normally land with the code they drive; the Phase-0 test/report commit is separate because it is a hard decision gate. Never add `Co-Authored-By` trailers. Before every commit run `git diff --check`, inspect staged paths, and ensure no unrelated or generated user-state files are staged.
