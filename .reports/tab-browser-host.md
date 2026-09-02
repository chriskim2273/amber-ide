# Tab browser host implementation report

Date: 2026-09-01
Branch: `feat/tab-browser-host`

## Result

This branch implements and Linux-validates the durable main-owned tab-browser foundation, rail UI, persistence, capacity policy, and the initial authenticated Pi control path. It does **not** satisfy the full approved product acceptance contract yet. In particular, the broad bounded browser-development tool set, screenshot attachment transport, approval coordinator, workspace v2 round-trip, deployed-reader upgrade proof, packaged-artifact gate, and macOS manual gate remain open. Those omissions must block merge of the complete feature.

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
- The installed Amber-owned Pi extension registers bounded `browser_open`, `browser_status`, and `browser_navigate` tools, uses no raw CDP API, and refuses to overwrite modified/unowned extension files.
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

A subsequent final-gate fix slice also closes three concrete bypasses: `.amberws` browser URLs are normalized through the same HTTP(S)/safe-restore policy on parse, save, and load planning; controller authorization now requires a live `kind:pi` daemon session that is not in `shell-fallback`; and page creation uses the persisted profile descriptor partition rather than a constructor default.

## Review-fix validation

- App: 64 files passed, 762 tests passed, one intentional real-daemon skip.
- App strict typecheck: passed.
- Electron production bundle and web production bundle: passed.
- Rust warnings-as-errors clippy: passed.
- Rust layout-CAS focused suite: 8 passed.
- Full Rust all-target run reached 436/437 library tests, with unrelated pre-existing timing test `manager::tests::automatic_pressure_suspend_rechecks_liveness_under_the_transition_lock` failing once with `ESRCH`; immediate isolated rerun passed. This is recorded as a flaky full gate, not claimed green.
- All commands used `/tmp/amber-ide-tab-browser-host` and `/tmp/amber-tab-browser-validation`; no production daemon command was issued.

## Open blocking work

1. Add the complete typed Pi tool surface required by the design (bounded observation, semantic interaction, wait/assert, binary screenshot attachment) without exposing unrestricted raw CDP/Playwright or filesystem screenshot paths.
2. Add the consequential-action classifier and user approval coordinator with exact action/origin/target previews, expiry, and stale-generation rejection.
3. Complete workspace `.amberws` v2 save/load for tab rails and define/verify collision-safe import semantics.
4. Wire and live-prove recognized legacy browser-leaf migration, including browser-only tabs and non-promoted URL recovery.
5. Prove the Rust layout-v2 reader through the real upgrade/deployment channel before enabling v2 writes by default.
6. Validate the real packaged artifact and all bundled binaries; static-musl packaging is unavailable on this box because no musl C compiler is installed.
7. Complete the explicit macOS native-view geometry, focus, IME, lifecycle, profile, and packaging manual gate. No macOS claim is made.
8. Resolve the inconclusive Linux physical-input packaged smoke.
9. Expand process-lifecycle and broker end-to-end tests around daemon reconnect races, orphan durable records after sidecar CAS conflict, and Pi cancellation during in-flight page work.

## Isolation and cleanup

- The production daemon was never stopped, restarted, signaled, or written through.
- The production Electron user profile was not launched or modified.
- One early Rust mosaic test was accidentally run without the intended `XDG_STATE_HOME`; it only read and ignored the user's existing sidecar. No write or daemon command occurred. Subsequent commands set private roots explicitly.
- Private app, site, and daemon PIDs were terminated by exact PID at the end. The existing production daemon remained running.
