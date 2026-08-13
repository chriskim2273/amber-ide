# Amber Memory Containment and Safe Session Parking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Amber and the host machine responsive under session memory pressure while preserving session identity, scrollback, and precisely resumable agent conversations.

**Architecture:** On Linux, delegate the `memory` cgroup-v2 controller to `amber.service`, isolate the daemon from stable per-session supervisor/workload subtrees, and apply soft `memory.high` boundaries without a default OOM ceiling. A cross-platform guardian samples aggregate pressure, snapshots state, and parks one old, idle, recorded agent session at a time; focus or input resumes only memory-parked sessions.

**Tech Stack:** Rust 2021, `std`, existing `libc`/`nix`, `portable-pty` 0.9, cgroup v2, systemd user services, serde protocol frames, Electron, React, strict TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-13-amber-memory-containment-design.md`

## Global Constraints

- Before editing source, use `superpowers:using-git-worktrees` and create an isolated worktree, for example `../amber-ide-memory-guardian` on `feat/memory-guardian`.
- The daemon remains the single source of truth for terminal-session existence and runtime state.
- The app remains a disposable client; memory-suspended state must not enter the layout sidecar.
- No new Rust crate, npm dependency, native Node addon, runtime service, or Windows target.
- Linux containment must degrade to the existing process-tree behavior when cgroup v2 or delegation is unavailable.
- `MemoryStat.rss_kb` keeps its existing RSS meaning; cgroup `memory.current` is separate aggregate charge telemetry.
- Never add a default `MemoryMax`; `memory.high` is the default containment mechanism.
- Never automatically park shells, `shell-fallback`, `claude-retrying`, manually suspended sessions, sessions without a recorded id, or sessions used within the last 120 seconds.
- Snapshot before every automatic park. A snapshot failure blocks the action.
- Park at most one session per guardian poll and never auto-resume when pressure clears.
- Both systemd unit copies must contain `Delegate=memory`, `MemoryAccounting=yes`, `MemoryHigh=50%`, and `OOMPolicy=continue`.
- Use conventional commits without `Co-Authored-By` lines.
- Before Task 7, use `design-master`; preserve existing banner, overlay,
  spacing, color, and focus patterns instead of redesigning interface.
- Do not mark the project checklist complete until automated, isolated Linux, pressure-soak, and real-Mac gates pass.

---

## Execution Preflight

- [ ] **Step 1: Ensure planning documents are on the source branch**

```bash
git status --short -- \
  docs/superpowers/specs/2026-08-13-amber-memory-containment-design.md \
  docs/superpowers/plans/2026-08-13-amber-memory-containment.md
```

If either file is uncommitted, commit only those two before creating worktree:

```bash
git add \
  docs/superpowers/specs/2026-08-13-amber-memory-containment-design.md \
  docs/superpowers/plans/2026-08-13-amber-memory-containment.md
git commit -m "docs: plan memory containment"
```

- [ ] **Step 2: Create required worktree**

```bash
git worktree add ../amber-ide-memory-guardian -b feat/memory-guardian
cd ../amber-ide-memory-guardian
```

- [ ] **Step 3: Re-read project instructions and design**

```bash
cat CLAUDE.md
cat docs/superpowers/specs/2026-08-13-amber-memory-containment-design.md
```

- [ ] **Step 4: Establish a clean baseline**

```bash
git status --short
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
npm --prefix app test -- --run
npm --prefix app run typecheck
npm --prefix app run build
```

Expected: clean worktree and all existing gates pass. Record any pre-existing environmental failure before changing code.

---

### Task 1: Backward-Compatible Memory Configuration and Pure Guardian Policy

**Files:**
- Modify: `crates/amber-core/src/state.rs:92-115`
- Modify: `crates/amber/src/procinfo.rs`
- Create: `crates/amber/src/memory_guardian.rs`
- Modify: `crates/amber/src/lib.rs`

**Interfaces:**
- Consumes: existing `Config`, `SessionKind`, `procinfo::process_table()`, and monotonic millisecond timestamps.
- Produces: `MemoryConfig`, `PressureLevel`, `Candidate`, `pressure_level`, `select_candidate`, and `procinfo::total_memory_kb` for later tasks.

- [ ] **Step 1: Write failing config compatibility tests**

Add these tests beside existing config tests in `crates/amber-core/src/state.rs`:

```rust
#[test]
fn config_written_before_memory_guardian_still_loads() {
    let dir = tempfile::tempdir().unwrap();
    let store = StateStore::new(dir.path());
    std::fs::create_dir_all(dir.path()).unwrap();
    std::fs::write(
        dir.path().join("config.toml"),
        "claude_path = \"/usr/bin/claude\"\nsnapshot_interval_secs = 10\nscrollback_bytes = 2097152\n",
    )
    .unwrap();

    let cfg = store.load_config().unwrap();
    assert_eq!(cfg.memory, MemoryConfig::default());
}

#[test]
fn memory_config_round_trips() {
    let dir = tempfile::tempdir().unwrap();
    let store = StateStore::new(dir.path());
    let mut cfg = Config::default();
    cfg.memory.enabled = false;
    cfg.memory.budget_mb = Some(6144);
    cfg.memory.session_high_mb = 2048;

    store.save_config(&cfg).unwrap();
    assert_eq!(store.load_config().unwrap(), cfg);
}

#[test]
fn partial_memory_section_uses_defaults() {
    let cfg: Config = toml::from_str(
        "snapshot_interval_secs = 10\nscrollback_bytes = 2048\n[memory]\nenabled = false\n",
    )
    .unwrap();
    assert!(!cfg.memory.enabled);
    assert_eq!(cfg.memory.budget_mb, None);
    assert_eq!(cfg.memory.session_high_mb, 4096);
}

#[test]
fn memory_budget_uses_available_sources_and_clamps_session_high() {
    let cfg = MemoryConfig::default();
    assert_eq!(cfg.budget_kb(Some(32 * 1024 * 1024), None), Some(16 * 1024 * 1024));
    assert_eq!(cfg.budget_kb(None, Some(8 * 1024 * 1024)), Some(8 * 1024 * 1024));
    assert_eq!(cfg.budget_kb(None, None), None);
    assert_eq!(cfg.session_high_kb(Some(512 * 1024)), 512 * 1024);
}
```

- [ ] **Step 2: Run the two tests and verify RED**

```bash
cargo test -p amber-core config_written_before_memory_guardian_still_loads
cargo test -p amber-core memory_config_round_trips
```

Expected: compilation fails because `MemoryConfig` and `Config::memory` do not exist.

- [ ] **Step 3: Add the minimal config types and runtime clamping**

Implement in `state.rs`:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryConfig {
    pub enabled: bool,
    pub budget_mb: Option<u64>,
    pub session_high_mb: u64,
}

impl Default for MemoryConfig {
    fn default() -> Self {
        Self { enabled: true, budget_mb: None, session_high_mb: 4096 }
    }
}

impl MemoryConfig {
    pub fn budget_kb(
        &self,
        physical_kb: Option<u64>,
        cgroup_limit_kb: Option<u64>,
    ) -> Option<u64> {
        let requested = self.budget_mb
            .map(|mb| mb.saturating_mul(1024))
            .or_else(|| physical_kb.map(|kb| kb / 2))
            .or(cgroup_limit_kb)?
            .max(512 * 1024);
        Some(cgroup_limit_kb.map_or(requested, |limit| requested.min(limit)))
    }

    pub fn session_high_kb(&self, budget_kb: Option<u64>) -> u64 {
        let requested = self.session_high_mb
            .saturating_mul(1024)
            .max(256 * 1024);
        budget_kb.map_or(requested, |budget| requested.min(budget))
    }
}
```

Add `#[serde(default)] pub memory: MemoryConfig` to `Config` and initialize it in `Default`.

- [ ] **Step 4: Run config tests and verify GREEN**

```bash
cargo test -p amber-core config_
cargo test -p amber-core memory_config_round_trips
```

Expected: all matching config tests pass, including pre-memory config fixtures.

- [ ] **Step 5: Write failing physical-memory parser tests**

Add pure parser coverage in `procinfo.rs`:

```rust
#[test]
fn parses_linux_memtotal_in_kibibytes() {
    assert_eq!(parse_memtotal_kb("MemTotal:       32620768 kB\nMemFree: 1 kB\n"), Some(32_620_768));
}

#[test]
fn rejects_missing_or_malformed_memtotal() {
    assert_eq!(parse_memtotal_kb("MemFree: 42 kB\n"), None);
    assert_eq!(parse_memtotal_kb("MemTotal: nope kB\n"), None);
}
```

- [ ] **Step 6: Implement `total_memory_kb` without a dependency**

