# Deep Review — Productivity & Continuity Suite Implementation Plan

**Reviewed:** `docs/superpowers/plans/2026-08-29-productivity-continuity-suite-implementation.md`
**Context:** reviewed after the design review and before code changes.

## Verdict matrix

| Dimension | Verdict | Critical | Important | Minor |
|---|---:|---:|---:|---:|
| Design coverage | PASS | 0 | 0 | 1 |
| Task ordering/dependencies | PASS WITH FIXES | 0 | 2 | 2 |
| TDD/verification quality | PASS | 0 | 1 | 1 |
| Architecture/concurrency | PASS WITH FIXES | 0 | 2 | 1 |
| Security/privacy | PASS | 0 | 1 | 1 |
| Delivery/rollback practicality | PASS WITH FIXES | 0 | 2 | 2 |

**Overall:** PASS WITH FIXES. The plan is executable without an unresolved architectural decision. The clarifications below are binding during execution.

## Coverage audit

| Design capability | Plan owner | Coverage |
|---|---|---|
| Command palette | Tasks 4, 6 | complete |
| Global search | Tasks 1, 4, 5, 6 | complete |
| Recovery center | Tasks 2, 4, 6 | complete |
| Templates | Tasks 3, 4, 6 | complete |
| Notifications | Tasks 3, 4, 6 | complete |
| Bookmarks | Tasks 3–6 | complete |
| Activity overview | Tasks 4, 6 | complete |
| `.amber.toml` | Tasks 3, 6 | complete |
| Restore points | Tasks 3, 6 | complete |
| Handoff export | Tasks 3, 5, 6 | complete |

## Findings and execution clarifications

### Task ordering

**Important — protocol routing belongs with each protocol milestone, not postponed to UI.**
The plan already mentions TS routing in Tasks 1/2. Execution must include preload/main/client plumbing and focused tests before those milestones commit, so later UI work never rests on an untested half-protocol.

**Important — productivity mutation API must exist before overlay work.**
Task 3 owns a renderer-callable load/save bridge and pure conflict retry helper; Task 6 must not invent ad hoc direct saves per dialog.

**Minor — pane hook tests depend on pure request models from Task 4.**
The ordering is correct; keep Task 5 after Task 4.

**Minor — documentation status cannot update `AGENTS.md` if it is not tracked at the feature base.**
Do not copy the main checkout’s untracked constitution into this branch. Update tracked public docs and the suite docs only; call out the absent tracked status file in the final recap.

### TDD and verification

**Important — establish a real failing test, not only a compile failure, for HOL behavior.**
The integration test should force a scan delay through a test-only hook/barrier, issue another control on the same socket, and assert the second request is processed before the delayed search result. A naturally fast 2 MiB scan is not a stable regression test.

**Minor — component rendering remains largely untested in this repository.**
Compensate with pure-model tests plus the required live CDP verification; do not add a second renderer test framework in this suite.

### Architecture and concurrency

**Important — journal locking must cover read-modify-write as one critical section.**
A mutex only around atomic write still loses concurrent appends. Hold it from load through cap/sequence assignment through successful replacement. Reads may take the same mutex for a coherent snapshot.

**Important — search result writes are bounded but still share the writer.**
The worker must use existing `write_frame`/`write_bounded`, not raw `write_all`; otherwise this feature would reopen the wedged-client freeze class.

**Minor — event recording must be best-effort around core lifecycle success.**
A recovery-journal disk failure cannot make a successful create/kill/rename appear failed after the authoritative state already changed. Log journal errors; only list/clear requests surface them directly.

### Security/privacy

**Important — checkpoint format should remain accepted by normal `.amberws` import.**
Implement checkpoint metadata as an additive top-level `checkpoint` field on an otherwise-valid `WorkspaceDoc`, not as an incompatible outer object despite the design’s shorthand “wrapper”. Existing parser ignores unknown top-level fields, preserving portability and manual recovery.

**Minor — notification click events must be window-scoped.**
Create the notification from the sender’s `WindowCtx`; on click signal only that renderer. Never broadcast a session name to remote/read-only windows.

### Delivery and rollback

**Important — one giant final UI commit would be hard to audit and revert.**
Within Task 6, commit coherent submilestones if the diff becomes large: navigation/search/recovery; templates/bookmarks; checkpoints/handoff; activity/notifications. Conventional commits remain required.

**Important — automatic checkpoint policy must not deadlock destructive flows.**
Represent destructive operation as an explicit async state machine:
`idle → checkpointing → confirmed → executing`, with errors returning to idle. Never trigger it from an effect watching the same kill/load state.

**Minor — app main IPC handlers are process-global.**
Register each channel once and route by sender/`WindowCtx`, matching existing daemon-command handling. Do not register handlers inside `openWindow`.

**Minor — full `npm ci` after every source sync is unnecessary.**
Install after lockfile changes and reuse the fast mirror’s `node_modules`; source sync must exclude it from deletion.

## Pre-implementation gate

The plan passes because it now has:

- a defined authority and persistence location for every datum;
- a bounded protocol and worker-thread rule for the riskiest operation;
- a safe, deliberately non-executable repository profile;
- transactional semantics for destructive-operation preflight;
- pure-test seams for every complex renderer policy;
- fast-mirror verification that honors the user’s drive constraint;
- explicit compatibility, privacy, and failure behavior.
