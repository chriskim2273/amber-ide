# Windows Port Rebase Design

**Date:** 2026-08-27
**Status:** implemented; automated native Windows gates and packaged daemon/CLI
smoke proof pass. Remaining manual release gates are tracked in
`2026-08-27-windows-verification.md`.
**Supersedes:** the unmerged `feat/windows-port` design for implementation planning. Its code is reference material, not a merge candidate.

## Goal

Support Amber natively on Windows 10 version 1809 or later, without reducing the current daemon, desktop, CLI, or mobile-web capabilities. The daemon remains authoritative, terminal bytes remain raw, and the existing Unix implementation remains behaviorally unchanged.

## Scope

The port covers the daemon, `amber` CLI and `attach`, Electron desktop app, packaging and autostart, session supervision, and `amber web`'s local daemon link. It includes all current agent session kinds rather than reviving the old branch's Claude-only assumptions.

Windows remote-SSH windows are deliberately unavailable in the first native release. That feature depends on Unix-domain socket forwarding, which Windows OpenSSH cannot be assumed to provide for Amber's named pipe. The UI must explain the limitation instead of creating a non-functional tunnel. It returns only after a separately designed transport-neutral tunnel.

## Constraints

- Windows floor: Windows 10 1809 / build 17763, for ConPTY.
- Standard-user install and autostart only; no service, scheduled task, or elevation.
- `amber-core` remains platform-neutral.
- Protocol framing stays length-prefixed and byte-compatible. Any supervisor-only command is never emitted to GUI clients.
- Unix socket, signal, raw-mode, backpressure, and shutdown behavior stay unchanged under `#[cfg(unix)]`.
- Windows release includes console `amber.exe` and windowless `amberd.exe`; each is self-contained and has no native Node addon dependency.
- No claim of reboot persistence until a real Windows reboot test passes.

## Architecture

### Local transport

Add `crates/amber/src/transport.rs` as the only daemon-client transport boundary.

- Unix wraps `UnixListener` and `UnixStream` without semantic changes.
- Windows wraps `interprocess` named pipes using `GenericNamespaced`, not a filesystem-path interpretation of `\\.\pipe\...`.
- The wrapper exposes connect, bind, split read/write halves, a bounded-write shutdown primitive, and only the timeout operations each platform can truthfully implement.
- The Electron client continues to use `net.createConnection({ path })`; `socketPath.ts` becomes platform-aware and byte-matches Rust's pipe-name derivation.

Phase 0 is mandatory before this code is trusted: a real Windows Node client must exchange Amber frames with two concurrent Rust pipe clients and prove that closing a blocked writer releases it. If the handshake fails, use loopback TCP with an authenticated per-user token, designed separately before implementation.

### Platform services

`platform.rs` owns paths, home directory, default shell, executable lookup, safe session-name validation, secure randomness, and platform permission setup. Windows state lives under `%LOCALAPPDATA%\\amber-ide`; Unix keeps XDG paths. Windows rejects reserved device names, forbidden characters, control characters, and trailing dot/space in every persisted session name.

The Windows pipe name is deterministic but access is protected by a user-scoped DACL and first-instance ownership. A non-owner must not be able to connect or pre-create Amber's endpoint. This is a release gate, not a best-effort preference.

### Lifecycle and installation

`amberd.exe` contains the daemon entrypoint and carries the Windows GUI subsystem attribute. `amber.exe` remains a console CLI and starts or controls `amberd.exe` as needed. The per-user installer copies both binaries to `%LOCALAPPDATA%\\Programs\\amber-ide` and writes an HKCU Run-key entry for `amberd.exe daemon`.

On shutdown, a hidden top-level tool window handles `WM_QUERYENDSESSION` and `WM_ENDSESSION`; it is not a message-only window. Console control handling covers interactive close paths. The callback only performs Amber's final snapshot; periodic snapshots remain the recovery backstop.

### PTY, supervision, and attach

The PTY waiter, not reader EOF, becomes the authoritative child-exit teardown path. This handles ConPTY retaining its output pipe after child exit. Windows resolves PowerShell 7, then Windows PowerShell, then `cmd.exe`; agent binaries resolve through `PATHEXT` plus current installer locations.

`amber attach` uses `SetConsoleMode`, console-size polling, and reader threads feeding one event channel. Prefix handling, status rendering, detach, and alternate-screen tracking stay shared pure logic.

Windows cannot use SIGUSR park/thaw. The supervisor holds one long-lived daemon connection that receives a supervisor-only `Suspend` or `Resume` command and reports its state. The command is defined so it can never be sent to an app, web, or attach client. This restores freeze/park parity for every supervised agent kind.

### Web and remote features

`amber web` replaces direct `UnixStream` usage with `transport::LocalStream` and routes secure-token creation and permissions through `platform.rs`. Windows token files must be readable only by the current user before web serving is enabled. The loopback HTTP/WebSocket server itself remains standard TCP.

Remote SSH windows stay visible but disabled on Windows with an explicit explanation. Local session control, browser access, and ordinary desktop panes remain fully available.

## Delivery Phases

1. **Prove and establish transport.** Add a Windows-only pipe/Node integration gate, platform-safe naming, path derivation, and updated CI. Preserve every Unix test.
2. **Port daemon core.** Move daemon, watchers, CLI control paths, PTY exit teardown, and current agent launch/resume flows to the transport and platform boundaries.
3. **Port lifecycle and desktop.** Add `amberd.exe`, HKCU autostart, named-pipe app connection, Windows binary resolution, NSIS packaging, and app tests.
4. **Port attach and supervision.** Add Windows raw mode, resize, detach, alternate-screen protection, and bidirectional supervisor control for freeze/park.
5. **Port web and feature guards.** Move web's daemon link and token security to platform services; disable unsupported SSH remote windows on Windows.
6. **Validate releases.** Run native Windows CI, packaged app tests, manual live GUI/agent/attach tests, a clean-user install, logoff, and reboot torture. Update constitution only after these gates pass.

Each phase starts with a failing test and ends with focused tests plus the full relevant Unix suite. Phases 1 through 5 may be merged only after their Windows CI gate passes; no phase implies reboot proof.

## Verification Matrix

| Area | Automated gate | Manual Windows gate |
| --- | --- | --- |
| Transport | Rust pipe tests plus Node frame round-trip test | two clients, stalled writer, app input/output |
| Daemon and agents | Rust unit/integration tests, clippy | shell exit, each agent starts/resumes, Ctrl-C fallback |
| Attach | pure tests and Windows console test | resize, `Ctrl-b d`, alternate-screen TUI |
| Install | NSIS build plus pure Run-key tests | standard-user fresh install and upgrade |
| Persistence | snapshot/unit tests | logoff and reboot restore with scrollback |
| Web | token/permission and local-link tests | browser access, reconnect, resize boundary |

## Remaining Non-Claims

- Interactive desktop behavior and shutdown-message delivery remain unproven;
  SSH-launched processes run outside the signed-in user's desktop.
- Reboot survival is not lossless until the post-reboot session restore check
  and later torture testing pass.
- Conversation resume for every supported agent, full-screen attach, and live
  browser access still need manual Windows runs.
- Code signing remains a release decision after the remaining manual evidence.

## Alternatives Rejected

- Merging `feat/windows-port`: it is 216 commits behind current `main` and predates current agent, web, memory, and client-recovery behavior.
- Replacing Unix sockets everywhere with `interprocess`: would weaken proven Unix timeout and stale-socket behavior.
- Treating freeze/park as unsupported: current Amber relies on it for resource containment, so native support needs supervisor control parity.
