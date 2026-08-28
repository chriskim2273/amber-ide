# Windows Port Rebase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port current Amber daemon, desktop app, CLI, supervision, and web link to Windows without weakening Unix behavior.

**Architecture:** A `transport` module isolates Unix sockets from Windows named pipes; a `platform` module isolates paths, names, permissions, shell selection, and lifecycle support. Existing daemon protocol and renderer flow remain unchanged. `amberd.exe` owns the windowless daemon role; `amber.exe` remains a console CLI.

**Tech Stack:** Rust, portable-pty, interprocess, windows-sys, winreg, directories, Electron, Node `net`, electron-builder NSIS, Vitest, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-27-windows-port-rebase-design.md`

## Global Constraints

- Support Windows 10 build 17763 or newer and x86_64 MSVC first.
- Never require elevation; use per-user paths and HKCU only.
- Keep `amber-core` platform-neutral and retain raw length-prefixed frames.
- Keep Unix behavior behind `#[cfg(unix)]` unchanged and rerun Unix Rust/app suites after every task.
- Use `GenericNamespaced` named pipes; do not rely on filesystem conversion for pipe names.
- Windows pipe access requires user-scoped DACL and first-instance ownership before release.
- `amberd.exe` is windowless; `amber.exe` remains a console application.
- Never claim named-pipe, ConPTY, or reboot correctness without Windows execution.

## File Structure

- `crates/amber/src/transport.rs`: local connection listener/stream split for Unix and Windows.
- `crates/amber/src/platform.rs`: paths, pipe names, name validation, shell/executable lookup, secure token files.
- `crates/amber/src/winlifecycle.rs`: Windows shutdown window and console control callback.
- `crates/amber/src/bin/amberd.rs`: Windows windowless daemon binary entrypoint.
- `crates/amber/src/{daemon,watchers,main,manager,pty,supervisor,attach,web}.rs`: consumers of platform and transport seams.
- `app/src/shared/socketPath.ts`: matching Node socket or named-pipe path.
- `app/src/main/{amberBin,serviceManager,index,sshRemote}.ts`: binaries, HKCU startup, packaged installation, Windows remote-feature guard.
- `scripts/dist.sh`, `app/scripts/dist.sh`, `app/package.json`, `.github/workflows/ci.yml`: Windows release and CI gates.

### Task 1: Platform primitives and safe names

**Files:**
- Create: `crates/amber/src/platform.rs`
- Modify: `crates/amber/Cargo.toml`, `crates/amber/src/lib.rs`, `crates/amber/src/manager.rs`

**Interfaces:**
- Produces `platform::state_root() -> anyhow::Result<PathBuf>`, `platform::socket_name() -> anyhow::Result<PathBuf>`, `platform::default_shell() -> OsString`, and `platform::validate_session_name(&str) -> anyhow::Result<()>`.
- `SessionManager::validate_name` delegates to `platform::validate_session_name`.
- `platform.rs` contains its own `#[cfg(test)] mod tests`.

- [ ] **Step 1: Write failing platform tests**

```rust
#[test]
fn rejects_windows_device_and_trailing_names() {
    for name in ["CON", "aux", "a:b", "name.", "name "] {
        assert!(validate_session_name(name).is_err(), "{name}");
    }
    assert!(validate_session_name("amber-1-1-0-safe").is_ok());
}
```

- [ ] **Step 2: Verify test fails because platform validation is absent**

Run: `cargo test -p amber rejects_windows_device_and_trailing_names`

Expected: compile failure for unresolved `validate_session_name`.

- [ ] **Step 3: Implement minimum cfg-gated platform helpers**

```rust
pub fn validate_session_name(name: &str) -> anyhow::Result<()> {
    if name.is_empty() || name.len() > 200 || name.bytes().any(|b| !matches!(b, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.')) {
        anyhow::bail!("invalid session name: {name:?}");
    }
    #[cfg(windows)]
    if name.ends_with(['.', ' ']) || reserved_device_name(name) { anyhow::bail!("invalid Windows session name: {name:?}"); }
    Ok(())
}
```

