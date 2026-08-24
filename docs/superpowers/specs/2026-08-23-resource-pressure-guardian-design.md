# Amber Resource-Pressure Guardian — Design

**Date:** 2026-08-23
**Status:** Approved for implementation planning
**Extends:** `2026-08-13-amber-memory-containment-design.md`

## Problem

Amber's existing memory guardian safely parks resumable agent sessions when
Amber approaches its aggregate memory budget. It does not react to sustained
host CPU or I/O pressure. It also treats PTY output as recent use. A hidden
agent that continuously emits output therefore remains protected even when its
workload contributes to a system-wide freeze.

On the affected Linux host, memory remained available while Amber's agent
workloads saturated the CPUs and a USB-backed worktree generated high I/O
pressure. A host-level balancer now limits the entire `amber.service` cgroup,
but an aggregate limit cannot distinguish the foreground pane from background
agents. Under contention it throttles the daemon and every session together.

Amber needs to preserve its control plane, favor the pane the user is working
in, and safely park resumable background agents only after pressure has been
sustained long enough to rule out ordinary bursts.

## Goals

- Keep the Amber daemon responsive while session workloads are CPU-bound.
- Preserve more CPU share for the most recently focused terminal pane.
- React to sustained host CPU, I/O, or memory PSI on Linux.
- Park the least recently user-active safe agent after 120 seconds of
  continuous host pressure.
- Ignore background output when ranking host-pressure candidates.
- Reuse the existing snapshot, suspension, workload cleanup, and exact-resume
  machinery.
- Preserve existing memory containment behavior and configuration.
- Degrade cleanly when PSI or delegated CPU control is unavailable.

## Non-goals

- Hard per-session CPU limits.
- Killing shells, shell fallbacks, retrying agents, or sessions without a
  recorded resume id.
- Automatically resuming parked work when pressure clears.
- Device-specific I/O bandwidth controls.
- Replacing the host-level `amber-codex-mem-balance` envelope.
- Windows support.

## Architecture

Resource management remains split across two ownership boundaries:

1. `amber-codex-mem-balance` owns the host-level envelope. It may adjust the
   aggregate Amber CPU and memory ceilings according to whole-machine
   pressure.
2. The Amber daemon owns session policy. It knows stable slots, focus, run
   state, recorded resume ids, cgroup placement, and suspension transitions.

The daemon extends its current memory guardian into a resource-pressure
guardian. The existing memory-budget path remains intact. A new Linux PSI path
adds CPU, I/O, and host-memory signals. Both paths feed the same safe parking
operation, but they use different notions of recency:

- Existing memory-budget parking continues to use focus, input, and output
  activity. This preserves the conservative guarantee from the memory
  containment design.
- Host-pressure parking uses only user focus and input. Continuous output from
  a hidden background agent does not prevent parking.

The manager tracks the foreground session by persisted numeric slot, not by
name. Rename therefore cannot remove foreground protection. The most recently
focused live slot remains protected until another live terminal pane receives
focus. Browser and editor panes do not replace it.

## Pressure inputs and state

Linux reads these PSI files once per second:

- `/proc/pressure/cpu`: `some avg10`
- `/proc/pressure/io`: `full avg10`
- `/proc/pressure/memory`: `full avg10`

Default host-pressure thresholds are:

| Signal | Critical threshold |
| --- | ---: |
| CPU `some avg10` | 25% |
| I/O `full avg10` | 20% |
| Memory `full avg10` | 2% |

Crossing any threshold starts a critical episode. Host-pressure parking becomes
eligible only after the threshold remains crossed for 120 consecutive seconds.
Falling below every active threshold before then cancels the episode. After a
parking action, the guardian waits 10 seconds and remeasures before selecting
another candidate. It parks at most one session per cooldown interval.

The existing aggregate memory-budget state machine remains the emergency
memory path. It may park immediately at its existing critical boundary; it does
not wait 120 seconds while Amber approaches an ancestor memory limit.

Default PSI thresholds, the 120-second sustain interval, and the 10-second
cooldown are optional configuration values. Existing configuration files
remain valid. The existing `[memory].enabled` setting remains the global switch
for all automatic parking so an operator's prior opt-out is respected.

