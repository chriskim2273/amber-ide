# Amber Memory Containment and Safe Session Parking — Design

**Date:** 2026-08-13
**Status:** Implemented; private Linux pressure verification complete;
repository formatting gate, production rollout, and real-Mac verification
pending
**Supersedes:** The deferred Slice 2 and Slice 3 designs in
`2026-07-17-memory-monitor-throttle-design.md`. The shipped Slice 1 memory
monitor remains compatible.

## Problem

Amber can preserve sessions across client crashes and daemon restarts, but the
process trees inside those sessions can consume enough memory to freeze the
machine. This is not primarily an Electron or daemon heap problem. At planning
time on the Linux development machine, `amber.service` used about 16.4 GiB and
held roughly 1,800 tasks while daemon process itself used only tens of MiB RSS.
The parent `app.slice` had a 24 GiB hard limit and no swap. During 2026-08-12
pressure event, service recorded an 18.5 GiB peak; a cgroup OOM event made
systemd SIGKILL descendant tools and main daemon under current stop policy.

Amber needs to keep its control plane responsive, limit the damage from one
session, and reclaim memory from sessions that can be resumed precisely.

## Guarantee boundary

No external controller can guarantee both zero interruption and tolerance of
unbounded memory growth. This design therefore makes the following promise:

- The daemon is isolated from session workloads on Linux.
- Each session receives a soft memory boundary, not a default OOM boundary.
- Amber automatically parks only supervised agent sessions with a recorded
  resume id and no recent interaction or output.
- Amber snapshots state before automatic parking.
- Shells, shell fallbacks, retrying agents, manually suspended panes, and
  sessions without a recorded id are never automatically parked.
- When no safe candidate exists, Amber reports that reclamation is blocked. It
  does not silently kill work.

A pathological shell, a silent long-running tool, or a workload where every
session remains protected can still reach an ancestor hard limit. A hard
`MemoryMax` remains an explicit administrator choice, not a product default.

## Decisions

### Linux containment uses delegated cgroup v2

`amber.service` remains under the existing user `app.slice`. The service gains:

```ini
Delegate=memory
MemoryAccounting=yes
MemoryHigh=50%
OOMPolicy=continue
```

`MemoryHigh=50%` is an aggregate soft boundary. `memory.high` applies reclaim
pressure and throttling but does not invoke the cgroup OOM killer. No default
`MemoryMax` is added.

Daemon owns only children below delegated service cgroup. It never writes
systemd-owned resource attributes such as service-root `memory.high` or
`memory.max`. It does write delegated core files `cgroup.procs` and
`cgroup.subtree_control` to move itself and enable child memory control, as
required by cgroup-v2 delegation.

### Process hierarchy

```text
amber.service/                  systemd-owned attributes; no processes
├── _daemon/                    daemon only; memory.low=128 MiB
├── session-<stable-slot>/      memory.high=4 GiB; no processes
│   ├── supervisor/             amber run for agent panes
│   └── workload/               shell, or agent plus MCP descendants
└── session-<stable-slot>/
    └── workload/               shell plus descendants
```

The path uses persisted `SessionMeta.slot`, not the session name. Rename keeps
the same cgroup. Reboot restore uses the same slot. User-controlled names never
become filesystem components.

The daemon moves itself to `_daemon` before enabling `+memory` on the service
root. This satisfies cgroup v2's no-internal-process rule. Missing cgroup v2,
missing delegation, a missing memory controller, or a permission failure
disables containment for that run and logs once; sessions still start.
Amber resolves cgroup2 root and mount point from `/proc/self/mountinfo`; it does
not assume hierarchy is mounted at `/sys/fs/cgroup`.

Activation validates before migration. If enabling `+memory` fails after daemon
moves, it rolls daemon back to service root and disables containment. Once
controller is enabled, a `memory.low` write failure is logged but containment
stays active; moving daemon back would violate no-internal-process rule.

### Placement must happen before exec or fork

`portable-pty` 0.9 does not expose a public `pre_exec` hook. Moving the child
after PTY spawn is racy because the target may fork first, leaving descendants
in the daemon leaf.

Amber adds a hidden internal command:

```text
amber __cgroup-exec --slot <n> --role <supervisor|workload> -- <program> [args]
```

The launcher accepts a numeric slot and fixed role, never a raw cgroup path. It
derives the delegated root from its current cgroup, moves itself to the target
leaf, and `exec`s the real program. Placement failure logs and executes
uncontained instead of losing the pane.

Shell panes launch through wrapper into `workload`. Agent panes launch
`amber run --slot <n>` into `supervisor`; explicit slot avoids create-time race
with metadata persistence. Supervisor launches Claude, Grok, or Codex through
wrapper into `workload`. Final PTY still owns one real process; launcher exists
only before `exec`.

