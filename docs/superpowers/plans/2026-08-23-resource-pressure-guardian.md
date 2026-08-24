# Resource-Pressure Guardian Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Amber responsive beside ChatGPT by prioritizing the foreground session and safely parking resumable background agents after sustained host CPU, I/O, or memory pressure.

**Architecture:** Keep `amber-codex-mem-balance` as the aggregate host envelope. Extend Amber's existing guardian with a pure Linux PSI policy, stable-slot foreground tracking, and session CPU weights; reuse the existing snapshot/suspend/resume safety path. Negotiate new pressure events with watcher protocol version 2 and present causes in Electron without breaking version-1 clients.

**Tech Stack:** Rust 1.96, serde/TOML/JSON, Linux cgroup v2 and PSI, systemd user units, Electron, React, TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-23-resource-pressure-guardian-design.md`

## Global Constraints

- Use TDD: every production behavior must first have a focused failing test whose failure is observed.
- Preserve existing immediate aggregate-memory parking and its output-recency protection.
- Host-pressure parking requires 120 consecutive seconds above CPU 25%, I/O 20%, or memory 2% PSI by default.
- Never auto-park current foreground slot, shells, fallbacks, retries, manual freezes, or sessions without a resume id.
- Park at most one session per 10-second cooldown and remeasure before every action.
- No hard per-session CPU cap; use relative weights 10000/1000/100 for daemon/foreground/background.
- `[memory].enabled = false` remains global auto-parking opt-out.
- Do not restart production `amber.service` during implementation or isolated verification.
- Do not add dependencies.

---

### Task 1: PSI Policy, Configuration, and Wire Contract

**Files:**
- Create: `crates/amber/src/host_pressure.rs`
- Modify: `crates/amber/src/lib.rs`
- Modify: `crates/amber-core/src/state.rs`
- Modify: `crates/amber-core/src/proto.rs`

**Interfaces:**
- Produces: `PressureConfig` with normalized defaults.
- Produces: `HostPressureSample { cpu_some_percent, io_full_percent, memory_full_percent }`.
- Produces: `HostPressureState::step(now_ms, Option<HostPressureSample>) -> HostPressureDecision`.
- Produces: `ControlMsg::ResourcePressure { level, causes, blocked }`.

- [ ] **Step 1: Add failing configuration tests**

Add tests proving old TOML receives these defaults and explicit values round-trip:

```rust
assert_eq!(cfg.pressure.cpu_some_percent, 25.0);
assert_eq!(cfg.pressure.io_full_percent, 20.0);
assert_eq!(cfg.pressure.memory_full_percent, 2.0);
assert_eq!(cfg.pressure.sustain_seconds, 120);
assert_eq!(cfg.pressure.cooldown_seconds, 10);
```

- [ ] **Step 2: Run configuration tests and observe the missing-field/type failure**

Run: `cargo test -p amber-core state::tests -- --nocapture`

- [ ] **Step 3: Add `PressureConfig` and `Config.pressure`**

Use serde defaults, finite percentage normalization clamped to `0.0..=100.0`, and nonzero interval fallback. Do not change `MemoryConfig` serialization or semantics.

- [ ] **Step 4: Add failing PSI parser and state-machine tests**

Cover valid PSI rows, malformed/missing `avg10`, non-finite values, threshold cause sets, a sample at 119,999 ms that cannot act, eligibility at 120,000 ms, cancellation when all causes clear, skipped unavailable samples, and 10,000 ms cooldown.

- [ ] **Step 5: Run focused PSI tests and observe missing-symbol failures**

Run: `cargo test -p amber host_pressure -- --nocapture`

- [ ] **Step 6: Implement pure PSI parsing and sustained-pressure state**

Keep file reads behind a small `sample_linux()` adapter. Keep parsing and transitions pure. An unavailable sample preserves a live episode timestamp but cannot itself trigger parking or falsely clear pressure.

- [ ] **Step 7: Add failing Rust protocol shape and compatibility tests**

Lock JSON shape:

```json
{"ResourcePressure":{"level":"critical","causes":["cpu","io"],"blocked":false}}
```

Reject unknown levels/causes, add `ResourcePressure` to `known_control_variant`, and prove existing `MemoryPressure` bytes remain unchanged.

- [ ] **Step 8: Implement protocol variant and run focused tests**

Run: `cargo test -p amber-core -- --nocapture`

- [ ] **Step 9: Commit core policy**

```bash
git add crates/amber/src/host_pressure.rs crates/amber/src/lib.rs crates/amber-core/src/state.rs crates/amber-core/src/proto.rs
git commit -m "feat: add host pressure policy"
```

### Task 2: Capability-Gated Resource Pressure Broadcast

**Files:**
- Modify: `crates/amber/src/watchers.rs`
- Modify: `crates/amber/src/daemon.rs`
- Modify: `crates/amber/src/web.rs`

**Interfaces:**
- Consumes: `ControlMsg::ResourcePressure` from Task 1.
- Produces: `WatchMemoryPressure` version-2 delivery; version 1 receives only `MemoryPressure`.

- [ ] **Step 1: Add failing watcher capability tests**

Register version-1 and version-2 watcher sockets. Broadcast both pressure variants. Assert version 1 decodes only `MemoryPressure`; version 2 decodes both in order.

- [ ] **Step 2: Run watcher tests and observe ResourcePressure rejection or misdelivery**

Run: `cargo test -p amber watchers::tests -- --nocapture`

- [ ] **Step 3: Implement capability-gated broadcast**

Keep `broadcast_pressure` for version 1. Add `broadcast_resource_pressure`, require version 2, and update debug assertions. Do not send unknown controls to legacy watchers.

- [ ] **Step 4: Add failing web bridge tests**

Prove daemon link subscribes with version 2 and maps the event to:

```json
{"t":"resourcePressure","level":"critical","causes":["cpu"],"blocked":false}
```

- [ ] **Step 5: Implement web mapping and run focused tests**

Run: `cargo test -p amber -- --nocapture`

- [ ] **Step 6: Commit watcher negotiation**

```bash
git add crates/amber/src/watchers.rs crates/amber/src/daemon.rs crates/amber/src/web.rs
git commit -m "feat: negotiate resource pressure events"
```

### Task 3: Foreground Truth and Safe Host-Pressure Parking

**Files:**
- Modify: `crates/amber/src/pty.rs`
- Modify: `crates/amber/src/manager.rs`
- Modify: `crates/amber/src/memory_guardian.rs`
- Modify: `crates/amber/src/main.rs`

**Interfaces:**
- Consumes: `PressureConfig`, `HostPressureState`, and `HostPressureDecision` from Task 1.
- Produces: `PtySession::last_user_ms()`.
- Produces: stable-slot foreground selection and host-pressure candidate APIs.
- Produces: one guardian loop coordinating existing memory pressure and new host PSI without concurrent suspension races.

- [ ] **Step 1: Add failing PTY and manager candidate tests**

Prove `last_user_ms()` excludes output; the foreground slot is excluded after more than 120 seconds; rename preserves exclusion; noisy background output does not protect a host-pressure candidate; recent focus/input does; all existing safety exclusions remain.

- [ ] **Step 2: Run focused tests and observe missing APIs**

Run: `cargo test -p amber manager::tests -- --nocapture`

Run: `cargo test -p amber pty::tests -- --nocapture`

- [ ] **Step 3: Implement foreground slot and separate user recency**

Store foreground as `AtomicU32` (`0` means none). Resolve names to stable slots. `focus_session` and `write` set foreground and mark user activity before resume. Remove/reap clears only a matching slot. Rename needs no foreground rewrite because slot is stable.

- [ ] **Step 4: Generalize automatic suspend origin and projection**

Replace runtime-only `SuspendOrigin::Memory` with `SuspendOrigin::Pressure`; project confirmed automatic suspension as `resource-suspended`. Keep clients able to render legacy `memory-suspended`. Preserve manual takeover and focus-only automatic resume rules.

- [ ] **Step 5: Implement host-pressure candidate selection and final locked recheck**

Reuse metadata and resume-id validation. Sort by `last_user_ms`, descending session memory, then name. Exclude foreground both during selection and under transition lock immediately before signaling.

- [ ] **Step 6: Add failing guardian coordination tests**

Prove host action waits 120 seconds, snapshots before suspend, honors cooldown, reports blocked when no candidate exists, never selects while another suspension is pending, and leaves immediate memory-budget behavior unchanged.

- [ ] **Step 7: Run guardian tests and observe expected policy failures**

Run: `cargo test -p amber memory_guardian::tests -- --nocapture`

Run: `cargo test -p amber host_pressure -- --nocapture`

- [ ] **Step 8: Integrate host sampling into the single guardian thread**

Read normalized pressure config at startup. Broadcast `ResourcePressure` transitions/refreshes through version-2 watchers. Keep PSI I/O off connection and PTY threads. Rate-limit read/parse logging. Do not spawn a second parking thread.

- [ ] **Step 9: Run manager and guardian suites**

Run: `cargo test -p amber -- --nocapture`

- [ ] **Step 10: Commit parking integration**

```bash
git add crates/amber/src/pty.rs crates/amber/src/manager.rs crates/amber/src/memory_guardian.rs crates/amber/src/main.rs
git commit -m "feat: park agents under host pressure"
```

### Task 4: Delegated CPU Weighting

**Files:**
- Modify: `crates/amber/src/cgroup.rs`
- Modify: `crates/amber/src/manager.rs`
- Modify: `infra/daemon/amber.service`
- Modify: `app/src/main/serviceManager.ts`
- Modify: `app/src/main/serviceManager.test.ts`

**Interfaces:**
- Consumes: manager foreground slot from Task 3.
- Produces: optional CPU controller activation and `reconcile_cpu_weights(foreground_slot)`.

- [ ] **Step 1: Add failing fake-cgroup tests**

Prove partial activation with memory-only controllers remains enabled, CPU-capable activation enables `+cpu +memory`, daemon weight is 10000, foreground session is 1000, background is 100, and a missing/failed `cpu.weight` does not fail session create or focus.

- [ ] **Step 2: Run cgroup tests and observe missing CPU behavior**

Run: `cargo test -p amber cgroup::tests -- --nocapture`

- [ ] **Step 3: Implement optional CPU delegation and weight reconciliation**

Track memory and CPU capability separately. Memory activation remains required for containment; CPU is optional. Write weights nonblocking. Reconcile after create, restore, focus/input, rename completion, remove, and reap.

- [ ] **Step 4: Add failing unit-parity tests**

Require both unit copies to contain `Delegate=cpu memory` and remain byte-equivalent for resource directives.

- [ ] **Step 5: Update both units and run focused app test**

Run: `cd app && npm test -- --run src/main/serviceManager.test.ts`

- [ ] **Step 6: Run Rust cgroup and manager tests**

Run: `cargo test -p amber -- --nocapture`

- [ ] **Step 7: Commit CPU prioritization**

```bash
git add crates/amber/src/cgroup.rs crates/amber/src/manager.rs infra/daemon/amber.service app/src/main/serviceManager.ts app/src/main/serviceManager.test.ts
git commit -m "feat: prioritize foreground amber session"
```

### Task 5: Electron and Web Resource-Pressure UI

**Files:**
- Modify: `app/src/shared/proto.ts`
- Modify: `app/src/shared/proto.test.ts`
- Modify: `app/src/client/index.ts`
- Modify: `app/src/web/amber.ts`
- Modify: `app/src/web/amber.test.ts`
- Modify: `app/src/renderer/store.ts`
- Modify: `app/src/renderer/store.test.ts`
- Modify: `app/src/renderer/main.tsx`
- Modify: `app/src/renderer/SplitView.tsx`
- Modify renderer tests that exercise pressure banners and parked overlays.

**Interfaces:**
- Consumes: watcher version 2, `ResourcePressure`, and `resource-suspended`.
- Produces: typed decode, reducer state, cause banner, and generalized parked overlay.

- [ ] **Step 1: Add failing shared-protocol and web tests**

Prove strict level/cause validation, additive `blocked` default, version-2 subscription, and resource-pressure bridge mapping.

- [ ] **Step 2: Run focused tests and observe missing variant failures**

Run: `cd app && npm test -- --run src/shared/proto.test.ts src/web/amber.test.ts`

- [ ] **Step 3: Implement TypeScript protocol and bridge support**

Use typed causes `'cpu' | 'io' | 'memory'`. Reject unknown values. Preserve all MemoryPressure behavior.

- [ ] **Step 4: Add failing reducer and presentation tests**

Prove cause updates, identical-event no-op, clear-on-reconnect, `resource-suspended` dot/label, legacy `memory-suspended` acceptance, and “Parked to protect system resources” overlay copy.

- [ ] **Step 5: Run focused renderer tests and observe failures**

Run: `cd app && npm test -- --run src/renderer/store.test.ts`

- [ ] **Step 6: Implement reducer, banner, and overlay changes**

Keep memory and resource pressure as separate state so memory telemetry remains visible. Clear both on reconnect to an older daemon. Focus from overlay continues using existing guarded user-interaction path.

- [ ] **Step 7: Run app tests and typecheck**

Run: `cd app && npm test -- --run`

Run: `cd app && npm run typecheck`

- [ ] **Step 8: Commit client support**

```bash
git add app/src
git commit -m "feat: show amber resource pressure"
```

### Task 6: Verification, Isolated Linux Proof, and Documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-08-23-resource-pressure-guardian-design.md`
- Modify only existing verification helpers if required by their documented interface.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: requirement-by-requirement evidence without touching production Amber sessions.

