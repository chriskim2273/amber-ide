# Tab browser host implementation report

Date: 2026-09-01
Branch: `feat/tab-browser-host`

## Result

This branch implements and Linux-validates the durable main-owned tab-browser foundation, rail UI, persistence, capacity policy, and authenticated Pi observation, navigation, and approval-gated semantic interaction substrate. It does **not** satisfy the full approved product acceptance contract yet. Independent Phase-B re-review, deployed-reader upgrade proof, packaged-artifact gates, and macOS manual gates remain open. Those omissions must block merge of the complete feature.

## Implemented

- Electron 43.1.0 is pinned exactly.
- The app has a feature-gated, main-owned `WebContentsView` browser host with one persistent `persist:amber-browser` profile.
- Browsers are associated one-per-tab through layout v2 rail metadata and have opaque 128-bit IDs.
- Durable runtime state is stored separately in a private atomic `browser-state.json`; safe restore URLs omit query and fragment unconditionally.
- Main owns page lifecycle across renderer window hide/reopen; explicit application quit destroys pages.
- HTTP(S)-only navigation, popup denial, permission denial, download denial, unsafe frame-navigation denial, hardened renderer preferences, and no preload are enforced.
- Four-live-page cap, eligible LRU freezing, thaw, page-incarnation checks, generation checks, and physical-input generation bumps are implemented.
- Desktop rail UI supports reveal/collapse, address navigation, reload, designation of one same-tab Pi pane, explicit sharing confirmation, and resize persistence.
- Legacy browser-pane creation was removed from the picker while transitional legacy renderer/workspace code remains available.
- Rust mosaic parsing accepts layout v2 and structurally ignores browser-private metadata.
- A private, framed, authenticated Unix-socket broker applies strict frame/connection limits, request shape validation, current daemon membership/kind checks, same-tab designation/share authorization, and first-use `open` solicitation semantics.
- The installed Amber-owned Pi extension registers bounded lifecycle/navigation, accessibility snapshot/find/inspect, in-memory screenshot, console/network, wait, history/reload, and viewport tools; it uses no raw CDP API and refuses to overwrite modified/unowned extension files.
- Web-host shims fail explicitly; they do not pretend browser-host support exists.

## Linux evidence

All state, runtime sockets, build output, and live fixtures used `/tmp/amber-tab-browser-validation`.

Phase-0 and later private live tests established:

- hardened `WebContentsView` creation on Electron 43.1.0;
- scoped debugger attach/evaluation and screenshot prototype;
- detach/reattach and BrowserWindow replacement while page identity and content survived;
- private-daemon rail creation and loopback navigation;
- layout/state persistence and safe URL restoration after restart;
- window close followed by single-instance reopen;
- authenticated broker `status` against the real resident host;
- first-use broker `open` creating a tab association and returning `CREATION_AWAITING_USER` without navigating or self-authorizing.

Physical XTest input remained inconclusive on this host because of the host's GPU/window-manager behavior. This is not counted as acceptance evidence.

## Automated gates