- [ ] **Step 4: Verify focused and full Unix tests pass**

Run: `cargo test -p amber rejects_windows_device_and_trailing_names && cargo test --workspace`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/amber/Cargo.toml crates/amber/src/{lib.rs,platform.rs,manager.rs}
git commit -m "feat(win): add platform primitives and safe names"
```

### Task 2: Named-pipe transport and Windows proof harness

**Files:**
- Create: `crates/amber/src/transport.rs`, `crates/amber/tests/windows_pipe.rs`, `app/test/windows-pipe.mjs`
- Modify: `crates/amber/Cargo.toml`, `crates/amber/src/lib.rs`

**Interfaces:**
- Produces `transport::{bind, connect, LocalListener, LocalStream, LocalReader, LocalWriter}`.
- `LocalStream::into_split() -> io::Result<(LocalReader, LocalWriter)>`; `LocalWriter::shutdown()` terminates a blocked peer.
- Unix test builds also expose `transport::test_pair() -> io::Result<(LocalStream, LocalStream)>`.

- [ ] **Step 1: Write failing Unix transport parity test and Windows pipe/Node harness**

```rust
#[test]
fn local_stream_round_trips_a_protocol_frame() {
    let (mut client, mut server) = transport::test_pair().unwrap();
    write_frame(&mut client, &Frame::Control(ControlMsg::SessionList { names: vec![] })).unwrap();
    assert!(matches!(Decoder::read_one(&mut server).unwrap(), Frame::Control(_)));
}
```

`windows-pipe.mjs` starts the test server, opens two `net.createConnection({ path })` clients, exchanges a `SessionList` frame, then closes one stalled client.

- [ ] **Step 2: Verify the Rust test fails because transport is absent**

Run: `cargo test -p amber local_stream_round_trips_a_protocol_frame`

Expected: compile failure for missing `transport` module.

- [ ] **Step 3: Implement transport without changing Unix semantics**

```rust
#[cfg(unix)] pub type LocalStream = UnixStream;
#[cfg(windows)] pub struct LocalStream(interprocess::local_socket::Stream);

#[cfg(windows)]
fn pipe_name(path: &Path) -> io::Result<Name<'static>> {
    path.to_str().ok_or_else(|| io::Error::other("non-UTF8 pipe name"))?
        .to_ns_name::<GenericNamespaced>()
}
```

Implement Windows listener creation with first-instance ownership and a user-scoped security descriptor. Keep `SO_SNDTIMEO` only on Unix; Windows eviction closes the writer handle after bounded queue grace.

- [ ] **Step 4: Verify transport gates**

Run: `cargo test -p amber local_stream_round_trips_a_protocol_frame && cargo clippy -p amber -- -D warnings && cargo test --workspace`

On Windows CI run: `cargo test -p amber --test windows_pipe` and `node app/test/windows-pipe.mjs`.

Expected: Unix PASS; Windows test proves Node interop, second client, and stalled-peer release.

- [ ] **Step 5: Commit**

```bash
git add crates/amber/Cargo.toml crates/amber/src/{lib.rs,transport.rs} crates/amber/tests/windows_pipe.rs app/test/windows-pipe.mjs
git commit -m "feat(win): add named-pipe transport boundary"
```

### Task 3: Move daemon, watchers, CLI, and web daemon link onto transport

**Files:**
- Modify: `crates/amber/src/{daemon.rs,watchers.rs,main.rs,supervisor.rs,web.rs}`
- Modify: Unix-only tests under `crates/amber/tests/`

**Interfaces:**
- Consumes Task 2 `LocalStream` and split halves.
- Produces no protocol changes; all call sites use `transport::connect` and `transport::bind`.
- Adds `Daemon::serve_one_for_test(LocalStream) -> anyhow::Result<()>` under `#[cfg(test)]` so the transport boundary has a real daemon-level test.

- [ ] **Step 1: Write failing compile-gate test for platform-neutral daemon connection**

```rust
#[test]
fn daemon_accepts_local_transport_listener() {
    let (_client, server) = transport::test_pair().unwrap();
    assert!(Daemon::new(test_manager(), test_watchers()).serve_one_for_test(server).is_ok());
}
```

