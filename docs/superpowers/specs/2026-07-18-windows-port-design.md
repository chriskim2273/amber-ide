# Windows Port — Design & Implementation Plan

> **Status: IN PROGRESS (owner-approved, spike skipped at owner's request).**
> Windows moved from *out of scope* to *in scope* per the owner. Phases 0 (spike)
> deliberately skipped. Implemented on branch `feat/windows-port`:
> Phases 1–5 (transport, pty-exit, shell/claude/supervisor, lifecycle, install,
> packaging, attach). Phase 6 (freeze/park control-channel) is DEFERRED — it
> degrades gracefully (a clear "not supported on Windows" error) per §D7.3.
>
> **Verification ceiling:** built on a Linux host with NO MSVC linker and NO
> Windows runtime, so "done" here means: the Windows target **typechecks**
> (`cargo check --target x86_64-pc-windows-msvc`, no link), the Unix build + full
> test suite stay green (no regression), clippy `-D warnings` is clean on both
> targets, and pure logic is unit-tested. Producing a runnable `.exe` (needs the
> MSVC toolchain — the added `windows-latest` CI job does the real link) and
> every live gate — the pipe↔Node handshake, live GUI, reboot-torture — remain
> for the owner's Windows dual-boot.
>
> **Known gaps found in review (not closed by the green gates):**
> - **Reboot survival is degraded, not guaranteed.** The shutdown-snapshot
>   handler (`winlifecycle.rs`) now uses a hidden **top-level** window (the first
>   cut used `HWND_MESSAGE`, which is excluded from `WM_QUERYENDSESSION`/
>   `WM_ENDSESSION` — a dead handler). Even corrected, the console-ctrl path is
>   compromised because registering the window links user32 (which suppresses
>   `CTRL_SHUTDOWN/LOGOFF` on the console handler). Until the top-level-window
>   path is confirmed on real Windows, treat reboot survival as "lose ≤ the
>   snapshot interval (~10 s)", NOT "lossless" — the periodic snapshot is the
>   real backstop.
> - **Open Decision #1 (windowless daemon) is UNRESOLVED in code.** The single
>   `amber` binary is console-subsystem, so the HKCU Run-key autostart flashes a
>   console at each logon. The app's own daemon spawn sets `windowsHide`, but the
>   logon autostart does not. Needs the separate-`amberd.exe` / `windows_subsystem`
>   decision (best made with Windows testing).
> - **Pipe interop (R1) is unproven and diverges from research.** Transport uses
>   `GenericFilePath` with a literal `\\.\pipe\...` string (research recommended
>   `GenericNamespaced`). Both should yield the same Win32 pipe, but this is the
>   exact handshake the skipped spike existed to prove — #1 runtime-failure
>   candidate; test first on the dual-boot.
> - **Phase 6 (freeze/park) NOT implemented** — returns a clear "not supported on
>   Windows" error. Deferred (untestable here + touches the frozen protocol), but
>   it is a real omission from "everything," not a closed item.
>
> **For agentic workers:** phases are milestones, each ending in working,
> testable software. Phase 0 is a throwaway spike that MUST pass before any
> other phase is built on it. Later phases use spike-then-TDD, because their
> feasibility depends on an unproven cross-runtime handshake — do not write
> "final" code for a phase whose foundation has not been proven on real Windows.

**Goal:** Run amber — the Rust session daemon, the `amber` CLI (incl. `amber
attach`), and the Electron GUI — natively on Windows 10/11, preserving total
session persistence (crash + reboot survival) and every core architectural rule.

**Architecture:** Keep the wire protocol (`amber-core::proto`) and scrollback
(`amber-core::ring`) **byte-for-byte unchanged** — `amber-core` is already 100%
portable. Confine all change to the `amber` binary crate and the Electron app.
Replace the four Unix-shaped subsystems — **transport** (unix socket → named
pipe), **lifecycle signals** (SIGTERM/SIGWINCH/SIGUSR → Win32 window messages +
console handlers), **terminal raw-mode** (termios → `SetConsoleMode`), and
**path/shell assumptions** (XDG/`$HOME`/`$SHELL` → `%LOCALAPPDATA%`/PowerShell) —
behind `#[cfg(...)]` boundaries so the hardened Unix paths are preserved
verbatim, not rewritten.

**Tech Stack:** Rust (`interprocess`, `windows-sys`, `directories`, `which`,
`winreg`), portable-pty 0.9 (ConPTY — already vendored), Electron + electron-vite
(TS strict), electron-builder (`nsis`, per-user).

---

## Global Constraints

Copied verbatim into every phase's requirements:

- **Windows version floor: Windows 10 1809 (build 10.0.17763) or newer.** ConPTY
  (`CreatePseudoConsole`) does not exist below 1809. Target Win10 21H2 / Win11 in
  practice.
- **No elevation, ever.** Install, auto-start, and first-run must work for a
  standard (non-admin) user. This disqualifies Windows Services and Task
  Scheduler `onlogon` triggers (both need admin).
- **One dependency-free `amber.exe`** (`x86_64-pc-windows-msvc`). No native Node
  addons. The Electron app bundles this exact release artifact.
- **`amber-core` stays clean** — zero platform-specific code. It currently has
  none; keep it that way. All `#[cfg(windows)]` lives in `crates/amber/`.
- **The wire protocol is frozen.** `amber-core::proto` framing (length-prefixed,
  no escaping) and message set do not change. Only the listener/stream *type*
  under it changes (core rule #4 preserved: raw bytes, one emulator).
- **No regression to the proven Unix daemon.** The Linux/macOS transport,
  backpressure, and lifecycle paths (hardened across multiple audit passes) must
  compile and behave identically. Windows code is *additive behind cfg*, not a
  rewrite of the shared path.
- **One-way data flow preserved** (core rule #3): daemon events remain the only
  thing that mutates pane existence/grouping in the UI.
- **Verification venue:** the owner's Windows dual-boot partition (manual,
  live-GUI). An optional `windows-latest` CI job may gate `cargo build`/`test`
  but cannot exercise the live GUI or the pipe↔Node handshake.

---

## Architecture Decisions (resolved by research)

Each decision cites the research that settled it. Sources are listed at the end.

### D1 — Transport: `interprocess` on Windows, std unix sockets unchanged on Unix

The daemon speaks length-prefixed frames over a byte stream to N clients via a
thread-per-connection blocking model. On Windows the equivalent primitive is a
**named pipe** (`\\.\pipe\...`), not a filesystem socket. AF_UNIX-on-Windows is
rejected: `std::os::unix::net` is not compiled on Windows at all, and AF_UNIX on
Windows lacks fd-passing/std support with no upside for a byte-stream daemon.

**Chosen:** introduce a `transport` module exposing a small common surface
(`LocalListener`, `LocalStream` with a `split()` into read/write halves).
- `#[cfg(unix)]` → thin wrappers over `std::os::unix::net::{UnixListener,
  UnixStream}` — **byte-identical to today**, including `set_write_timeout`
  (`SO_SNDTIMEO`) laggard eviction in `watchers.rs`. Zero behavior change.
- `#[cfg(windows)]` → `interprocess` 2.4.2 `local_socket` (blocking API, named
  pipe backend). `ListenerOptions::new().name(name).create_sync()` →
  `listener.incoming()` yields `Stream: Read + Write`; one thread per stream —
  a 1:1 map to the current model. `Stream::split()` gives the send half for the
  `SharedWriter`.

Why cfg-gate rather than move everyone to `interprocess`: the Unix path is
hardened (backlog-HOL fix, watcher `SO_SNDTIMEO` eviction, steal-guard).
`interprocess` has **no write-timeout equivalent** — adopting it everywhere would
*regress Linux's laggard eviction*. Gating keeps the Unix hardening verbatim.

**The Electron client needs no transport rewrite.** Node's `net.createConnection({
path })` (used in `app/src/client/connection.ts:30` and `daemonBoot.ts`) speaks
Windows named pipes natively when `path` is `\\.\pipe\<name>`. Only
`app/src/shared/socketPath.ts` (the single source of the path) gains a Windows
branch returning the pipe name that matches the Rust daemon's.

**Windows has no `SO_SNDTIMEO` for pipes.** On Windows, `watchers.rs` and the
Output forwarders evict a wedged client by **bounded-queue-full-past-grace →
close the handle** (which aborts the blocked write) rather than a write timeout.
The bounded queues already exist; the timeout was only ever the secondary
backstop. `#[cfg]`-split that one eviction detail.

