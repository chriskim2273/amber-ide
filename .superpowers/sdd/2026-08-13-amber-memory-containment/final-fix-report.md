# Final Fix Report — Amber Memory Containment

## Status

Complete. All requested final-review findings are fixed and the implementation
is committed as `d03ed5677ba80251743f76272aa9f07b52182890`
(`fix: harden memory containment transitions`). No production install or
service restart was run.

## Findings closed

### 1. Mixed-version pressure protocol

- Added the explicit, versioned `WatchMemoryPressure { version }` capability.
  `WatchSessions` retains its old meaning, and `MemoryPressure` is queued only
  to connections that opted into pressure version 1 or later.
- Watch capabilities merge onto one per-connection watcher/forwarder, avoiding
  duplicate queues or socket writers when Electron or amber-web requests both
  session and pressure events.
- Electron and amber-web advertise pressure version 1. Their current daemon
  decoders skip a well-framed unknown control and continue at the next frame.
  Framing errors remain fatal.
- Rust decoding distinguishes a genuinely unknown enum variant from a malformed
  known variant by inspecting the externally tagged JSON before deserializing
  `ControlMsg`. Known malformed controls remain hard failures. Electron keeps
  its required `MemoryPressure.level` validation as well.
- Linux amber-web upgrades now run `systemctl --user enable` followed by an
  explicit `restart`; `enable --now` would leave an already-running old strict
  decoder resident.
- The socket integration regression connects a strict legacy session watcher
  and a versioned watcher to the same daemon. Only the latter receives pressure;
  the former's next frame is an ordinary `Sessions` reply, proving it remains
  connected and never sees the new variant.

### 2. Crash-safe session rename

- Replaced artifact moves with a durable copy/publish/cleanup transaction:
  source metadata and artifacts remain intact while destination Claude resume
  metadata, generated settings, and scrollback are copied; destination session
  metadata is published only after those copies are durable; source metadata is
  then removed as the commit point; source artifacts are garbage-collected
  afterward.
- Atomic writes now sync the temporary file and containing directory. Metadata
  removal also syncs its directory. A directory-sync error after a successful
  source-metadata removal is logged without deleting the destination, avoiding
  the only rollback direction that could lose both authoritative records.
- Every destination metadata/artifact is preflighted. Existing destination
  metadata and orphan artifacts are never clobbered.
- Pre-commit operational failures remove published destination copies in
  reverse order. Post-commit cleanup failures are logged and treated as
  successful rename so the live manager never rolls back against an already
  committed new name.
- A deterministic crash seam interrupts immediately after all eight mutations:
  three artifact copies, destination metadata publication, source metadata
  removal, and three source-artifact removals. At every interruption, every
  restorable old/new metadata record has the matching recorded conversation id.
- Existing manager rollback coverage remains green for partial store refusal,
  cgroup prepare failure, and restore/spawn failure.

### 3. Output/suspend linearization

- Exact output activity is now published at the raw PTY-read boundary, under
  the same per-session transition guard used by the guardian's final
  eligibility check and suspend claim.
- The guard is released before the bounded batching channel, ring work, and
  subscriber fan-out. A saturated client can therefore backpressure output
  without holding the suspend/focus transition lock.
- UI `Activity` emission retains its independent 500 ms rate-limit clock;
  guardian truth is never rate-limited.
- The fault test fills a subscriber queue, blocks the batcher in fan-out, then
  produces another PTY read behind it. That later output updates activity before
  reaching the ring and makes `suspend_for_memory` reject the claim as recent.

### 4. Authoritative ordered run state

- `ReportRunState` carries a monotonic per-supervisor sequence and receives a
  matching `RunStateAck`. Sequence zero remains a mixed-version legacy mode
  until a versioned report establishes authority for the live PTY.
- The manager applies sequence checks under the session transition guard.
  Duplicate/stale reports are acknowledged idempotently but cannot overwrite a
  newer state; legacy reports cannot overwrite versioned truth.
- Each `amber run` owns one ordered reporter worker. It processes states FIFO,
  retries the same sequence across dropped connections/acks, and advances only
  after acknowledgement. The final `shell-fallback` report waits for itself and
  all predecessors before the supervisor execs the shell.
- `claude` running state is emitted only after the agent process successfully
  spawns. Manager restore no longer infers a running agent merely because the
  supervisor PTY exists.
- Tests prove a dropped terminal-state ack retries the identical sequence, a
  stale reordered running report cannot replace acknowledged shell fallback,
  and a spawn failure emits retrying but never running.

