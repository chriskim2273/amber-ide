# Tab browser host implementation report

Date: 2026-09-04
Branch: `feat/tab-browser-host`

## Result

This branch implements and Linux-validates the durable main-owned tab-browser foundation, rail UI, persistence, capacity policy, and authenticated Pi observation, navigation, and approval-gated semantic interaction substrate. The independent review is PASS WITH FIXES and all three follow-up P2 findings are now closed. It does **not** satisfy the full approved product acceptance contract yet: deployed-reader upgrade proof, external packaged/platform gates, and macOS manual gates remain open. Those omissions must block merge of the complete feature. `mergeReady: false`.

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

### Six accepted resident-lifecycle findings (2026-09-03; implementation complete, independent re-review pending)

This pass used tests first and narrow conventional commits to close the accepted resident-lifecycle findings without changing the daemon protocol or widening browser authority:

1. **Broker drain replay:** cached broker results now register as broker operations, re-check drain/abort state before waiting and immediately before writing, and cannot replay page data after resident Quit begins. The regression covers a cached request retried after `beginDrain`.
2. **Watcher epochs:** the utility `Connection` assigns each socket a monotonically increasing epoch and drops stale data/open/close/error callbacks. `BrowserDaemonWatcher` requires a fresh full list for the active epoch and ignores callbacks from older sockets or after close.
3. **Capacity rollback:** a selected victim is marked unavailable when its page closes or crashes during deferred admission validation. Rollback removes the candidate without inventing a live renderer for that victim; close and crash races are covered.
4. **Recovery TOCTOU:** migration recovery entries receive stable opaque IDs (legacy records are deterministically upgraded), and list/copy/delete/attach plus runtime-delta merging address those IDs rather than mutable array indexes. Duplicate URL deletion and persistence fixtures cover the identity boundary.
5. **AppImage replacement:** the stable pathname is replaced with one atomic rename after a fsynced staged copy; a rollback copy remains until launcher registration succeeds, and cleanup failure cannot undo an already committed pathname. Registration failure and pre-commit interruption are tested.
6. **Windows enable:** `amber ctl browser-host enable` rejects with `BROWSER_HOST_UNSUPPORTED` before reading or mutating the inhibit marker on unsupported platforms.

Validation from `/tmp/amber-tab-browser-validation` on this branch: app **916 passed / 1 intentional real-daemon skip** (`npm test`), strict typecheck, Electron build, and hosted-web build; Rust workspace **789 passed / 1 intentional delegated-cgroup ignore** (`cargo test --workspace --all-targets`), warnings-as-errors workspace clippy, and isolated browser-host CLI coverage. `cargo fmt --all -- --check` remains red only for the repository's documented pre-existing formatter drift; no bulk reformat was applied. The focused resident/browser suites passed after the final changes. `npm run lint` remains unavailable because this repository has the documented ESLint 9 flat-config gap. The `/tmp` `npm run dist` attempt built a static `amber` but stopped before packaging because the Linux root dist script does not produce the required `amber-router-linux-x86_64`; no packaged artifact claim is made. No production daemon or profile was contacted. Independent resident re-review and the existing deployed-reader, packaged Linux/macOS, and manual platform gates remain open, so `mergeReady` stays false.

### Final resident tranche and packaged Linux validation (2026-09-03)

The six accepted resident-lifecycle findings are now implemented and committed in narrow changes. Quit flushes carry the caller's `AbortSignal` and a drain generation; timeout cancellation therefore fences late freeze/destroy work, while a later quit can run normally. Recovery attach/delete mutations use one serialized queue and idempotently reconcile the committed store, so a selected recovery item closing or being deleted during validation cannot produce stale-index `NO_RECOVERY_ITEM` races. The Rust browser-host enable tests are cfg-gated: Unix covers successful enable and Windows covers typed unsupported rejection without inhibit mutation. The app's inhibit durability test is skipped on Windows, where that Unix persistence surface is unsupported.