Use `/proc/meminfo` on Linux and
`nix::libc::sysctlbyname("hw.memsize")` on macOS. Return `Option<u64>`; return
`None` on unsupported systems or read failure. Keep `parse_memtotal_kb` private
and pure.

- [ ] **Step 7: Write failing pressure and candidate tests**

Create `memory_guardian.rs` and add tests for every policy branch:

```rust
#[test]
fn pressure_uses_hysteresis() {
    assert_eq!(pressure_level(PressureLevel::Normal, 699, 1000), PressureLevel::Normal);
    assert_eq!(pressure_level(PressureLevel::Normal, 700, 1000), PressureLevel::Warning);
    assert_eq!(pressure_level(PressureLevel::Warning, 800, 1000), PressureLevel::Critical);
    assert_eq!(pressure_level(PressureLevel::Critical, 699, 1000), PressureLevel::Warning);
    assert_eq!(pressure_level(PressureLevel::Warning, 649, 1000), PressureLevel::Normal);
}

#[test]
fn selects_oldest_safe_candidate_then_largest_then_name() {
    let now = 500_000;
    let candidates = vec![
        candidate("focused", 1, 400_000, true, true, true, false),
        candidate("b", 900, 100_000, true, true, true, false),
        candidate("a", 900, 100_000, true, true, true, false),
        candidate("shell", 2000, 0, false, true, true, false),
    ];
    assert_eq!(select_candidate(now, &candidates).map(|c| c.name.as_str()), Some("a"));
}

#[test]
fn excludes_recent_unrecorded_nonrunning_and_suspended_sessions() {
    let now = 500_000;
    let cases = [
        candidate("recent", 1, now - 1, true, true, true, false),
        candidate("no-id", 1, 0, true, true, false, false),
        candidate("retrying", 1, 0, true, false, true, false),
        candidate("manual", 1, 0, true, true, true, true),
    ];
    assert!(select_candidate(now, &cases).is_none());
}
```

Use `RECENT_USE_MS = 120_000`, integer percentage math, and deterministic sorting. `Candidate` must carry only data needed by the pure selector:

```rust
pub struct Candidate {
    pub name: String,
    pub memory_kb: u64,
    pub last_used_ms: u64,
    pub is_agent: bool,
    pub running: bool,
    pub has_resume_id: bool,
    pub suspended: bool,
}
```

The pure selector needs only a suspended boolean. Task 4 defines the canonical
origin enum and `SessionManager::memory_candidates` maps every non-`None`
origin to `suspended=true`.

- [ ] **Step 8: Run policy tests and verify RED**

```bash
cargo test -p amber memory_guardian::tests
```

Expected: compilation fails until `PressureLevel`, `pressure_level`, and `select_candidate` exist.

- [ ] **Step 9: Implement the pure policy and verify GREEN**

Implement exactly three levels (`Normal`, `Warning`, `Critical`), thresholds 70/80/65, candidate eligibility, and ordering. Do not start threads or read cgroups in this task.

```bash
cargo test -p amber memory_guardian::tests
cargo test -p amber procinfo::tests
cargo test -p amber-core
```

- [ ] **Step 10: Commit Task 1**

```bash
git add crates/amber-core/src/state.rs crates/amber/src/procinfo.rs crates/amber/src/memory_guardian.rs crates/amber/src/lib.rs
git commit -m "feat(core): add memory guardian policy"
```

---

### Task 2: Delegated Cgroup-v2 Containment and Upgrade-Safe Units

**Files:**
- Create: `crates/amber/src/cgroup.rs`
- Modify: `crates/amber/src/lib.rs`
- Modify: `infra/daemon/amber.service`
- Modify: `infra/daemon/install.sh:39-50`
- Modify: `app/src/main/index.ts:98-177`
- Modify: `app/src/main/serviceManager.ts`
- Modify: `app/src/main/serviceManager.test.ts`

**Interfaces:**
- Consumes: `MemoryConfig::session_high_kb`, `/proc/self/cgroup`,
  `/proc/self/mountinfo`, cgroup-v2 control files, and existing install paths.
- Produces: cloneable `CgroupManager`, `CgroupRole`, stable slot paths, aggregate/session accounting, bounded subtree kill/cleanup, and systemd units that delegate memory.

- [ ] **Step 1: Write failing cgroup path tests**

Add tests in `cgroup.rs`:

```rust
#[test]
fn parses_only_the_unified_cgroup_entry() {
    let body = "11:memory:/legacy\n0::/user.slice/user-1000.slice/user@1000.service/app.slice/amber.service\n";
    assert_eq!(
        parse_unified_path(body).unwrap(),
        PathBuf::from("/user.slice/user-1000.slice/user@1000.service/app.slice/amber.service")
    );
}

#[test]
fn rejects_parent_and_non_normal_components() {
    assert!(validate_relative(Path::new("../escape")).is_err());
    assert!(validate_relative(Path::new("session-1/../../escape")).is_err());
}

#[test]
fn slot_paths_never_include_session_names() {
    let paths = SessionPaths::new(Path::new("/sys/fs/cgroup/x"), 7).unwrap();
    assert_eq!(paths.parent, PathBuf::from("/sys/fs/cgroup/x/session-7"));
    assert_eq!(paths.supervisor, paths.parent.join("supervisor"));
    assert_eq!(paths.workload, paths.parent.join("workload"));
}

#[test]
fn resolves_cgroup2_mount_without_assuming_sys_fs_cgroup() {
    let mountinfo = "31 22 0:27 / /run/cgroup rw,nosuid,nodev,noexec - cgroup2 cgroup rw\n";
    let mount = parse_cgroup2_mount(mountinfo).unwrap();
    assert_eq!(
        resolve_cgroup_path(&mount, Path::new("/user.slice/amber.service")).unwrap(),
        PathBuf::from("/run/cgroup/user.slice/amber.service"),
    );
}
```

- [ ] **Step 2: Write the failing nonblocking-control-file test**

On Unix, create a temporary regular file, open it with the same private helper used for `memory.high`, and assert `O_NONBLOCK` through `fcntl(F_GETFL)`:

```rust
#[test]
fn memory_high_writer_is_nonblocking() {
    use std::os::fd::AsRawFd;
    let file = tempfile::NamedTempFile::new().unwrap();
    let opened = open_control_nonblocking(file.path()).unwrap();
    let flags = unsafe { nix::libc::fcntl(opened.as_raw_fd(), nix::libc::F_GETFL) };
    assert_ne!(flags & nix::libc::O_NONBLOCK, 0);
}
```

- [ ] **Step 3: Implement the cgroup manager**

Use this public surface:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CgroupRole { Supervisor, Workload }

#[derive(Clone, Debug)]
pub struct CgroupManager {
    root: Option<PathBuf>,
    session_high_bytes: Option<u64>,
}

