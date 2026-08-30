# Productivity & Continuity Suite — Implementation Plan

**Design:** `docs/superpowers/specs/2026-08-29-productivity-continuity-suite-design.md`  
**Worktree:** `/media/poyto/Teacup/Worktrees/amber-productivity-suite`  
**Branch:** `feat/productivity-suite`  
**Testing rule:** author tests in the worktree; mirror with `rsync` into `/tmp/amber-productivity-suite-test` and run every command there. Never execute tests/builds from `/media/poyto/Teacup`.

## Execution discipline

- TDD within each task: add focused failing tests, mirror, run the focused test to establish failure, implement, mirror, rerun.
- Commit each milestone with a concise conventional commit.
- After each milestone inspect its diff for authority, blocking IO, unbounded state, path traversal, event/listener cleanup, and keyboard leakage.
- At the end run complete Rust tests twice, clippy with warnings denied, app tests, typecheck, Electron build, and web build from the fast mirror.
- Do not pause for batch review; execute all tasks through final verification.

## Task 0 — Fast test mirror and baseline inventory

1. Create `/tmp/amber-productivity-suite-test` as a disposable local clone/worktree-independent copy.
2. Add a local-only sync command (do not commit host paths):
   `rsync -a --delete --exclude .git --exclude target --exclude node_modules <worktree>/ <mirror>/`.
3. Confirm branch/base SHAs and record baseline test counts if the existing suites can complete.
4. Never copy secrets/untracked files from the main checkout; source is the clean feature worktree only.

## Task 1 — Add daemon search protocol and sanitizer

**Files**

- `crates/amber-core/src/proto.rs`
- `crates/amber/src/search.rs` (new)
- `crates/amber/src/lib.rs`
- `crates/amber/src/manager.rs`
- `crates/amber/src/daemon.rs`
- `crates/amber/src/web.rs` as required for exhaustive matching/security tests
- `app/src/shared/proto.ts`
- `app/src/shared/proto.test.ts`

**Tests first**

1. Rust wire round trips for `SearchScrollback`, `SearchResults`, and `SearchResult`.
2. Known-control list recognizes both variants and malformed known shapes remain hard errors.
3. TS encode/decode tests lock exact serde JSON shape.
4. Sanitizer tests:
   - plain UTF-8/newlines;
   - CSI color/cursor sequences;
   - OSC BEL and ST terminators;
   - DCS/APC/PM strings;
   - CR/backspace and C0 controls;
   - invalid UTF-8;
   - oversized logical lines and preview truncation.
5. Pure search tests for trim/empty rejection, case folding, name scope, line order, global limit, and whitespace normalization.
6. Manager test proves session map is cloned before text scan (test via an injected scan hook or by keeping create/list responsive while a large search runs).
7. Daemon integration test fills multiple rings, searches them, sends `ListSessionsDetailed` behind the request, and asserts the listing reply is not head-of-line blocked by the scan.
8. Web mapping test confirms search messages cannot be constructed from any browser message.

**Implementation**

1. Define `SearchResult` and additive controls.
2. Implement a bounded byte-state sanitizer in `search.rs`; no screen/cursor model.
3. Implement `search_snapshot(query, sessions, limit)` as a pure function.
4. Add `SessionManager::search_scrollback` that clones `(name, Arc<PtySession>)` handles under the sessions lock, copies each selected ring, and delegates scanning with locks released.
5. In daemon control handling, validate cheap bounds, clone manager/writer, and spawn a worker for scan + response.
6. Add TS protocol mirror, strict result decoding, and request routing through preload → main → utilityProcess.

**Milestone review/commit:** `feat: add global scrollback search protocol`

## Task 2 — Add durable recovery journal and protocol

**Files**

- `crates/amber-core/src/proto.rs`
- `crates/amber-core/src/state.rs`
- `crates/amber/src/manager.rs`
- `crates/amber/src/daemon.rs`
- `crates/amber/src/main.rs`
- `app/src/shared/proto.ts`
- protocol/state/manager integration tests

**Tests first**

1. Recovery event/control wire shape and backward defaults.
2. Missing journal → empty; malformed → error without affecting unrelated state reads.
3. Atomic append preserves order, assigns monotonic sequence, caps at 500, truncates detail, and handles concurrent append threads without lost entries.
4. Clear produces an empty valid journal.
5. Manager lifecycle tests for create, rename, remove, reap/exit, suspend/resume, restore summary/failure.
6. Daemon explicit snapshot success/failure events and list/clear request timeout-safe replies.
7. Reap logs exit before metadata/artifact deletion.

**Implementation**