**Fallback if the pipe↔Node handshake fails the Phase 0 spike:** TCP loopback
(`127.0.0.1`, ephemeral port written to the state dir) + a per-connection auth
token. std-only, trivially Node-compatible. Downgrades the OS-permission security
model (any local process can `connect`; the token gates it), so named-pipe +
per-user DACL stays the default — loopback is the documented escape hatch only.

### D2 — pty child-exit teardown: drive from the waiter, not reader-EOF (both platforms)

**This is the highest-risk correctness item.** Today (`pty.rs:302-314`) the
batcher clears subscribers when the pty **reader hits EOF** (Unix: dropping the
slave at `pty.rs:169` makes `read()` return 0 on child exit). The daemon
forwarder (`daemon.rs:276-300`) only sends the `Exit` frame *after* `rx.recv()`
returns `Err` (channel closed by that `subs.clear()`).

On Windows, **the ConPTY reader does not hit EOF when the child exits** — the
output pipe is held open by the pseudoconsole, not the child (wezterm #463). So
`subs.clear()` never runs, `rx.recv()` never returns, and the `Exit` frame never
fires **even though the waiter thread already set `exit_code()`**. Every pane
hangs "alive" forever — the exact silently-dead-session failure the constitution
fights (core rule / "Symptom shape to recognise").

**Chosen:** make the **waiter thread** (`pty.rs:318-327`, `child.wait()` — the
authoritative, cross-platform exit signal) drive teardown: on child exit it
records the code **and** clears subscribers (closing their channels). Do this on
**both** platforms so teardown logic is not forked — on Unix it races the
existing reader-EOF path harmlessly (whichever fires first clears under the same
lock; `subs.clear()` is idempotent). The reader-EOF path stays as a
best-effort/secondary trigger. Also budget for bundling a known-good ConPTY DLL
pair (`conpty.dll` + `OpenConsole.exe`) to dodge OS-shipped ConPTY TUI-exit bugs.

`MasterPty::resize()` is already fully portable (ConPTY `ResizePseudoConsole`
internally) — **no change** to resize.

### D3 — Shutdown snapshot (SIGTERM equivalent): hidden message-only window

The daemon's only pre-reboot final-snapshot trigger is
`Signals::new([SIGTERM, SIGINT])` → `snapshot_final()` → `exit(0)`
(`main.rs:508-522`). Windows has no SIGTERM.

**Chosen:** a **hidden message-only window** handling `WM_QUERYENDSESSION`
(return `TRUE`) / `WM_ENDSESSION` (snapshot here), plus `SetConsoleCtrlHandler`
for `CTRL_C_EVENT`/`CTRL_CLOSE_EVENT` (the `SIGINT`/interactive cases).

Why not `SetConsoleCtrlHandler` alone for shutdown: once a process links
user32/gdi32 (which a windowless daemon or portable-pty plumbing can pull in
transitively), the OS **silently stops delivering `CTRL_SHUTDOWN/LOGOFF`** to the
console handler — exactly the snapshot we care most about. Microsoft's prescribed
fix is the hidden-window `WM_ENDSESSION` path, which does not depend on a console.

**Time budget: ~5 s** (`HungAppTimeout`) before force-kill. The daemon already
snapshots on a timer, so the shutdown handler flushes only a small final delta —
well under budget. Use `ShutdownBlockReasonCreate` only if measurements overrun.

### D4 — Auto-start at login, no admin: `HKCU\...\Run` + windowless subsystem

**Chosen:** the first-run installer writes
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` →
`amber-daemon = "<stable>\amber.exe" daemon` (via the `winreg` crate,
idempotently — re-write = self-repair/upgrade, mirroring the existing
"cargo-free install writes the boot unit directly" pattern). HKCU is read/write
for the signed-in user → no elevation. Runs at every logon, survives reboot.

Build the daemon exe **windowless**: `#![windows_subsystem = "windows"]` so it
starts with no console window (which is *why* D3 needs the hidden-window path,
not a console handler). Task Scheduler `onlogon` and Windows Services both need
admin → rejected.

### D5 — Paths: `directories` crate, named pipe replaces `XDG_RUNTIME_DIR`

`main.rs:150-168` derives the state root from `XDG_STATE_HOME`/`$HOME` and the
socket from `XDG_RUNTIME_DIR`.

**Chosen:** `directories` 6.x `ProjectDirs::from("", "amber", "amber-ide")` →
`data_local_dir()` for the state store → `%LOCALAPPDATA%\amber-ide` on Windows
(non-roaming — correct for large/volatile scrollback), unchanged XDG/`~/.local`
region on Unix. `home_dir()` for the restore-cwd fallback (the existing
"fall back to `$HOME`" rule ports directly). **There is no socket path on
Windows** — the "socket" is a named pipe name `\\.\pipe\amber-ide-<user>`; both
Rust `default_socket()` and TS `resolveSocketPath()` gain a Windows branch
producing the identical name. `atomic_write` (`state.rs:117-132`) already works
on Windows — `fs::rename` over an existing file maps to `MoveFileEx` with replace
semantics in modern Rust std. (Light caveat noted; no code change required.)

### D6 — Shell + `claude` resolution on Windows

Unix resolves the login `$SHELL` and finds `claude` through it
(`claude.rs:117-133`, `manager.rs`, `supervisor.rs:339`).

**Chosen shell:** `pwsh.exe` (PowerShell 7) if on PATH, else `powershell.exe`
(5.1, always present). **Never Git Bash** — Claude Code's interactive CLI needs
real raw-mode TTY, which Git Bash lacks; ConPTY gives PowerShell the
pseudoconsole it needs. `%COMSPEC%`/`cmd.exe` only as last resort. There is no
`$SHELL` — do not read a login shell on Windows.

**Chosen `claude` resolution:** the `which` crate (honors `PATHEXT`, resolves
`claude.cmd`/`claude.exe`), **plus** explicit probes of
`%USERPROFILE%\.local\bin\claude.exe` (native installer — not on PATH by default)
and `%APPDATA%\npm\claude.cmd` (npm install). Cache the resolved absolute path in
config exactly as the login-shell result is cached today. A `.cmd` entry point
must be spawned through the shell (`cmd /c` / PowerShell), not raw `CreateProcess`.

### D7 — Supervisor: exit classification + no `exec` + freeze/park without SIGUSR

Three Unix couplings in `supervisor.rs`/`manager.rs`:
1. **Exit classification** (`supervisor.rs:203-225`) uses
   `ExitStatusExt::signal()` to tell a user ^C (SIGINT / exit 130) from a crash,
   which drives the drop-to-shell fallback. Windows has no signals — a Ctrl-C to
   a console app surfaces as exit code `0xC000013A` (STATUS_CONTROL_C_EXIT) /
   `3221225786`. `#[cfg]`-split `classify_run`: Unix keeps `signal()`; Windows
   maps the control-C exit code + code 0 to `UserInterrupt`, else crash.
2. **`exec()` shell fallback** (`supervisor.rs:337-340`, replaces the supervisor
   process with a login shell). Windows has no `exec` — spawn the shell as a
   child, `wait()`, and propagate its exit. No `-l` flag (no login shell).
3. **Freeze/park** (`manager.rs:466-469` sends `SIGUSR1`/`SIGUSR2` via
   `nix::libc::kill` to park/thaw a claude pane to free RAM; supervisor registers
   them at `supervisor.rs:311-312`). **Windows has no per-process user signal.**
   Replace the signal with a small **control channel**: the supervisor already
   connects to the daemon (`supervisor.rs:256`) to report run-state; extend that
   into a bidirectional or supervisor-polled control so the daemon delivers
   suspend/resume over the existing pipe transport rather than a signal. This is
   the trickiest port item → its own late phase (Phase 6); freeze/park degrades
   gracefully (feature disabled) until then.

### D8 — `amber attach` (in v1): `SetConsoleMode` + `WaitForMultipleObjects`

`attach.rs` (1122 lines) is the heaviest single rewrite: a `nix::poll` event loop
multiplexing stdin + socket (`attach.rs:511-514`), termios raw mode
(`attach.rs:337-360`), `SIGWINCH`-flag resize (`attach.rs:390`), `AsFd`. Owner
chose **full parity in v1**.

**Chosen:** `#[cfg]`-split the client core:
- Raw mode: `SetConsoleMode` on the console input/output handles (disable line
  input/echo, enable `ENABLE_VIRTUAL_TERMINAL_INPUT` and
  `ENABLE_VIRTUAL_TERMINAL_PROCESSING`) via `windows-sys`, RAII-restored — the
  Windows analog of the `RawModeGuard`.
- Event loop: replace `poll([stdin, socket])` with a two-thread model (a stdin
  reader thread + a socket reader thread feeding one channel) or
  `WaitForMultipleObjects` on the console-input handle + pipe handle. The
  two-thread channel model is simpler and portable-friendly; prefer it.
- Resize: no SIGWINCH — poll the console screen-buffer size
  (`GetConsoleScreenBufferInfo`) on a timer tick (the loop already ticks every
  `POLL_TICK_MS`) and send `Resize` on change.
- The prefix state machine, detach, status bar, nest-refusal (all pure logic)
  are unchanged.

### D9 — Packaging: electron-builder `nsis`, per-user, bundle `amber.exe`

**Chosen:** `nsis` with `{ oneClick: false, perMachine: false, allowElevation:
false }` → assisted, per-user install under `%LOCALAPPDATA%\Programs\amber-ide`,
no admin. Bundle `amber.exe` via `extraResources`; locate at runtime with
`process.resourcesPath` (mirrors the Linux/macOS path exactly, just `amber.exe`).
First run copies `amber.exe` to the stable path `%LOCALAPPDATA%\Programs\amber-
ide\amber.exe` (the path in the HKCU Run key) and writes the Run key. `portable`
and `appx`/MSIX are rejected (no stable path for a resident daemon; MSIX sandbox
blocks pty spawning + `HKCU\Run`). Ship **unsigned** initially (SmartScreen
warning accepted); optional Azure Trusted Signing (~$9.99/mo) later — skip EV
certs (they no longer auto-bypass SmartScreen).

### D10 — Session-name filesystem safety on Windows

Session names become `.json`/`.bin` file paths (`state.rs:96-106`) and the pipe
name. Windows reserves `:\/<>|?*"`, control chars, trailing dot/space, and the
device names `CON PRN AUX NUL COM1-9 LPT1-9`. The existing name validation
(constitution: "session-name validation") must gain a Windows-reserved-name/char
guard so a name like `aux` or `a:b` cannot poison the state store. Pure function
→ unit-tested.

---

## Risks & the load-bearing spike

| # | Risk | Mitigation |
|---|------|-----------|
| R1 | **Rust named pipe ↔ Node `net` client do not interoperate** (name mapping, byte framing, security descriptor Node can't traverse). Whole design rests on this. | **Phase 0 spike proves it on real Windows before anything else.** Fallback: TCP loopback + token (D1). |
| R2 | **ConPTY reader never EOFs → panes hang "alive."** | D2: waiter-driven teardown on both platforms. Regression test asserts `Exit` fires from `child.wait()`, not reader-EOF. |
| R3 | **Shutdown snapshot silently dropped** once user32 links in. | D3: hidden-window `WM_ENDSESSION`, not console handler alone. Torture-test: reboot with live sessions, assert restore. |
| R4 | ConPTY OS-DLL TUI-exit crashes. | Bundle a known-good `conpty.dll`/`OpenConsole.exe` pair (wezterm precedent). |
| R5 | Rewriting proven Unix transport introduces Linux regressions. | D1: Unix path is cfg-gated and **unchanged** — Windows is additive. Existing Rust + live-GUI gates re-run. |
| R6 | Freeze/park has no clean Windows mechanism. | D7.3: control-channel replacement, isolated to Phase 6; degrades gracefully until then. |

---

## Phased Plan (milestones)

Each phase ends in working, testable software. **Phase 0 gates everything.**
Stop conditions per phase: a verification fails twice after a reasonable fix; the
live code contradicts an assumption here; work spills outside the phase's files.

### Phase 0 — Spike: prove the pipe↔Node handshake (throwaway)

**Goal:** de-risk R1 before committing to the abstraction. Not shipped code.

**Deliverable:** a throwaway Rust bin (a named-pipe server via `interprocess`
`GenericNamespaced`, echoing length-prefixed frames with the real
`amber-core::proto` codec) + a ~30-line Node script using
`net.createConnection({ path: '\\\\.\\pipe\\amber-spike' })` that sends and
receives framed messages both directions.

**Run on:** the owner's Windows dual-boot.

**Acceptance criteria (ALL must hold):**
- [ ] Node connects to the interprocess-hosted pipe by its `\\.\pipe\<name>` path.
- [ ] A `proto`-encoded frame Rust→Node and Node→Rust round-trips byte-exact.
- [ ] A second concurrent Node client connects (multi-instance server works).
- [ ] Closing a client's handle unblocks a mid-write on the server (eviction path).

**If it fails:** switch the whole plan's transport to the D1 TCP-loopback+token
fallback and re-spike that (std `TcpListener` ↔ Node `net.connect({port})` is
near-certain). Record the outcome in this doc before Phase 1.

### Phase 1 — Transport abstraction; daemon compiles & GUI connects on Windows

**Goal:** `cargo build --target x86_64-pc-windows-msvc` succeeds for the daemon
path; the GUI connects to a Windows daemon and renders one shell pane both
directions. **This is the product's core** — the milestone that proves viability.

**Files:**
- Create: `crates/amber/src/transport.rs` — `LocalListener`, `LocalStream`
  (+`split()`), `connect()`, `bind_or_detect_stale()`; `#[cfg(unix)]` wraps
  `std::os::unix::net` (semantics unchanged, incl. `set_write_timeout`),
  `#[cfg(windows)]` wraps `interprocess::local_socket`.
- Modify: `crates/amber/src/daemon.rs` (types: `UnixListener/UnixStream` →
  `transport::Local*`; `try_clone` → `split()` for `SharedWriter`; `prepare_socket`
  → cfg: Unix keeps the stale-file steal-guard, Windows uses
  `FILE_FLAG_FIRST_PIPE_INSTANCE`/name-in-use detection).
- Modify: `crates/amber/src/watchers.rs` (`UnixStream` → `transport::LocalStream`;
  cfg-split eviction: Unix `set_write_timeout`, Windows queue-full-grace + close).
- Modify: `crates/amber/src/main.rs` (`default_root`/`default_socket` gain
  `#[cfg(windows)]` via `directories` + pipe name; the 7 `UnixStream::connect`
  client sites → `transport::connect`).
- Modify: `crates/amber/src/supervisor.rs:256` (run-state report connect).
- Modify: `crates/amber/Cargo.toml` — add `[target.'cfg(windows)'.dependencies]
  interprocess = "2.4"`, `directories = "6"`.
- Modify: `app/src/shared/socketPath.ts` — Windows branch → `\\.\pipe\amber-ide-
  <user>` matching Rust.
- Add: `.cargo/config.toml` or CI note for the msvc target; optional
  `windows-latest` job in `.github/workflows/ci.yml`.

**Approach:** the `transport` module is the ONE new abstraction; every call site
swaps a type, not logic. `attach.rs` is NOT touched here (Phase 5). Keep the
`amber-core::proto` decoder/encoder exactly as-is.

**Gate (acceptance):**
- [ ] Rust workspace builds for `x86_64-pc-windows-msvc`; all existing
  non-attach unit tests pass on Windows.
- [ ] Existing Linux `cargo test` + clippy still green (no Unix regression).
- [ ] On the dual-boot: launch daemon (`amber.exe daemon`), `amber.exe ls` over
  the pipe returns; GUI (dev build) renders a shell pane; keystrokes reach the
  pty and output renders — 1× each direction.

### Phase 2 — pty exit-teardown + shell/claude spawn on Windows

**Goal:** panes end cleanly (no hang), shells and `claude` spawn correctly on
Windows.

**Files:**
- Modify: `crates/amber/src/pty.rs` — move `subs.clear()` into the waiter thread
  (D2), keep reader-EOF as secondary. Add the regression test.
- Modify: `crates/amber/src/manager.rs` — `resolve_cwd` `$HOME`→`home_dir()`
  fallback; `$SHELL`→`pwsh`/`powershell` (cfg).
- Modify: `crates/amber/src/claude.rs` — Windows `claude` resolution (`which` +
  `.local\bin`/`npm` probes); `$HOME\.claude*` → `home_dir()` join.
- Modify: `crates/amber/src/supervisor.rs` — `classify_run` cfg-split
  (control-C exit code); `exec()` → spawn+wait+propagate (cfg).
- Modify: `crates/amber/Cargo.toml` — `which = "6"` (all targets or windows).

**Gate:**
- [ ] New test: a session whose child exits sends `Exit` driven by `child.wait()`
  (assert without relying on reader-EOF; force the ConPTY no-EOF condition in the
  test harness or assert the waiter path directly).
- [ ] On the dual-boot: open a shell pane, `exit` → pane shows ended (not hung);
  open a claude pane → it resolves `claude`, starts, resumes across restart; ^C
  in claude drops to a shell (not a dead pane).

### Phase 3 — Lifecycle: shutdown snapshot + install/auto-start on Windows

**Goal:** reboot survival — the whole point of the product — works on Windows.

**Files:**
- Create: `crates/amber/src/winlifecycle.rs` (`#[cfg(windows)]`) — hidden
  message-only window + `WM_QUERYENDSESSION`/`WM_ENDSESSION` → `snapshot_final()`;
  `SetConsoleCtrlHandler` for CTRL_C/CLOSE. Via `windows-sys`.
- Modify: `crates/amber/src/main.rs` — daemon start: `#[cfg(unix)]` keeps the
  `signal-hook` thread; `#[cfg(windows)]` spawns `winlifecycle::run_pump()`. Add
  `#![cfg_attr(windows, windows_subsystem = "windows")]` (guarded so it doesn't
  hide console output for the CLI subcommands — resolve via a separate binary
  target or a console-alloc for non-daemon commands; see Open Decisions).
- Modify: `crates/amber/src/main.rs` `ctl install`/`uninstall` — Windows branch:
  copy `amber.exe` to `%LOCALAPPDATA%\Programs\amber-ide\amber.exe`, write the
  HKCU Run key (`winreg`).
- Modify: `app/src/main/serviceManager.ts` — `win32` branch (Run-key path helpers
  mirroring the systemd/launchd ones; `bootUnitPath`/`stopDaemonCommand`).
- Modify: `app/src/main/index.ts` `installDaemon()` — `win32` branch (copy exe +
  write Run key + start daemon detached windowless).
- Modify: `crates/amber/Cargo.toml` — `[target.'cfg(windows)'.dependencies]
  windows-sys = "0.61"`, `winreg = "0.52"`.

**Gate:**
- [ ] Unit: Run-key argv/path builders (pure) tested; Windows-reserved session
  name guard (D10) tested.
- [ ] On the dual-boot **reboot torture test**: open several panes incl. claude,
  reboot into Windows-then-back (or log off/on), confirm the daemon auto-started
  and every session + scrollback restored. This is the headline guarantee.

### Phase 4 — Packaging: NSIS installer with bundled `amber.exe`

**Goal:** a distributable per-user Windows installer.

**Files:**
- Modify: `app/package.json` build config — add `"win": { "target": ["nsis"] }`,
  `"nsis": { "oneClick": false, "perMachine": false, "allowElevation": false }`,
  `extraResources` includes `amber.exe`.
- Modify: `app/src/main/amberBin.ts` — packaged Windows path →
  `join(resourcesPath, 'amber.exe')` (cfg on `process.platform`).
- Modify: `scripts/dist.sh` — add the `x86_64-pc-windows-msvc` release build +
  static-linkage/target assertion (analog of the musl/universal assertions);
  stage `amber.exe` for the app bundler. (Built on Windows or via cross toolchain.)
- Optionally bundle the ConPTY DLL pair (R4) under `extraResources`.

**Gate:**
- [ ] `npm run dist` on Windows produces an NSIS `.exe` that installs per-user
  (no admin), first-run writes the Run key + starts the daemon, GUI works.
- [ ] Fresh-machine (or fresh-user) install → reboot → sessions restore.

### Phase 5 — `amber attach` Windows client (full parity, per owner)

**Goal:** `amber attach` works from a Windows terminal.

**Files:**
- Modify: `crates/amber/src/attach.rs` — cfg-split raw mode (`SetConsoleMode` via
  `windows-sys`, RAII), event loop (two-thread stdin+socket channel replacing
  `nix::poll`), resize (poll `GetConsoleScreenBufferInfo`, no SIGWINCH). Pure
  logic (prefix SM, status bar, nest-refusal) unchanged.
- Modify: `crates/amber/Cargo.toml` — extend the windows `windows-sys` features
  (`Win32_System_Console`).

**Gate:**
- [ ] On the dual-boot (Windows Terminal / PowerShell): `amber attach` renders a
  live session, keystrokes flow, resize reflows, `Ctrl-b d` detaches, sessions
  survive detach. Alt-screen (claude) not corrupted.

### Phase 6 — Freeze/park without SIGUSR (control-channel)

**Goal:** restore the RAM-saving park/thaw feature on Windows.

**Files:**
- Modify: `crates/amber/src/manager.rs` `signal_suspend` — Windows: send a
  suspend/resume control message over the existing supervisor pipe instead of
  `nix::libc::kill(SIGUSR*)`.
- Modify: `crates/amber/src/supervisor.rs` — Windows: receive suspend/resume on
  the control channel (replace the `SIGUSR1/2` flag registration) and drive the
  same park/thaw state machine.
- Possibly extend `amber-core::proto` with a supervisor-control message **only if
  unavoidable** — prefer reusing existing plumbing to honor the frozen-protocol
  constraint; if a new message is required, it is daemon↔supervisor internal, not
  daemon↔GUI.

**Gate:**
- [ ] On the dual-boot: freeze a claude pane (RAM drops), thaw it (resumes),
  matching Unix behavior.

---

## Testing strategy

- **Pure logic → unit tests (TDD), cross-platform:** transport name derivation,
  Windows session-name guard (D10), Run-key argv builders, `classify_run`
  Windows branch, claude-resolution probe order. These run in CI on all OSes.
- **Daemon/pty integration:** the D2 exit-teardown regression test must assert
  `Exit` originates from `child.wait()` (simulate the no-EOF condition), so it
  fails on the pre-fix code on Windows.
- **Live-GUI + reboot torture:** manual, on the owner's dual-boot, per the gates
  above. The pipe↔Node handshake and reboot survival cannot be CI-tested.
- **Optional `windows-latest` CI job:** `cargo build`/`test` + `app` typecheck +
  vitest, gating build/unit regressions automatically (mirrors the existing
  `rust-macos` job). It cannot exercise the live GUI or pipe handshake.

---

## Out of scope / accepted tradeoffs

- **Windows 7/8.1:** unsupported (no ConPTY). Floor is Win10 1809.
- **Code signing:** ship unsigned initially; SmartScreen warning accepted.
  Optional Azure Trusted Signing later; no EV certs.
- **`procinfo.rs`** already compiles to a Windows no-op stub
  (`#[cfg(not(any(linux,macos)))]`) — live-cwd survival and ad-hoc-claude
  detection **degrade gracefully** (disabled) on Windows. Wiring Windows process
  introspection (`NtQueryInformationProcess` / Toolhelp) is a possible later
  enhancement, not part of this port.
- **`SO_SNDTIMEO` write-timeout on Windows:** replaced by queue-full-grace +
  handle-close eviction (D1); the bounded-queue backstop is the primary defense
  on all platforms anyway.

---

## Open decisions for the owner (resolve before / during Phase 3)

1. **Windowless daemon vs. console CLI in one binary.** `#![windows_subsystem =
   "windows"]` makes the *whole* `amber.exe` windowless — but the same binary
   runs `ls`/`status`/`attach`, which need console output. Options: (a) a
   separate `amberd.exe` daemon binary (cleanest, adds a target); (b) one binary
   that `AllocConsole`/attaches a console for non-daemon subcommands; (c) keep it
   console-subsystem and spawn the daemon with `CREATE_NO_WINDOW`. **Recommend
   (a)** — a dedicated windowless daemon binary, CLI stays console. Decide before
   Phase 3.
2. **Per-user pipe DACL hardening.** `interprocess` `ListenerOptions` does not
   expose a custom DACL; the default same-session pipe is likely fine for a
   per-user daemon. If stricter isolation is wanted, the *listener* drops to the
   raw `windows` crate (custom `SECURITY_ATTRIBUTES` + `FILE_FLAG_FIRST_PIPE_
   INSTANCE` anti-squat) while `interprocess` still serves clients. Decide during
   Phase 1 based on the threat model.
3. **ConPTY DLL bundling (R4):** bundle a pinned pair now (safer, larger) or rely
   on the OS ConPTY and only bundle if TUI-exit bugs appear in testing. Recommend
   defer-until-observed to keep the installer lean.

---

## Sources

Transport / pty: docs.rs/portable-pty 0.9, docs.rs/interprocess 2.4.2
(`local_socket`), wezterm #463 (Windows reader no-EOF), wezterm #7774 (ConPTY DLL
bundling), learn.microsoft.com Named Pipes / Named Pipe Instances,
CreateNamedPipe, devblogs ConPTY intro (1809 floor).

Lifecycle / packaging: learn.microsoft.com SetConsoleCtrlHandler, WM_QUERYEND
SESSION / WM_ENDSESSION, Run/RunOnce Registry Keys, schtasks /create; docs.rs
ctrlc, windows-sys 0.61, directories 6.x, dirs 6.0; code.claude.com setup
(Windows `claude` install paths); electron.build/docs/nsis; learn.microsoft.com
SmartScreen reputation / code-signing options.