- [ ] **Step 1: Run formatting and static gates**

Run:

```bash
cargo fmt --all -- --check
RUSTFLAGS='-D warnings' cargo clippy --workspace --all-targets
cd app && npm run typecheck
```

- [ ] **Step 2: Run complete automated suites**

Run:

```bash
cargo test --workspace
cd app && npm test -- --run
```

- [ ] **Step 3: Verify systemd unit parity and syntax**

Run the existing service-manager tests and `systemd-analyze --user verify infra/daemon/amber.service` without installing or restarting the unit.

- [ ] **Step 4: Run private Linux smoke proof**

Start the worktree binary in a transient user service with an isolated temporary state root and delegated CPU/memory controllers. Create resumable fake agent workloads. Verify cgroup placement and exact weights, inject or use a test PSI source to advance a 120-second episode deterministically, prove foreground exclusion, one-at-a-time parking, workload cleanup, and exact resume. Stop the transient unit and remove only its validated temporary state root.

- [ ] **Step 5: Update verification log with exact commands and results**

Record platform, test counts, cgroup observations, smoke-test results, known external/pre-existing gate failures, and explicit statement that production `amber.service` was not restarted.

- [ ] **Step 6: Audit every spec requirement against code or test evidence**

Check goals, non-goals, thresholds, capability negotiation, safety, degraded behavior, UI, rollback, and success criteria. Any missing evidence returns to the responsible task.

- [ ] **Step 7: Commit verification record**

```bash
git add docs/superpowers/specs/2026-08-23-resource-pressure-guardian-design.md
git commit -m "docs: verify resource pressure guardian"
```