- `cargo clippy --workspace --all-targets -- -D warnings`: passed.
- `cargo test -p amber --lib pi::tests -- --nocapture`: 16 passed.
- `npm test`: 63 files passed, 747 tests passed, one intentional real-daemon skip.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm run build:web`: passed.
- Focused browser broker, host, state, layout, service, policy, and shared-model tests passed.
- `git diff --check`: passed at every commit boundary.

## Synthesized-review fix wave (2026-09-01)

A follow-up correctness/security review found the foundation unsafe to extend as-is. The branch now additionally:

- serializes BrowserHost commands and state saves;
- projects top-level navigation/loading/title/crash state from the actual `WebContents` and persists safe restore changes;
- stops active navigation when the broker client disconnects or times out;
- bounds broker buffered frames, per-connection queue depth, global in-flight work, request time, socket idle time, replayed request IDs, and server shutdown;
- strictly parses opaque IDs, exact command keys, URL/incarnation/generation sizes, and native-view bounds;
- protects the visible renderer from LRU eviction and guarantees only one native browser view is attached visibly;
- makes collapse functional and sizes `WebContentsView` to a dedicated DOM slot so errors/chrome are not covered by native content;
- adds a shared Node/Rust lock around layout content-CAS so simultaneous cross-process writers cannot both commit;
- marks unknown future layout files read-only through renderer and main save paths;
- adds journaled, idempotent legacy migration, trusts sidecar coordinates over stale encoded IDs, retains bounded migration recovery, and restores persisted `live` records honestly as frozen;
- rolls back a newly-created broker browser if its association CAS conflicts;
- refreshes a full daemon session list every two seconds and rejects Pi authorization after five seconds without a full list;
- drains all PTY pane subscriptions when the resident window is hidden while retaining the metadata control connection.

The layout-v2 deployed-reader barrier is now enforced in code: browser hosting requires both `AMBER_TAB_BROWSER_HOST=1` and `AMBER_TAB_BROWSER_V2_READER_DEPLOYED=1`. The second variable must not be set in production until the real upgrade-channel proof exists.

The exact continuation contract is machine-readable in `.reports/tab-browser-host-remaining.json`. The feature remains **not merge-ready**.

Later bounded tranches closed the association/state race and broker ordering contract: `TabBrowserStateStore.withLock` now holds one owner across journal write, layout CAS, and journal clear, so asynchronous BrowserHost saves queue behind it; ordinary association writes, startup replay, and orphan grace use that path. Broker envelopes now carry `clientInstanceId` plus monotonic `sequence`; a bounded digest-keyed result cache replays identical requests, rejects changed payloads and evicted sequences, and per-controller queues preserve mutation/observation order. Disconnect and timeout abort only work owned by that connection.

The capacity tranche now uses one global FIFO with eight entries, one waiter per browser, a deterministic ten-second deadline, cancellation, and independent visible/operation/approval protection. Runtime status exposes capacity waiting to the rail. Workspace files now write v2 tab-owned browser intent, migrate v1 placeholders deterministically, retain extra browser URLs as bounded recovery, mint collision-checked opaque IDs, reset Share/controller authority, import records before destructive work, and preserve the current workspace when import validation fails. Committed association removal closes replaced BrowserHost records only after the layout transaction succeeds. The legacy renderer `<webview>` pane and its runtime creation/move/close branches were removed after the v1/v2 round-trip suite passed.

The first independent implementation gate failed and every valid finding was addressed in the following fix wave. Renderer workspace projection now unions browser-only layout tabs and has a save→parse→load integration round-trip. Workspace replacement sends the complete staged plan to main; main validates fresh browser authority, journals state resources plus layout under one lock, rolls back state on CAS failure, and only returns to the renderer to kill old sessions after commit. Renderer layout saves are structurally compared and cannot add/remove/move/share/designate browsers regardless of `browserRevision`; sender-derived main commands own those changes. Global service serialization was replaced by per-browser queues while opens reach the capacity FIFO concurrently. BrowserHost events reach the rail, thaw stays protected through restore load, runtime persistence uses locked read-modify-write, browser snapshot failure aborts save, and bounded recovery now has list/attach/copy/delete UI and IPC. Obsolete browser-pane helpers and CSS were deleted; legacy browser shapes remain decode-only in migration/workspace parsing.

The independent re-review then found eight remaining integration gaps. The second fix wave adds an acknowledged `browser:set-context` IPC; every renderer browser operation refreshes that sender-derived workspace/tab context, tab switches cancel the previous browser's queued activation in main, and show/thaw revalidates the association after capacity admission but before page creation or attachment. Workspace import now sends only the original portable `.amberws` source plus mode: main parses it, derives all destination workspace/tab/id choices from `WindowCtx`, and prepares/commits the complete tree/editor/frozen/browser sidecar. Terminal/editor-only imports run through the same production helper without requiring BrowserHost; imports that add/remove browser resources journal those resources and the complete sidecar together. Runtime persistence now applies explicit record and recovery deltas against a synchronized baseline rather than replacing a stale host snapshot. Recovery deletion has a real store→service-restart test. Workspace save validates that every selected rail ID has a host snapshot. The live browser-pane save fallback, runtime filtering/tests, CSS selectors, transitional `LoadPlan.browsers`, and stale comments were removed; only explicit v1 parsers/migration retain browser-pane shapes.

The final reviewer verdict was PASS WITH FIXES and identified one remaining dispatch-time race. The final fix centralizes validation immediately before every `TabBrowserService` dispatch, so already-live `show` and queued `navigate`/`bounds` cannot execute on an authorization snapshot taken before another per-browser command. Host `open` also validates again after capacity admission and removes its provisional record on cancellation/staleness; the removal emits a persistence change so a capacity-wait event cannot leave the provisional record on disk. Renderer `WindowCtx` leases carry a monotonic generation, stale completions cannot overwrite the current context, and a newly committed stale association is CAS-rolled back with bounded retries before its BrowserHost record is destroyed. Broker navigation supplies the same fresh daemon/layout validator; broker solicitation open validates before and after capacity, before association, and after association. Production service tests cover an already-live show after context switch, a navigate waiting behind a serialized command, and a capacity-waiting open whose provisional in-memory and persisted records are both removed after a switch.

The subsequent P1 confirmation found two final compensation gaps. `BrowserCapacity` now tracks each queued admission as a provisional transaction: rollback removes the candidate and restores the full selected victim entry only until Host marks that victim actually frozen; after that boundary rollback never invents a live renderer for a destroyed page. Open and thaw use this API across validation, cancellation, and page-factory failures. A rejected open explicitly awaits the persistence queue, so provisional records written by capacity-wait events are deleted on disk before rejection. The regression asserts exact live membership restoration, immediate persisted cleanup without a test-only flush, and a successful next open. Broker attached actions now route through one dispatcher: `stop`, like `navigate`, always carries the request AbortSignal and fresh daemon/layout authorization into the service queue; only read-only `status` remains an intentional validator-free early return. A queued-stop regression proves lost authorization prevents `page.stop()`.

A subsequent final-gate fix slice also closes three concrete bypasses: `.amberws` browser URLs are normalized through the same HTTP(S)/safe-restore policy on parse, save, and load planning; controller authorization now requires a live `kind:pi` daemon session that is not in `shell-fallback`; and page creation uses the persisted profile descriptor partition rather than a constructor default.

## Review-fix validation

- App: 64 files passed, 762 tests passed, one intentional real-daemon skip.
- App strict typecheck: passed.
- Electron production bundle and web production bundle: passed.
- Rust warnings-as-errors clippy: passed.
- Rust layout-CAS focused suite: 8 passed.
- Full Rust all-target run reached 436/437 library tests, with unrelated pre-existing timing test `manager::tests::automatic_pressure_suspend_rechecks_liveness_under_the_transition_lock` failing once with `ESRCH`; immediate isolated rerun passed. This is recorded as a flaky full gate, not claimed green.
- All commands used `/tmp/amber-ide-tab-browser-host` and `/tmp/amber-tab-browser-validation`; no production daemon command was issued.

## Pi observation/navigation substrate (phase A)

The selected `webContents.debugger` adapter is now production-wired behind a narrow typed interface. Its command set is fixed: accessibility-tree capture, allowlisted DOM description/box geometry, screenshot, emulated viewport, and console/network event domains. It exposes no generic debugger method, runtime evaluation, response body, cookie, storage, request-header, or filesystem-path capability. Snapshot references are opaque and scoped to browser ID, page incarnation, generation, and snapshot ID; every queued action revalidates daemon/layout authority immediately before service dispatch, and Host rejects stale results after asynchronous work. Snapshot, text, node, ring, wait, viewport, frame, and image bounds follow the design limits. Console/network output removes URL credentials/query/fragment and common credential canaries, while the report still treats page-rendered text and pixels as potentially sensitive.

Screenshots cross the local broker as a JSON metadata frame followed by a bounded raw binary frame. The Pi extension converts those bytes only at its typed image-result boundary; no screenshot path or JSON numeric byte array exists. The installed extension schemas cover status/open/navigate, snapshot/find/inspect/screenshot, console/network, wait, reload/back/forward, and viewport. Focused security tests pin unknown-key rejection, safe regex restrictions, scoped-reference staleness, attribute allowlisting, binary framing, cancellation, FIFO ordering, dispatch-time authority, and absence of generic sensitive automation methods.

Phase A deliberately does not implement element interaction or approvals. `.reports/tab-browser-host-remaining.json` therefore marks `P1-pi-tools-and-approvals` partial, not complete, and `mergeReady` remains false.

Phase-A automated evidence before independent review: 812 app tests passed with one intentional real-daemon skip; focused browser tests passed 50/50; strict app typecheck, Electron build, hosted-web build, and workspace warnings-as-errors clippy passed; Pi extension installer tests passed 18/18 under the focused Cargo filter.

## Independent Phase-A review — remediation complete, re-review pending

The independent gate failed with six valid findings. The first remediation replaced `Accessibility.getFullAXTree` with fixed `//*` DOM search pages of 32 IDs and one-node partial AX reads, stopping before snapshot-map insertion at scan, raw-input, node, and output-byte budgets. Hostile million-node and 600 KB accessible-name fixtures prove bounded accumulation. Encoded PNG dimensions are validated independently of caller clip dimensions, viewport/content geometry is preflighted, and target-plus-full-page ambiguity is rejected.

