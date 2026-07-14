# macOS (Intel) support — design

**Date:** 2026-07-14
**Status:** approved, ready for implementation plan
**Target:** `x86_64-apple-darwin` (Intel Mac). Apple Silicon (`aarch64-apple-darwin`)
and aarch64-Linux-musl are explicitly out of scope.

## Problem

The `amber` daemon already *builds and installs* on macOS (launchd agent, plist
template, install/uninstall scripts, app menu roles). But its **process
introspection is `/proc`-based, which is Linux-only**. On macOS these paths do
not crash — they degrade silently — so two persistence features quietly no-op:

1. **Shell `cd` does not survive restart.** `PtySession::live_cwd()` reads
   `/proc/<pid>/cwd`; on macOS it returns `None`, so a restored shell pane falls
   back to its original creation cwd instead of where the user last `cd`'d.
2. **Ad-hoc `claude` in a shell pane is not re-detected.** `is_running_claude()`
   scans `/proc` for a `claude` descendant; on macOS it returns `false`, so a
   shell in which the user hand-launched `claude` is restored as a bare shell
   rather than a resumable, supervised claude.

Core `claude` supervision (`amber run <name>` panes) is **unaffected** — it is
driven by the generated `SessionStart` hook writing the recorded id, not by
`/proc` scanning. That is why this gap is not in the constitution's known-open
macOS list: it is silent degradation, not a crash or a broken core feature.

### The three Linux-only sites (all currently degrade gracefully, none panic)

| Site | Current impl | macOS today |
|------|--------------|-------------|
| `pty.rs` `is_claude_pid(pid)` | reads `/proc/<pid>/cmdline`, `.ok()…unwrap_or(false)` | `false` |
| `pty.rs` `claude_descends_from(root)` | scans `/proc`, `/proc/<pid>/stat` for ppid; `let Ok(entries) = read_dir("/proc") else { return false }` | `false` |
| `pty.rs` `PtySession::live_cwd()` | `read_link("/proc/<pid>/cwd").ok()` | `None` |

Consumers (`manager.rs::persist_live_cwd`) already tolerate `None`/`false` via
fallbacks, so restoring macOS parity is purely additive — no consumer changes.

## Goals

- macOS (Intel) reaches **runtime parity** with Linux for live-cwd tracking and
  ad-hoc-claude detection, via native syscalls behind `cfg`.
- No new third-party runtime dependency. macOS bindings come from `libc` (the
  system library, platform-own), honoring the constitution's "one
  dependency-free `amber` binary" rule.
- The macOS code path is **compile-verified on Linux** via
  `cargo check --target x86_64-apple-darwin` (no Mac SDK needed — `check` does
  not link).
- A concrete **Intel-Mac verification checklist** the user runs on real hardware
  as the behavioral acceptance criteria.

## Non-goals

- Apple Silicon (`aarch64-apple-darwin`), universal `lipo` binaries, and
  aarch64-Linux-musl static builds. Intel only.
- Any change to the socket protocol, snapshot format, supervision ladder, or
  app/renderer. This is daemon-internal introspection only.
- Rewriting the XDG state/socket path layout for macOS conventions
  (`~/Library/...`). The existing `$XDG_STATE_HOME` → `$HOME/.local/state`
  fallback is functional on macOS; leaving it is deliberate. Not parity-relevant.

## Architecture

### New module: `crates/amber/src/procinfo.rs`

A thin platform-abstraction layer. Only the **OS primitives** are `cfg`-split;
the claude-ancestry algorithm is lifted out as a **shared pure function** so it
is written once and unit-tested on Linux CI.