Unsupported platforms and Linux hosts without readable PSI files keep the
existing memory guardian and omit host-pressure parking.

## CPU prioritization

The Linux systemd unit delegates both `cpu` and `memory`. During cgroup
activation, Amber enables both controllers at the service root when available.
Memory containment remains active if CPU delegation is unavailable.

The cgroup hierarchy remains structurally unchanged:

```text
amber.service/
├── _daemon/
├── session-<slot>/
│   ├── supervisor/
│   └── workload/
└── session-<slot>/
    ├── supervisor/
    └── workload/
```

Amber applies relative CPU weights at the direct children of the service root:

- `_daemon`: `cpu.weight=10000`
- foreground session: `cpu.weight=1000`
- every background session: `cpu.weight=100`

Weights matter only while siblings contend. They do not reserve idle CPU and
do not create a hard per-session ceiling. The existing host-level 8/6/4-core
normal/contended/critical envelope remains the aggregate limit.

Focus immediately promotes the new slot and demotes the previous slot. Create,
rename, restore, remove, and focus paths reconcile weights. A failed weight
write is logged once and does not fail the user operation or disable memory
containment.

The daemon remains in `_daemon`, so its high relative weight keeps control,
snapshot, watcher, and resume paths responsive during workload contention.

## Candidate safety and ordering

A host-pressure candidate must satisfy all existing automatic-parking safety
conditions:

- Persisted kind is Claude, Grok, or Codex.
- Run state is exactly `claude`.
- A non-empty recorded resume id exists.
- Suspend origin is clear.
- No user focus or input occurred during the last 120 seconds.
- Stable slot is not the current foreground slot.

Shells, shell fallbacks, retrying agents, manually suspended panes, and sessions
without a resume id remain ineligible.

Candidates sort by oldest user activity, then largest measured session memory,
then name. Output timestamps do not participate in host-pressure ordering. New
sessions begin with fresh user activity and cannot be parked for at least 120
seconds.

The final eligibility check runs under the existing per-session suspension
transition lock. A focus or input event that wins the race prevents parking.

## Parking and resume flow

For each eligible host-pressure action, the guardian:

1. Remeasures PSI and confirms the 120-second critical episode.
2. Selects one eligible background candidate.
3. Flushes `SessionManager::snapshot()`.
4. Rechecks foreground slot, user recency, run state, resume id, and suspend
   origin under the transition lock.
5. Claims automatic pressure suspension.
6. Signals the existing supervisor suspension path.
7. Waits for the workload cgroup to empty and the supervisor to report
   `suspended`.
8. Broadcasts updated session and resource-pressure state.
9. Starts the 10-second cooldown before considering another candidate.

Automatic pressure suspension uses a generalized runtime origin. It is not
persisted. Manual suspension can still replace an automatic origin, and focus
can resume only an automatic origin. Existing memory-suspended values remain
accepted during a rolling client/daemon upgrade.

Parked sessions never auto-resume when pressure clears. Focus, terminal input,
`amber attach`, mobile selection, or explicit Resume restarts the exact recorded
conversation and refreshes its 120-second protection.

## Protocol and UI

`MemoryPressure` remains unchanged for aggregate-memory telemetry. A new
additive watcher event reports host resource pressure:

```rust
ResourcePressure {
    level: String,       // normal | critical
    causes: Vec<String>, // cpu | io | memory
    blocked: bool,
}
```

`WatchMemoryPressure { version: 2 }` advertises support for this new event.
Version-1 watchers continue receiving only `MemoryPressure`; the daemon never
sends `ResourcePressure` to a strict older client. The existing decoder's
unknown-control skip remains a second compatibility boundary, not the primary
negotiation mechanism.

Transition events broadcast immediately. Unchanged state follows the existing
bounded watcher refresh behavior.

The Electron client:

- Shows a banner naming active causes, such as CPU or I/O pressure.
- Uses “Parked to protect system resources” for automatically parked panes.
- Keeps the xterm instance mounted.
- Sends Focus only for real terminal panes, as it does today.
- Accepts both the legacy `memory-suspended` projection and the generalized
  resource-suspended projection during upgrades.

