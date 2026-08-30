# Windows native CI and release verification

**Status:** native implementation, full CI gate, current-head native MSVC rerun,
NSIS packaging, packaged daemon/CLI/agent-supervisor smoke, and one reboot restore
proof are complete. Interactive desktop use, real-agent resume coverage, logoff,
and a second reboot on the final rebuilt package remain open.

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
5. `npm ci`, `npm run typecheck`, `npx vitest run`, `npm run build`, and
   `npm run build:web` in `app`.
6. The job stages the release Rust binaries, builds the per-user x64 NSIS
   installer, and asserts that the installer plus bundled `amber.exe` and
   `amberd.exe` exist.
7. The job launches the packaged daemon and CLI, creates shell and Pi panes,
   verifies that the Pi pane is supervised by adjacent `amber.exe` rather than
   recursively launching `amberd.exe`, snapshots, and cleans up. The native
   `windows_daemon` integration test separately clears every standard handle and
   proves the windowless Run-key entrypoint still binds its isolated named pipe.

The web fixture uses `LocalStream::read_with_timeout` for its Create → Created
acknowledgement. A persistent `set_read_timeout` is a Unix-socket operation and
correctly returns `Unsupported` for a Windows named pipe; the deadline read
retains the same protocol coverage on both transports.

`windows_attach` opens a real current-user named pipe and drives the production
Windows attach event loop through Focus → raw Attach → Resize → Input → Detach,
then separately proves a peer close wakes that loop. Its console-mode test seam
uses the same RAII teardown helper as the real guard and verifies output mode is
restored before input mode without mutating the CI console.

## Pre-main-sync native evidence at `decb88a`

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
- [x] App Vitest passed 583 tests across 43 files, with 5 explicitly
  Unix-specific skips; typecheck and production bundle build passed.
- [x] Linux reruns of the full Rust workspace, strict all-target clippy, app
  tests, typecheck, and production bundle also passed.
- [ ] Run the committed `rust-windows` job on GitHub Actions. The same commands
  passed manually on the native host, but this branch has not been pushed.

## Current-main integration evidence

The branch was rebased onto `main` at `b80c138`, including the productivity,
scrollback-search, preset-input, Pi keyboard-mode, and Linux input-health work.
Integration preserved Hermes and Pi supervision/setup, `%USERPROFILE%` fallback
for every agent's Windows home, Pocket web packaging, platform transports, and
the packaged `amberd.exe`/`amber.exe` command split. Closing a desktop window now
also closes its MessagePort, kills its utility client, unregisters its quit
listener, and suppresses queued relaunches.

- [x] Windows MSVC cross-target check passes for the full workspace and all
  targets with `test-support`.
- [x] Linux full workspace passed 650 tests with 1 intentional ignore; strict
  all-target clippy passes.
- [x] App typecheck, 685 tests, Electron production build, and Pocket web build
  pass on Linux.
- [x] On Windows 10 Pro 10.0.19045 with Rust 1.98.0, strict native all-target
  clippy and the complete serial native workspace pass with zero failures.
  This rerun found and fixed a test-only portability defect: the new search
  integration had sent Unix `printf` plus LF into Windows `cmd.exe`; it now uses
  a valid temp cwd and native CRLF shell input.
- [x] The current Node/Rust named-pipe peer passed exact frame exchange,
  multi-client acceptance, and forced blocked-reader release.
- [x] Native app typecheck passed; Vitest passed 684 tests with 5 platform skips;
  Electron and Pocket production bundles both built.
- [x] Current release `amber.exe` and `amberd.exe` built, electron-builder
  produced the x64 per-user NSIS installer, and exact `win-unpacked` binaries
  passed an isolated daemon/CLI/shell/Pi-supervisor/snapshot smoke.
- [x] Exact `win-unpacked` binaries created a Pi pane whose live process command
  was `amber.exe run windows-proof-agent`; the pane reached `shell-fallback`,
  snapshotting passed, and cleanup passed.
- [x] The rebuilt windowless release started through `Win32_Process.Create`
  with no standard handles and accepted CLI connections. This caught and fixed
  a release blocker where early diagnostics could stall before `serve`.
- [ ] Run the committed `rust-windows` job on GitHub Actions. Equivalent commands
  pass manually, but this branch has not been pushed.

## Native packaged-runtime evidence

`app/scripts/dist.sh` produced `amber-windows-x86_64.exe`,
`amberd-windows-x86_64.exe`, and `amber-ide Setup 0.0.1.exe`. A clean per-user
reinstall on the existing `dev` account placed the app under
`%LOCALAPPDATA%\\Programs\\amber-ide`, bundled both Rust binaries, copied stable
CLI/daemon binaries, and wrote the `amber-daemon` HKCU Run value.

The packaged app started the named-pipe daemon. The installed CLI then created
`win-smoke`, listed it, and forced a snapshot. This run found and fixed four
release-only defects: npm package identity selected the wrong install directory;
Electron 43 generated an invalid Windows `file:` URL through `loadFile`;
`amberd.exe` recursively received `run`/`hook` commands instead of dispatching
them through adjacent `amber.exe`; and a Run-key launch without standard handles
could stall on diagnostics before accepting its named pipe. Tests and the native
CI runtime smoke now cover the latter two paths.

The launch occurred through SSH in the Windows Services session. With
`--disable-gpu` (required only for that non-interactive session), Electron 43
kept its main, renderer, utility, and daemon processes alive from installed
paths. The installed CLI created/listed/snapshotted a session, and app startup
installed both the Codex handoff skill and Pi extension under `%USERPROFILE%`.
This proves packaged process startup, renderer loading, daemon RPC, agent setup,
session creation, and snapshotting, but not interactive GUI gestures.

The host rebooted after snapshotting `win-smoke`. After sign-in, Tailscale and
SSH returned; `amberd.exe` was running from the installed path, the HKCU Run
value was intact, and `amber ls` showed `win-smoke` alive. That proves one full
reboot restore using the pre-final-sync package. The final rebuilt package has
instead been proved through the stricter no-stdio WMI launch; a second physical
reboot on that exact artifact remains manual.

## Manual Windows release checklist

These items require direct native Windows evidence. Automated native runs and
the SSH Services-session package smoke do not substitute for interactive checks.

- [ ] Fresh-user desktop install and first launch.
- [ ] Resume each supported agent conversation after daemon restart: Claude,
  Codex, Grok, OpenCode, Hermes, and Pi.
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