```rust
/// One process, as seen by the OS process table.
pub struct ProcEntry {
    pub pid: u32,
    pub ppid: u32,
    pub comm: String, // argv0 / exec basename, e.g. "claude"
}

// --- OS primitives (cfg-split) ---

/// Full snapshot of live processes (pid, ppid, comm). Used for the
/// claude-descendant walk. Empty vec if the OS is unsupported or the scan fails.
pub fn process_table() -> Vec<ProcEntry>;

/// A single process's current working directory. None if unavailable.
pub fn cwd_of(pid: u32) -> Option<PathBuf>;

/// A single process's argv0/exec basename. None if unavailable.
pub fn argv0_basename(pid: u32) -> Option<String>;

// --- shared pure logic (compiled on all targets, tested on Linux) ---

/// Is any process named "claude" a descendant of `root` within the table?
/// Builds a pid->ppid map and walks each claude's ancestor chain (bounded 64
/// deep, stopping at pid<=1). Pure over `table` — no syscalls.
pub fn claude_descends_from_table(table: &[ProcEntry], root: u32) -> bool;
```

**Linux impl** (`#[cfg(target_os = "linux")]`): the existing code, moved verbatim.
- `process_table`: scan `/proc`, parse `/proc/<pid>/stat` for ppid (after the
  last `')'`, field 2), read `/proc/<pid>/cmdline` argv0 basename for `comm`.
- `cwd_of`: `read_link("/proc/<pid>/cwd").ok()`.
- `argv0_basename`: read `/proc/<pid>/cmdline`, split on `\0`, basename of argv0.

**macOS impl** (`#[cfg(target_os = "macos")]`, via `libc`):
- `process_table`: `proc_listpids(PROC_ALL_PIDS, 0, buf, len)` to enumerate pids;
  per pid `proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &mut info, size)` →
  `pbi_ppid` for ppid and `pbi_comm` (NUL-terminated exec name, ~16 chars) for `comm`.
- `cwd_of`: `proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &mut vpi, size)` →
  `vpi.pvi_cdir.vip_path` (a C `char` array) → `PathBuf`.
- `argv0_basename`: reuse the `PROC_PIDTBSDINFO` call's `pbi_comm`. **Decision:**
  `pbi_comm` (one syscall) over `proc_pidpath` (full path, extra syscall) —
  `pbi_comm` is truncated to ~16 chars, and "claude" fits. Semantic note:
  `pbi_comm` is the *accounting exec name*, not argv0; for our sole purpose
  (equality with "claude") the two coincide.
- Same-user processes only need no special entitlement (the daemon inspects its
  own children). `proc_*` failures return `None`/skip the entry — never panic.

**Fallback impl** (`#[cfg(not(any(target_os = "linux", target_os = "macos")))]`):
`process_table` → empty, `cwd_of`/`argv0_basename` → `None`. Preserves today's
silent-degrade behavior on any other OS and keeps the crate compiling everywhere.

### Call-site rewiring (`pty.rs`)

- `is_claude_pid(pid)` → `procinfo::argv0_basename(pid).as_deref() == Some("claude")`.
- `claude_descends_from(root)` → `procinfo::claude_descends_from_table(&procinfo::process_table(), root)`.
- `PtySession::live_cwd()` → `self.pid.and_then(procinfo::cwd_of)`.
- `PtySession::is_running_claude()` unchanged in signature; body delegates as above.

`manager.rs::persist_live_cwd` and all other consumers are **untouched** — they
already handle `None`/`false`.

### Dependency

