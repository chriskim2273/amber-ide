# Task 8 report — native Windows CI and verification record

**Outcome:** DONE_WITH_CONCERNS

## Delivered

- Added the mandatory `rust-windows` `windows-latest` / MSVC GitHub Actions
  job. It strictly clippies `amber`, builds both the `amber` and `amberd`
  binary targets, runs explicit portable and Windows-native Rust targets,
  builds the isolated `windows_pipe_peer.exe`, runs the real Node ↔ Rust
  named-pipe harness with an absolute `AMBER_WINDOWS_PIPE_PEER`, and performs
  app typecheck plus Vitest.
- Replaced the web integration fixture's `LocalStream::set_read_timeout` with
  one wall-clock deadline and `LocalStream::read_with_timeout`. This preserves
  the Create → Created daemon-link assertion while using the named-pipe-safe
  API.
- Made strict Windows clippy executable without a warning-suppression policy:
  Linux-only cgroup, PSI, `/proc`, signal, and systemd helpers now compile only
  on Linux (or for their unit tests). Also fixed the three actual clippy issues
  discovered by the target check.
- Updated the README and project constitution for platform-local IPC and added
  the native/manual proof record at
  `docs/superpowers/specs/2026-08-27-windows-verification.md`.

## Evidence run locally

| Check | Result |
| --- | --- |
| Initial `grep -q 'windows-pipe.mjs' .github/workflows/ci.yml` | Red (exit 1 before workflow edit) |
| Workflow YAML parse + both required greps | Pass |
| `cargo check -p amber --lib --bins --target x86_64-pc-windows-msvc` | Pass, no warnings |
| `RUSTFLAGS='-Dwarnings' cargo clippy -p amber --target x86_64-pc-windows-msvc` | Pass |
| `cargo test -p amber --test web` | Pass, 18 tests |
| `cargo test -p amber --lib cgroup` | Pass, 28 tests (365 filtered) |
| `cargo test -p amber --test windows_pipe` | Pass, 2 tests on this Unix host |
| `cargo test -p amber --features test-support --test windows_pty` | Pass, 2 tests |
| `node --test app/test/windows-pipe-lifecycle.test.mjs` | Pass, 18 tests |
| `node --check app/test/windows-pipe.mjs` | Pass |
| `cd app && npm run typecheck && npm test` | Pass, 583 tests; 1 existing skip |
| `cargo fmt --check` | Not green: broad pre-existing formatting drift outside Task 8 |
| `cargo test --workspace` | Not green on this host: attempted Windows-GNU DLL tooling and failed because `x86_64-w64-mingw32-dlltool` is absent; the explicit target gates above passed |

The normal local command wrapper corrupts Cargo's `-- -D warnings` forwarding
by passing `-D` to rustc as an input filename. The equivalent strict check
above uses `RUSTFLAGS='-Dwarnings'`; the GitHub Actions workflow uses the
ordinary required `cargo clippy -p amber -- -D warnings` command.

## Native Windows evidence and residual gates

At `fc12fc6`, supplied fresh Windows 10/MSVC evidence confirms token privacy,
stability, and concurrent creation; it also identified the named-pipe timeout
failure in the web fixture. The amended native CI job has not been executed in
this task, so it remains the next required gate.

The manual checklist remains deliberately unchecked: fresh-user install, every
agent resume, alternate-screen attach, real browser web access, logoff restore,
and reboot restore. The verification document records these without claiming
Linux or cross-target output as native proof.

## Review follow-up: native library and attach coverage

- The mandatory Windows job now executes `cargo test -p amber --lib` in
  addition to `cargo test -p amber-core` and the explicit web integration
  target. This makes the Task 7 Windows ACL-negative unit tests executable on
  a real Windows runner rather than merely compilable.
- Cross-target compilation exposed only genuinely Unix-specific library unit
  tests: Unix permission-bit journal recovery, cgroup pipe behavior, and
  Unix `waitpid`/signal supervision. Those exact tests are cfg-gated; portable
  `amber` unit coverage remains in the new library gate.
- `windows_attach` now uses a real named pipe and invokes the production
  Windows attach event loop through Focus → Attach → Resize → Input → Detach;
  a second case closes the accepted pipe and asserts the blocked loop returns
  `SocketClosed`. Its test-only console boundary calls the shared RAII restore
  helper, proving output mode restores before input mode without duplicating
  attach logic or modifying the runner console.
- Node setup remains before both the pipe-peer build and the Node harness, so
  the harness cannot depend on the image's incidental Node installation.

### Follow-up local evidence

| Check | Result |
| --- | --- |
| `cargo test -p amber-core` | Pass, 116 tests |
| `cargo test -p amber --lib` | Pass, 393 tests |
| `cargo check -p amber-core --tests --target x86_64-pc-windows-msvc` | Pass |
| `cargo check -p amber --lib --target x86_64-pc-windows-msvc` | Pass |
| `cargo check -p amber --features test-support --test windows_attach --target x86_64-pc-windows-msvc` | Pass |

This Linux host cannot link MSVC binaries (`link.exe` is unavailable), so
cross-target checks do not replace native execution. The amended web suite
must complete on the Windows runner with its normal Cargo test timeout; it is
not skipped or given a short artificial timeout. `cargo fmt --check` remains
blocked by unrelated repository-wide formatting drift, and the prior
Windows-GNU DLL-tool issue remains outside this task.