The Linux packaging gap is fixed. `scripts/dist.sh` now builds both `amber` and `amber-router` for static musl and honors absolute or repository-relative `CARGO_TARGET_DIR`/`AMBER_DIST_DIR` staging overrides; `app/scripts/dist.sh` passes the same isolated output directory through the real packaging chain. The new shell contract test and shell syntax checks pass. The real `/tmp` chain (`npm run dist`) produced an AppImage; unpacked resources contain `amber` and `amber-router`, and `file` reports both as `static-pie linked`. A private-daemon packaged startup smoke observed the packaged app resident with no production state or daemon access. The exact Electron 43.1.0 hostile fixture passed hardened preferences, popup/permission denial, debugger scoping, screenshot, detach/reattach, and window-reopen checks. Its physical XTest check remains inconclusive because the fixture has no input injector; this is not claimed as physical-input evidence.

Final isolated validation: `npm test` **921 passed / 1 intentional real-daemon skip**, strict TypeScript typecheck, Electron and hosted-web builds, `cargo test --workspace --all-targets` **784 passed / 1 intentional delegated-cgroup ignore**, warnings-as-errors workspace Clippy, generated Pi v6 installation/compilation/production-loader/cold-start verification with all 26 tools, static binary checks, package-content checks, private packaged startup, shell tests, and `git diff --check`. The MSVC cross-target check was attempted but cannot run on this Linux host because `ring` requires the unavailable `lib.exe`; no Windows execution claim is made. `cargo fmt --all -- --check` remains red only for documented pre-existing formatter drift, and `npm run lint` remains unavailable because of the repository's ESLint 9 flat-config gap. `npm ci` reports 25 dependency audit findings separately from these gates. No production daemon or profile was contacted.

Independent resident re-review, deployed-reader proof, Linux physical-input evidence, and macOS native-view/focus/IME/accessibility/lifecycle/profile/package gates remain open. `mergeReady: false`.

### Important containment and cancellation fixes (2026-09-03; implementation complete, independent re-review pending)

This pass used tests first and kept the daemon protocol and production daemon
untouched:

- Broker requests now own an abort controller before asynchronous `queueKey`
  admission. Socket close, Stop Pi, and operation-registry drain cancel that
  admission; later FIFO work still runs, while cancelled requests never reach
  the browser service. The default queue path keeps its prior scheduling shape.
- Node layout CAS rereads use a regular-file descriptor with an 8 MiB byte
  bound, symlink/identity checks, and growth detection. Remote SSH probes use
  the same 8 MiB stdout/stderr budget, a wall-clock timeout, child termination,
  and suppress partial output on overflow/timeout.
- Rust `mosaic` and `layout_cas` share a bounded regular-file loader. It rejects
  symlinks, non-regular files, oversized/growing/replaced files, and invalid
  UTF-8 before returning text. Parsed mosaic graphs cap workspaces, tabs, maps,
  strings, total nodes, and depth; the web poller caches an unchanged hostile
  fallback instead of reparsing it every second.

Focused and repository validation completed in this worktree: app **951
passed / 1 intentional real-daemon skip**, strict typecheck, Rust workspace
**805 passed / 1 intentional delegated-cgroup ignore**, warnings-as-errors
workspace Clippy, Windows GNU cross-target compile, Electron/web production
builds, Linux AppImage packaging with static `amber` and `amber-router`, and
`git diff --check`. The Rust and Node loaders now have deterministic
truncate/regrow/append/FIFO/symlink-swap coverage, and remote probes are
exercised with XDG/HOME paths containing spaces and glob characters. No
production daemon or profile was contacted. The full packaged Linux/macOS
gates, deployed-reader proof, and independent resident re-review remain open;
`mergeReady` stays false.

## Accepted P1 containment and lock remediation (2026-09-04; implementation complete, independent re-review pending)

This pass closes the four accepted P1 containment findings without changing the
Amber daemon protocol or contacting a production daemon:

- Timed-out browser adapter work now remains attached to a bounded per-browser
  FIFO barrier until the adapter settles. If it does not settle, the host
  quarantines the exact page incarnation: it invalidates automation, advances a
  generation tombstone, suppresses late page events, stops and destroys the
  native page, marks the record frozen, and emits the durable state change.
  Quarantine work is included in pending-work accounting so Quit cannot claim a
  clean drain while isolation is still running.
- Node file ingress is centralized in `safeFileReader.ts`. It opens bounded
  regular-file descriptors with symlink/FIFO rejection, checks current-user
  ownership when requested, validates descriptor/path identity and metadata
  before returning, detects growth/replacement, and decodes UTF-8 fatally.
  Layout, browser state, workspace imports, productivity/checkpoint files,
  editor files/drafts/images, Claude transcript prefixes, compatibility flags,
  broker tokens, and macOS service logs now use the hardened boundary.
- Protocol JSON and UTF-8 session names are fatal rather than replacement-
  decoded. Invalid broker JSON returns the stable `INVALID_REQUEST` path and
  closes unauthenticated/malformed connections; the shared daemon decoder
  rejects invalid control JSON and data-frame session names.
- TypeScript and Rust layout CAS locks now carry a versioned owner record with
  PID, process-start identity, and a per-acquisition token. Age alone never
  reclaims a lock: only a demonstrably dead owner is reclaimed, unknown owner
  state waits for the bounded timeout, and release requires matching record
  content and file metadata so an old owner cannot remove a successor lock.

TDD coverage includes non-cooperative adapter quarantine/FIFO release,
invalid UTF-8 in state/layout/editor/protocol ingress, symlink/FIFO and
truncate/regrow/append identity races, live/dead/unknown lock owners, and
successor-lock protection.

Final isolated validation in this worktree: app **964 passed / 1 intentional
real-daemon skip** (`npm test`); Rust workspace **811 passed / 1 intentional
delegated-cgroup ignore** (`cargo test --workspace --all-targets --quiet`);
workspace warnings-as-errors Clippy; strict TypeScript typecheck; Electron and
hosted-web production builds; Linux `npm run dist` with static-musl `amber` and
`amber-router` bundled into an AppImage; shell contract tests; and
`git diff --check`. `cargo fmt --all -- --check` remains red only for the
repository's documented broad pre-existing formatter drift, and `npm run lint`
remains unavailable because the repository has no ESLint 9 flat config. The
Windows GNU cross-target check is unavailable on this Linux host because the
`ring` build requires `x86_64-w64-mingw32-gcc`; no Windows execution claim is
made. Independent resident re-review, deployed-reader proof, packaged Linux
physical-input evidence, and macOS native-view/focus/IME/accessibility/
lifecycle/package gates remain open, so `mergeReady: false`.

## P1 queue, control-file, lock, and Pi-frame follow-up (2026-09-04; implementation complete, independent review pending)

This follow-up closes the four confirmed P1s without changing the daemon
protocol or contacting a production daemon. It supersedes the earlier
resident-pass shorthand that described malformed browser tokens as being
quarantined and rotated: invalid browser-host token bytes now fail closed and
are never replaced automatically.

- Per-browser queue entries now carry explicit operation ownership. A cancelled
  follower remains attached to its predecessor's FIFO tail and cannot release
  the tail early or quarantine the active entry. Only an operation that passed
  its own dispatch fence can bind a page incarnation and arm the one-shot
  non-cooperative barrier. A timed-out active adapter is quarantined before a
  later operation may thaw a fresh incarnation; late events/results remain
  suppressed and queue/barrier/quarantine accounting drains for Quit.
- Electron's compatibility marker has a synchronous bounded regular-file,
  no-follow reader for the pre-renderer startup decision. Browser-host token
  reads use the same bounded descriptor/identity/fatal-UTF-8 boundary and a
  strict 43-character base64url grammar; invalid UTF-8, malformed, oversized,
  symlink, FIFO, changed, or unsafe files return stable errors before the
  broker listens or transmits a token. The Rust browser-host readiness probe
  and launcher metadata reader were audited for the same fixed-size boundary.