The five ordered follow-up findings are now remediated:

1. Every asynchronous attached broker action revalidates Share, designation, live Pi controller, association, incarnation, and generation after completion. A 100 ms authority poll aborts in-flight work when authority disappears, replay-cache responses also reauthorize, and stale results are suppressed as `STALE_BROWSER_CONTEXT`. Race tests cover Share-off, designation change, association replacement, controller loss, and active cancellation.
2. BrowserHost owns reload/back/forward generation changes. A pending-navigation marker consumes the corresponding synchronous or asynchronous production navigation-start event, while rejected/no-history back and forward operations do not advance generation. Commit, load-stop, and crash clear stale markers.
3. Every Pi model-visible browser result starts with a fixed `UNTRUSTED BROWSER CONTENT` warning. Text truncation preserves that prefix within the 2,000-line/50,000-byte envelope, and screenshot metadata plus typed Pi image results carry the fixed `untrusted-browser-content` classification.
4. Console/network rings now compute loss from the requested cursor against the currently retained cursor range, without double-counting historical evictions. Oversized rejected entries still consume a cursor position; tests cover retained, stale, future, and oversized-entry gaps. Cursor parsing also rejects values beyond JavaScript's safe integer range.
5. `npm run test:pi-browser-extension` installs the exact extension from the newly built Amber binary into a private temporary Pi agent root, proves idempotent byte identity, compiles it against the supported Pi/TypeBox/Node modules, loads it through Pi's production extension loader, verifies all 15 registered tools, and executes labeled text and binary-image tool results through a temporary framed Unix-socket broker.