### 5. Suspension failure containment

- Both SIGUSR1 and SIGUSR2 handler registrations are required before supervised
  agent launch. If either cannot be installed, Amber does not expose unsafe
  suspend capability; it reports shell fallback and retains the pane/session.
- A nonretryable cgroup workload-cleanup error now performs fallback process-tree
  and child reclamation, waits for the child, and returns success to the parked
  supervisor loop. It no longer exits `amber run`, so daemon reap cannot delete
  session metadata or its resume record because containment cleanup failed.
- Fault tests cover failure of the second signal registration and a
  nonretryable cgroup cleanup error while asserting the workload child is gone
  and the supervisor path remains recoverable.
- The adjacent socket Focus fixture now begins in genuinely suspended state and
  asserts the actual resume signal printed by its trapped child. It no longer
  pre-seeds a running value that could make the test pass without proving a
  signal.

### 6. Parked overlay activation

- The memory-parked overlay is keyboard-focusable and has a visible focus ring
  plus an accessible resume label.
- Resume-on-focus uses Amber's existing one-shot user arming model: trusted
  pointer activation sends once and suppresses its paired focus; trusted Tab
  navigation arms one focus event; focus bubbling from the Resume button stays
  on that button's single click path.
- Unarmed programmatic mount/keep-alive focus and hidden-tab focus remain inert.
  This deliberately does not rely on `FocusEvent.isTrusted`, which browsers may
  set even when script calls `element.focus()`.

## TDD and fault-injection evidence

Representative RED failures recorded before implementation:

- Electron unknown-control regression threw `unknown control: FutureControl`.
- Versioned watcher integration failed to compile before the capability and
  pressure-only broadcast existed.
- Rename crash test failed to compile before the checkpoint transaction seam;
  the old move-first implementation could strand old metadata without its
  source resume record.
- Saturated-output regression initially allowed `suspend_for_memory`; the
  strengthened second-stage regression then timed out with
  `raw pty output queued behind fan-out never published activity` before the
  timestamp moved to the raw-reader boundary.
- Reordered run-state integration timed out before acknowledgements/sequences;
  the dropped-ack test had no retry path, and spawn-failure coverage observed
  the pre-spawn running report.
- Signal-install and nonretryable-cleanup fault tests failed under the previous
  best-effort/propagating behavior.
- The overlay predicate test initially failed because the guarded activation
  helper did not exist.

Focused GREEN evidence:

- `cargo test -p amber-core state::tests -- --nocapture` — 34 passed.
- `cargo test -p amber restore_ -- --nocapture` — 9 passed.
- `cargo test -p amber manager::tests::output_waiting_on_a_saturated_subscriber_blocks_memory_suspend -- --nocapture`
  — 1 passed after the strengthened RED.
- `npm test -- --run src/renderer/store.test.ts src/shared/proto.test.ts` —
  65 passed.

## Final verification

- `cargo test --workspace --all-targets --quiet` — 450 tests passed across all
  Rust unit/integration/binary suites.
- `cargo clippy --workspace --all-targets --quiet -- -D warnings` — passed.
- `npm test -- --run` — 480 passed; the existing real-daemon test remained the
  single intentional skip.
- `npm run typecheck` — both TypeScript projects passed.
- `npm run build` — Electron main, preload, and renderer production bundles
  built successfully.
- `bash -n infra/daemon/install.sh` — passed.
- `git diff --exit-code -- Cargo.lock app/package-lock.json` — no dependency or
  lockfile changes.
- `git diff --check` and staged diff check — passed.

## Review notes and remaining verification boundaries

- The rename crash matrix is deterministic mutation-boundary fault injection,
  not a real power-cut test. It exercises the transaction state after every
  visible mutation without running in-process rollback; Linux file/directory
  sync calls were exercised, while real-Mac filesystem crash behavior remains
  an existing platform verification boundary.
- The mixed-version integration uses a strict old-client decoding path against
  the current daemon rather than launching a historical packaged binary.
- The overlay policy has pure reducer/helper coverage and passes the complete
  app build; this repository still has no renderer component harness, so a live
  pointer/Tab gesture check remains useful during the existing GUI verification
  pass.
- Ordered reporting intentionally favors state truth over immediate fallback:
  if the daemon socket is temporarily unavailable, the terminal
  `shell-fallback` transition waits and retries until it is acknowledged.
- `known_control_variant` is deliberately explicit; future `ControlMsg`
  additions must update that list so malformed known messages never degrade to
  skippable unknowns. A code comment records this maintenance invariant.
