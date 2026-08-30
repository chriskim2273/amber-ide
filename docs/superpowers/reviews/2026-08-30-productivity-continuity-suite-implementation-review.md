# Productivity & Continuity Suite — Final Implementation Review

**Status:** complete; no open critical findings
**Reviewed:** 2026-08-30
**Branch:** `feat/productivity-suite`
**Design:** `docs/superpowers/specs/2026-08-29-productivity-continuity-suite-design.md`

## Scope reviewed

The final branch was reviewed against the architecture constitution and every acceptance criterion in the design: command palette, daemon-side global scrollback search, durable recovery history, workspace templates, desktop notifications, terminal bookmarks, activity overview, strict project profiles, named restore points, and session handoff export.

Review dimensions were architecture/authority, protocol compatibility, concurrency and head-of-line safety, persistence and crash safety, security boundaries, bounds/performance, renderer lifecycle, keyboard/accessibility behavior, remote-web isolation, test coverage, and live behavior.

## Requirement matrix

| Capability | Implementation evidence | Verification |
|---|---|---|
| Command palette | ranked pane/workspace/tab/action entries; toolbar and shared xterm/global chord | live CDP: opened, filtered, ran navigation/search/bookmark/activity commands |
| Global search | additive Rust/TS controls, ANSI/control sanitizer, scoped point-in-time rings, latest-request cancellation, worker reply | Rust unit/integration + live marker search and pane-local FindBar handoff |
| Recovery center | 500-event atomic daemon journal, lifecycle/restore/snapshot events, filters/actions/clear | Rust state/protocol tests + live create/restart and poison-restore persistence |
| Templates | bounded `productivity.json`, placeholder `WorkspaceDoc`, existing one-way `planLoad` path | live capture and instantiate created a daemon-confirmed new workspace |
| Notifications | bounded main-process bridge, preferences, mute/suppression/dedup, click-to-focus routing | TS policy/main behavior tests; OS notification click remains environment-manual |
| Bookmarks | xterm selected/cursor context capture, bounded durable metadata, rename/delete/find | live palette capture, browse, find text, and delete |
| Activity | daemon-derived summary/filter/sort and focus/adopt/suspend/export/guarded kill controls | live five-session overview with RSS and actions |
| `.amber.toml` | strict non-executable parser, realpath containment, explicit review | live accepted two-pane profile and rejected `command` key |
| Restore points | atomic bounded wrapper, metadata-prefix index, retention, preflight guards | tests + live create and restore-as-new with fresh daemon session |
| Handoff export | bounded validated base64 document, no reusable daemon name, atomic native save | schema and IPC-boundary tests; native save modal remains environment-manual |

## Architecture and correctness findings

### Closed during review

1. **Lifecycle broadcast could trail journal fsync.** A watcher subscribing after `Created` could receive its full snapshot and then a duplicate added-only delta. Lifecycle truth now broadcasts before recovery journaling (`88f9bd9`); the previously failing rename watcher integration test passes.
2. **Checkpoint listing parsed complete files.** Listing up to 100 potential 128 MiB documents violated the bounded-index design. New files put validated metadata first; listing reads only a 4 KiB prefix, rejects symlinks, and full parsing happens only on restore (`8b67a48`, `f3ec31a`).
3. **Queued productivity CAS writes could erase remote changes.** Operations now queue and replay in order over the last confirmed disk value, and replay again over a conflict response before retrying (`0e78748`).
4. **Search copied every ring and stale searches kept running.** Manager snapshotting now filters scope before copying; each connection has a latest-request epoch, and stale scans cancel between copies/lines without replying (`d8e8420`).
5. **Project review reused stale profile state.** Opening the project-profile command now resets prior review/error state and always requires an explicit reread; live testing caught and verified this fix (`0e78748`).
6. **New file boundaries needed stronger validation.** Productivity load/save and checkpoint indexing reject symlinks and oversized/non-regular files; handoff IPC validates size/schema/base64/metadata and writes through a unique atomic temp file (`f3ec31a`).
7. **New Rust compiler lint blocked warnings-as-errors.** The pre-existing byte-char slice warning was corrected without broad formatting churn (`88f9bd9`).