Manual frozen state remains separate and is never cleared by focus.

## Configuration

New optional fields use serde defaults and require no migration:

```toml
[pressure]
cpu_some_percent = 25
io_full_percent = 20
memory_full_percent = 2
sustain_seconds = 120
cooldown_seconds = 10
```

`[memory].enabled = false` disables both memory-budget and host-pressure
automatic parking. Memory telemetry and PSI telemetry may continue for UI and
diagnostics.

Invalid zero intervals or non-finite percentage values fall back to defaults
with one startup warning. Threshold percentages are clamped to the PSI range
of 0 through 100.

## Failure handling

- PSI read or parse failure skips that sample and logs at a bounded rate. It
  does not manufacture a normal sample that would falsely clear an episode.
- If every PSI source remains unavailable, host-pressure parking disables for
  that run while memory-budget parking continues.
- Missing delegated CPU control disables CPU weighting only.
- Snapshot failure, lost eligibility, missing resume id, or suspension failure
  produces blocked pressure state and performs no destructive fallback.
- A pending suspension retains the existing 10-second stall detection. The
  guardian does not choose another victim until the first transition resolves.
- Unknown protocol events remain safely ignorable by older clients through the
  existing additive protocol handling.

## Verification

Automated Rust tests cover:

- PSI parsing for valid, missing, malformed, and non-finite fields.
- Threshold evaluation for CPU, I/O, and memory causes.
- Cancellation before 120 seconds and eligibility at 120 seconds.
- Cooldown enforcement and one-candidate-per-step behavior.
- Foreground-slot exclusion across rename.
- User-input protection while background output does not protect a host-
  pressure candidate.
- Existing conservative output protection for memory-budget candidates.
- Safety exclusions for shells, fallbacks, retries, manual suspension, and
  missing resume ids.
- CPU controller partial activation and nonfatal weight-write failures.
- Correct daemon, foreground, and background weights in a fake cgroup tree.
- Backward-compatible configuration and protocol serialization.

Electron tests cover reducer behavior, banner causes, legacy state acceptance,
the generalized parked overlay, and focus resume.

Before rollout, a private transient Linux service must verify real cgroup
placement, CPU weights, foreground responsiveness, PSI event delivery,
one-at-a-time parking, exact resume, and graceful operation when CPU
delegation or PSI access is removed. It must not restart the user's production
Amber daemon.

Before production rollout, run workspace Rust tests, app tests, TypeScript
typecheck, clippy with warnings denied, systemd unit parity checks, and the
repository's formatting gate. Production installation remains a separate
explicit restart step because it interrupts live session processes while they
are restored.

## Success criteria

- Opening ChatGPT while Amber agents run no longer makes Firefox, Discord, or
  the Amber client unusable.
- Amber daemon control operations remain responsive under the aggregate CPU
  quota.
- Foreground terminal receives substantially more CPU time than background
  sessions during contention.
- A hidden, output-producing agent becomes eligible after 120 seconds without
  user focus or input.
- No foreground session, shell, fallback, retrying agent, manual freeze, or
  unresumable agent is automatically parked.
- Pressure is remeasured between every parking action.
- Exact conversation resume and existing memory containment guarantees remain
  intact.

## Rollback

Setting `[memory].enabled = false` disables all automatic parking. Removing the
new `[pressure]` table restores default thresholds.

To disable CPU prioritization, restore `Delegate=memory`, reload the user
systemd manager, and restart `amber.service`. Memory containment and the
existing guardian continue to work. No persisted session-state migration is
introduced, so an older daemon can read the same state store.

## Task 6 verification record (2026-08-23)

Corrective verification ran in the resource-pressure-guardian worktree through
fix-round-4 commit `1b18cb5bb87f529296dbbc7f368be9f788a24df1`, on
Linux with a user systemd manager and cgroup v2. Round 5 then added and checked
the transient-unit cleanup regression described below. The corrective proof
used only a validated temporary state root, an explicit socket under that root,
and a unique private transient unit. It did not query, restart, stop, attach to,
or focus the production Amber service or its default socket.