Post-remediation full `/tmp`-only gates passed: app 821 tests with one intentional real-daemon skip; strict typecheck; Electron and hosted-web production builds; Rust all-target workspace tests 781 passed with one intentional delegated-cgroup ignore; workspace all-target warnings-as-errors clippy; exact generated Pi extension install/compile/runtime-load; and `git diff --check`. Build output stayed under `/tmp/amber-tab-browser-validation`. No production daemon was contacted.

The first Phase-A re-review found one additional P1: the bounded XPath only selected elements, so ordinary DOM text whose accessibility projection is `StaticText` could be absent. The remediation keeps incremental traversal and adds text nodes through a fixed XPath union. It excludes whitespace-only nodes and script/style/noscript/template subtrees before search results are returned; CSS-, `hidden`-, and ARIA-hidden text is discarded through the ignored AX projection. `DOM.getDocument(depth:0)` now establishes valid frontend node IDs before search (a real Electron 43 probe otherwise returned zero IDs). Each text/element candidate still uses one `DOM.describeNode` and one `Accessibility.getPartialAXTree(fetchRelatives:false)` call, with the same scan/depth/input/output limits. AX identities are SHA-256-deduplicated without retaining attacker-sized IDs, and references remain sequential snapshot-scoped opaque IDs.

The production-shaped regression projects `<p>Ready</p>` as one `StaticText` node, proves `browser_wait` text succeeds, suppresses hidden text and duplicate AX nodes, and asserts the XPath exclusions. Hostile million-wide, over-depth, 600 KB partial-AX, and 600 KB document-root fixtures pin scan, depth, input, and output bounds. A no-daemon Electron 43/CDP probe under Xvfb confirmed the fixed XPath returns the real `P` plus `#text → StaticText "Ready"`, excludes script/style and whitespace text from search, and marks hidden/form text ignored.

Post-P1 full `/tmp` gates passed: app 822 tests with one intentional real-daemon skip; strict typecheck; Electron and hosted-web builds; Rust all-target workspace tests 781 passed with one intentional delegated-cgroup ignore; warnings-as-errors workspace clippy; exact Pi extension install/compile/production-loader/runtime verification; and diff checks. No production daemon was contacted.

Phase A's final finding was remediated before Phase B began.

## Pi semantic interactions and approvals (phase B; independently accepted)

Phase B adds typed click, double-click, hover, fill, type, press, single-value native select, check, uncheck, scroll, and drag operations. Targets are either opaque snapshot references or bounded exact role/name locators. Every operation resolves to one current target, compares the current semantic fingerprint, rejects hidden/disabled/non-actionable or operation-incompatible nodes, and dispatches only fixed DOM/CSS/Accessibility/Input commands. There is still no raw CDP method, arbitrary JavaScript, response-body, cookie/storage, unrestricted-header, file-upload path, or filesystem screenshot surface.