- [ ] **Step 2: Verify test fails on Unix-only daemon signatures**

Run: `cargo test -p amber daemon_accepts_local_transport_listener`

Expected: type mismatch between `LocalListener` and `UnixListener`.

- [ ] **Step 3: Replace only transport types at connection boundaries**

```rust
pub fn serve(&self, listener: LocalListener) -> anyhow::Result<()> { /* existing loop */ }
fn connection_loop(stream: LocalStream, ...) { let (read, write) = stream.into_split()?; }
```

Move `web::Hub`'s daemon field and reconnect loop to `LocalStream`; retain its HTTP TCP sockets unchanged. Preserve Unix test helpers behind `#[cfg(unix)]`.

- [ ] **Step 4: Verify daemon, watcher, web, and Unix regression suites**

Run: `cargo test -p amber daemon_accepts_local_transport_listener && cargo test -p amber --test socket --test watch --test web && cargo test --workspace`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/amber/src/{daemon.rs,watchers.rs,main.rs,supervisor.rs,web.rs} crates/amber/tests
git commit -m "refactor: route daemon clients through local transport"
```

### Task 4: Windows PTY and current-agent lifecycle

**Files:**
- Modify: `crates/amber/src/{pty.rs,manager.rs,supervisor.rs,claude.rs,codex.rs,grok.rs,opencode.rs,procinfo.rs}`
- Create: `crates/amber/tests/windows_pty.rs`

**Interfaces:**
- `PtySession` closes subscriptions when waiter records terminal child status.
- `SupervisorControl` owns `suspend: AtomicBool` and `resume: AtomicBool`; Unix signals and Windows daemon commands set the same state machine.
- `PtySession::session_with_non_eof_reader_for_test(CommandBuilder)` is a test-only fixture that retains the read handle after child exit.

- [ ] **Step 1: Write failing waiter-teardown test**

```rust
#[test]
fn child_wait_closes_subscriptions_without_reader_eof() {
    let session = PtySession::session_with_non_eof_reader_for_test(command("exit 7"));
    let receiver = session.subscribe();
    assert_eq!(session.wait_exit().unwrap(), 7);
    assert!(receiver.recv_timeout(Duration::from_secs(1)).is_err());
}
```

- [ ] **Step 2: Verify test fails while EOF remains authoritative**

Run: `cargo test -p amber child_wait_closes_subscriptions_without_reader_eof`

Expected: receiver remains open or test helper is missing.

- [ ] **Step 3: Implement waiter-authoritative teardown and platform launch helpers**

```rust
let code = child.wait()?.exit_code();
*exit_code.lock().unwrap() = Some(code);
subs.lock().unwrap().clear();
```

Use `platform::default_shell`, `which`/`PATHEXT` lookup, Windows Ctrl-C exit classification, and Windows shell fallback by spawn-and-wait. Keep Unix `exec`, signals, cgroups, and process inspection cfg-gated.

- [ ] **Step 4: Add supervisor-control test before implementation**

```rust
#[test]
fn supervisor_command_parks_then_resumes_agent() {
    let control = SupervisorControl::default();
    control.apply(SupervisorCommand::Suspend);
    assert!(control.take_suspend());
    control.apply(SupervisorCommand::Resume);
    assert!(control.take_resume());
}
```

- [ ] **Step 5: Implement bidirectional supervisor control and verify**

Run: `cargo test -p amber child_wait_closes_subscriptions_without_reader_eof supervisor_command_parks_then_resumes_agent && cargo test --workspace`

Expected: PASS; each current supervised agent continues to use its existing resume ladder.

- [ ] **Step 6: Commit**

```bash
git add crates/amber/src/{pty.rs,manager.rs,supervisor.rs,claude.rs,codex.rs,grok.rs,opencode.rs,procinfo.rs} crates/amber/tests/windows_pty.rs
git commit -m "feat(win): port pty and supervisor lifecycle"
```

### Task 5: Windows daemon binary, lifecycle, and command-line attach

**Files:**
- Create: `crates/amber/src/{winlifecycle.rs,bin/amberd.rs}`
- Modify: `crates/amber/src/{main.rs,attach.rs,lib.rs}`, `crates/amber/Cargo.toml`
- Test: `crates/amber/src/attach.rs` unit module, `crates/amber/tests/windows_attach.rs`

**Interfaces:**
- `winlifecycle::install_shutdown_handler(Arc<SessionManager>)` invokes `snapshot_final` after `WM_ENDSESSION`.
- `amberd` starts `amber::daemon_main()` with `#![windows_subsystem = "windows"]` only on Windows.