Add `libc` to the workspace (`[workspace.dependencies] libc = "0.2"`) and to
`amber`'s `[dependencies]`. `libc` is already present transitively (via `nix`);
promoting it to a direct dep is a platform-own system binding, not an external
runtime dep in the constitution's sense. All `libc` use is `#[cfg(target_os =
"macos")]`-gated.

## Data flow (unchanged shape)

Snapshot timer / shutdown → `manager` iterates sessions → `persist_live_cwd` →
`sess.live_cwd()` (now `procinfo::cwd_of`) + `sess.is_running_claude()` (now
`procinfo::process_table` + shared walk) → `SessionMeta` written to state store.
On restart, restore reads that meta. Nothing downstream of `procinfo` changes.

## Error handling

- Every `procinfo` primitive is **infallible-by-degrade**: a failed syscall or
  parse yields `None` / a skipped entry / an empty table, never a panic or a
  propagated error. This matches the existing Linux contract and keeps a bad
  read from ever killing a session.
- macOS `proc_pidinfo` returning `<= 0`, a short byte count, or a zero-length
  `vip_path` → treat as "unavailable" (`None`).

## Testing

**Unit (Linux CI, host target):**
- `claude_descends_from_table` over synthetic `Vec<ProcEntry>`: direct child,
  deep chain (≤64), chain exceeding 64 (no false positive), sibling/no-claude,
  claude present but not under root, ppid loop guard, root at pid 1.
- `argv0_basename`/`cwd_of` smoke test against the test process's own pid on
  Linux (self-introspection) to prove the Linux primitive still works after the
  move.

**Compile gate (Linux, no Mac):**
- `cargo check --target x86_64-apple-darwin -p amber` must pass. This typechecks
  the entire macOS `cfg` branch (structs, `libc` symbols, field names) without a
  macOS linker or SDK. Add to the dev/CI check set. `rustup target add
  x86_64-apple-darwin` is the only prerequisite.

**Behavioral (Intel Mac, user-run — the acceptance criteria):** see checklist.

## Build / packaging

- Primary target: `x86_64-apple-darwin`. Provide an **Intel-only** daemon build
  path (`cargo build --release --target x86_64-apple-darwin --bin amber`) so the
  user is not forced to add `aarch64-apple-darwin` just to produce a binary.
  `scripts/dist.sh` gains (or documents) an Intel-only branch producing
  `amber-x86_64-apple-darwin`; the existing universal `lipo` path stays but is
  optional and unused for Intel-only.
- App packaging (`app/scripts/dist.sh`, electron-builder dmg) is unchanged; it
  already targets the host platform and resolves the bundled `amber`.

## Intel-Mac verification checklist (user-run)

Written to `infra/daemon/` (alongside the reboot-torture doc) as the behavioral
acceptance criteria. Steps:

1. `rustup target add x86_64-apple-darwin` (if needed);
   `cargo build --release --target x86_64-apple-darwin --bin amber`.
2. `cargo test -p amber` on the Mac (host = x86_64) — unit + integration green.
3. Install via `infra/daemon/install.sh` → launchd agent loaded
   (`launchctl print gui/$(id -u)/com.amber-ide.daemon`).
4. **Live-cwd parity:** create a shell session, `cd` into a deep dir, trigger a
   snapshot (`amber ctl snapshot-now`), restart the daemon → session restores at
   the `cd`'d dir, not the original. (Validates `cwd_of`.)
5. **Ad-hoc-claude parity:** in a shell session hand-run `claude`, snapshot,
   restart → pane restored as a supervised, resumable claude. (Validates
   `process_table` + walk.)
6. **Reboot torture:** follow `infra/daemon`'s reboot doc → sessions survive a
   real reboot via launchd + final-snapshot.
7. App: build the dmg (`app/scripts/dist.sh`), launch, confirm end-to-end
   (daemon → utilityProcess → xterm; keystrokes → pty).

## Risks / tradeoffs

- **Cannot behaviorally verify from Linux.** Mitigated by the
  `cargo check --target x86_64-apple-darwin` compile gate + the user's Intel Mac
  running the checklist. The compile gate catches wrong `libc` symbol/struct
  names — the most likely macOS-code mistake — without a Mac.
- **`pbi_comm` truncation (~16 chars).** Acceptable: only compared against
  "claude". Documented at the call site.
- **`libc` struct/const availability.** `proc_listpids`, `proc_pidinfo`,
  `proc_bsdinfo` (`pbi_ppid`/`pbi_comm`), `proc_vnodepathinfo`
  (`pvi_cdir.vip_path`), `PROC_PIDTBSDINFO`, `PROC_PIDVNODEPATHINFO`,
  `PROC_ALL_PIDS` are macOS-gated in `libc`. The cross-`check` gate is the proof;
  if any symbol is missing in the pinned `libc`, bump `libc` or bind it locally
  in an `extern "C"` block within `procinfo` (still no third-party dep).
```