| Gate | Command | Result |
| --- | --- | --- |
| Rust formatting (branch) | `cargo fmt --all -- --check` | **failed** (exit 1): repository-wide formatting differences; output was truncated after 7,913 lines. No broad formatting rewrite was applied. |
| Rust formatting (merge base) | `cargo fmt --all -- --check` at merge base `ae889630c8ffcf5f435b665a0a5a7541653c47a6` in a temporary worktree | **failed** (exit 1): the same repository-wide drift was already present; output was truncated after 8,837 lines. The temporary worktree was removed. |
| Rust lint | `RUSTFLAGS='-D warnings' cargo clippy --workspace --all-targets` | passed (exit 0). |
| TypeScript | `cd app && npm run typecheck` | passed (exit 0). |
| Rust tests | `cargo test --workspace` | passed on the second full run: 570 passed, 1 ignored, 23 suites. The first full run had one failure in `agent_rename_keeps_memory_suspension_resumable_on_focus`; its exact rerun passed before the clean full rerun. |
| App tests | `cd app && npm test -- --run` | passed: 561 passed, 1 skipped, 42 files. Expected malformed-frame stderr was emitted by a connection test. |
| Unit parity | `cd app && npm test -- --run src/main/serviceManager.test.ts` | passed (exit 0): 21 tests. |
| Unit syntax | `systemd-analyze --user verify infra/daemon/amber.service` | passed with no diagnostics. This verifies the file; it does not install or restart the unit. |
| Patch hygiene | `git diff --check` | passed. |
| Cleanup regression | `cargo test -p amber --test claude_supervise delegated_daemon_inspection_failure_cleans_exact_private_unit_and_root -- --exact --nocapture` | passed: 1 test. Fake `systemd-run`/`systemctl` executables force inspection failure without contacting systemd, then verify exact-unit stop/reset, private-root removal, and preservation of an adjacent sentinel. |
| Focused lint after cleanup fix | `RUSTFLAGS='-D warnings' cargo clippy -p amber --test claude_supervise` | passed. |
| Guarded private Linux proof | `target/debug/deps/claude_supervise-0267583557aef905 --ignored isolated_delegated_cgroup_places_workloads_and_weights_sessions --nocapture` | passed after the cleanup fix: 1 test. |

### Guarded private Linux proof

The ignored, fail-closed proof
`isolated_delegated_cgroup_places_workloads_and_weights_sessions` passed in
round 4 and was rerun successfully after the round-5 cleanup-guard change. The
round-5 run used root `/tmp/.tmpFlEGyQ`, socket
`/tmp/.tmpFlEGyQ/amberd.sock`, and unique unit
`amber-task6-cgroup-676007-0.service`. Its cgroup root was:

```text
/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/amber-task6-cgroup-676007-0.service
```

The proof asserts all of the following against the real private cgroup v2
hierarchy:

- `cpu` and `memory` are present in both `cgroup.controllers` and
  `cgroup.subtree_control`.
- Foreground slot 1 and background slot 2 each have populated `supervisor` and
  `workload` leaves. Every PID in each leaf reports the matching
  `session-<slot>/<role>` suffix in `/proc/<pid>/cgroup`.
- CPU weights are exactly `_daemon=10000`, foreground session `=1000`, and
  background session `=100`.
- Both private sessions are removed. The guard invokes stop/reset using the
  exact generated unit name, and the proof observes that the quoted cgroup root
  no longer exists.

The round-5 guard is constructed immediately after `systemd-run` returns and
before socket waiting, `systemctl show`, cgroup-path assertions, controller
reads, or weight/placement inspection. Successful startup transfers the guard
to `RunningDaemon`; any panic or early return drops it. The focused fake-command
regression proves that an inspection failure issues `stop` and `reset-failed`
only for that generated unit, removes only its validated private state root,
and preserves an adjacent sentinel.

Synthetic unit-policy evidence, rather than a live 120-second episode, comes
from `host_pressure_waits_snapshots_and_honors_cooldown`: no candidate at
119,999 ms, one at 120,000 ms, and no second selection until the 10-second
cooldown expires. The workspace test run also covers
foreground-after-rename exclusion, ignored background output vs user input,
safety exclusions, protocol capability gating, configuration defaults,
partial CPU activation, and UI reducer/banner/parked-overlay behavior.