Consequential classification covers credential fields, payment, destructive actions, external communication, file-transfer controls, form submission, and confirmation-like actions. A visible main-owned approval coordinator binds request/controller/browser/page-incarnation/generation/origin/action/target fingerprint/value category/value digest/expiry into a SHA-256 digest. It supports exact approve-once/reject and only safe category-scoped temporary origin grants; credentials, payments, destructive actions, communication, file transfer, and generic submission cannot be granted. Approval events omit secret values, explicitly label target content untrusted, occlude the native page, fail closed without a visible window, expire, and are invalidated by navigation, page-input generation changes, Share revoke, designation/controller loss, close, or Stop Pi.

Irreversible dispatch increments generation and invalidates snapshots before input. Cancellation before dispatch reports ordinary cancellation; cancellation, generation change, or authority loss after dispatch reports a stable `*_NO_ROLLBACK` error. Broker replay identity is a SHA-256 digest rather than retained request JSON, so credential text is not parked in the replay cache. Controller-scoped Stop Pi cancels active and queued broker work, rejects pending approvals, clears temporary grants, and increments page generation. JavaScript dialogs are dismissed fail-closed and only bounded redacted metadata reaches the user callback.

The installed Amber-owned Pi extension is version 4 and registers 26 tools through strict TypeBox schemas. The production-loader check installs the exact generated bytes from the built Amber binary into a private Pi root, compiles and loads them through Pi, and exercises both ordinary labeled output and binary image output.

Phase-B `/tmp` gates: 838 app tests passed with one intentional real-daemon skip; focused Phase-B browser tests passed 76/76 before the full run; strict typecheck, Electron production build, hosted-web production build, 779 Rust tests with one intentional delegated-cgroup ignore, workspace all-target warnings-as-errors clippy, exact generated extension verification, and diff checks passed. No production daemon was contacted.

The first independent Phase-B review failed with valid P1/P2 findings. Commits `896ba3a` and `d5eed37` remediate them:

- every pointer-bearing interaction recomputes actionability, geometry, and fingerprint, checks a bounded visual viewport, and uses bounded `DOM.getNodeForLocation` immediately before dispatch; only the exact target or a descendant reached through a 32-node parent walk is accepted, while overlays and off-viewport centers fail closed;
- drag source and destination have independent current fingerprints, both enter the approval digest, and both are revalidated; bounded ancestor-form action/method metadata and conservative button/destination semantics classify drag-to-delete, JavaScript-style role buttons, send/save/submit, and destructive destinations;
- approval availability is tied to an exact visible, expanded, local window context for the owning browser; collapsed/background requests trigger a main-derived workspace/tab/browser reveal and fail immediately so Pi must retry only after that surface is renderable; resolution and temporary grants also recheck that exact surface, and the native view is physically detached while an approval is visible;
- alert/confirm/prompt/beforeunload now use a browser-scoped 60-second dialog coordinator with exact digests, bounded/redacted message metadata, bounded prompt responses, visible UI, expiry, revoke/close/crash cancellation, headless fail-closed behavior, and native-view occlusion; approved actions no longer cause unconditional dialog denial;
- broker high-water identities are retained for the host epoch, unseen identities are refused once the 1,024-client bound is reached, and result cache entries carry acceptance timestamps with five-minute expiry while sequence tombstones continue preventing re-execution;
- approvals use the required 60-second lifetime with a 250 ms live countdown, and Pi actions emit secret-free started/completed/failed lifecycle events plus last-action rail status for semantic, navigation, and stop actions.

Post-remediation `/tmp` gates: 850 app tests passed with one intentional real-daemon skip; focused review tests passed 87/87; strict typecheck, Electron and hosted-web production builds, 779 Rust tests with one intentional delegated-cgroup ignore, workspace all-target warnings-as-errors clippy, generated Pi extension install/compile/production-loader verification, and diff checks passed. No production daemon was contacted.

The first independent review correctly failed this wave and led to the remediation below. Final acceptance is recorded after the second remediation.

## Second Phase-B re-review remediation and acceptance (2026-09-02)

The next independent review found three additional integration failures. This remediation closes them without weakening the merge gate:

- Browser surface authority is now acknowledged rather than inferred from a lagging sidecar write. Every renderer context update carries the current collapsed state; main resets `activeBrowserExpanded` on every context/show/hide transition and sets it true only after an associated `show` succeeds. The approval boundary additionally requires the Host runtime to report that exact page visible. Collapse, tab switch, and direct hide synchronously invalidate approvals/dialogs and abort owned Pi work, while reveal still fails the triggering request and requires a retry after the exact workspace/tab/browser has mounted and acknowledged `show`.
- Pending dialogs now bind browser ID, page incarnation, generation, request owner, owner AbortSignal, and expiry into their lifecycle and digest. Resolution rechecks exact identity plus surface visibility. Cancellation/disconnect, Stop Pi, navigation/stop intent, generation or incarnation advance, collapse/tab switch, freeze/crash/close, and controller revocation all dismiss pending dialogs. Interaction execution holds its broker request through the dialog decision/`Page.handleJavaScriptDialog`, and broker navigation now carries request identity while awaiting beforeunload, so disconnect remains a real cancellation owner rather than stale metadata.
- The resident main-process service retains the latest bounded, secret-safe Pi action per browser (maximum 256 browser entries; bounded controller/action/error fields; request IDs and arguments omitted). `status` replays that authoritative summary, so background actions and renderer remounts no longer lose the rail's last-action state. Destroy removes the entry.