### Whole-workload suspension

The current supervisor kills only its direct agent child. MCP servers and other
grandchildren can survive. Under cgroup containment, suspension uses
`cgroup.kill` on `workload`, waits for it to empty, and keeps the supervisor and
PTY alive. Unsupported platforms reuse the existing descendant snapshot plus
process-group kill path from `PtySession::kill`, then wait for the direct child.
On older cgroup-v2 kernels without `cgroup.kill`, Amber enumerates leaf
`cgroup.procs`, sends SIGKILL, and counts success only after recursive
`cgroup.events` reports `populated 0`.

The supervisor reports `suspended`, idles, and resumes through the existing
recorded-id ladder. Shell fallback stays in `supervisor`, is reported as
`shell-fallback`, and is never suspended. Before reporting fallback and
`exec`ing shell, supervisor ignores SIGUSR1/SIGUSR2; ignored dispositions
survive exec and close the brief asynchronous report race.

### Restore normalizes supervised session kind

Today a shell containing a hand-started Claude sets `resume_as_claude=true`.
After restart, `restore_one` launches the Claude supervisor but leaves persisted
kind as `Shell`. That makes UI, rename, raw attach, and suspension decisions
disagree with the running process.

During restore, Amber atomically rewrites:

```text
kind=Shell, resume_as_claude=true
```

to:

```text
kind=Claude, resume_as_claude=false
```

before spawning. A live hand-started Claude remains a shell until restart; it
is not automatically parked. This avoids signaling an ordinary shell process.

### Suspend origin is daemon runtime truth

Each `PtySession` tracks:

```rust
enum SuspendOrigin {
    None,
    Manual,
    Memory,
}
```

The value is concurrency-safe and not persisted. Manual suspend claims
`Manual` before signaling. The guardian can claim only `None`. Manual suspend
may replace `Memory`, preventing a focus event from undoing the user's freeze.
Resume clears the origin only after signaling succeeds; a failed signal restores
the prior value.

Each session also has one short transition mutex. Suspend, resume, and focus
hold it across eligibility checks, origin changes, and signal delivery. This
prevents focus from clearing Memory after the guardian claims it but before
SIGUSR1 is delivered.

For a new suspend, manager requires persisted agent kind and run state
`claude`. It rejects `claude-retrying` and `shell-fallback` at daemon trust
boundary. Manual suspend may replace existing Memory origin: an already
`suspended` session is reclassified without another signal, while a still
running `claude` session is signaled so manual request cannot be lost.

No protocol field is added for the origin. `SessionInfo.run_state` projects
supervisor state `suspended` plus origin `Memory` as `memory-suspended`. Manual
suspension remains `suspended`.

## Memory guardian

### Configuration

Old configuration files remain valid:

```rust
#[serde(default)]
pub memory: MemoryConfig

#[serde(default)]
pub struct MemoryConfig {
    pub enabled: bool,              // default true
    pub budget_mb: Option<u64>,     // default None
    pub session_high_mb: u64,       // default 4096
}
```

An operator who wants an explicit 12 GiB aggregate calibration with the
default 4 GiB per-session soft boundary can use:

```toml
[memory]
enabled = true
budget_mb = 12288
session_high_mb = 4096
```

`budget_mb` calibrates Amber's warning, critical, and parking thresholds; it is
not a hard allocation limit. Linux still clamps it to the lowest finite cgroup
boundary. The installed systemd unit's default `MemoryHigh=50%` is the aggregate
soft reclaim boundary. Administrators may add `MemoryMax=` in a systemd drop-in,
but that is a destructive OOM boundary: crossing it can kill workload processes
and, if no reclaimable child remains, the daemon. Amber intentionally ships no
default `MemoryMax`.

On macOS, the same guardian policy uses process-tree RSS and can park recorded
idle agent sessions, but there is no cgroup placement or soft throttling.

`budget_mb` is a calibration override. Before ancestor limits, runtime clamping
keeps aggregate budget at least 512 MiB and per-session soft boundary at least
256 MiB. A lower ancestor boundary still wins because descendants cannot escape
it. Effective session boundary cannot exceed known effective aggregate budget.

On Linux, the effective aggregate budget is the lowest finite value among the
configured override or 50% of physical RAM, the service/ancestor
`memory.high`, and service/ancestor `memory.max`. On macOS or a Linux fallback,
it is the configured override or 50% of physical RAM.

If physical memory cannot be read and no configured or cgroup boundary exists,
Amber keeps per-session RSS telemetry but disables pressure transitions and
automatic parking for that run.

### Pressure state