- Node and Rust layout locks now prepare and fsync a complete owner record in a
  same-directory temporary, publish it with an exclusive hard link, and remove
  the temporary only after publication. This is the cross-language no-replace
  primitive, so a crash before publication leaves no final partial record and a
  crash after publication leaves a complete record reclaimable only when its
  PID/start identity is demonstrably dead. Identifiable dead legacy partial
  records can be reclaimed; live, unknown, and unidentifiable legacy records
  fail closed after the bounded timeout. Release compares owner token, exact
  record text, and file metadata before unlinking, so an old owner cannot remove
  a successor. Platforms/filesystems without the primitive fail closed rather
  than age-stealing.
- The generated Amber-owned Pi extension remains v6 while adding bounded
  validation. It bounds and validates the browser token with a no-follow
  descriptor read, uses a fatal TextDecoder for
  each broker JSON frame before JSON.parse, closes malformed connections, and
  never normalizes invalid bytes to U+FFFD. The exact installed source is
  compiled and loaded through Pi's production extension loader; runtime checks
  cover invalid/oversized token files and an invalid UTF-8 reply frame.

Independent-review remediation now gives every browser queue barrier an
explicit cooperative/isolated/poisoned terminal state: quarantine failures
fall back to frozen teardown or poison the browser before later work can
enter, and queue owners are aborted alongside adapter/registry controllers by
hide, association close, Pi revoke, and quit. Legacy Node/Rust lock recovery
rejects duplicate (including identical) `pid`, `start`, `token`, or `created`
fields, rejects unknown/oversized/non-canonical fields consistently, and only
accepts reordered unique records. New regressions cover isolation rejection,
A/B/C no-overlap and quit completion, direct hidden work, association close,
Pi-owner revoke, and cross-language lock vectors.

Validation is green in the isolated `/tmp` worktree: app **982 passed / 1
intentional real-daemon skip**, Rust workspace **821 passed / 1 intentional
delegated-cgroup ignore**, warnings-as-errors workspace Clippy, strict
TypeScript, Electron and hosted-web production builds, static Linux AppImage
packaging with both `amber` and `amber-router`, shell package contracts,
exact installed Pi 0.81 production-loader/runtime checks (including fatal
token/frame fixtures), and `git diff --check`. A separate global Pi 0.85
probe is not claimed because that published install imports its omitted
`@earendil-works/pi-server` dependency. `cargo fmt --all -- --check` remains
red only for the repository's documented broad pre-existing formatter drift; no
bulk reformat was applied. Independent review and external deployed-reader,
physical-input, and platform gates remain pending; `mergeReady` stays false.

## Open blocking work

1. Obtain independent review of the resident lifecycle/launcher/Quit implementation and remediate every valid finding before changing its P1 status.
2. Prove the Rust layout-v2 reader through the real upgrade/deployment channel before enabling v2 writes by default.
3. Complete the remaining packaged Linux hostile-fixture, physical-input, and resident evidence; the real `/tmp` chain now produces static-musl `amber` and `amber-router` and the unpacked AppImage has both.
4. Complete the explicit macOS native-view geometry, focus, IME, lifecycle, profile, and packaging manual gate. No macOS claim is made.
5. Resolve the inconclusive Linux physical-input packaged smoke and run the remaining production-path Electron evidence for the semantic adapter and visible approval UI against approved hostile fixtures.
6. Expand process-lifecycle and broker end-to-end tests around daemon reconnect races and orphan durable records after sidecar CAS conflict.

## Isolation and cleanup

- The production daemon was never stopped, restarted, signaled, or written through.
- The production Electron user profile was not launched or modified.
- One early Rust mosaic test was accidentally run without the intended `XDG_STATE_HOME`; it only read and ignored the user's existing sidecar. No write or daemon command occurred. Subsequent commands set private roots explicitly.
- Private app, site, and daemon PIDs were terminated by exact PID at the end. The existing production daemon remained running.

## External acceptance gates (2026-09-04; sole validation run)