impl CgroupManager {
    pub fn disabled() -> Self;
    pub fn activate() -> Self;
    pub fn set_session_high_kb(&mut self, session_high_kb: u64);
    pub fn is_enabled(&self) -> bool;
    pub fn prepare_session(&self, slot: u32) -> io::Result<()>;
    pub fn aggregate_current_kb(&self) -> io::Result<Option<u64>>;
    pub fn lowest_finite_limit_kb(&self) -> io::Result<Option<u64>>;
    pub fn session_current_kb(&self, slot: u32) -> io::Result<Option<u64>>;
    pub fn kill_workload(&self, slot: u32) -> io::Result<bool>;
    pub fn kill_session(&self, slot: u32) -> io::Result<bool>;
    pub fn remove_session(&self, slot: u32) -> io::Result<()>;
}
```

Implementation order on Linux:

1. Parse current unified cgroup plus cgroup2 root/mount point from mountinfo;
   resolve and validate path without assuming `/sys/fs/cgroup`, then require
   `memory` in `cgroup.controllers`.
2. Create `_daemon`.
3. Write the current PID to `_daemon/cgroup.procs`.
4. Write `+memory` to service-root `cgroup.subtree_control`.
5. Write `134217728` to `_daemon/memory.low`.
6. Store the validated service root.

Validate mount/controller before moving. If `+memory` fails after move, write
self back to service-root `cgroup.procs`, remove `_daemon`, and return disabled;
log rollback failure explicitly. Once `+memory` succeeds, keep containment
enabled. A later `memory.low` write failure logs once but does not move daemon
back into now-controller-owning inner root.

Mountinfo parser accepts only `cgroup2` separator entry, decodes standard proc
octal escapes (`040`, `011`, `012`, `134`), accounts for mount-root prefix, and
rejects any resolved non-normal or escaping component before filesystem writes.

`prepare_session` first kills, waits for, and removes any pre-existing subtree
for the same otherwise-unused slot; this clears crash leftovers before restore
or slot reuse. It then creates parent and two leaves, enables `+memory` on empty
parent, and writes `memory.high` with `open_control_nonblocking`. `kill_*` writes
`1` to `cgroup.kill` and waits at most two seconds for recursive
`cgroup.events` `populated 0`. If `cgroup.kill` is unavailable, enumerate
`cgroup.procs` in target leaves, send SIGKILL, and re-read until empty or the
same deadline. Return `true` only after recursive `populated 0`; callers then
know reclamation succeeded. Cleanup removes workload, supervisor, then parent.
All public methods return harmless disabled values when `root` is `None`.

`activate` establishes delegated hierarchy but does not choose policy. After
activation, startup reads finite ancestor limits, computes effective budget,
then calls `set_session_high_kb` before any session is prepared. `None`, not
numeric zero, represents an unconfigured boundary; `prepare_session` fails
closed until setter has been called.

Do not write service-root `memory.high`, `memory.max`, or other systemd-owned attributes.

- [ ] **Step 4: Run cgroup unit tests**

```bash
cargo test -p amber cgroup::tests
```

Expected: parser, containment, stable-path, finite-limit, and nonblocking tests pass without root or a real cgroup mount.

- [ ] **Step 5: Add service directives to both unit copies**

The `[Service]` section in `infra/daemon/amber.service` and the embedded unit must contain:

```ini
Delegate=memory
MemoryAccounting=yes
MemoryHigh=50%
OOMPolicy=continue
```

Move the embedded unit string to exported `AMBER_SYSTEMD_UNIT` in `serviceManager.ts`, then import it from `index.ts`; this gives the app test a direct, pure assertion target.

- [ ] **Step 6: Write failing service and restart-order tests**

Add to `serviceManager.test.ts`:

```typescript
it('delegates memory with a soft aggregate boundary and no hard max', () => {
  expect(AMBER_SYSTEMD_UNIT).toContain('Delegate=memory')
  expect(AMBER_SYSTEMD_UNIT).toContain('MemoryAccounting=yes')
  expect(AMBER_SYSTEMD_UNIT).toContain('MemoryHigh=50%')
  expect(AMBER_SYSTEMD_UNIT).toContain('OOMPolicy=continue')
  expect(AMBER_SYSTEMD_UNIT).not.toContain('MemoryMax=')
})

