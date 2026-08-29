# Windows native CI and release verification

**Status:** native CI gates are defined; release proof remains in progress.

Amber's Windows daemon uses current-user named pipes and ConPTY, so the
mandatory proof runs on `windows-latest` x64 with the MSVC toolchain. Linux
cross-compilation is useful for build coverage but cannot replace these gates.

## Mandatory GitHub Actions gate

The `rust-windows` job runs as a standard GitHub-hosted Windows user and must
remain executable, not a documentation-only checklist:

1. `cargo clippy -p amber -- -D warnings` for the real Windows package target.
   This is a strict warnings-as-errors policy—no target-specific warning
   suppression or `--no-deps` exception is used.
2. `cargo build -p amber --bin amber --bin amberd`, which builds both shipped
   binaries. `amberd` is a binary target in the `amber` package, not a separate
   Cargo package.
3. `cargo test -p amber-core` and `cargo test -p amber --lib` run the core and
   all portable `amber` unit tests, including the Task 7 Windows ACL negative
   tests. The portable `web` daemon-link target and the Windows-native
   `windows_pipe`, `windows_attach`, and `windows_pty` targets run separately.
   The attach and pty targets use their declared `test-support` feature. We
   deliberately do not use broad `cargo test -p amber`: several unrelated
   integration targets use Unix sockets, Unix signals, or shell scripts. Only
   genuinely Unix-only test bodies are cfg-gated; no portable target is hidden
   to make Windows green.
4. Build `crates/amber/tests/windows_pipe_peer` and set
   `AMBER_WINDOWS_PIPE_PEER` to the absolute generated
   `windows_pipe_peer.exe`, then run `node app/test/windows-pipe.mjs`. This is
   the real Node ↔ Rust named-pipe harness, not its platform-neutral lifecycle
   unit test.
5. `npm ci`, `npm run typecheck`, and `npx vitest run` in `app`.

The web fixture uses `LocalStream::read_with_timeout` for its Create → Created
acknowledgement. A persistent `set_read_timeout` is a Unix-socket operation and
correctly returns `Unsupported` for a Windows named pipe; the deadline read
retains the same protocol coverage on both transports.

`windows_attach` opens a real current-user named pipe and drives the production
Windows attach event loop through Focus → raw Attach → Resize → Input → Detach,
then separately proves a peer close wakes that loop. Its console-mode test seam
uses the same RAII teardown helper as the real guard and verifies output mode is
restored before input mode without mutating the CI console.

## Native evidence at `fc12fc6`

The following fresh Windows 10/MSVC evidence was supplied before this CI gate
was added:

- [x] `token_file_is_private_and_stable_until_regenerated` passed.
- [x] `concurrent_token_creation_returns_the_single_established_token` passed.
- [x] The real named-pipe `set_read_timeout` behavior was identified as the
  cause of eight web daemon-link failures, rather than being suppressed or
  skipped. The fixture now uses the platform-neutral deadline API.
- [x] Windows cross-target checking validates the amended `amber-core` tests,
  `amber --lib`, and the feature-enabled `windows_attach` target. The one
  state-store test that requires Unix permission bits is cfg-gated; all other
  portable tests remain in the native library gate.
- [ ] Run the amended `web` suite natively.
- [ ] Run the complete mandatory GitHub Actions `rust-windows` job at or after
  the commit containing this document.

## Manual Windows release checklist

These items are intentionally unchecked until someone performs them on a
native Windows machine. Linux output, cross-compilation, and CI compilation do
not satisfy them.

- [ ] Fresh-user desktop install and first launch.
- [ ] Resume each supported agent conversation after daemon restart: Claude,
  Codex, Grok, and OpenCode.
- [ ] `amber attach` through an alternate-screen/full-screen TUI, including
  clean detach and terminal restoration.
- [ ] `amber web` in a real Windows browser, including login and live terminal
  input/output.
- [ ] Windows logoff and sign-in restore.
- [ ] Full Windows reboot and deterministic session restore.

Record the command output, Windows version, Rust toolchain, and any packaging
artifact used when checking an item. Do not convert these into checked items
from a non-Windows run.