1. Define `RecoveryEvent`, requests, and replies.
2. Add a journal mutex to `StateStore`; implement bounded load/append/clear.
3. Expose manager record/list/clear helpers.
4. Record lifecycle events at the layer that knows the authoritative outcome—manager for session/store operations, daemon for explicit protocol snapshot outcome.
5. Restore collects successes/skips and writes one summary plus per-failure entries; journal failure is logged and never aborts restore.
6. Reap records before removing artifacts.
7. Add daemon list/clear handlers; list can remain synchronous because the file is bounded/small, but writes use bounded writer.
8. Mirror protocol and utility routing in TS.

**Milestone review/commit:** `feat: add durable recovery history`

## Task 3 — Productivity persistence, project profile, checkpoints, handoff

**Files**

- `app/src/shared/productivity.ts` + tests (new)
- `app/src/shared/projectProfile.ts` + tests (new)
- `app/src/shared/checkpoint.ts` + tests (new)
- `app/src/shared/handoff.ts` + tests (new)
- `app/src/main/productivityIO.ts` + tests (new)
- `app/src/main/projectProfile.ts` + tests (new or shared parser with main IO wrapper)
- `app/src/main/checkpointIO.ts` + tests (new)
- `app/src/main/index.ts`
- `app/src/preload/index.ts`

**Tests first**

1. Productivity defaults, full parse, malformed optional dropping, per-field lengths, per-session/total bookmark caps, template cap, and notification preference defaults.
2. Productivity exact-content CAS success/conflict and atomic write error behavior.
3. Strict `.amber.toml` parser accepts the documented schema and rejects:
   - commands/env/unknown keys;
   - duplicate scalar keys;
   - unsupported version/kind/direction;
   - absolute cwd, `..`, NUL, malformed strings;
   - >32 panes.
4. Root containment and directory existence checks, including sibling-prefix attacks (`/root/app2` vs `/root/app`).
5. Checkpoint ID grammar, wrapper parse, 128 MiB cap, listing cap/order, write/read/delete containment, automatic retention, malformed-file skip.
6. Handoff parse/serialize, field bounds, base64 payload, and no reusable daemon name.

**Implementation**

1. Implement pure schema modules with constants and shape guards.
2. Implement atomic JSON IO using same-directory temp+rename and best-effort directory fsync where Node supports it.
3. Register narrow IPC handlers:
   - productivity load/save;
   - project profile read;
   - checkpoint list/write/read/delete;
   - handoff native save;
   - native notification delivery.
4. Validate sender payloads at main boundary; validate all IDs before path construction.
5. In preload expose typed methods only; no generic file read/write.
6. Add notification click relay and length bounds.

**Milestone review/commit:** `feat(app): add productivity persistence and safe file services`

## Task 4 — Pure renderer feature models

**Files**

- `app/src/renderer/commandPalette.ts` + tests (new)
- `app/src/renderer/globalSearch.ts` + tests (new)
- `app/src/renderer/recovery.ts` + tests (new)
- `app/src/renderer/notifications.ts` + tests (new)
- `app/src/renderer/activity.ts` + tests (new)
- `app/src/renderer/templates.ts` + tests (new)
- `app/src/renderer/bookmarks.ts` + tests (new)
- `app/src/renderer/keys.ts` / `keys.test.ts`

**Tests first**

1. Palette entry construction includes panes/workspaces/tabs/actions; normalized fuzzy ranking prioritizes exact slot/title/name matches; stable order and result cap.
2. Search scope chooses exact daemon names, request IDs reject stale replies, timeout/error states are deterministic.
3. Recovery filters and action gating.
4. Notification transition detection, active-window suppression, workspace mute, preference gating, and 30-second dedup.
5. Activity metrics, filter, and sort with unknown memory/slots.
6. Template capture removes every scrollback and identity; duplicate name handling and cap.
7. Bookmark capture/label/excerpt normalization, bounds, update/delete, and search-anchor selection.
8. New palette/global-search chords match and are vetoed from xterm.

**Implementation**

Keep components thin by putting ranking, transition policy, filtering, and document transformations in these pure modules. Reuse `assembleSave`/`planLoad` instead of a second layout conversion.

**Milestone review/commit:** `feat(app): add productivity feature models`

## Task 5 — Pane bookmark and navigation hooks

**Files**

- `app/src/renderer/Pane.tsx`
- `app/src/renderer/SplitView.tsx`
- component-adjacent pure tests where practical

**Tests first**

1. Pure terminal-line capture helper prefers selection, otherwise joins bounded visible lines, strips trailing blanks, and caps output.
2. `SplitView` request matching only acts when active and the target leaf exists.
3. Search request sequencing opens/refocuses the correct find bar and seeds the query.

**Implementation**