### Authority and one-way flow

- Daemon session lifecycle remains changed only by daemon events. Templates, project profiles, checkpoints, and workspace restores use existing `Create` plus pending confirmation; replace waits for daemon removals.
- Search and recovery are read-only daemon queries. App-owned data contains recipes, anchors, preferences, and export documents—not authoritative session existence or resumable process identity.
- Destructive replace/bulk-kill/restore-over flows require a successfully written, complete preflight restore point. A timed-out backlog capture cancels the destructive action.
- Arbitrary process-memory restoration is never claimed; restore-point UI says sessions are recreated and scrollback replayed.

### Concurrency and performance

- Search ring copy, sanitizer/scan, and response writes run off the connection read thread.
- Scope filtering happens before ring copies; invalid query/scope bounds are rejected before worker creation; a newer request cancels stale work.
- DumpBacklog retains the existing off-read-thread single-binary-frame discipline.
- Recovery history and control replies are bounded. Lifecycle broadcasts happen before fsync-backed journal writes so UI truth is not delayed behind persistence.
- PTY output still bypasses React state; no output-chunk renderer update was introduced.

### Security and compatibility

- Browser/web message mapping gained no productivity protocol operation. Desktop-only surfaces are capability-hidden when the web bridge lacks productivity storage.
- Remote SSH windows remain read-only for every new main-process IPC handler.
- `.amber.toml` rejects execution fields, absolute/traversing paths, unknown keys/kinds, and symlink escapes after realpath.
- Checkpoint IDs are validated before path construction; handoff suggested filenames are reduced to a basename.
- New control variants are additive and unknown variants retain the existing lenient-control behavior. Older daemons produce explicit desktop timeouts rather than infinite loading.

## Automated gates (fast mirror only)

All commands ran under `/tmp/amber-productivity-suite-test`; none ran in the `/media` worktree.

- Rust full workspace: **622 passed, 1 intentional ignored**, twice with `--test-threads=1`.
- Rust clippy: `cargo clippy --workspace --all-targets -- -D warnings` passed.
- App: **616 passed, 1 intentional skipped**.
- TypeScript strict typecheck passed for renderer and Node configs.
- Electron production bundle passed.
- Web production bundle passed; only the existing large-chunk advisory remains.
- Full `cargo fmt --check` still reports repository-wide pre-existing formatting drift, already recorded in the project constitution; no broad cleanup was mixed into this feature.

One initial parallel Rust run exposed two unrelated manager-test timing flakes. Both targeted tests passed, the feature-induced watcher race was fixed separately, and two complete serial runs passed. This is test-isolation debt, not evidence of a productivity-suite runtime failure.

## Live verification

An isolated daemon/state/home and Electron app were built and driven from the fast mirror under xvfb/CDP:

- searched a real PTY marker globally, selected the result, and saw the pane-local FindBar focused with the same query;
- captured/deleted a terminal bookmark;
- captured and instantiated a workspace template;
- restarted the daemon, restored all sessions, and observed prior recovery events plus the new restore summary;
- planted a poison session whose scrollback path was a directory, restarted, kept five healthy sessions, and observed durable `session.restore_failed` plus warning summary events;
- created and restored a named restore point as a new workspace/session;
- reviewed and created a two-pane project profile, then rejected an unsupported `command` field;
- opened the activity overview with five daemon sessions, memory totals, filters, and actions;
- verified command palette toolbar and action paths throughout.

Native OS notification clicking and native handoff save-dialog interaction are not automatable through the available headless CDP harness; their pure/main-process boundaries are tested and remain the two manual environment gestures.

## Final assessment

No critical or high-severity architecture, security, correctness, performance, or compatibility issue remains in the reviewed diff. The two native-environment gestures above are verification limitations, not missing implementation.