- [ ] **Step 1: Write failing Windows-only console-size test**

```rust
#[cfg(windows)]
#[test]
fn windows_console_size_reads_visible_window() {
    let info = ConsoleBufferInfo { width: 132, height: 43 };
    assert_eq!(windows_console_size_from_info(info), (132, 43));
}
```

- [ ] **Step 2: Verify test fails because Windows attach path is absent**

Run: `cargo test -p amber --test windows_attach windows_console_size_reads_visible_window`

Expected: compile failure for missing `windows_console_size_from_info`.

- [ ] **Step 3: Implement narrow cfg-gated Windows paths**

Use `SetConsoleMode` RAII restoration, a stdin reader plus socket reader forwarding to one `mpsc` loop, and `GetConsoleScreenBufferInfo` polling. Create a hidden top-level `WS_EX_TOOLWINDOW` for `WM_QUERYENDSESSION`/`WM_ENDSESSION`; never use `HWND_MESSAGE`.

- [ ] **Step 4: Verify compile and focused tests**

Run: `cargo test -p amber --test windows_attach windows_console_size_reads_visible_window && cargo test --workspace && cargo clippy -p amber -- -D warnings`

On Windows CI run: `cargo build -p amber -p amberd` and `cargo test -p amber --test windows_attach`.

- [ ] **Step 5: Commit**

```bash
git add crates/amber/Cargo.toml crates/amber/src/{main.rs,attach.rs,lib.rs,winlifecycle.rs,bin/amberd.rs} crates/amber/tests/windows_attach.rs
git commit -m "feat(win): add daemon lifecycle and attach client"
```

### Task 6: Electron connection, installer, packaging, and SSH feature guard

**Files:**
- Modify: `app/src/shared/{socketPath.ts,socketPath.test.ts}`, `app/src/main/{amberBin.ts,amberBin.test.ts,serviceManager.ts,serviceManager.test.ts,index.ts,sshRemote.ts,sshRemote.test.ts}`
- Modify: `app/package.json`, `scripts/dist.sh`, `app/scripts/dist.sh`

**Interfaces:**
- `resolveSocketPath(env, platform)` returns the Windows pipe name when `platform === 'win32'`.
- `windowsDaemonPath(localAppData)` returns `%LOCALAPPDATA%\\Programs\\amber-ide\\amberd.exe`.
- `sshRemote.isSupportedOnPlatform('win32')` returns false with user-facing reason.

- [ ] **Step 1: Write failing TypeScript tests**

```ts
it('uses matching Windows pipe name', () => {
  expect(resolveSocketPath({ USERNAME: 'alice' }, 'win32')).toBe('\\\\.\\pipe\\amber-ide-alice')
})
it('declares remote SSH unsupported on Windows', () => {
  expect(isSupportedOnPlatform('win32')).toEqual({ ok: false, reason: expect.stringContaining('named pipe') })
})
```

- [ ] **Step 2: Verify tests fail**

Run: `npm test -- src/shared/socketPath.test.ts src/main/sshRemote.test.ts`

Expected: missing platform parameter or unsupported-feature helper.

- [ ] **Step 3: Implement matching paths and per-user install**

Add NSIS `win` target with `perMachine: false` and `allowElevation: false`. Bundle console `amber.exe` plus `amberd.exe`; install both atomically; write HKCU Run value for `amberd.exe daemon`; use `taskkill` only after `snapshot-now` succeeds or reports daemon absent.

- [ ] **Step 4: Verify TypeScript gates**