This run used one unique evidence root, `/tmp/amber-tab-browser-validation/20260904T174029-1660527`, with private `HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`, daemon/browser sockets, Electron data/cache, browser profile, Pi roots, Cargo/npm/Electron caches, and a PID ledger. All launch and destructive actions were path/PID guarded. No production daemon, profile, config, service manager, installed binary, production AppImage, or global Pi extension was contacted or modified. The historical external artifacts were produced from archive source head `66a02a4`; the production code validated by the current follow-up is `c5b87c8`, while `e856624` is the documentation/report baseline. The current follow-up commits only verifier/tests and metadata.

The latest queue/control-file/layout-lock remediation already has an independent PASS with no blocking findings. The rail (`P1-rail-product-states`) and Pi semantic/approval work (`P1-pi-tools-and-approvals`) retain their previously recorded independent PASS reviews. The resident lifecycle review is PASS WITH FIXES; its three P2 follow-ups are closed below, while external deployment/platform gates still keep `mergeReady: false`.

### Gate A — deployed reader/channel: CHANNEL_INCOMPLETE

The required read-only `gh release list`/`gh api` preflight for origin `https://github.com/chriskim2273/amber-ide.git` returned the unauthenticated-CLI error (rc 4) under a private `GH_CONFIG_DIR`. A public read-only GitHub API fallback recorded the complete channel in `ledger/release-channel-summary.txt` and `ledger/github-releases-public.json`:

- `v0.0.1` (reader absent, tag commit `42357316460ba1b590718cf1c2b17ffcb4f1d326`) publishes Linux `amber-ide-0.0.1.AppImage` (`sha256:b0e0eecf593b769acf38a06ba1b3070dff29a6d24cf7af4b05a53525ff1feede`), macOS arm64 DMG (`sha256:f5b3f6b7c7dfb9845cbe20d23dd4bf800473ed689325bf14fe30f471f038a9ef`), macOS x64/arm64 DMG (`sha256:6a5ea7c084c9459087dd583307b010df286f0e28597d0e73fadb2f4147481dfc`), and `amber-macos-universal` (`sha256:2a0d7ab1f2931e24eb9e511cb1890fdbe4dda66e8e655cb7a448c84fea0cfac9`).
- `v0.0.2` (reader present, tag commit `4e158f35076a273f4b9a8c0308f3c3f2ad46cd9a`) publishes only Windows assets: NSIS (`sha256:fb5e314b5b57dc33058efcab22bd3a869c47cdb19d9cacb5f6f655adb6e403b6`), `amber-windows-x86_64.exe` (`sha256:3cf6df2b6579455b0390dd1a4d90aadac43c51a6a54f84673aa5c3501c65c842`), and `amberd-windows-x86_64.exe` (`sha256:ead9c6192a1b0b31700f0f7aa72e961ee67ab553a08cc5feceacf0a23cad2674`).
- `windows-preview` is prerelease only and is irrelevant to the Linux/macOS upgrade channel.

Therefore the actual channel is `CHANNEL_INCOMPLETE`: the newer published v2-reader release has no Linux/macOS artifact. `AMBER_TAB_BROWSER_V2_READER_DEPLOYED=1` was used only in private validation process environments to exercise the package; it was never set in production and no release was published.

### Gate B — packaged Linux: PASS with explicit substrate limitation

The packaged platform evidence mirror at `source-accept` was archived from source head `66a02a4` (archive SHA-256 `4c5cf068b460b9992144c4b5aeeb223cac2210ddddb21a4e1b52d0991ab241d5`), before the production-code validation commit `c5b87c8`. `npm ci` and the real `npm run dist` chain passed with all mutable caches/staging under the private root. This artifact remains platform/substrate evidence only and is not attributed to c5 or Pi extension v7. The final AppImage is:

`source-accept/app/release/amber-ide-0.0.2.AppImage` — SHA-256 `7bf2ab0dd9758f1de197dd77881d5b426209ba0003908d92dc5bc177ca93077d`.