Race coverage now includes host-hidden approval refusal, collapse while an approval is pending, dialog owner cancellation, stale-generation dialog resolution, and bounded last-action replay after remount. Post-remediation `/tmp` gates passed: 857 app tests with one intentional real-daemon skip; focused browser review tests 94/94; strict typecheck; Electron and hosted-web production builds; 779 Rust tests with one intentional delegated-cgroup ignore; warnings-as-errors workspace clippy; exact generated Pi extension install/compile/production-loader/runtime verification; and diff checks. No production daemon was contacted.

Independent reviewer run `44ad20dd-20fa-48a6-a244-d964d09a11a1` accepted commit `4bb2adf` with **No issues found** and a **PASS** merge verdict for Phase B. The review explicitly verified collapse/show/hide/reveal authority, dialog ownership and invalidation, resident last-action retention, pointer confinement, conservative classification and dual-endpoint digests, replay high-water tombstones, approvals, and strict Pi schemas. `P1-pi-tools-and-approvals` is therefore completed. Repository merge readiness remains false because the separate external reader/package/platform gates remain open.

## Rail product states (2026-09-02; independently accepted)

The rail now consumes the main-owned Host runtime stream rather than issuing status polls. Runtime updates are authoritative and coalesced through a 256-browser latest-value map on a 16 ms cadence; console warnings/errors and network failures are independently accumulated with hard 10,000 counters and emitted at most every 250 ms, preventing a React update per network event. The local renderer event and direct local command paths carry a bounded raw current URL for the user-visible address bar. Broker status, navigation, and stop results explicitly strip that raw URL and retain only `safeRestoreUrl`, which removes credentials, query, and fragment.

User chrome adds back, forward, reload/stop, explicit Preview/Browse metadata, fixed desktop/tablet/phone presets, strict custom viewport bounds, and a responsive-to-rail mode. Viewport metadata persists and is reapplied when a frozen page is recreated. Focus is explicit: “Focus page” enters the native view, focused state is visible without relying only on color, and Ctrl/Cmd+Shift+B returns focus to Amber chrome from the page. The current page title and security level are visible, while loading, focus, capacity wait, frozen/reloaded state, restore error, console/network issue counts, Share status, and the authoritative latest Pi action are exposed through a restrained live region.

Collapse, terminal zoom, narrow windows, tab/background changes, viewport menus, and visible Amber dialog/menu/overlay surfaces detach the native `WebContentsView`; expansion reattaches only after main receives exact current geometry. The divider supports pointer capture and Left/Right/Home/End keyboard sizing with bounded width and ARIA separator/value metadata. Collapsed and terminal-zoom states remain visibly labeled. SSH remote windows do not create local browser state and instead show explicit copy that browser rails are local-only and remote streaming is unavailable. Recovery is a first-class rail action into the existing recovery surface; approval/dialog cards retain their 60-second countdown, untrusted-content labels, and native-view occlusion.

Focused rail/host/service/automation coverage passed 69/69, including server-rendered accessibility contracts, raw-local/redacted-broker URL separation, command parser bounds, diagnostics batching, Host focus/mode/thaw projection, and runtime event coalescing. Full `/tmp` gates passed: app 868 tests with one intentional real-daemon skip; strict typecheck; Electron and hosted-web production builds; Rust 781 tests with one intentional delegated-cgroup ignore; warnings-as-errors all-target workspace clippy; exact generated Pi extension install/compile/production-loader/runtime verification; JSON validation and diff checks. No production daemon was contacted.

### Independent rail review remediation (2026-09-02; accepted)

The first rail review failed with six valid Important/Minor integration findings. The remediation closes each one without widening the browser authority surface:

- The rail's loading control now builds one exact generation-bearing Stop command that the strict renderer parser accepts. Stop bypasses the per-browser mutation tail so it reaches `webContents.stop()` while navigation is active; Host generation revalidation prevents a late load completion from committing after Stop.
- Reload on a crashed/frozen status now builds `show` with current page-slot bounds instead of silently returning from the live-only helper. Service `show` performs capacity admission, creates a new page incarnation, reloads the durable redacted restore URL, reapplies the viewport, clears a prior crash error only on success, and remains frozen with a stable error if restore fails.
- Electron now projects only main-frame `did-navigate-in-page` events, bounded to 8,192 characters. Host treats SPA/history/hash changes as page-context changes, invalidates snapshots, advances generation exactly once, updates the raw user URL, and durably updates only the sanitized restore URL.
- Navigation policy is centralized in main. Browse permits HTTP(S); Preview permits loopback plus a bounded set of exact origins explicitly selected by trusted renderer navigation or mode change. Broker navigation cannot add an origin or promote to Browse. The same policy gates direct loads, redirects, main-frame navigations, in-page projection, restore, path changes, and mode changes; a policy-escaping committed page is destroyed and frozen rather than displayed.
- `browserViewport.ts` is now the single 200..4096 inclusive integer contract used by renderer validation/responsive clamping, renderer IPC, Pi tool parsing, automation dispatch, Host mutation, state parsing, workspace parsing/staging, and thaw. A disk-save/process-restart/thaw test pins the exact 200x200 minimum and CDP reapplication.
- `browserRail.ts` is now the sole rail width calculation. Rendered style width/min/max, pointer drag, keyboard sizing, and ARIA min/max/current all consume the same metrics. A workarea `ResizeObserver` reclamps the stored width and sends the changed width through the existing sidecar persistence path; compact-mode thresholds use the same minimum-terminal constant.

Expanded coverage exercises the component's clamped style/ARIA contract, component-produced Stop/Reload/restore commands, parser compatibility, immediate Stop dispatch, active-load cancellation, crash-to-new-incarnation restore, SPA URL projection, Preview/Browse origin and redirect rules, user-versus-broker source binding, bounded origin persistence, shared viewport boundaries, workspace staging, and real state-file save/restart/thaw. The post-fix focused set passes 200/200. Full `/tmp` gates pass: app 887 tests with one intentional real-daemon skip, strict typecheck, Electron and hosted-web production builds; Rust 781 tests with one intentional delegated-cgroup ignore; all-target warnings-as-errors clippy; exact generated Pi extension install/compile/production-loader/runtime verification; JSON and diff checks. One initial parallel Rust run hit two pre-existing process-lifecycle flakes (`No such process`); the required serial run and a clean ordinary retry both passed 781/781 with the same single intentional ignore. Updated full gate results are recorded with the remediation commit. Independent re-review supplied a PASS for the remediation, so `P1-rail-product-states` is completed. External deployment and platform gates keep `mergeReady` false.

## Resident lifecycle, launcher, and explicit Quit (2026-09-02; independent review pending)

The browser-enabled desktop now has a resident singleton lifecycle. Closing the local window detaches every browser view, revokes surface-bound Pi work, closes the per-window terminal utility client, and keeps the main-owned BrowserHost, metadata watcher, broker, and durable records alive. Reopen through a validated versioned second-instance activation, macOS `activate`, or the Linux tray restores exactly one local presentation and starts a fresh terminal client without re-registering process-global IPC handlers. A `--browser-host` launch starts hidden and does not retain a terminal client merely to host pages.

Plain Quit Amber IDE is now separate from Quit amber daemon. It warns about active Pi actions, approvals, dialogs, loads, and queued work; writes a private durable explicit-stop inhibit; rejects new browser commands; cancels activation/Pi work and denies approvals/dialogs; freezes pages; waits for the browser state persistence queue; then closes broker, watcher, tray, windows/clients/tunnels and exits. A bounded drain failure offers cancel (clears inhibit and re-enables commands) or force quit with an explicit persistence warning. Daemon Quit retains its separate destructive confirmation and then uses the same IDE drain.

Packaged normal launches atomically register a canonical executable, fixed `--browser-host` argv, platform, install generation, and owner identity in a private state file; normal launch clears inhibit, while `--browser-host` does not. AppImage registration uses the original stable image rather than Chromium's ephemeral mount, desktop-shortcut installation repairs registration to the stable copied image, and every packaged upgrade rewrites the record atomically. The Rust helper strictly validates schema, owner-only registration permissions, canonical regular executable identity, platform, and fixed argv. `amber ctl browser-host status|ensure|enable` reports typed unsupported/inhibited/unregistered states, launches with separate argv and no shell, performs a bounded authenticated broker readiness handshake, and never removes the inhibit during ensure. Windows ensure remains typed unsupported.

