# `amber attach` detach hotkey + tmux-parity conveniences

**Date:** 2026-07-14
**Status:** design, pending implementation
**Scope:** CLI `amber attach` client only (`crates/amber/src/attach.rs`,
`crates/amber/src/main.rs`), plus one backward-compatible field on the shared
`SessionInfo` wire struct.

## Motivation

`amber attach` is the `tmux attach -t <name>` replacement for driving a session
over SSH. Today it has no in-band detach: to leave a session without killing its
child you must close the terminal / SSH connection or kill the client process.
Users coming from tmux expect `Ctrl-b d`. This adds that, plus two small
conveniences, without disturbing the daemon's raw-bytes contract.

The Electron app does **not** use this code path (it attaches through its own
`utilityProcess` connection), so nothing here affects the GUI. Core rule #4
("raw bytes, one emulator") is preserved: prefix interception lives only in the
CLI client and can be disabled entirely (`--no-prefix`).

## Features

### 1. Prefix-detach hotkey (the request)

A prefix-key state machine on the client's **stdin** path in `run_client`:

- **Prefix key** defaults to `Ctrl-b` (byte `0x02`).
- `prefix` then `d` → detach: send `ControlMsg::Detach { name }`, then return a
  new `ClientEnd::Detached`. The existing `RawModeGuard` restores the terminal
  on the way out; the daemon already releases the subscription on `Detach`
  (`daemon.rs:302`) and the session's child keeps running.
- `prefix` then `prefix` → forward one literal prefix byte to the child (tmux
  parity — the child can still receive `Ctrl-b`).
- `prefix` then any **other** byte → no-op; the prefix and the following byte
  are both dropped (tmux "unbound key" behavior). Documented so it is not a
  surprise.

**Cross-read state.** stdin arrives in arbitrary chunks. The prefix byte can be
the last byte of one `read` and the command byte the first of the next. The
scanner therefore keeps a small persistent flag (`prefix_armed: bool`) across
loop iterations. A chunk may also contain multiple prefixes; the scanner walks
the buffer byte by byte, forwarding literal runs and acting on prefix
dispatches, accumulating the bytes to forward into a single write per chunk
where possible.

**Bytes never silently lost.** Every input byte is either forwarded to the
child, consumed as a recognized command (`d`, second prefix), or intentionally
dropped as an unbound-key command byte. There is no path where a normal
keystroke vanishes.

### 2. Configurable / disable-able prefix

Precedence (highest first):

1. `--no-prefix` CLI flag → interception fully disabled; stdin is forwarded raw,
   exactly as today. The pure-raw escape hatch that keeps core rule #4 intact.
2. `AMBER_PREFIX` env var → remap the prefix. Accepted forms:
   - `C-<letter>` / `c-<letter>` (e.g. `C-a`) → the corresponding control byte
     (`Ctrl-a` = `0x01` … `Ctrl-z` = `0x1a`).
   - `none` or empty string → disable interception (same as `--no-prefix`).
   - Anything else → the client prints a warning to stderr and falls back to the
     default; it does not abort the attach.
3. Default → `Ctrl-b` (`0x02`).

Prefix resolution is a pure function `resolve_prefix(flag_no_prefix: bool, env:
Option<&str>) -> Option<u8>` (returns `None` when disabled), unit-tested in
isolation.

### 3. Attach banner

When stdin is a tty, print one line to **stderr** (not stdout — stdout carries
the terminal reset + replayed backlog and must not be polluted) before the event
loop starts:

```
[amber] attached to <name> — Ctrl-b d to detach
```

The key name reflects the resolved prefix (`Ctrl-a` if remapped); when the
prefix is disabled the line reads `… — close the terminal to detach`. Suppressed
when stdin is not a tty (piped/test), matching the existing `is_terminal()`
gating for raw mode.

### 4. Attach newest when no name is given

`amber attach` with no `<name>` attaches the most-recently-updated live session,
like `tmux attach` with no target.