(The exact recorded hash is also in `ledger/accept-appimage.sha256`; see that file for the authoritative value.) Unpacking passed the package checks. `resources/bin/amber` and `resources/bin/amber-router` were executable `static-pie linked` ELF files, with hashes `aed8779d43a0bd6323d2054147ee0addae55a08cfad089a15fef5cca9ea7fc11` and `b65260bc58d49e31db5d34a2b3981eb617ae787f48a148281d5175cdae40c2dd`; no unintended Chromium/Chrome/Firefox/WebKit/Playwright executable was present. Evidence: `ledger/accept-appimage-binary-file.txt`, `ledger/accept-bundled-binary-hashes.txt`, and `ledger/accept-appimage-checks.txt` (the extracted resource listing is in `source-accept/app/release/linux-unpacked`).

The exact packaged artifact ran under private Xvfb `:122` and a private minimal window manager, with compatibility flags unset (`AMBER_NO_SANDBOX`, `AMBER_SOFTWARE_GL`, and `ELECTRON_DISABLE_SANDBOX` all unset). The validation selected private XIM (`GTK_IM_MODULE=xim`, `QT_IM_MODULE=xim`, no IBus repair) to avoid touching the production input-method service. The renderer reported `softwareGl:false` and rendered normally after the first external run exposed synchronous `WebGL2 not supported`; the failing `terminalRenderer.test.ts` was added first and the minimal DOM-renderer fallback landed in `58b205d`, then the packaged chain was rerun.

The committed hostile fixture (`app/e2e/tabBrowser/phase0-main.cjs`) passed hardened preferences, popup denial, permission denial, debugger scope, screenshot, detach/reattach, and window reopen; its direct physical flag remained false without an injector (`ledger/phase0-xtest-result.json`). The packaged live fixture additionally proved, through the private broker and native page, that the remote page had `process`, `require`, `window.electron`, and `window.amber` all `undefined`, geolocation permission state `denied`, no `/popup` request after a popup click, and no `file:`/`passwd` request after the unsafe-link click. Evidence: `ledger/packaged-final-page-security-observation.json` and `ledger/packaged-accept-popup-check.txt`.

The final package's private browser rail loaded the hostile page, and the broker successfully returned status, bounded accessibility snapshot/find, DOM/CSS inspection, console entries, and an in-memory binary screenshot. Semantic interaction used the exact generated target and completed after the visible approval card was shown and approved: the card displayed the communication category, exact local origin, controller, 60-second countdown, and `untrusted browser content` target label; XTest clicked `Approve once`; the fixture received the form POST and the rail reported `Pi click: completed`. Evidence: `ledger/packaged-accept-broker-inspect.log`, `screenshots/approval-packaged-final-before.xwd`, `screenshots/approval-packaged-final-before.png`, `logs/broker-approval-packaged-final.log`, and `ledger/hostile-server-after-packaged-approval.txt`. The live interaction bugs found during this run were fixed TDD-first in `b5189c1` (correct CDP `backendNodeId` parameter), `ad9d334` (do not double-count adapter input), and `ace60fa` (preserve the acknowledged approval surface); the strict regressions are included in the commits.

Resident/package lifecycle also passed on the final artifact. Ordinary close via the private X server left the exact packaged main PID resident, the browser-host socket and private daemon socket present, and the window unmapped (`ledger/packaged-close-window-state-2.txt`, `ledger/packaged-close-sockets-2.txt`). A second packaged launch exited 0, left one resident owner, remapped the same window, and exposed one app renderer plus one browser target (`ledger/packaged-second-instance-result.txt`, `ledger/packaged-second-cdp-list.txt`). Reopening the same private profile restored the opaque browser association, safe URL/title/viewport, and designated/shared state (`ledger/packaged-accept-reopen-dom.json`, `ledger/packaged-accept-layout-after-restart.json`). Explicit menu **Quit Amber IDE** exited the exact app PID, removed only the private browser-host socket, and left the private daemon reachable (`ledger/packaged-final-explicit-quit.txt`, `ledger/packaged-final-quit-sockets.txt`, `ledger/packaged-final-daemon-after-quit-ls.txt`). The XTest helper was compiled from `ledger/xtest-helper.c` and successfully injected packaged-app clicks, typing, menu actions, and approval; this is X-server substrate evidence only, not physical hardware or IBus evidence. Real physical input/IME/accessibility on Linux remains an external/manual residual.