### Original production Focus/Attach incident

The first Task 6 verification run at
`5c7aa5daf5dbe52cb3b14eb1a3d745f57596fb82` was noncompliant. It ran:

```bash
AMBER_SOCK=/tmp/amber-task6-rpg.cFnP89/amberd.sock timeout 1 \
  ./target/debug/amber attach foreground
```

The command omitted the required `--socket` flag. That CLI ignores
`AMBER_SOCK` for this command, resolved the default production user socket, and
sent Focus/Attach for a production session named `foreground` for up to one
second. Production `amber.service` was not installed, restarted, stopped, or
killed, but production focus/session state could have changed. No restoration
was attempted by guessing the prior state. The later guarded proof is separate
corrective evidence; it does not erase or relabel this original safety
incident.

### Requirement audit, rollout status, and remaining risk

Automated coverage supports PSI parsing/thresholds, synthetic sustain/cooldown
policy, capability-gated watcher v2, configuration normalization, candidate
safety/order, snapshot/transition safeguards, exact-resume components,
memory-path preservation, degraded PSI/CPU branches, additive UI handling,
rollback settings, and service-unit parity. It does not prove every goal or
success criterion in a live system.

The proof establishes delegated controller availability, real process
placement, and configured relative weights. It does **not** measure foreground
responsiveness or actual CPU share under contention. Live PSI injection,
`ResourcePressure` watcher delivery, a live automatic one-at-a-time parking
episode, and user-visible Firefox/Discord/Amber responsiveness all remain
unproven. Existing fixtures expose no safe injectable live PSI source.

Production rollout is therefore **not approved by this record**. Clippy,
workspace tests, app tests, typecheck, unit parity/syntax, the private cgroup
proof, and patch hygiene are green. The repository formatting gate remains red,
with merge-base evidence that the drift predates this branch. More importantly,
the required live PSI/automatic-parking and responsiveness acceptance evidence
is still absent. No production installation or restart has been performed.

## Final review fix wave (2026-08-23)

Implementation commit `5c33e61ad620dc9d8d7c7d8a75866a4214c62c6a`
addresses the final concurrency, timing, and safe-hardening findings.

### Reconciliation and timing corrections

- A manager-owned mutex now serializes every CPU-weight reconciliation. Each
  pass reads the latest foreground slot only after taking that mutex. Focus and
  input update the atomic slot under the session transition lock, release that
  per-session lock, and run the O(session-count) cgroup pass only when the slot
  changed. Create, restore, rename, remove, and reap retain membership-change
  reconciliation.
- Host PSI is timestamped immediately after the PSI files are sampled, after
  earlier memory work. The manager takes a new monotonic timestamp after the
  snapshot and final metadata checks when it records a pending pressure
  suspend, then takes another timestamp after the supervisor signal succeeds.
  Only that successful-signal timestamp starts the ten-second host cooldown.
- Invalid explicit pressure percentages and zero intervals now produce one
  daemon-start warning when deserialization clamps or replaces them. The
  diagnostic stays outside `PressureConfig`, preserving its public and
  serialized data shape.
- Unsupported non-Linux targets skip PSI polling for the guardian run. Linux
  does not mutate this capability flag after an unavailable sample, so a
  transient read or parse failure is retried on the next tick.
- The private cleanup validator now rejects the OS temporary directory itself,
  requires a strict temporary-directory child, and requires an exact
  test-owned marker before a cleanup guard may own that root.

### TDD regression evidence