it('linux upgrade reloads, enables, then explicitly restarts', () => {
  expect(linuxInstallServiceArgv()).toEqual([
    { cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
    { cmd: 'systemctl', args: ['--user', 'enable', 'amber.service'] },
    { cmd: 'systemctl', args: ['--user', 'restart', 'amber.service'] },
  ])
})
```

Extract only the three-command builder needed by this test. Do not create a general service-command framework.

- [ ] **Step 7: Make both Linux installers restart an existing service**

In `infra/daemon/install.sh`, replace `enable --now` with:

```bash
"$BIN_DIR/amber" ctl snapshot-now >/dev/null 2>&1 || true
systemctl --user daemon-reload
systemctl --user enable amber.service
systemctl --user restart amber.service
```

Use the same command order in packaged `installDaemon()`. Keep the existing best-effort linger behavior. Do not change macOS install behavior.

- [ ] **Step 8: Verify unit syntax and app tests**

```bash
systemd-analyze --user verify infra/daemon/amber.service
npm --prefix app test -- --run src/main/serviceManager.test.ts
npm --prefix app run typecheck
cargo test -p amber cgroup::tests
```

- [ ] **Step 9: Commit Task 2**

```bash
git add crates/amber/src/cgroup.rs crates/amber/src/lib.rs infra/daemon/amber.service infra/daemon/install.sh app/src/main/index.ts app/src/main/serviceManager.ts app/src/main/serviceManager.test.ts
git commit -m "feat(daemon): add delegated memory containment"
```

---

### Task 3: Race-Free Slot Placement and Cgroup Lifecycle

**Files:**
- Modify: `crates/amber/src/main.rs`
- Modify: `crates/amber/src/manager.rs:140-900`
- Modify: `crates/amber/src/cgroup.rs`
- Modify: `crates/amber/tests/slots.rs`
- Modify: `crates/amber/tests/restart.rs`
- Modify: `crates/amber/tests/kill_group.rs`

**Interfaces:**
- Consumes: `CgroupManager`, persisted `SessionMeta.slot`, existing `maintenance` lock, `CommandBuilder`, and `resolve_current_exe`.
- Produces: hidden `__cgroup-exec`, `SessionManager::new_with_cgroups`, slot-aware spawn, and cleanup shared by remove/reap/spawn failure.

- [ ] **Step 1: Write failing hidden-launcher argument tests**

Add parser tests in `main.rs` for:

```text
amber __cgroup-exec --slot 7 --role workload -- /bin/sh -l
```

Assert that slot zero is rejected, role accepts only `supervisor|workload`, and the command vector must be non-empty. The command vector must use `OsString`, `trailing_var_arg = true`, and `allow_hyphen_values = true` so agent flags are preserved byte-for-byte.

Also parse `amber run name --kind claude --slot 7`; assert slot is retained, and
legacy invocation without `--slot` remains accepted for compatibility.

- [ ] **Step 2: Implement the hidden launcher**

Add a hidden Clap subcommand and dispatch:

```rust
Command::CgroupExec { slot, role, command } => {
    amber::cgroup::exec_current_into(slot, role.into(), command)
}
```

`exec_current_into` derives the service root from the launcher's current cgroup:

- current path ending in `_daemon` means service root is its parent;
- current path ending in `session-<n>/supervisor` or `/workload` means service root is the grandparent;
- any other shape disables placement for this exec.

It validates requested target exists under that root, writes `0` to target
`cgroup.procs`, and calls `CommandExt::exec`. On placement failure, log once and
still exec target command.

Extend internal `amber run` with hidden `--slot <n>`. Daemon always passes
allocated slot explicitly because create spawns before metadata persistence;
reading store in new supervisor would race. Direct legacy `amber run` without
flag may fall back to stored slot, or run uncontained when none exists.

- [ ] **Step 3: Write failing manager lifecycle tests**

Add or extend these exact manager tests with a fake-root `CgroupManager`:

- `create_allocates_slot_before_spawn_and_rolls_back_cgroup_on_persist_failure`:
  extend existing metadata-write-failure harness with fake cgroup, call
  `create`, assert error and no live session, then assert allocated `session-1`
  directory was removed.
- `missing_shell_is_reaped_without_a_cgroup_leak`: set `SHELL` to a nonexistent
  executable under repository's serial environment guard. Because hidden
  launcher itself spawns successfully, create may acknowledge before target
  `exec` fails; wait for normal reap, then assert metadata and `session-1` are
  gone.
- `concurrent_creates_get_unique_slots_without_persisted_reservations`: share an
  `Arc<SessionManager>`, release two create threads through a `Barrier`, then
  assert both sessions exist with distinct nonzero slots and exactly two stored
  metadata files.
- `restore_reuses_the_persisted_slot`: create and snapshot a shell, record its
  slot, construct a new manager on the same state root, restore, and assert the
  restored metadata and cgroup path use that slot.
- `shell_rename_keeps_pid_and_cgroup_slot`: record PID and slot, rename, and
  assert both values remain equal under the new name.
- `agent_rename_respawns_but_keeps_cgroup_slot`: use the existing fake-agent
  harness, assert PID changes while slot and recorded id remain equal.
- `reap_and_remove_clear_session_cgroups`: exercise explicit remove and natural
  exit in separate sessions; after each, assert the matching parent,
  supervisor, and workload directories are absent.

Use a test-only cgroup root constructor inside `cgroup.rs`; keep it `pub(crate)`
under `#[cfg(test)]` instead of introducing a trait. Its pseudo control files
emulate only directory creation/accounting. Omit `cgroup.kill` so manager stop
tests use direct-child fallback, report `is_enabled() == false` so commands stay
direct and no kernel-empty guarantee is claimed, and remove seeded regular
control files during test-only cleanup before removing directories. Manager
calls `prepare_session`/`remove_session` unconditionally; disabled production
methods remain no-ops.

- [ ] **Step 4: Add the cgroup-aware manager constructor**

Keep existing tests/source callers simple:

```rust
pub fn new(root: impl Into<PathBuf>) -> anyhow::Result<Self> {
    let root = root.into();
    let config = StateStore::new(&root).load_config()?;
    Self::new_with_cgroups(root, config, CgroupManager::disabled())
}

pub fn new_with_cgroups(
    root: impl Into<PathBuf>,
    config: Config,
    cgroups: CgroupManager,
) -> anyhow::Result<Self>;
```

Store `config` and `cgroups` directly on `SessionManager`. `run_daemon` loads
config once through `StateStore`, calls `CgroupManager::activate()`, computes
effective budget from physical memory and `lowest_finite_limit_kb()`, calls
`set_session_high_kb`, then passes same config plus manager into
`new_with_cgroups` before `restore()`. Pass `config.memory.clone()` and computed
budget to guardian in Task 5; do not reload config between containment and
guardian setup.

- [ ] **Step 5: Make command construction slot-aware**

Change signatures to:

```rust
fn command_for(
    &self,
    kind: SessionKind,
    name: &str,
    cwd: &Path,
    slot: u32,
) -> anyhow::Result<CommandBuilder>;

fn spawn(
    &self,
    kind: SessionKind,
    name: &str,
    cwd: &Path,
    slot: u32,
) -> anyhow::Result<Arc<PtySession>>;
```

When cgroups are enabled, `command_for` makes the current Amber binary the PTY command and passes `__cgroup-exec`, slot, role, `--`, then the original executable and arguments. Shell role is `workload`; agent `amber run` role is `supervisor`. Preserve all current cwd, TERM, COLORTERM, PATH, display, `AMBER_SESSION`, `AMBER_STATE_DIR`, and `AMBER_SOCK` behavior.
Agent argv includes hidden `--slot <slot>` after `run`; never make freshly
spawned supervisor rediscover its slot from not-yet-persisted metadata.

- [ ] **Step 6: Reorder create under the existing mutation lock**

Use this order:

1. Validate name and resolve cwd.
2. Acquire `maintenance`.
3. Reject both a live-name collision and an existing stored-name collision.
4. Read stored metadata outside `sessions`; derive used slots from the stored
   list and reject a stored-name collision.
5. Under a short `sessions` lock, reject a live-name collision; release it and
   keep `maintenance`.
6. Prepare cgroup.
7. Spawn through the wrapper.
8. Persist metadata.
9. Insert the live `Arc` under the short `sessions` lock.

On any failure after cgroup preparation: kill the spawned PTY if present, `kill_session(slot)`, remove the cgroup, and return the original error. Do not persist a reservation before spawn; `maintenance` serializes all slot-mutating paths.

- [ ] **Step 7: Apply the same mutation lock and cleanup to restore, rename, remove, and reap**

Lock order is always `maintenance`, then short `sessions`, then existing auxiliary maps. Never hold `sessions` during PTY kill, process scans, cgroup waits, or disk I/O.

Centralize cleanup:

```rust
fn stop_session(
    &self,
    slot: u32,
    session: Option<&Arc<PtySession>>,
) -> anyhow::Result<()> {
    let mut empty = self.cgroups.kill_session(slot).unwrap_or(false);
    if !empty {
        if let Some(session) = session { session.kill()?; }
        empty = self.cgroups.kill_session(slot).unwrap_or(false);
    }
    if self.cgroups.is_enabled() && !empty {
        anyhow::bail!("session cgroup {slot} remained populated");
    }
    self.cgroups.remove_session(slot)?;
    Ok(())
}
```

Use it for explicit remove, dead reap, failed create, and agent rename before
respawn. Explicit remove deletes live/store state only after cleanup succeeds;
reap retains failed cleanup for next retry. Failed-create cleanup preserves
original error and appends/logs cleanup error. For agent rename, stop old process
before store rename; if store rename fails, best-effort restore old metadata/name
and return error. Shell rename keeps running PID and cgroup path unchanged.

For restore, hold `maintenance` around the full deterministic restore/slot-repair
loop. Read and normalize stored metadata first, then prepare, spawn, and insert
each session without holding `sessions`; acquire `sessions` only for each final
insertion. Preserve the existing by-name `used` set so zero and duplicate slots
are repaired once and persisted before their cgroups are prepared.

- [ ] **Step 8: Run manager and process-lifecycle tests**

```bash
cargo test -p amber manager::
cargo test -p amber --test slots
cargo test -p amber --test restart
cargo test -p amber --test kill_group
```

- [ ] **Step 9: Commit Task 3**

```bash
git add crates/amber/src/main.rs crates/amber/src/manager.rs crates/amber/src/cgroup.rs crates/amber/tests/slots.rs crates/amber/tests/restart.rs crates/amber/tests/kill_group.rs
git commit -m "feat(daemon): place sessions in stable cgroups"
```

---

### Task 4: Restore Truth, Suspend Origin, and Whole-Workload Reclamation

**Files:**
- Modify: `crates/amber/src/pty.rs:72-97,159-364`
- Modify: `crates/amber/src/manager.rs:562-769`
- Modify: `crates/amber/src/supervisor.rs:101-213,386-510`
- Modify: `crates/amber/tests/claude_supervise.rs`
- Modify: `crates/amber/tests/run_state.rs`
- Modify: `crates/amber/tests/socket.rs`

**Interfaces:**
- Consumes: existing SIGUSR1/SIGUSR2 supervisor flags, recorded session ids, run-state reports, and Task 3 slot placement.
- Produces: canonical `SuspendOrigin`, concurrency-safe session activity/origin methods, `SessionManager::suspend`, `resume`, `focus_session`, and supervisor workload cleanup.

- [ ] **Step 1: Write failing restored-kind normalization tests**

Add manager tests that persist `SessionKind::Shell` with `resume_as_claude=true`, restore, and assert:

```rust
let restored = mgr.store.read_session(name).unwrap().unwrap();
assert_eq!(restored.kind, SessionKind::Claude);
assert!(!restored.resume_as_claude);
assert_eq!(mgr.session_infos().unwrap()[0].kind, "claude");
```

Also assert live shell with `resume_as_claude=true` before restart still reports
`shell`, rejects `set_run_state` and suspend, renames in place with same PID,
and raw Attach retains shell backlog behavior. The flag remains valid for
periodic detection and hook cwd protection; it must not act as runtime kind.

- [ ] **Step 2: Normalize metadata atomically before restore spawn**

Add a private helper:

```rust
fn normalize_restored_meta(&self, mut meta: SessionMeta) -> anyhow::Result<SessionMeta> {
    if meta.resume_as_claude {
        if meta.kind == SessionKind::Shell { meta.kind = SessionKind::Claude; }
        meta.resume_as_claude = false;
        self.store.write_session(&meta)?;
    }
    Ok(meta)
}
```

Call it in `restore()` before `restore_one()`. If the atomic rewrite fails, log and skip that session exactly like another restore failure; do not spawn a supervised process with lying metadata.

After normalization, `restore_one`, `set_run_state`, suspend/resume, rename, and
session-info decisions use persisted `kind` only. Remove `resume_as_claude` from
runtime agent-kind predicates. Keep its existing uses in shell-process
detection, final snapshot preservation, hook cwd guard, and this restore
normalizer.

- [ ] **Step 3: Write failing suspend-origin and activity tests**

In `pty.rs`, add:

- `manual_origin_overrides_memory_but_memory_never_overrides_manual`: claim
  Memory from None, claim Manual and assert the returned previous value is
  Memory, then assert a Memory claim fails with Manual unchanged.
- `new_session_starts_recently_used`: spawn `/bin/sh`, read `last_used_ms`, and
  assert it is nonzero.
- `output_activity_updates_last_output_clock`: spawn `/bin/cat`, capture
  `last_used_ms`, write a byte, wait for echoed output, and assert the value
  increased.

In manager tests, add:

- `shell_fallback_and_retrying_sessions_refuse_suspend`: set each run state on a
  fake agent session and assert
  `suspend(name, SuspendOrigin::Manual)` returns the documented
  error while origin stays None.
- `focus_resumes_memory_origin_but_not_manual_origin`: set each origin in turn,
  call `focus_session`, and assert `true` plus SIGUSR2 for Memory versus `false`
  and no signal for Manual.
- `input_resumes_memory_but_is_rejected_while_manual`: assert Memory input sends
  SIGUSR2 then reaches PTY; Manual input returns suspended error and bytes are
  never buffered for later resume.
- `failed_signal_restores_the_previous_origin`: terminate the supervisor,
  attempt resume, assert an error, and assert the origin equals its pre-call
  value. For failed Manual-over-Memory suspend, assert prior pending timestamp
  is restored too.
- `shell_fallback_ignores_late_supervisor_signals`: drive fake agent to fallback,
  send SIGUSR1 and SIGUSR2 directly during/after fallback transition, and assert
  fallback shell remains alive.

- [ ] **Step 4: Implement the canonical session state**

Define `SuspendOrigin` in `pty.rs`:

```rust
#[repr(u8)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SuspendOrigin { None = 0, Manual = 1, Memory = 2 }
```

Add `AtomicU8 suspend_origin`, `AtomicU64 last_user_ms`,
`AtomicU64 memory_suspend_started_ms`, and short `Mutex<()> suspend_transition`
to `PtySession`. Initialize `last_user_ms` to
`monotonic_ms().max(1)`. Make existing `pty::monotonic_ms` `pub(crate)` and use
that same clock in guardian; do not create a second timestamp origin. Expose:

```rust
pub fn suspend_origin(&self) -> SuspendOrigin;
pub fn claim_suspend(&self, origin: SuspendOrigin) -> Result<SuspendOrigin, SuspendOrigin>;
pub fn restore_suspend_origin(&self, expected: SuspendOrigin, previous: SuspendOrigin);
pub fn clear_suspend_origin(&self) -> SuspendOrigin;
pub fn mark_user_activity(&self);
pub fn last_used_ms(&self) -> u64; // max(last_user_ms, activity.last_ms)
pub fn memory_suspend_started_ms(&self) -> u64;
pub(crate) fn lock_suspend_transition(&self) -> MutexGuard<'_, ()>;
```

`claim_suspend(Memory)` succeeds only from `None`. `claim_suspend(Manual)` changes `None` or `Memory` to `Manual`. Implement with a short compare-exchange loop.
Manager sets `memory_suspend_started_ms` immediately after a successful Memory
claim using `now_ms.max(1)` and resets it on rollback, manual override, or
resume; zero remains “not pending.” A failed Manual-over-Memory signal restores
both previous Memory origin and previous timestamp.
All manager suspend, resume, and focus eligibility/origin/signal sequences hold
`suspend_transition`; no focus may clear Memory between its claim and SIGUSR1.
Update Task 3 `stop_session` to hold same guard while killing/removing session,
so concurrent focus cannot signal a process being destroyed.
Add a manager test that holds this guard, starts Focus on another thread,
asserts Focus remains blocked, then releases the guard and observes completion.

- [ ] **Step 5: Replace boolean signaling with typed manager methods**

Use these interfaces:

```rust
pub enum ResumeCause { Manual, Focus }

pub fn suspend(&self, name: &str, origin: SuspendOrigin) -> anyhow::Result<()>;
pub fn resume(&self, name: &str, cause: ResumeCause) -> anyhow::Result<bool>;
pub fn focus_session(&self, name: &str) -> anyhow::Result<bool>;
```

For a new suspension from `None`, `suspend` requires persisted agent kind,
`run_state == Some("claude")`, and successful origin claim before SIGUSR1.
Manual suspend may upgrade existing `Memory`: when run state is `suspended`,
change origin to `Manual` and return without another signal; when it is still
`claude`, change origin and send SIGUSR1 so a pending guardian action cannot
leave pane running. Existing `Manual` plus `suspended` is idempotent. Reject
`claude-retrying` and `shell-fallback` in every case. `ResumeCause::Focus` acts
only on `Memory`; `Manual` acts on `Manual` or `Memory`. Signal SIGUSR2 first,
then clear origin. Restore origin on signal failure.

Factor focus transition into one private helper that assumes
`suspend_transition` is held. Both `focus_session` and `write` use it. `write`
holds guard through transition decision and PTY write:

```rust
pub fn write(&self, name: &str, bytes: &[u8]) -> anyhow::Result<()> {
    let session = self.session(name)
        .ok_or_else(|| anyhow::anyhow!("no such session: {name}"))?;
    let _guard = session.lock_suspend_transition();
    session.mark_user_activity();
    self.resume_for_focus_locked(name, &session)?;
    if session.suspend_origin() == SuspendOrigin::Manual {
        anyhow::bail!("session is manually suspended: {name}");
    }
    session.write(bytes)
}
```

`session_infos` emits `memory-suspended` only when the supervisor reports `suspended` and origin is `Memory`.

- [ ] **Step 6: Write the failing stubborn-descendant supervisor test**

Extend the existing fake-agent harness in `claude_supervise.rs`. The fake agent must fork a child that ignores SIGTERM and allocates memory. The test runs under a delegated test cgroup when available and asserts:

```rust
assert!(wait_until(|| workload_populated(slot) == Some(false)));
assert!(supervisor_pid_is_alive());
assert_eq!(reported_state(), "suspended");
resume();
assert_eq!(recorded_resume_id(), "conv-42");
```

If the test process lacks a delegated memory controller, skip only the cgroup-specific assertions and still prove the direct child stops/resumes.

- [ ] **Step 7: Launch agent children into workload and kill the subtree on suspend**

Pass explicit hidden Run slot through `run_supervisor`, `run_session`, and
`supervise_agent`. For legacy direct Run without slot, read persisted slot only
as fallback. On Linux with slot, build real agent command through
`__cgroup-exec --role workload`; on fallback platforms use existing direct
command.

Add exact helper contract in `cgroup.rs`:

```rust
pub fn kill_workload_from_current(slot: u32) -> io::Result<Option<bool>>;
```

Return `None` when current process is not in Amber delegated hierarchy,
`Some(true)` only after recursive empty, and `Some(false)` on a bounded attempt
that remains populated. Supervisor retries only `Some(false)` or recoverable IO
failure; `None` uses process-tree fallback.

On suspend:

1. Try `cgroup::kill_workload_from_current(slot)`.
2. If cgroups are unavailable, call shared process-tree kill helper extracted
   from `PtySession::kill` using child's PID. Keep existing descendant snapshot,
   process-group SIGKILL, and stray-PID SIGKILL behavior in one place.
3. If cgroups are available but workload is still populated, log at bounded
   intervals and retry kill/wait; never report successful suspension while a
   descendant remains. A queued Resume is honored after cleanup completes.
4. Always `child.wait()`.
5. Report `suspended` only after cgroup path is recursively unpopulated, or
   after process-tree fallback completes on an uncontained platform.
6. Wait for resume and reset existing resume ladder.

Do not move shell fallback to workload; it stays in supervisor and is excluded by the manager run-state check.

Immediately before reporting `shell-fallback`, set SIGUSR1 and SIGUSR2 to
`SIG_IGN`, then report, then `exec` shell. Ignored dispositions survive exec;
this closes asynchronous report race where daemon still sees `claude` after
supervisor has already entered shell fallback. Keep normal handlers throughout
all supervised states.

- [ ] **Step 8: Run suspend, supervisor, and restore tests**

```bash
cargo test -p amber manager::
cargo test -p amber --test claude_supervise -- --test-threads=1
cargo test -p amber --test run_state
cargo test -p amber --test socket raw_attach
```

- [ ] **Step 9: Commit Task 4**

```bash
git add crates/amber/src/pty.rs crates/amber/src/manager.rs crates/amber/src/supervisor.rs crates/amber/src/memory_guardian.rs crates/amber/tests/claude_supervise.rs crates/amber/tests/run_state.rs crates/amber/tests/socket.rs
git commit -m "feat(daemon): reclaim suspended agent workloads"
```

---

### Task 5: Guardian Runtime and Additive Pressure Protocol

**Files:**
- Modify: `crates/amber-core/src/proto.rs:25-157`
- Modify: `crates/amber/src/memory_guardian.rs`
- Modify: `crates/amber/src/manager.rs`
- Modify: `crates/amber/src/main.rs:651-699`
- Modify: `crates/amber/src/watchers.rs`

**Interfaces:**
- Consumes: pure policy from Task 1, cgroup accounting from Task 2, typed suspension from Task 4, existing process-tree RSS, snapshots, and bounded watcher broadcast.
- Produces: `Focus`, `MemoryPressure`, `SessionManager::memory_candidates`, and the single monitor/guardian thread.

- [ ] **Step 1: Write failing Rust protocol round-trip tests**

Add to `amber-core/src/proto.rs`:

```rust
#[test]
fn focus_control_roundtrips() {
    roundtrip(ControlMsg::Focus { name: "amber-1-1-0-x".into() });
}

#[test]
fn memory_pressure_roundtrips_with_additive_fields() {
    roundtrip(ControlMsg::MemoryPressure {
        level: "critical".into(),
        current_kb: 7_000_000,
        budget_kb: 8_000_000,
        blocked: true,
    });
}
```

Add `#[serde(default)]` to every numeric/boolean `MemoryPressure` field. Keep `level` required so malformed senders do not silently invent a state.

- [ ] **Step 2: Add the two protocol variants**

```rust
Focus { name: String },
MemoryPressure {
    level: String,
    #[serde(default)] current_kb: u64,
    #[serde(default)] budget_kb: u64,
    #[serde(default)] blocked: bool,
},
```

Do not add a suspend-origin field to `SessionInfo`.

- [ ] **Step 3: Write failing guardian decision tests**

Add tests inside `memory_guardian.rs` that pass explicit fake timestamps and
samples to private `step`. Keeping them beside `GuardianStep` avoids exporting
test-only API. Cover exact behavior:

- below warning produces `Normal` and no snapshot/suspend;
- warning emits pressure but does not park;
- critical snapshots and parks exactly one oldest eligible session;
- next step remeasures before a second action;
- a pending Memory-origin cleanup prevents second victim, remains unblocked for
  10 seconds, then becomes blocked under fake clock;
- snapshot failure emits `blocked=true` and does not suspend;
- no candidate emits one blocked transition per pressure episode;
- dropping below 65% clears the episode;
- pressure clear never calls resume;
- an input/focus race after selection causes the manager's final eligibility recheck to reject or immediately resume the park.

Use a private `GuardianStep` seam, not a service abstraction:

```rust
pub(crate) struct StepDecision {
    pub level: PressureLevel,
    pub candidate: Option<String>,
    pub blocked: bool,
}

pub(crate) fn step(
    previous: PressureLevel,
    now_ms: u64,
    current_kb: u64,
    budget_kb: u64,
    pending_since_ms: Option<u64>,
    candidates: &[Candidate],
) -> StepDecision;
```

Factor snapshot/action ordering into one private generic helper taking two
closures, `snapshot: FnOnce() -> anyhow::Result<()>` and
`suspend: FnOnce(&str) -> anyhow::Result<()>`. Unit tests use counting closures
to prove snapshot runs first, suspension never runs after snapshot failure, and
exactly one name is passed. Do not add a trait or mock framework.

- [ ] **Step 4: Expose manager candidate snapshots**

Add:

```rust
pub fn memory_candidates(&self, per_session_kb: &HashMap<String, u64>) -> Vec<Candidate>;
pub fn suspend_for_memory(&self, name: &str, now_ms: u64) -> anyhow::Result<()>;
pub fn memory_suspend_pending_since(&self) -> Option<u64>;
pub fn cgroup_memory_sample(
    &self,
) -> anyhow::Result<Option<(u64, HashMap<String, u64>)>>;
```

`memory_candidates` reads stored metadata, live sessions, recorded ids, run state, origin, and last-use clocks without holding `sessions` across disk I/O: clone `(name, Arc<PtySession>)` handles first, release the lock, then read metadata.

`cgroup_memory_sample` returns `None` when containment is disabled. Otherwise it
reads aggregate charge plus each live session parent charge by persisted slot;
clone live handles first and never hold `sessions` across store or cgroup reads.

`suspend_for_memory` repeats every eligibility check immediately before `claim_suspend(Memory)`. This is the race-closing trust boundary; the guardian's earlier selection is advisory.

`memory_suspend_pending_since` returns earliest start timestamp for any Memory
origin whose supervisor has not yet reported `suspended`. While present,
guardian remeasures but selects no second victim. Keep `blocked=false` for first
10 seconds; after `SUSPEND_STALL_MS = 10_000`, emit `blocked=true`. Once workload
is empty, supervisor report changes projection to `memory-suspended`; next poll
may select another session only if aggregate remains critical.

- [ ] **Step 5: Replace the inline memory monitor with the guardian loop**

Expose:

```rust
pub fn start(
    manager: Arc<SessionManager>,
    watchers: Arc<Watchers>,
    config: MemoryConfig,
    budget_kb: Option<u64>,
);
```

Loop behavior:

- Linux cgroup-enabled tick: one second; read aggregate `memory.current` and per-session charge.
- Every third tick: take one `process_table()` snapshot, broadcast existing per-session RSS/growth `MemoryStat`, and reuse RSS sum when cgroups are disabled.
- Startup computes budget once from physical RAM, config, and cgroup finite
  limits and passes it to the guardian. Log chosen value. If no source is
  available, keep existing `MemoryStat` telemetry, emit one warning, and skip
  pressure transitions and automatic suspension.
- At critical pressure with no pending memory suspension, select one candidate,
  call `manager.snapshot()`, then `suspend_for_memory`. Do not snapshot when no
  candidate exists.
- Broadcast `MemoryPressure` immediately on level/blocked change and otherwise at most every three seconds.
- If `config.enabled == false`, preserve `MemoryStat` monitoring but skip automatic suspension; still report pressure.
- Catch/log each sampling or candidate error and continue the loop; no guardian failure may stop the daemon.

- [ ] **Step 6: Verify bounded watcher behavior**

Extend the existing wedged-watcher test to broadcast repeated `MemoryPressure` frames and assert a healthy watcher receives them while the laggard is evicted. Do not add a separate queue.

- [ ] **Step 7: Run guardian and protocol tests**

```bash
cargo test -p amber-core focus_control_roundtrips
cargo test -p amber-core memory_pressure_roundtrips
cargo test -p amber memory_guardian::tests
cargo test -p amber watchers::tests
```

- [ ] **Step 8: Commit Task 5**

```bash
git add crates/amber-core/src/proto.rs crates/amber/src/memory_guardian.rs crates/amber/src/manager.rs crates/amber/src/main.rs crates/amber/src/watchers.rs
git commit -m "feat(daemon): park idle agents under memory pressure"
```

---

### Task 6: Focus and Pressure Across Daemon, CLI, and Mobile Web

**Files:**
- Modify: `crates/amber/src/daemon.rs:239-551`
- Modify: `crates/amber/src/attach.rs`
- Modify: `crates/amber/src/web.rs:225-380`
- Modify: `crates/amber/assets/app.js`
- Modify: `crates/amber/tests/socket.rs`
- Modify: `crates/amber/tests/web.rs`
- Modify: `app/src/shared/proto.ts`
- Modify: `app/src/shared/proto.test.ts`
- Modify: `app/src/client/index.ts`
- Modify: `app/src/preload/index.ts`
- Modify: `app/src/web/amber.ts`
- Modify: `app/src/web/amber.test.ts`
- Modify: `app/src/renderer/main.tsx:26-67`

**Interfaces:**
- Consumes: Task 5 `Focus`/`MemoryPressure`, `SessionManager::focus_session`, existing tolerant control decoder, and browser whitelist.
- Produces: focus command through every real terminal client and pressure decoding through desktop/mobile bridges.

- [ ] **Step 1: Write failing daemon focus tests**

Add socket integration coverage:

- `focus_refreshes_use_and_resumes_only_memory_suspension`: memory-suspend a
  recorded fake agent, send Focus, assert the supervisor reports `claude` and
  `last_used_ms` increases.
- `focus_never_resumes_manual_suspension`: manually suspend the same fixture,
  send Focus, and assert run state and origin remain manual/suspended.
- `input_uses_the_same_focus_boundary_before_write`: memory-suspend, send a Data
  frame, assert resume happens, then assert the bytes reach the relaunched
  process.
- `focus_of_unknown_session_returns_an_error_without_closing_connection`: send
  Focus for a missing name, read Error, then issue ListSessions on the same
  socket and receive the normal reply.

- [ ] **Step 2: Handle Focus at the shared daemon boundary**

Add a `ControlMsg::Focus` match arm that calls `manager.focus_session`. On error, write the existing small `Error` frame. On success, send no reply; the supervisor's run-state report produces the authoritative `SessionsChanged` event after resume.

Keep `Frame::Data` routed through `manager.write`; Task 4 already makes input refresh/resume there.

Map manual `Suspend` to `manager.suspend(name, SuspendOrigin::Manual)` and manual `Resume` to `manager.resume(name, ResumeCause::Manual)`.

- [ ] **Step 3: Send Focus before raw Attach**

In `run_client`, send:

```rust
send_control(&stream, &ControlMsg::Focus { name: name.clone() })?;
send_control(&stream, &ControlMsg::Attach {
    name: name.clone(),
    raw_client: true,
    preview: false,
})?;
```

Update attach harness expectations. Older daemons skip the unknown additive frame and still process Attach.

- [ ] **Step 4: Write failing mobile whitelist tests**

Add `BrowserMsg::Focus { name }` tests:

```rust
assert_eq!(
    map_browser_msg(&BrowserMsg::Focus { name: "live".into() }, None, &sessions),
    vec![ControlMsg::Focus { name: "live".into() }],
);
assert!(map_browser_msg(&BrowserMsg::Focus { name: "missing".into() }, None, &sessions).is_empty());
```

Extend `no_browser_input_can_reach_a_forbidden_control_message` so Focus is allowed but `Snapshot` and `ReportRunState` remain unreachable.

Add Hub test feeding daemon `MemoryPressure` and asserting every browser client
receives exact `memoryPressure` JSON. Add `app/src/web/amber.test.ts` coverage
that parses it into one renderer daemon event and that explicit
`focusSession(name)` emits `{t:'focus',name}` once.

- [ ] **Step 5: Add explicit mobile focus and pressure translation**

Add `BrowserMsg::Focus` to Rust and `{t:'focus', name}` to the hand-written mobile app only when the user selects/opens a session. Do not send it from the keep-alive pane socket's `Open` path.

Translate daemon pressure to JSON:

```json
{"t":"memoryPressure","level":"critical","current_kb":7000000,"budget_kb":8000000,"blocked":false}
```

Update `app/src/web/amber.ts` `ServerMsg`, parser, `toDaemonEvent`, and bridge:

```typescript
focusSession: (name: string) => control.send({ t: 'focus', name })
```

- [ ] **Step 6: Add desktop binary protocol and bridge support**

In `shared/proto.ts`, add exact variants matching Rust. In client/preload, web
bridge, and renderer's existing `Window.amber` declaration, add:

```typescript
focusSession(name: string): void
```

The utility process maps renderer `{ cmd: 'focus', name }` to encoded `Focus`. Keep this on the control socket, never pane data ports.

Extend `shared/proto.test.ts` with Rust-shape round trips for Focus and
MemoryPressure. Decoder must accept only `normal|warning|critical` for pressure
level and reject another string; numeric/boolean defaults remain additive.

- [ ] **Step 7: Run protocol, socket, web, and bridge tests**

```bash
cargo test -p amber --test socket focus_
cargo test -p amber web::tests
cargo test -p amber --test web
npm --prefix app test -- --run src/shared/proto.test.ts src/web/amber.test.ts
npm --prefix app run typecheck
```

- [ ] **Step 8: Commit Task 6**

```bash
git add crates/amber/src/daemon.rs crates/amber/src/attach.rs crates/amber/src/web.rs crates/amber/assets/app.js crates/amber/tests/socket.rs crates/amber/tests/web.rs app/src/shared/proto.ts app/src/shared/proto.test.ts app/src/client/index.ts app/src/preload/index.ts app/src/web/amber.ts app/src/web/amber.test.ts app/src/renderer/main.tsx
git commit -m "feat(clients): resume memory parked sessions on focus"
```

---

### Task 7: Desktop Pressure Banner and Memory-Parked Pane State

**Files:**
- Modify: `app/src/renderer/store.ts`
- Modify: `app/src/renderer/store.test.ts`
- Modify: `app/src/renderer/main.tsx:70-1388`
- Modify: `app/src/renderer/SplitView.tsx:141-769`
- Modify: `app/src/renderer/theme.css`

**Interfaces:**
- Consumes: `MemoryPressure`, `SessionInfo.run_state == "memory-suspended"`, `window.amber.focusSession`, existing banner/error UI, existing frozen overlay, `paneDot`, and tab-dot aggregation.
- Produces: global pressure state, terminal-only focus hint, visible blocked warning, and resumable memory-parked overlay without xterm remount.

- [ ] **Step 1: Write failing reducer and dot tests**

Extend `store.test.ts`:

```typescript
it('stores aggregate pressure and no-ops identical refreshes', () => {
  const first = reduce(initialState(), {
    kind: 'MemoryPressure', level: 'critical', currentKb: 7_000_000,
    budgetKb: 8_000_000, blocked: false,
  })
  expect(first.pressure).toEqual({ level: 'critical', currentKb: 7_000_000, budgetKb: 8_000_000, blocked: false })
  expect(reduce(first, {
    kind: 'MemoryPressure', level: 'critical', currentKb: 7_000_000,
    budgetKb: 8_000_000, blocked: false,
  })).toBe(first)
})

it('renders memory-suspended as a distinct resumable agent state', () => {
  expect(paneDot('claude', 'memory-suspended')).toEqual({
    cls: 'memory-suspended',
    label: 'claude (parked for memory)',
  })
  expect(paneDot('grok', 'memory-suspended').cls).toBe('memory-suspended')
  expect(paneDot('codex', 'memory-suspended').cls).toBe('memory-suspended')
})
```

Add tab aggregation coverage for exact priority: retrying still wins; a running
agent plus a memory-parked agent keeps normal agent dot; when every non-fallback
agent is `memory-suspended`, tab gets `memory-suspended`; shell fallback alone
retains fallback dot. Memory parking is never treated as dead.

- [ ] **Step 2: Add pressure state and decoding**

Extend `AppState`:

```typescript
pressure: null | {
  level: 'normal' | 'warning' | 'critical'
  currentKb: number
  budgetKb: number
  blocked: boolean
}
```

Add `DaemonEvent.kind = 'MemoryPressure'`, decode it in `main.tsx::toEvent`, and
handle it in `reduce`. Reuse validated level from shared protocol instead of
casting an arbitrary string. Dispatch pressure immediately; do not place it in
Activity/MemoryStat coalescing buffer.

- [ ] **Step 3: Add the stable terminal-only focus callback**

Use `focusSession` already added to renderer Window type in Task 6 and create:

```typescript
const onPaneFocus = useCallback((name: string): void => {
  if (isBrowserName(name) || isEditorName(name)) return
  window.amber.focusSession(name)
}, [])
```

Pass it through `SplitView`. Call it from actual terminal focus/click and from the memory-parked Resume button. Do not call it when keep-alive layers mount, tabs render in the background, or app-local panes receive focus.

Use pane wrapper's existing bubbling `onFocusCapture` plus
`onPointerDownCapture`; do not add a new listener inside memoized `Pane`.

- [ ] **Step 4: Reuse existing banner and overlay structure**

Banner copy is exact:

- warning: `Amber memory usage is high: {used} of {budget}. Idle agent panes may be parked.`
- critical, reclaiming possible: `Amber is protecting system memory by parking idle agent panes.`
- critical, blocked: `Amber memory is critical, but no idle resumable agent pane can be parked. Close or freeze active work.`

Use existing `SplitView::fmtMem` for `{used}` and `{budget}`. Use
`role="status"` for warning and `role="alert"` for critical. Keep existing
dismissible daemon error independent.

For `meta.runState === 'memory-suspended'`, render the existing overlay shape with:

```tsx
<div className="memory-parked-overlay" role="status">
  <span>Parked to protect system memory</span>
  <button type="button" onClick={() => onPaneFocus(meta.name)}>Resume</button>
</div>
```

Do not add the pane to `frozenSet`, block directional focus, detach its port, or unmount `Pane`. Manual `layout.frozen` behavior remains unchanged.

- [ ] **Step 5: Add token-based CSS only**

Add `.memory-banner`, `.memory-parked-overlay`, and `.kind-dot.memory-suspended` using existing color, border, spacing, and focus-visible tokens. Do not introduce gradients, icons, fonts, animations, or a new component library.

- [ ] **Step 6: Run renderer tests and build gates**

```bash
npm --prefix app test -- --run src/renderer/store.test.ts src/shared/proto.test.ts src/web/amber.test.ts
npm --prefix app run typecheck
npm --prefix app run build
```

Expected: reducer and pure presentation logic pass; renderer typechecks; production bundle builds. This repository intentionally has no renderer component harness, so live GUI verification remains in Task 8.

- [ ] **Step 7: Commit Task 7**

```bash
git add app/src/renderer/store.ts app/src/renderer/store.test.ts app/src/renderer/main.tsx app/src/renderer/SplitView.tsx app/src/renderer/theme.css
git commit -m "feat(app): surface memory pressure and parked panes"
```

---

### Task 8: Documentation, Full Gates, Isolated Pressure Proof, and Rollout

**Files:**
- Modify: `docs/superpowers/specs/2026-07-17-memory-monitor-throttle-design.md`
- Modify: `docs/superpowers/specs/2026-08-13-amber-memory-containment-design.md`
- Modify: `docs/superpowers/plans/2026-08-13-amber-memory-containment.md`
- Modify: `infra/daemon/README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: all prior tasks, existing daemon install/status tools, systemd user transient units, and current reboot-torture process.
- Produces: verified release evidence, operator calibration/rollback instructions, and an accurate project checklist.

- [x] **Step 1: Update documentation before running final gates**

In the 2026-07-17 document, mark its deferred Slice 2/3 text as superseded by the new design rather than rewriting history. Add operator examples to the new design:

```toml
[memory]
enabled = true
budget_mb = 12288
session_high_mb = 4096
```

Document that `budget_mb` is calibration, `MemoryHigh=50%` is the default systemd soft boundary, `MemoryMax` is an optional administrator drop-in with destructive OOM semantics, and macOS has guardian parking without cgroup throttling.

Extend `infra/daemon/README.md` with slot/cgroup/state checks listed below and
remove its obsolete “snapshot-now pending” note. Do not mark `CLAUDE.md`
complete yet.

- [ ] **Step 2: Run the complete automated gate twice where the project requires flake detection**

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo test --workspace
npm --prefix app test -- --run
npm --prefix app run typecheck
npm --prefix app run build
systemd-analyze --user verify infra/daemon/amber.service
git diff -- Cargo.lock app/package-lock.json
```

Expected: all gates pass; lockfile diff is empty.

Result (2026-08-13): Rust tests passed twice (438 each); app tests passed (478
with one intentional skip); equivalent warnings-as-errors clippy, typecheck,
bundle, unit verification, and lockfile checks passed. The literal clippy form
is misrouted by the repository command hook, while the `RUSTFLAGS='-D warnings'`
equivalent passes. The formatting gate remains open because rustfmt 1.9 reports
repository-wide pre-existing differences outside Task 8's documentation scope.

- [x] **Step 3: Build a private low-budget Linux test service**

Use explicit private paths; never point the test at production state:

Run Steps 3–10 in same shell so validated `test_root`/`test_socket` variables
remain available.

```bash
test_root="$(mktemp -d /tmp/amber-memory-test.XXXXXX)"
test_socket="$test_root/amber.sock"
test_bin="$(pwd)/target/debug/amber"

systemd-run --user \
  --unit amber-memory-test \
  --property=Type=simple \
  --property=Delegate=memory \
  --property=MemoryAccounting=yes \
  --property=MemoryHigh=512M \
  --property=OOMPolicy=continue \
  --setenv=AMBER_STATE_DIR="$test_root" \
  "$test_bin" daemon --root "$test_root" --socket "$test_socket"
```

Install fake Claude/Grok/Codex fixtures only in the private config. Each fixture records its resume id, allocates a known amount of memory, and forks one MCP-like stubborn descendant.

- [x] **Step 4: Verify cgroup placement and soft-pressure behavior**

Resolve the transient service path from `systemctl --user show amber-memory-test.service -p ControlGroup --value`, then assert:

- daemon PID appears only in `_daemon/cgroup.procs`;
- agent `amber run` appears in `session-<slot>/supervisor/cgroup.procs`;
- agent and MCP child appear in `session-<slot>/workload/cgroup.procs`;
- shell and descendants appear in their `workload` leaf;
- each session parent reads the clamped private boundary,
  `memory.high = 536870912`, because the transient service budget is 512 MiB;
- `memory.events` `high` increases during allocator stress;
- `amber ls`, Create, Attach, Input, Kill, Snapshot, and watcher updates remain responsive during reclaim;
- no `oom` or `oom_kill` counter increases.

Result: all listed placement, boundary, control-plane, watcher, reclaim-event,
and zero-OOM assertions passed in `amber-memory-test.service`.

- [ ] **Step 5: Verify guardian ordering and state preservation**

Create two recorded agent panes. Keep one focused and idle the other beyond 120 seconds. Increase memory until critical. Assert:

- idle pane becomes `memory-suspended` first;
- its workload cgroup becomes unpopulated and aggregate `memory.current` falls;
- focused pane accepts input throughout;
- manual frozen pane remains `suspended` and focus does not resume it;
- shell, retrying, fallback, and unrecorded agent fixtures never auto-park;
- critical-without-candidate produces the blocked banner and no process kill;
- pressure clear does not auto-resume;
- desktop click, `amber attach`, and mobile selection resume the exact recorded id;
- reconnect reports `memory-suspended` before resume without layout-sidecar mutation.

Partial result: live daemon evidence covered oldest-idle ordering, focused
protection, workload reclamation, blocked critical state, manual-origin
protection, shell exclusion, no auto-resume, and exact-id raw-attach resume.
Retry/fallback/unrecorded exclusions, desktop/mobile activation, renderer
banner, reconnect, and layout-sidecar invariants remain automated-test evidence,
not live GUI/phone proof in this pass.

- [ ] **Step 6: Verify rename, kill, restart, and fallback behavior**

Assert:

- shell rename preserves PID and cgroup slot;
- agent rename changes supervisor PID but preserves slot and recorded id;
- pane kill removes stubborn descendants and all three cgroup directories;
- daemon restart restores name, cwd, scrollback, slot, and conversation;
- `systemctl --user show amber-memory-test.service -p OOMPolicy -p MemoryHigh -p Delegate` reports expected values;
- the service remains active when a supervised fixture child exits and retries;
- launching the daemon directly outside a delegated unit logs one containment warning and still creates/attaches/kills sessions.

Partial result: rename PID/slot/id behavior, stubborn-descendant kill, restart
restore, unit properties, and direct nondelegated fallback passed live. The
fixture crash/retry path remains integration-test evidence rather than a live
transient-service assertion.

- [x] **Step 7: Run a 30–60 minute pressure soak**

During the soak, sample every ten seconds:

```bash
systemctl --user show amber-memory-test.service \
  -p ActiveState -p SubState -p MemoryCurrent -p MemoryPeak -p TasksCurrent
timeout 2 target/debug/amber ls --socket "$test_socket"
```

Acceptance: service stays active; `amber ls` never times out; machine desktop remains responsive; no daemon OOM, cgroup `oom_kill`, wedged socket, lost session metadata, or unbounded orphan process appears.

Result: 1,820 seconds, 180/180 active/running samples, 180/180 two-second
`amber ls` probes, 13 stable tasks after reclaim, 570,601,472-byte peak, and no
OOM or `oom_kill` event.

- [ ] **Step 8: Run real-Mac verification**

On a normal Mac build:

- verify startup performs no cgroup filesystem access;
- verify aggregate RSS warning/critical transitions;
- verify one old recorded agent parks at a time;
- verify focused/manual/shell/fallback exclusions;
- verify focus resumes the same recorded id;
- verify daemon restart restores state.

Record OS version, architecture, commands, and result in the design spec's verification log.

Pending: no Mac was available; the verification log records this explicitly.

- [ ] **Step 9: Roll out to the production user service**

```bash
amber ctl snapshot-now
amber ctl install
systemctl --user show amber.service \
  -p ActiveState -p Delegate -p MemoryHigh -p OOMPolicy -p ControlGroup
amber ls
```

One daemon restart is expected. Verify every prior session restores before deleting private test state. If rollback is needed, set `[memory] enabled = false` and restart; remove the unit memory directives only after another snapshot.

Deferred: production state is outside the worktree. Its daemon stayed PID 2314
throughout the private proof and was not restarted or reinstalled.

- [x] **Step 10: Remove only private test service and state**

```bash
test -n "${test_root:-}"
resolved_test_root="$(realpath -- "$test_root")"
systemctl --user stop amber-memory-test.service
systemctl --user reset-failed amber-memory-test.service 2>/dev/null || true
case "$resolved_test_root" in
  /tmp/amber-memory-test.*) rm -rf -- "$resolved_test_root" ;;
  *) printf 'refusing unexpected test root: %s\n' "$resolved_test_root" >&2; exit 1 ;;
esac
```

Result: validated root `/tmp/amber-memory-test.jQkxvy` was removed; the private
unit ended inactive/dead with PID 0.

- [ ] **Step 11: Update project status only after every gate passes**

Add one dated checklist entry to `CLAUDE.md` summarizing containment, guardian
behavior, exact test counts, isolated pressure proof, soak result, and real-Mac
result. If Mac gate remains pending, state that explicitly and do not claim
feature fully verified.

- [x] **Step 12: Commit Task 8**

```bash
git add docs/superpowers/specs/2026-07-17-memory-monitor-throttle-design.md docs/superpowers/specs/2026-08-13-amber-memory-containment-design.md docs/superpowers/plans/2026-08-13-amber-memory-containment.md infra/daemon/README.md CLAUDE.md
git commit -m "docs: document memory containment rollout"
```

---

## Completion Checklist

- [x] Every automatic park has a successful preceding snapshot.
- [x] Every parked agent has a recorded resume id and resumes that id.
- [x] Manual suspend cannot be reclassified or undone by focus.
- [x] Shell, retrying, fallback, recent, and unrecorded sessions are excluded.
- [x] Daemon, supervisor, workload, and descendant placement match the slot hierarchy.
- [x] `memory.high` is nonblocking and no default `memory.max` exists.
- [x] One parked workload frees all descendants while keeping PTY/supervisor alive.
- [x] Pressure events cannot block daemon watchers or control messages.
- [x] Electron, web, and raw attach focus paths resume memory origin only.
- [x] App-local panes never send daemon Focus.
- [x] Old config and state files load without migration.
- [ ] Nondelegated Linux and macOS retain usable session behavior.
- [ ] Automated gates, Linux pressure proof, soak, and real-Mac verification are recorded.