### Gate C — macOS: blocked before platform work

The required read-only Tailscale/SSH preflight was run using the MacBook skill's full PATH pattern. The local Tailscale CLI did not accept the skill's obsolete `-t` spelling; the equivalent read-only command `tailscale ping -c 1 --timeout=5s christophers-macbook-pro` resolved `100.120.200.20` but timed out with no reply. `ssh -o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 macbookpro 'source ~/.zprofile 2>/dev/null; export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"; xcodebuild -version && asc auth status --validate'` likewise timed out (rc 255). The complete output is `ledger/mac-preflight.log`. The Mac build/DMG/universal-binary/codesign/native-view/focus/IME/accessibility/profile/approval gate was not run and is not claimed. Required user action: wake/connect `macbookpro` over Tailscale/SSH, then rerun the clean remote private build and native smoke; no Mac state was touched.

### Gate D — Pi packages and first-use path

The current global package is `@earendil-works/pi-coding-agent` 0.85.0 at `/home/poyto/.nvm/versions/node/v24.16.0/lib/node_modules/@earendil-works/pi-coding-agent`. The exact generated-extension verifier against the packaged Amber failed before loader/runtime checks because this published package imports the omitted `@earendil-works/pi-server` dependency (`ERR_MODULE_NOT_FOUND`); this is a published Pi packaging blocker, not an Amber extension error. A direct private Amber `ctl install-pi-extension` plus TypeScript compile against current 0.85 passed (`ledger/pi-current-install-compile.txt`), isolating the failure to Pi's loader dependency. No global extension changed.

The pinned 0.81.0 package at `/home/poyto/.pi/agent/npm/node_modules/@earendil-works/pi-coding-agent` passed the exact `npm run test:pi-browser-extension` verifier against the pre-c5 packaged Amber: `installedBytes:25325`, `compiled:true`, `loaded:true`, `labeledResults:true`, `fatalTokenAndFrameChecks:true`, and all 27 browser tools registered. This historical v6-package result is retained for provenance; the current v7 result is recorded below against a c5-built private binary. Because the mandated private root makes the verifier's long Unix socket path exceed AF_UNIX's 108-byte limit, `TMPDIR` pointed to a short `/tmp/ambertab-…` symlink whose resolved target remained inside the unique private root; the alias was removed immediately. Evidence: `ledger/pi-081-short-verifier-tail.txt`, `ledger/pi-package-versions.txt`, `ledger/pi-current-verifier-tail.txt`.

With a private fake `kind:pi` executable (no provider credentials or network), the packaged first-use path was exercised without touching any real Pi profile: removing the private tab association, a broker `open` returned `CREATION_AWAITING_USER` and visibly revealed the rail; the user then designated the same live Pi pane and approved Share with Pi; status/snapshot/find/inspect/screenshot tools succeeded; unsharing made the next broker status fail `NOT_SHARED` while the private daemon still listed the Pi session. Evidence: `ledger/gate-d-first-open.log`, `ledger/gate-d-first-open-dom.json`, `screenshots/gate-d-share-confirm.png`, `ledger/gate-d-first-use-broker-inspect.log`, `ledger/gate-d-revoke-status.log`, `ledger/gate-d-daemon-live-after-revoke.txt`. A real authenticated Pi conversation was not attempted because credentials were unavailable; the exact pinned loader/runtime gate and the private authorization/approval path are the claims made here.

### Current automated evidence and changed commits