Run: `npm test -- src/shared/socketPath.test.ts src/main/{amberBin,serviceManager,sshRemote}.test.ts && npm run typecheck && npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/package.json app/scripts/dist.sh scripts/dist.sh app/src/shared/socketPath.* app/src/main/{amberBin.*,serviceManager.*,index.ts,sshRemote.*}
git commit -m "feat(win): package desktop daemon and pipe client"
```

### Task 7: Web token security and named-pipe daemon link

**Files:**
- Modify: `crates/amber/src/{web.rs,platform.rs}`
- Test: `crates/amber/src/web.rs` tests and `crates/amber/tests/web.rs`

**Interfaces:**
- `platform::random_bytes(&mut [u8]) -> io::Result<()>` uses Unix entropy or Windows cryptographic RNG.
- `platform::write_user_private(path, bytes) -> anyhow::Result<()>` creates or verifies a current-user-only token file.

- [ ] **Step 1: Write failing token helper tests**

```rust
#[test]
fn token_creation_uses_platform_private_file() {
    let root = tempfile::tempdir().unwrap();
    let token = load_or_create_token(root.path(), false).unwrap();
    assert_eq!(token.len(), 43);
    assert!(platform::is_user_private(&root.path().join("web-token")).unwrap());
}
```

- [ ] **Step 2: Verify test fails because web uses `/dev/urandom` and Unix modes directly**

Run: `cargo test -p amber token_creation_uses_platform_private_file`

Expected: absent platform private-file API.

- [ ] **Step 3: Implement secure platform-backed token operations**

Replace direct `/dev/urandom`, `OpenOptionsExt::mode`, `PermissionsExt`, and `UnixStream` references in web daemon-link code. Refuse `amber web` on Windows when current-user token permissions cannot be established.

- [ ] **Step 4: Verify web gates**

Run: `cargo test -p amber token_creation_uses_platform_private_file && cargo test -p amber --test web && cargo test --workspace`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/amber/src/{web.rs,platform.rs} crates/amber/tests/web.rs
git commit -m "feat(win): port web daemon link and token security"
```

### Task 8: Native CI and release verification record

**Files:**
- Modify: `.github/workflows/ci.yml`, `README.md`, `CLAUDE.md`
- Create: `docs/superpowers/specs/2026-08-27-windows-verification.md`

**Interfaces:**
- Windows CI executes `cargo clippy -p amber -- -D warnings`, `cargo build -p amber -p amberd`, Rust Windows tests, Node pipe harness, `npm run typecheck`, and Vitest.

- [ ] **Step 1: Write failing workflow assertion test**

```bash
grep -q 'windows-latest' .github/workflows/ci.yml
grep -q 'windows-pipe.mjs' .github/workflows/ci.yml
```

- [ ] **Step 2: Verify assertion fails before Windows job exists**

Run: `grep -q 'windows-pipe.mjs' .github/workflows/ci.yml`

Expected: exit 1.

- [ ] **Step 3: Add native Windows CI and manual verification checklist**

Run the new native commands in the workflow. Record unverified items as unchecked: fresh-user install, each agent resume, attach alt-screen, web browser, logoff, and reboot restore. Do not mark them complete from Linux output.

- [ ] **Step 4: Verify workflow syntax and all local regressions**

Run: `cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace && (cd app && npm run typecheck && npm test)`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml README.md CLAUDE.md docs/superpowers/specs/2026-08-27-windows-verification.md
git commit -m "ci(win): add native Windows verification gates"
```

## Plan Self-Review

- Spec coverage: Tasks 1–3 cover platform, transport, daemon, watchers, CLI, and web local link; Tasks 4–5 cover PTY, agents, supervision, attach, lifecycle, and `amberd`; Task 6 covers desktop/package/SSH guard; Task 7 covers web token security; Task 8 covers CI and release proof.
- Placeholder scan: no incomplete work markers, vague test instructions, or unspecified interfaces remain.
- Type consistency: all consumers use `transport::LocalStream`; platform helpers use the names declared in Task 1; supervisor-control and app path interfaces are declared before their consumers.