| Regression | RED evidence before the fix | GREEN evidence |
| --- | --- | --- |
| `manager::tests::concurrent_focus_reconciliation_uses_latest_slot_without_holding_transition_lock` | Deterministic barrier/condition-variable interleaving left the older slot at weight `1000` instead of `100`. | passed: 1 test. The hook observed non-overlapping passes, latest-slot final weights, and a released session transition lock. |
| `manager::tests::repeated_input_on_the_foreground_slot_skips_cpu_reconciliation` | Three writes to the already-foreground slot observed 3 reconciliation starts instead of 0. | passed: 1 test. |
| `memory_guardian::tests::delayed_sampling_snapshot_and_signal_use_fresh_guardian_timestamps` | Failed to compile because the fresh-sample and injected-clock boundaries did not exist and host action returned only a boolean. | passed: 1 test. It proves a 60-second pre-sample delay does not shorten the 120-second episode, a 30-second snapshot delay does not backdate pending-stall time, and cooldown starts five seconds later only after the signal. |
| `state::tests::pressure_config_reports_only_explicit_values_that_were_normalized` | Failed to compile before the normalization diagnostic existed. | passed: 1 test. |
| `host_pressure::tests::host_psi_polling_matches_compile_time_platform_support` | Failed to compile before the explicit platform capability existed. | passed: 1 test. |
| `private_root_validator_rejects_temp_directory_and_unmarked_children` | Failed to compile before the ownership marker helper existed. | passed: 1 test. |

The current stderr-only startup logging has no injectable logging abstraction,
so the focused configuration test covers the one-shot diagnostic input rather
than capturing global process stderr.

### Final-wave verification

| Gate | Command | Result |
| --- | --- | --- |
| Focus race | `cargo test -p amber manager::tests::concurrent_focus_reconciliation_uses_latest_slot_without_holding_transition_lock -- --exact --nocapture` | passed: 1 passed, 463 filtered. |
| Repeated input | `cargo test -p amber manager::tests::repeated_input_on_the_foreground_slot_skips_cpu_reconciliation -- --exact --nocapture` | passed: 1 passed, 463 filtered. |
| Delayed clock | `cargo test -p amber memory_guardian::tests::delayed_sampling_snapshot_and_signal_use_fresh_guardian_timestamps -- --exact --nocapture` | passed: 1 passed, 463 filtered. |
| Config diagnostic | `cargo test -p amber-core state::tests::pressure_config_reports_only_explicit_values_that_were_normalized -- --exact --nocapture` | passed: 1 passed, 113 filtered. |
| PSI platform capability | `cargo test -p amber host_pressure::tests::host_psi_polling_matches_compile_time_platform_support -- --exact --nocapture` | passed: 1 passed, 463 filtered. |
| Cleanup ownership | `cargo test -p amber --test claude_supervise private_root_validator_rejects_temp_directory_and_unmarked_children -- --exact --nocapture` | passed: 1 passed, 12 filtered. |
| Cleanup failure path | `cargo test -p amber --test claude_supervise delegated_daemon_inspection_failure_cleans_exact_private_unit_and_root -- --exact --nocapture` | passed: 1 passed, 12 filtered. |
| Rust lint | `RUSTFLAGS='-D warnings' cargo clippy --workspace --all-targets` | passed. |
| Rust workspace | `cargo test --workspace` | passed: 577 passed, 1 ignored, 23 suites. |
| Guarded private Linux proof | `target/debug/deps/claude_supervise-0267583557aef905 --ignored --exact isolated_delegated_cgroup_places_workloads_and_weights_sessions --nocapture` | passed: 1 passed, 12 filtered. Root `/tmp/.tmp76csA8`; unit `amber-task6-cgroup-870666-0.service`; exact weights `10000/1000/100`; quoted cgroup removed. |
| Rust formatting | `cargo fmt --all -- --check` | failed with 8,011 repository-wide diff lines. The merge-base failure above proves this drift predates the branch; no broad `manager.rs` or repository formatting rewrite was applied. |
| Patch hygiene | `git diff --check` | passed. |
| App tests/typecheck | not run in this wave | No app file changed; the complete prior app gates remain recorded above. |

No production/default socket or service command was run. The first Cargo
wrapper attempt to run the ignored proof reported 0 passed and 1 ignored and
started no daemon; the strengthened guarded test binary was then run directly.
The original production Focus/Attach incident remains recorded above and is
not superseded by this proof.

Production rollout remains **not approved**. The private proof re-establishes
controller delegation, process placement, relative weights, and fail-closed
cleanup after the validator change. It still does not prove live PSI watcher
delivery, a live automatic one-at-a-time parking episode, actual CPU share or
foreground responsiveness under contention, or the user-visible
Firefox/Discord/Amber success criteria.