- Normal: below 70% of the effective budget.
- Warning: at or above 70%.
- Critical: at or above 80%; parking may begin.
- Clear: return to Normal only below 65%, providing hysteresis.

Linux samples aggregate `memory.current` every second. Fallback platforms use
the existing process-tree RSS scan every three seconds. The existing per-pane
`MemoryStat.rss_kb` keeps its RSS meaning; cgroup charge is reported separately
as aggregate pressure.

### Candidate safety and ordering

A session is eligible only when all conditions hold:

- Persisted kind is Claude, Grok, or Codex.
- Run state is `claude`.
- The state store contains a recorded session id.
- Suspend origin is `None`.
- No focus, input, or output activity occurred in the last 120 seconds.

New sessions start protected. Focus and input refresh protection. Existing
rate-limited PTY output activity supplies output timestamp. Guardian and PTY
activity use the same existing monotonic clock origin.

Candidates sort by oldest last use, then largest session memory, then name.
Only one candidate is parked per poll. The guardian remeasures before another
action.

### Automatic parking sequence

1. Remeasure aggregate pressure.
2. Select one safe candidate.
3. Flush `SessionManager::snapshot()`.
4. Recheck eligibility and atomically claim `SuspendOrigin::Memory`.
5. Signal suspend.
6. Supervisor kills workload subtree, waits for it to empty, reports
   `suspended`, and idles. It retries cleanup and never reports success while
   descendant remains.
7. Watchers receive updated session state and aggregate pressure.

Snapshot failure, missing resume id, a lost eligibility race, or failed
suspension produces a blocked pressure state and no destructive action.

Parked sessions never auto-resume when pressure clears. Explicit focus, input,
manual Resume, raw attach, or mobile selection resumes a memory-parked session
and protects it for another 120 seconds.

While one Memory-origin suspension is still waiting for workload to empty,
guardian remeasures but does not select second victim. Pending cleanup keeps
normal critical status for 10 seconds, then reports blocked pressure until
supervisor confirms `suspended`. Pending timestamp is runtime-only and clears
on rollback, manual override, or resume.

## Protocol

Two additive control messages are sufficient:

```rust
Focus { name: String }

MemoryPressure {
    level: String,      // normal | warning | critical
    current_kb: u64,
    budget_kb: u64,
    blocked: bool,
}
```

`Focus` is a hint, not authoritative UI state. It has a one-shot TTL through
the recent-use timestamp, so no Unfocus message or per-client focus registry is
needed.

`MemoryPressure` rides the existing bounded watcher broadcast. Transition
events are immediate; unchanged pressure is refreshed at most every three
seconds.

## Clients

- Electron sends Focus only for real terminal panes on focus or click. Browser
  and editor panes never send daemon focus.
- `Frame::Data` refreshes use and resumes a memory-parked session before
  forwarding input.
- `amber attach` sends Focus before Attach.
- `amber web` adds `focus` to its explicit browser whitelist and sends it only
  when the user selects a session, not when a background pane socket opens.
- Unknown or non-live names are ignored or returned as the existing daemon
  error; no new authority is added to the browser client.

## UI

The UI reuses current components and tokens:

- Existing top banner shows warning or critical aggregate pressure.
- `paneDot` and tab aggregation understand `memory-suspended`.
- A memory-parked terminal shows a focusable overlay: “Parked to protect system
  memory” with a Resume button.
- The overlay resembles the existing frozen overlay but is not written to
  `layout.frozen`.
- Focusing or activating the overlay sends Focus. The xterm instance remains
  mounted.
- Manual frozen state remains independent and is never undone by focus.

## Installation and upgrade

Both systemd unit copies must carry identical memory directives:

- `infra/daemon/amber.service`
- the embedded `AMBER_SYSTEMD_UNIT` in `app/src/main/index.ts`

After writing the unit, Linux install/upgrade performs `daemon-reload`, enables
the unit, and explicitly restarts it. `enable --now` alone does not refresh
properties on an already-running service. Snapshot is attempted before the
restart. The restart is expected; sessions restore from the existing state
store.

## Cross-platform behavior

Linux with delegated cgroup v2 receives containment, exact aggregate charge,
per-session soft throttling, and whole-workload cleanup. macOS and unsupported
Linux receive the guardian using process-tree RSS and existing kill fallback,
without cgroup soft throttling. Windows remains out of scope.

## Verification

Automated tests cover pure policy, backward-compatible config, protocol shapes,
cgroup path validation, nonblocking control-file writes, lifecycle cleanup,
restore normalization, suspend races, browser whitelisting, reducer behavior,
and install-unit parity.

A Linux transient user service with a deliberately low budget and a fake agent
that allocates memory and forks a stubborn child must prove:

- correct daemon/supervisor/workload placement;
- oldest safe idle agent parks first;
- the workload cgroup empties and aggregate memory falls;
- focused work remains interactive;
- create, attach, input, kill, snapshot, and watcher paths remain responsive;
- desktop, web, and raw attach resume the same recorded id;
- rename and daemon restart preserve slot, name, cwd, scrollback, and
  conversation;
- nondelegated startup still works; and
- a 30–60 minute pressure soak produces no daemon OOM or control-plane wedge.

Real-Mac verification covers RSS-based pressure, safe parking, focus resume,
and persistence without cgroup access.

### Verification log

- 2026-08-13 automated gates on Linux 7.0.0 x86_64, systemd 255, Rust
  1.96.1: Rust tests passed twice (438 each); app tests passed (478 with one
  intentional skip); equivalent warnings-as-errors clippy, TypeScript
  typecheck, production bundle, systemd unit verification, and lockfile check
  passed. The literal clippy command is misrouted by the repository command
  hook; `RUSTFLAGS='-D warnings' cargo clippy --workspace --all-targets` passed.
  `cargo fmt --all -- --check` did not pass: rustfmt 1.9 reports repository-wide
  formatting differences in pre-existing Rust files, while this documentation
  task changed no Rust source. The automated release gate is therefore not
  fully green.
- 2026-08-13 private Linux proof used a transient `amber-memory-test.service`
  with an isolated `/tmp/amber-memory-test.*` state root, 512 MiB
  `MemoryHigh`, `Delegate=memory`, `OOMPolicy=continue`, and no `MemoryMax`.
  The service root stayed empty; the daemon, supervisors, workloads, shell, and
  stubborn descendants appeared in the expected slot leaves. Every session
  parent read `memory.high=536870912`. Reclaim raised the service `high` event
  counter while `oom` and `oom_kill` stayed zero. List, create, attach, input,
  kill, snapshot, and watcher traffic remained responsive.
- Guardian proof: the oldest idle recorded agent parked before the focused
  agent, its workload leaf became unpopulated, and service charge fell from
  about 444 MiB to 228 MiB. The blocked-critical watcher event was observed
  when no candidate was yet eligible. Raw attach resumed the exact
  `sid-mem-idle`; a manual suspension remained `suspended` after Focus. Shell
  rename preserved PID and slot; agent rename changed supervisor PID while
  preserving slot and recorded id. Kill removed the supervisor, stubborn
  descendant, and slot cgroups. Private daemon restart restored name, cwd,
  scrollback, slots, and the exact recorded conversation id. A direct
  nondelegated daemon logged one containment warning and still supported
  create, attach/input, list, and kill.
- Pressure soak ran 1,820 seconds with 180 samples at ten-second intervals.
  All 180 samples reported active/running and all 180 two-second `amber ls`
  probes succeeded. After reclaim, charge stayed about 429–431 MiB, peak was
  570,601,472 bytes, task count stayed 13, `high=3308`, and `oom=oom_kill=0`.
  The private unit was then stopped, its validated state root removed, and the
  unit reported inactive/dead with PID 0.
- Production rollout is intentionally deferred: installing this worktree build
  would restart live user sessions. The production daemon remained PID 2314
  throughout the proof. Real-Mac verification is pending because this host is
  Linux; no macOS result is claimed. Desktop/mobile resume and renderer-banner
  behavior remain automated-test evidence rather than live GUI/phone evidence
  in this pass.

## Rollback

Setting `[memory] enabled = false` and restarting disables automatic parking.
To disable Linux containment too, restore the previous unit file that omitted
the memory directives, or override the installed unit with explicit neutral
values:

```ini
[Service]
Delegate=no
MemoryAccounting=no
MemoryHigh=infinity
MemoryMax=infinity
OOMPolicy=stop
```

After `systemctl --user daemon-reload`, restart the service. An empty
`Delegate=` is not the rollback syntax: systemd treats it as delegation enabled
with the controller list reset. `MemoryHigh=infinity` disables throttling and
`MemoryMax=infinity` removes any administrator hard cap. No state migration is
introduced; session metadata, scrollback, and conversation records remain
readable by the previous binary.

## Authoritative references

- Linux kernel cgroup v2 documentation:
  <https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html>
- systemd cgroup delegation:
  <https://systemd.io/CGROUP_DELEGATION/>
- systemd resource control:
  <https://man7.org/linux/man-pages/man5/systemd.resource-control.5.html>
- systemd service OOM policy:
  <https://www.man7.org/linux/man-pages/man5/systemd.service.5.html>
- portable-pty 0.9 `CommandBuilder`:
  <https://docs.rs/portable-pty/0.9.0/portable_pty/cmdbuilder/struct.CommandBuilder.html>