Ordering needs an honest key. `SessionInfo` currently carries no timestamp;
`SessionMeta` in the state store has `updated: u64` (set on create and on cwd
change). We surface it:

- **Wire change:** add `#[serde(default)] pub updated: u64` to `SessionInfo`
  (`amber-core/src/proto.rs`). `#[serde(default)]` keeps it backward compatible —
  older clients and the Electron app (which never constructs `SessionInfo` and
  ignores unknown JSON fields on decode) are unaffected.
- **Daemon:** `Manager::session_infos()` populates `updated` from `meta.updated`.
  (The existing name-sort is retained for the `Sessions`/`ls` display order.)
- **Fixture fallout:** `#[serde(default)]` covers the wire, but a new non-`Option`
  field forces every Rust `SessionInfo { .. }` literal to add `updated: <val>`.
  All such literals (daemon/proto/manager tests) must be updated — the plan
  enumerates them. The TS `proto.ts` decode ignores the extra JSON field; no TS
  change is required, but this is verified during implementation.
- **Client (no name):** send `ListSessionsDetailed`, receive `Sessions`, filter
  `alive`, pick the entry with the greatest `updated` (tie-break: greatest
  `name`, for determinism). If there are **zero** live sessions, print
  `[amber] no live sessions to attach` to stderr and exit non-zero. This
  selection is a pure function `pick_newest(&[SessionInfo]) -> Option<&SessionInfo>`,
  unit-tested.

The no-name lookup uses a short-lived control exchange on the same socket before
the attach handshake, then proceeds exactly as the named path.

## CLI surface

```
amber attach [--no-prefix] [--socket <path>] [<name>]
```

- `<name>` becomes optional (clap `Option<String>`). Absent → newest-live lookup.
- `--no-prefix` → disable prefix interception.
- `AMBER_PREFIX=C-a` (env) → remap prefix.

`main.rs` resolves the prefix and no-name lookup, then calls into `attach`.

## Data flow

```
stdin bytes ──► [prefix scanner] ──► Data frame ──► socket ──► pty
                      │
                      ├─ prefix d      ──► Detach frame ──► socket; ClientEnd::Detached
                      └─ prefix prefix ──► literal prefix byte ──► pty
```

Output path (socket → stdout) is unchanged.

## Error handling

- Unknown `AMBER_PREFIX` → warn to stderr, use default (non-fatal).
- No-name lookup with zero live sessions → stderr message + non-zero exit.
- Detach send failing (socket already gone) → treat as a normal socket-closed
  teardown; the terminal is still restored by `RawModeGuard`.
- All existing teardown reasons (`StdinEof`, `SocketClosed`, `SessionExit`)
  keep their behavior; `Detached` prints `[amber] detached from <name>` and
  exits zero.

## Testing (TDD)

Pure units (no tty, no daemon), added to `attach.rs` tests:

- `resolve_prefix`: `--no-prefix` → `None`; `AMBER_PREFIX=C-a` → `Some(0x01)`;
  `none`/empty → `None`; garbage → default `Some(0x02)` (+ warning path);
  unset → `Some(0x02)`.
- `pick_newest`: empty → `None`; ignores dead; picks max `updated`; name
  tie-break.
- Prefix scanner via the existing socketpair `Harness`:
  - `prefix d` produces a `Detach` control frame and `ClientEnd::Detached`
    (feed `0x02 0x64` on the stdin feeder; assert the server sees `Detach` and
    the client returns `Detached`).
  - `prefix` split across two feeds still detaches (`0x02` then `0x64`) — proves
    cross-read state.
  - `prefix prefix` forwards exactly one `0x02` `Data` byte, no `Detach`.
  - `prefix x` (unbound) forwards nothing and does not detach; a subsequent
    normal byte still forwards.
  - With prefix disabled, a raw `0x02` forwards as data (no interception).

Existing `attach.rs` tests must keep passing unchanged.

## Out of scope

Copy-mode / scrollback navigation; in-attach window switching; read-only attach
(considered, deferred); multi-key prefix tables beyond `d` + literal.