The Pi extension is now owned version v6. A missing token or socket invokes one bounded `amber ctl browser-host ensure --root <AMBER_STATE_DIR>` child with `shell:false`, retries the broker once after readiness, preserves cancellation, and returns actionable unavailable/inhibited guidance without affecting Pi supervision. Browser `open` continues through the existing broker path that reveals/reopens the GUI before association completion.

Automated evidence after the initial resident implementation: app 895 tests passed with one intentional real-daemon skip; new lifecycle/registration/drain/stale-live-socket tests were included; strict typecheck and Electron/web builds passed. Rust 786 tests passed serially with one intentional delegated-cgroup ignore; warnings-as-errors workspace clippy passed; isolated CLI tests covered status/inhibit/enable; generated Pi extension v5 installed idempotently, compiled, loaded through Pi's production loader, and registered all 26 tools. No production daemon was contacted.

### Resident P1/P2 remediation

The review findings are closed in code and await independent re-review. A process-global `BrowserOperationRegistry` now registers broker requests when accepted (including work waiting in the per-browser FIFO), renderer association/recovery/import transactions, and direct service commands. It owns abort controllers, warning counts, dispatch rejection, and the bounded quit empty barrier. Transaction paths revalidate before durable commit, then use explicit completion-only import/recovery/destroy paths so a drain cannot interrupt post-commit cleanup and strand an orphan. The broker parser no longer blocks acceptance behind a running request; per-browser ordering remains on the existing promise tail.

Broker startup now waits for a current-epoch full daemon session list rather than exposing an authenticated socket against stale or empty authority. Browser tokens are written through exclusive 0600 temporaries, file- and directory-fsynced rename, with invalid private regular tokens quarantined to one bounded slot before rotation. Linux fallback runtime paths are UID-specific (`/tmp/amber-ide-$UID`), and Node, Rust, and the generated Pi extension validate non-symlink current-owner 0700 directories, current-owner private regular tokens, and current-owner Unix socket endpoints before connecting or transmitting a token.

Launcher state and explicit-stop inhibit writes now use fsynced atomic private files. Registration requires current-user ownership metadata, exact version/platform/fixed argv, canonical non-writable executable and parent ancestry, and the expected Linux/macOS executable shape. AppImage upgrades stage and fsync the replacement while retaining the old artifact until launcher registration succeeds, restoring it on every failure path. The startup intent latch preserves activation and Quit requests received before window/service handlers exist. Pi extension v6 includes the hardened path contract and a production-loader cold-start test in which the first tool begins with no token or socket, invokes ensure once, and retries successfully.

Post-remediation evidence from this isolated `/tmp` worktree: app **908 passed / 1 intentional real-daemon skip**; Rust workspace **788 passed / 1 intentional delegated-cgroup ignore**; warnings-as-errors workspace clippy; strict TypeScript typecheck; Electron and hosted-web production builds; focused resident/browser suites; isolated `ctl browser-host`; generated Pi v6 installation, compilation, production loading, cold-start recovery, labels/bounds, and all 26 registered tools; `git diff --check`; report JSON parse. Full `cargo fmt --all -- --check` remains red on the repository's documented broad pre-existing formatter drift (720 diff hunks), so no bulk reformat was applied. No production daemon was contacted. Packaged Linux resident/physical-input and macOS lifecycle remain external gates; this P1 awaits independent code review.

## Open blocking work

1. Obtain independent review of the resident lifecycle/launcher/Quit implementation and remediate every valid finding before changing its P1 status.
2. Prove the Rust layout-v2 reader through the real upgrade/deployment channel before enabling v2 writes by default.
3. Validate the real packaged artifact and all bundled binaries; static-musl packaging is unavailable on this box because no musl C compiler is installed.
4. Complete the explicit macOS native-view geometry, focus, IME, lifecycle, profile, and packaging manual gate. No macOS claim is made.
5. Resolve the inconclusive Linux physical-input packaged smoke and run production-path Electron evidence for the semantic adapter and visible approval UI against approved hostile fixtures.
6. Expand process-lifecycle and broker end-to-end tests around daemon reconnect races and orphan durable records after sidecar CAS conflict.

## Isolation and cleanup

- The production daemon was never stopped, restarted, signaled, or written through.
- The production Electron user profile was not launched or modified.
- One early Rust mosaic test was accidentally run without the intended `XDG_STATE_HOME`; it only read and ignored the user's existing sidecar. No write or daemon command occurred. Subsequent commands set private roots explicitly.
- Private app, site, and daemon PIDs were terminated by exact PID at the end. The existing production daemon remained running.