1. Extend `SearchApi` with `captureBookmark()`.
2. Add `initialQuery` behavior to `FindBar` without remounting Terminal.
3. Add `focusRequest` / `findRequest` props to `SplitView` and sequence-driven effects.
4. Add pane menu actions “Bookmark position” and “Export handoff”.
5. Add callbacks to App; keep Pane memoization effective by using stable callbacks/primitive request fields.

**Milestone review/commit:** `feat(app): add pane bookmark and navigation hooks`

## Task 6 — Desktop overlays and command integration

**Files**

- `app/src/renderer/CommandPalette.tsx` (new)
- `app/src/renderer/GlobalSearch.tsx` (new)
- `app/src/renderer/RecoveryCenter.tsx` (new)
- `app/src/renderer/TemplatesDialog.tsx` (new)
- `app/src/renderer/BookmarksDialog.tsx` (new)
- `app/src/renderer/CheckpointsDialog.tsx` (new)
- `app/src/renderer/ProjectProfileDialog.tsx` (new)
- `app/src/renderer/ActivityOverview.tsx` (new, replaces sessions dialog body)
- `app/src/renderer/main.tsx`
- `app/src/renderer/theme.css`
- `app/src/renderer/Icon.tsx` only if existing icons cannot express actions

**Implementation sequence**

1. Add one discriminated overlay state so only one modal surface can own keyboard input.
2. Wire productivity load at startup and serialized CAS mutation helper.
3. Build navigation helper from session/app-local names and sequence requests into `SplitView`.
4. Mount command palette and connect dynamic entries/actions.
5. Wire global search request/reply correlation, debounce, scopes, stale response dropping, timeout, result navigation.
6. Wire recovery list/clear/refresh and actions.
7. Capture/instantiate/rename/delete templates through existing pending-load path.
8. Add notification preferences, transition detection, delivery, and click navigation.
9. Capture/list/rename/delete bookmarks; include them in export.
10. Replace/enhance Sessions with Activity Overview while preserving adoption, selection, and guarded kill.
11. Add project profile review/create flow.
12. Add checkpoint create/list/restore/delete and preflight integration for replace/bulk-kill/checkpoint replace.
13. Add handoff export from pane/activity/palette.
14. Add tools/continuity menu entries and help-overlay chord rows.
15. Style responsive, keyboard-visible, scroll-bounded dialogs using existing tokens; no new visual system.

**Behavioral constraints**

- Overlay keydown stops propagation before xterm.
- Async operations have pending, empty, disconnected, timeout, and error states.
- No control action edits live daemon pane state optimistically.
- Checkpoint/template load uses staged replay before panes mount and commits sidecar only after daemon confirmations.
- Auto-checkpoint recursion is explicitly prevented.
- Remote/read-only windows hide mutation surfaces and never save productivity/checkpoints for the remote host.

**Milestone review/commit:** `feat(app): ship productivity and continuity suite`

## Task 7 — Documentation and constitution status

**Files**

- `README.md`
- `PRODUCT.md` only if capability inventory needs an additive sentence
- `AGENTS.md` build-status entry (worktree currently tracks it only if present at base; if absent, do not copy the dirty main-checkout file)
- design/plan/review documents

1. Document chords and truthful restore semantics.
2. Document `.amber.toml` schema and explicit no-command rule.
3. Document state files and privacy of checkpoints/handoffs.
4. Note daemon restart requirement for new protocol.
5. Record test counts and live verification evidence only after obtained; never pre-claim.

**Milestone review/commit:** `docs: document productivity suite`

## Task 8 — Full review and fast-mirror verification

### 8.1 Static/diff review

Review the complete merge-base diff through these lenses:

1. product scope and truthfulness;
2. daemon authority / one-way state flow;
3. concurrency, HOL blocking, locks, and bounded memory;
4. protocol compatibility and strict decoding;
5. filesystem/path security and privacy;
6. React/xterm lifecycle and render frequency;
7. keyboard, focus, labels, and screen-reader behavior;
8. test quality and failure-path coverage.

Fix all critical and important findings. Re-review changed regions.

### 8.2 Fast-mirror commands

After each sync into `/tmp/amber-productivity-suite-test`:

```bash
cargo test --workspace
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cd app
npm ci
npm test
npm run typecheck
npm run build
npm run build:web
```

If `npm ci` is already complete in the mirror and the lockfile is unchanged, reuse it between syncs by excluding `node_modules` from deletion or reinstall once after final sync.

### 8.3 Live isolated verification

Read `.agents/skills/verify/SKILL.md` fully, then use its private state/socket/Xvfb+CDP procedure from a fast source mirror/build output. Verify the scenarios in design §18. Do not touch the production daemon or user state.

### 8.4 Final artifacts

- Update design status and constitution only with observed evidence.
- Save final review report under `docs/superpowers/reviews/`.
- Ensure worktree is clean and all milestone commits contain no co-author lines.
