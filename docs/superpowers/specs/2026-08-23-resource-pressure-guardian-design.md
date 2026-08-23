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

A private transient Linux service verifies real cgroup placement, CPU weights,
foreground responsiveness, PSI event delivery, one-at-a-time parking, exact
resume, and graceful operation when CPU delegation or PSI access is removed.
This proof must not restart the user's production Amber daemon.

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

Verification ran in the resource-pressure-guardian worktree at commit
`5c7aa5daf5dbe52cb3b14eb1a3d745f57596fb82`, on Linux with a user systemd
manager and cgroup v2. This record is evidence, not a production-rollout
approval.

| Gate | Command | Result |
| --- | --- | --- |
| Rust formatting | `cargo fmt --all -- --check` | **failed** (exit 1): rustfmt reported repository-wide formatting differences (7,815 displayed diff lines; output was truncated). No formatting changes were made in this task. |
| Rust lint | `RUSTFLAGS='-D warnings' cargo clippy --workspace --all-targets` | **failed** (exit 101): `clippy::field_reassign_with_default` at `crates/amber-core/src/state.rs:1258-1265`, promoted by `-D warnings`. |
| TypeScript | `cd app && npm run typecheck` | passed (exit 0). |
| Rust tests | `cargo test --workspace` | passed (exit 0): 569 tests, 23 suites. |
| App tests | `cd app && npm test -- --run` | passed (exit 0): 560 passed, 1 skipped, 42 files (41 passed). Expected malformed-frame stderr was emitted by a connection test. |
| Unit parity | `cd app && npm test -- --run src/main/serviceManager.test.ts` | passed (exit 0): 21 tests. |
| Unit syntax | `systemd-analyze --user verify infra/daemon/amber.service` | passed (exit 0). |

### Isolated Linux evidence and cleanup

The existing `claude_supervise` fixture was run as
`cargo test -p amber --test claude_supervise suspend_reclaims_a_stubborn_descendant_before_reporting_suspended -- --exact --nocapture`
and passed (1 test, 9 filtered). It launches the worktree test binary under a
temporary user unit, creates a fake recorded Claude workload, proves a
workload leaf is emptied before suspension completes, then resumes the exact
recorded id (`--resume conv-42`) and drops its temporary state.

An additional manually inspected private unit,
`amber-task6-rpg-cfnp89.service`, ran only
`target/debug/amber daemon --root /tmp/amber-task6-rpg.cFnP89 --socket
/tmp/amber-task6-rpg.cFnP89/amberd.sock` with `Delegate=cpu memory`.
Its cgroup was
`/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/amber-task6-rpg-cfnp89.service`.
Observed controls were `cgroup.controllers = cpu memory pids`,
`cgroup.subtree_control = cpu memory`, `_daemon/cpu.weight = 10000`,
`session-1/cpu.weight = 1000` after focus, and
`session-2/cpu.weight = 100`; live fake workloads were in their matching
`session-{slot}/workload` leaves. This proves actual direct-child placement
and weights, not a CPU-share benchmark.

The private unit initially did not stop through the normal stop request. Each
remaining PID was then verified by command line, temporary root/socket, and
private cgroup before TERM was sent: daemon `1494362`, supervisors `1501012`
and `1501061`, and fake workload shells `1501086` and `1501108`. All exited
within one second. The unit then reported `MainPID=0`, `ActiveState=inactive`,
`SubState=dead`; its cgroup was absent. Only the validated temporary root
`/tmp/amber-task6-rpg.cFnP89` (including its socket) was removed.

Deterministic policy proof used the existing test suite rather than waiting
120 real seconds: `host_pressure_waits_snapshots_and_honors_cooldown` proves
no candidate at 119,999 ms, one at 120,000 ms, and no second selection until
the 10-second cooldown expires. The workspace test run also covers
foreground-after-rename exclusion, ignored background output vs user input,
safety exclusions, protocol capability gating, configuration defaults,
partial CPU activation, and UI reducer/banner/parked-overlay behavior.

### Requirement audit and remaining risk

Goals and thresholds (CPU 25%, I/O 20%, memory 2%; 120-second sustain;
10-second cooldown), capability-gated watcher v2, configuration normalization,
safe candidate ordering/exclusions, snapshot-before-park, exact resume,
memory-path preservation, degraded PSI/CPU behavior, additive UI handling,
rollback settings, and service-unit parity all have automated evidence above.

The following are **not** fully live-proven: deterministic PSI injection into
the running private daemon, delivery of a live `ResourcePressure` watcher
event, an automatic one-at-a-time host-pressure parking transition, and an
actual CPU-share/foreground-responsiveness benchmark. Existing fixtures prove
the relevant state-machine and suspension/resume components but do not expose
a safe live PSI source. The two failed static gates also block a green
pre-rollout gate.

Safety incident: during the private proof, the command
`AMBER_SOCK=/tmp/amber-task6-rpg.cFnP89/amberd.sock timeout 1 ./target/debug/amber attach foreground`
was used without the CLI's required `--socket` flag. This CLI ignores
`AMBER_SOCK` for that command and resolved the default production user socket;
it resolved a production session named `foreground` and sent Focus/Attach for
up to one second. Production `amber.service` was **not** installed, restarted,
stopped, killed, or otherwise lifecycle-mutated. No attempt was made to guess
or restore production focus state. Treat this as a verification-safety failure
when deciding rollout approval.
