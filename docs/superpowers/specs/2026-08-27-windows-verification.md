# Windows native CI and release verification

**Status:** native implementation, full CI gate, NSIS packaging, and packaged
daemon/CLI smoke proof complete. Interactive-desktop, agent-resume, logoff, and
reboot restore proof remain open.

Amber's Windows daemon uses current-user named pipes and ConPTY, so the
mandatory proof runs on `windows-latest` x64 with the MSVC toolchain. Linux
cross-compilation is useful for build coverage but cannot replace these gates.

## Mandatory GitHub Actions gate

The `rust-windows` job runs as a standard GitHub-hosted Windows user and must
remain executable, not a documentation-only checklist:

1. `cargo clippy -p amber --all-targets --features test-support -- -D warnings`
   covers every native Amber target under a strict warnings-as-errors policy.
2. `cargo test --workspace --features test-support -- --test-threads=1` runs
   the complete workspace natively. Tests are skipped only when their subject
   is inherently Unix-specific; portable integration targets are not selected
   out of the job. Serial execution avoids collisions between integration
   tests that share the deterministic current-user daemon pipe.
3. `cargo build --release -p amber --bin amber --bin amberd` builds both shipped
   binaries. `amberd` is a binary target in the `amber` package, not a separate
   Cargo package.
4. Build `crates/amber/tests/windows_pipe_peer` and set
   `AMBER_WINDOWS_PIPE_PEER` to the absolute generated
   `windows_pipe_peer.exe`, then run `node app/test/windows-pipe.mjs`. This is
   the real Node ↔ Rust named-pipe harness, not its platform-neutral lifecycle
   unit test.
5. `npm ci`, `npm run typecheck`, `npx vitest run`, and `npm run build` in
   `app`.
6. The job stages the release Rust binaries, builds the per-user x64 NSIS
   installer, and asserts that the installer plus bundled `amber.exe` and
   `amberd.exe` exist.

The web fixture uses `LocalStream::read_with_timeout` for its Create → Created
acknowledgement. A persistent `set_read_timeout` is a Unix-socket operation and
correctly returns `Unsupported` for a Windows named pipe; the deadline read
retains the same protocol coverage on both transports.

`windows_attach` opens a real current-user named pipe and drives the production
Windows attach event loop through Focus → raw Attach → Resize → Input → Detach,
then separately proves a peer close wakes that loop. Its console-mode test seam
uses the same RAII teardown helper as the real guard and verifies output mode is
restored before input mode without mutating the CI console.

## Native evidence through `decb88a`

The following commands ran on the native MSVC Windows host during the final
implementation pass:

- [x] `token_file_is_private_and_stable_until_regenerated` passed.
- [x] `concurrent_token_creation_returns_the_single_established_token` passed.
- [x] The real named-pipe `set_read_timeout` behavior was identified as the
  cause of eight web daemon-link failures, rather than being suppressed or
  skipped. The fixture now uses the platform-neutral deadline API.
- [x] `cargo test --workspace --features test-support -- --test-threads=1`
  passed the complete native workspace, including the amended web suite.
- [x] `cargo clippy -p amber --all-targets --features test-support -- -D warnings`
  passed.
- [x] The Node/Rust named-pipe peer harness passed with two clients, exact frame
  exchange, and blocked-peer release.
- [x] App Vitest passed 582 tests across 43 files, with 5 explicitly
  Unix-specific skips; typecheck and production bundle build passed.
- [x] Linux reruns of the full Rust workspace, strict all-target clippy, app
  tests, typecheck, and production bundle also passed.
- [ ] Run the committed `rust-windows` job on GitHub Actions. The same commands
  passed manually on the native host, but this branch has not been pushed.

## Native packaged-runtime evidence

`app/scripts/dist.sh` produced `amber-windows-x86_64.exe`,
`amberd-windows-x86_64.exe`, and `amber-ide Setup 0.0.1.exe`. A clean per-user
reinstall on the existing `dev` account placed the app under
`%LOCALAPPDATA%\\Programs\\amber-ide`, bundled both Rust binaries, copied stable
CLI/daemon binaries, and wrote the `amber-daemon` HKCU Run value.

The packaged app started the named-pipe daemon. The installed CLI then created
`win-smoke`, listed it, and forced a snapshot. This run also found and fixed two
release-only defects: npm package identity selected the wrong install directory,
and Electron 43 generated an invalid Windows `file:` URL through `loadFile`.
Production now uses the intended package identity and an explicit
`pathToFileURL(...).href` renderer URL.

The launch occurred through SSH in the Windows Services session. It proves
packaged process startup, renderer URL loading, daemon RPC, session creation,
and snapshotting, but not interactive GUI gestures. The host was rebooted after
the snapshot; it has not returned to Tailscale yet, so post-reboot restore is
not checked.

## Manual Windows release checklist

These items require direct native Windows evidence. Automated native runs and
the SSH Services-session package smoke do not substitute for interactive checks.

- [ ] Fresh-user desktop install and first launch.
- [ ] Resume each supported agent conversation after daemon restart: Claude,
  Codex, Grok, and OpenCode.
- [ ] `amber attach` through an alternate-screen/full-screen TUI, including
  clean detach and terminal restoration.
- [ ] `amber web` in a real Windows browser, including login and live terminal
  input/output.
- [ ] Windows logoff and sign-in restore.
- [ ] Full Windows reboot and deterministic session restore.

Partial install evidence: clean per-user reinstall and packaged daemon/CLI smoke
passed on the existing `dev` account. It was not a new Windows user profile, so
the fresh-user item remains unchecked.

Record the command output, Windows version, Rust toolchain, and any packaging
artifact used when checking an item. Do not convert these into checked items
from a non-Windows run.