The production code under test is commit `c5b87c8`. The prior documentation/report HEAD was `e856624`; the current follow-up adds only verifier/tests and metadata, with no unrecorded production behavior change. Fresh isolated gates at this follow-up pass report `npm test` **1003 passed / 1 intentional real-daemon skip** (81 files); strict `npm run typecheck`; `npm run build`; `npm run build:web`; Rust `cargo test --workspace --all-targets` **821 passed / 1 intentional delegated-cgroup ignore** (36 suites); and warnings-as-errors workspace Clippy. The focused Rust socket test `focus_refreshes_use_and_resumes_only_memory_suspension` passed **5/5** after `b832761`; the fixture-only synchronization remains confined to that focus harness. A c5-built private Amber binary (`f99567881863ba4775b1f828606557cc30530a6df21949b6b82d1070b7c119d1`) passed the Pi v7 production-loader verifier: `installedBytes:28111`, `compiled:true`, `loaded:true`, `labeledResults:true`, `fatalTokenAndFrameChecks:true`, and all 27 tools. Evidence is `logs/pi-followup-verifier.log` and `ledger/pi-followup-verifier-rc.txt` under the private root. The older packaged AppImage evidence in Gate B was built from a pre-c5 archive and remains platform/substrate evidence only; it is not attributed to c5 or Pi v7. Repository-wide rustfmt remains the documented pre-existing formatter drift and lint remains unavailable because of the ESLint-9 flat-config gap.

Electron cannot provide a trustworthy physical-versus-CDP source marker, so every `before-input-event` and `before-mouse-event` callback advances the page generation. There is no signature/token ledger: identical physical and CDP-shaped callbacks, composition, drag events, out-of-order callbacks, and late callbacks all increment independently. Host interaction dispatch validates the prepared generation immediately before the first irreversible Input-domain command, increments before dispatch, then permits later input/navigation increments and returns the final observed page incarnation/generation plus an `interleaved` indicator. The adapter reports a bounded typed failure carrying `dispatched`; Host and broker normalize any partial dispatch to `ACTION_FAILED_NO_ROLLBACK`, `retryable:false`, current context, and a fresh-snapshot instruction. The generated Pi extension preserves only this structured, secret-safe result and tells the caller to snapshot fresh. The Pi verifier now parses that result and asserts exact `code`, `retryable`, `message`, `pageIncarnation`, `generation`, `snapshotHint`, `dispatched`, and `nextStep` fields with no secret leakage. Service coverage rejects a queued stale-generation interaction before adapter dispatch, while Host coverage exercises drag, type, and fill with callbacks during every dispatch and confirms monotonic final generations without false stale errors. New validation metadata is rooted at `CODE_TESTED_COMMIT=c5b87c8`, `REPORT_BASE_COMMIT=e856624`, and the follow-up evidence files above. The normalized environment/head record is `validation.env`; the code/report distinction is `ledger/code-vs-report-head.txt`, and the JSON/test summary is `ledger/remaining-json-validated.json` plus `ledger/followup-tests-summary.txt`. Report evidence paths resolve against the unique validation root.

Defect-fix commits made during this validation, each conventional and without `Co-Authored-By`, are: `58b205d fix(app): fall back when WebGL is unavailable`; `2889f06 fix(app): prefer DOM identities for browser targets`; `b5189c1 fix(app): use valid accessibility backend parameters`; `ad9d334 fix(app): isolate automation input generations`; `ace60fa fix(app): preserve browser approval surfaces`; `40496a8 fix(app): wait for daemon sessions before revoking Pi`; `642caa0 fix(app): honor isolated Electron data paths`; `a8820fa fix(app): account for synthetic browser input events`; `af83f70 fix(app): preserve input ledger during observations`; `6e8ecbb fix(app): use uniform browser input generations`; and `c5b87c8 fix(app): expose typed browser action errors`. The follow-up P2 tests/verifier are in `3ef779f`, and the fixture synchronization plus metadata/report corrections are recorded by the subsequent conventional commits. `mergeReady` remains false until the deployed-reader channel, independent resident re-review, physical/manual Linux gate, and macOS gate are closed.
