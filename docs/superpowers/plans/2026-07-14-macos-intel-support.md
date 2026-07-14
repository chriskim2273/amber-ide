# macOS (Intel) Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Linux-parity process introspection (live cwd + ad-hoc-claude detection) on macOS Intel by replacing `/proc`-only reads with a cfg-split `procinfo` module backed by `libc` syscalls.

**Architecture:** A new `crates/amber/src/procinfo.rs` exposes three OS primitives (`process_table`, `cwd_of`, `argv0_basename`) that are `cfg`-split per OS, plus one shared pure function (`claude_descends_from_table`) holding the ancestor-walk algorithm. `pty.rs` call sites delegate to it. The macOS branch is compile-verified on Linux via `cargo check --target x86_64-apple-darwin`; behavior is verified by the user on an Intel Mac from a checklist.

**Tech Stack:** Rust (Cargo workspace), `libc` (macOS-gated FFI), existing `portable-pty`. No new third-party runtime dep beyond `libc` (system binding).

## Global Constraints

- **Target:** `x86_64-apple-darwin` (Intel) only. Do NOT add `aarch64-apple-darwin`, universal `lipo`, or aarch64-Linux-musl.
- **No new third-party runtime dep.** macOS bindings come from `libc` only; all `libc` use is `#[cfg(target_os = "macos")]`-gated.
- **Degrade, never panic.** Every `procinfo` primitive returns `None`/empty on any failure — matches the existing Linux contract. No `?`/`unwrap` on a syscall/parse failure.
- **No consumer changes.** `manager.rs` and the protocol/snapshot/supervision are untouched; this is daemon-internal introspection only.
- **Keep `cargo clippy --workspace --all-targets` clean.**
- Spec: `docs/superpowers/specs/2026-07-14-macos-intel-support-design.md`.

---

### Task 1: `procinfo` module skeleton — `ProcEntry` + shared ancestor walk

**Files:**
- Create: `crates/amber/src/procinfo.rs`
- Modify: `crates/amber/src/lib.rs` (register module)

**Interfaces:**
- Produces:
  - `pub struct ProcEntry { pub pid: u32, pub ppid: u32, pub comm: String }`
  - `pub fn claude_descends_from_table(table: &[ProcEntry], root: u32) -> bool`

- [ ] **Step 1: Write the failing test**

Create `crates/amber/src/procinfo.rs` with only the type, a stub, and tests:

```rust
//! Platform-abstracted process introspection: live cwd + ad-hoc-claude
//! detection. OS primitives are cfg-split (Linux `/proc`, macOS `libc`);
//! the ancestor-walk logic is shared and pure. Every primitive degrades to
//! None/empty on failure — it never panics (matches the daemon's contract).

use std::path::PathBuf;

/// One process as seen by the OS process table.
pub struct ProcEntry {
    pub pid: u32,
    pub ppid: u32,
    /// argv0 / exec basename, e.g. "claude".
    pub comm: String,
}

/// Is any process named `claude` a descendant of `root` within `table`?
/// Builds a pid->ppid map and walks each claude's ancestor chain (bounded 64
/// deep, stopping at pid <= 1). Pure over `table` — no syscalls.
pub fn claude_descends_from_table(table: &[ProcEntry], root: u32) -> bool {
    let _ = (table, root);
    unimplemented!()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(pid: u32, ppid: u32, comm: &str) -> ProcEntry {
        ProcEntry { pid, ppid, comm: comm.to_string() }
    }

    #[test]
    fn direct_child_claude_is_detected() {
        let t = vec![e(100, 1, "bash"), e(101, 100, "claude")];
        assert!(claude_descends_from_table(&t, 100));
    }

    #[test]
    fn deep_chain_within_limit_is_detected() {
        let t = vec![
            e(100, 1, "bash"),
            e(200, 100, "sh"),
            e(300, 200, "npx"),
            e(400, 300, "claude"),
        ];
        assert!(claude_descends_from_table(&t, 100));
    }

    #[test]
    fn claude_not_under_root_is_ignored() {
        let t = vec![e(100, 1, "bash"), e(101, 1, "claude")];
        assert!(!claude_descends_from_table(&t, 100));
    }

    #[test]
    fn no_claude_returns_false() {
        let t = vec![e(100, 1, "bash"), e(101, 100, "vim")];
        assert!(!claude_descends_from_table(&t, 100));
    }

    #[test]
    fn ppid_cycle_does_not_loop_forever() {
        // Malformed table with a 2-cycle not reaching root: must terminate.
        let t = vec![e(10, 11, "claude"), e(11, 10, "x")];
        assert!(!claude_descends_from_table(&t, 999));
    }

    #[test]
    fn chain_longer_than_64_is_not_falsely_matched() {
        // claude 70 hops above root; walk caps at 64, so root is never reached.
        let mut t = vec![e(1_000_000, 1, "claude")];
        let mut child = 1_000_000u32;
        for i in 0..70 {
            let parent = child;
            child = 2_000_000 + i;
            t.push(e(child, parent, "sh"));
        }
        let root = child; // bottom of the chain
        assert!(!claude_descends_from_table(&t, root));
    }
}
```

Register the module — modify `crates/amber/src/lib.rs`, insert after `pub mod manager;`:

```rust
pub mod procinfo;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p amber procinfo:: 2>&1 | tail -20`
Expected: tests compile but PANIC with `not implemented` (the `unimplemented!()` stub).

- [ ] **Step 3: Write minimal implementation**

Replace the `claude_descends_from_table` body in `crates/amber/src/procinfo.rs`:

```rust
pub fn claude_descends_from_table(table: &[ProcEntry], root: u32) -> bool {
    use std::collections::HashMap;
    let mut ppid_of: HashMap<u32, u32> = HashMap::with_capacity(table.len());
    let mut claude_pids: Vec<u32> = Vec::new();
    for entry in table {
        ppid_of.insert(entry.pid, entry.ppid);
        if entry.comm == "claude" {
            claude_pids.push(entry.pid);
        }
    }
    for &cp in &claude_pids {
        let mut cur = cp;
        for _ in 0..64 {
            match ppid_of.get(&cur) {
                Some(&pp) if pp == root => return true,
                Some(&pp) if pp > 1 => cur = pp,
                _ => break,
            }
        }
    }
    false
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p amber procinfo:: 2>&1 | tail -20`
Expected: PASS — 6 tests in `procinfo::tests`.

- [ ] **Step 5: Commit**

```bash
git add crates/amber/src/procinfo.rs crates/amber/src/lib.rs
git commit -m "feat(procinfo): shared claude-ancestor walk over a process table"
```

---

### Task 2: OS primitives — Linux `/proc`, macOS `libc`, generic fallback

**Files:**
- Modify: `crates/amber/src/procinfo.rs` (add primitives + Linux self-introspection test)
- Modify: `Cargo.toml` (workspace `libc` dep)
- Modify: `crates/amber/Cargo.toml` (crate `libc` dep)

**Interfaces:**
- Consumes: `ProcEntry` (Task 1).
- Produces:
  - `pub fn process_table() -> Vec<ProcEntry>`
  - `pub fn cwd_of(pid: u32) -> Option<PathBuf>`
  - `pub fn argv0_basename(pid: u32) -> Option<String>`

- [ ] **Step 1: Add the `libc` dependency**

Modify `Cargo.toml` `[workspace.dependencies]`, add:

```toml
libc = "0.2"
```

Modify `crates/amber/Cargo.toml` `[dependencies]`, add after `clap`:

```toml
libc = { workspace = true }
```

- [ ] **Step 2: Write the failing test**

Append to the `tests` module in `crates/amber/src/procinfo.rs` (Linux-only self-introspection — proves the Linux primitives work against the running test process):

```rust
    #[cfg(target_os = "linux")]
    #[test]
    fn self_argv0_basename_is_the_test_binary() {
        let pid = std::process::id();
        let name = argv0_basename(pid).expect("own argv0 readable");
        assert!(!name.is_empty());
        // The test harness binary is not literally "claude".
        assert_ne!(name, "claude");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn self_cwd_of_matches_current_dir() {
        let pid = std::process::id();
        let got = cwd_of(pid).expect("own cwd readable");
        let want = std::env::current_dir().unwrap();
        assert_eq!(got.canonicalize().unwrap(), want.canonicalize().unwrap());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn process_table_contains_self_with_a_ppid() {
        let me = std::process::id();
        let table = process_table();
        let mine = table.iter().find(|e| e.pid == me).expect("self in table");
        assert!(mine.ppid >= 1);
    }
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cargo test -p amber procinfo:: 2>&1 | tail -20`
Expected: COMPILE ERROR — `cannot find function process_table` / `cwd_of` / `argv0_basename` in this scope.

- [ ] **Step 4: Write minimal implementation**

Insert the primitives into `crates/amber/src/procinfo.rs`, after `claude_descends_from_table` and before `#[cfg(test)]`:

```rust
// ---- Linux: /proc ----

#[cfg(target_os = "linux")]
pub fn process_table() -> Vec<ProcEntry> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in entries.flatten() {
        let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        let Some(ppid) = read_ppid_linux(pid) else { continue };
        let comm = argv0_basename(pid).unwrap_or_default();
        out.push(ProcEntry { pid, ppid, comm });
    }
    out
}

/// Parse ppid from `/proc/<pid>/stat`: after the last ')', ppid is the second
/// whitespace field (process state is first).
#[cfg(target_os = "linux")]
fn read_ppid_linux(pid: u32) -> Option<u32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let close = stat.rfind(')')?;
    stat[close + 1..].split_whitespace().nth(1)?.parse::<u32>().ok()
}

#[cfg(target_os = "linux")]
pub fn cwd_of(pid: u32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
}

#[cfg(target_os = "linux")]
pub fn argv0_basename(pid: u32) -> Option<String> {
    let bytes = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let s = String::from_utf8_lossy(&bytes);
    let argv0 = s.split('\0').next().unwrap_or("");
    if argv0.is_empty() {
        return None;
    }
    Some(argv0.rsplit('/').next().unwrap_or(argv0).to_string())
}

// ---- macOS: libc proc_* ----

/// Read a NUL-terminated C char array into a String (lossy).
#[cfg(target_os = "macos")]
fn cstr_field(buf: &[libc::c_char]) -> String {
    let bytes: Vec<u8> = buf.iter().take_while(|&&c| c != 0).map(|&c| c as u8).collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Fetch a process's BSD info (ppid + comm) in one `proc_pidinfo` call.
#[cfg(target_os = "macos")]
fn bsdinfo(pid: u32) -> Option<libc::proc_bsdinfo> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let sz = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let r = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            sz,
        )
    };
    if r == sz {
        Some(info)
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
pub fn process_table() -> Vec<ProcEntry> {
    // First call sizes the pid buffer; second fills it.
    let n_bytes = unsafe { libc::proc_listpids(libc::PROC_ALL_PIDS, 0, std::ptr::null_mut(), 0) };
    if n_bytes <= 0 {
        return Vec::new();
    }
    let cap = n_bytes as usize / std::mem::size_of::<libc::c_int>();
    let mut pids = vec![0 as libc::c_int; cap];
    let got = unsafe {
        libc::proc_listpids(
            libc::PROC_ALL_PIDS,
            0,
            pids.as_mut_ptr() as *mut libc::c_void,
            n_bytes,
        )
    };
    if got <= 0 {
        return Vec::new();
    }
    let n = got as usize / std::mem::size_of::<libc::c_int>();
    pids.truncate(n);
    let mut out = Vec::new();
    for &pid in &pids {
        if pid <= 0 {
            continue;
        }
        if let Some(info) = bsdinfo(pid as u32) {
            out.push(ProcEntry {
                pid: pid as u32,
                ppid: info.pbi_ppid,
                comm: cstr_field(&info.pbi_comm),
            });
        }
    }
    out
}

#[cfg(target_os = "macos")]
pub fn cwd_of(pid: u32) -> Option<PathBuf> {
    let mut vpi: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let sz = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    let r = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            &mut vpi as *mut _ as *mut libc::c_void,
            sz,
        )
    };
    if r != sz {
        return None;
    }
    let path = cstr_field(&vpi.pvi_cdir.vip_path);
    if path.is_empty() {
        None
    } else {
        Some(PathBuf::from(path))
    }
}

#[cfg(target_os = "macos")]
pub fn argv0_basename(pid: u32) -> Option<String> {
    // pbi_comm is the accounting exec name (~16 chars, NUL-terminated). For our
    // sole use — equality with "claude" — it coincides with argv0's basename.
    let comm = cstr_field(&bsdinfo(pid)?.pbi_comm);
    if comm.is_empty() {
        None
    } else {
        Some(comm)
    }
}

// ---- Other OS: degrade (preserves today's silent no-op) ----

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn process_table() -> Vec<ProcEntry> {
    Vec::new()
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn cwd_of(_pid: u32) -> Option<PathBuf> {
    None
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn argv0_basename(_pid: u32) -> Option<String> {
    None
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cargo test -p amber procinfo:: 2>&1 | tail -20`
Expected: PASS — 6 pure tests + 3 Linux self-introspection tests.

- [ ] **Step 6: Commit**

```bash
git add Cargo.toml crates/amber/Cargo.toml Cargo.lock crates/amber/src/procinfo.rs
git commit -m "feat(procinfo): cfg-split OS primitives (linux /proc, macos libc)"
```

---

### Task 3: Rewire `pty.rs` to `procinfo`; delete the old `/proc` functions

**Files:**
- Modify: `crates/amber/src/pty.rs` (remove `is_claude_pid` + `claude_descends_from`; delegate `live_cwd` + `is_running_claude`)

**Interfaces:**
- Consumes: `crate::procinfo::{cwd_of, process_table, claude_descends_from_table}` (Tasks 1-2).

- [ ] **Step 1: Delete the two old free functions**

In `crates/amber/src/pty.rs`, delete lines 122-175 — the entire `is_claude_pid` function (with its `/// Basename…` doc) and the entire `claude_descends_from` function (with its `/// Is any claude…` doc). Delete nothing else in that range.

- [ ] **Step 2: Delegate `live_cwd`**

Replace the `live_cwd` method body. Old:

```rust
    /// The child process's current working directory, read live from
    /// `/proc/<pid>/cwd`. For a shell this tracks the user's `cd`s, so it can be
    /// snapshotted and restored. None if unavailable (no pid, not Linux, the
    /// process is gone, or the link can't be read).
    pub fn live_cwd(&self) -> Option<std::path::PathBuf> {
        let pid = self.pid?;
        std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
    }
```

New:

```rust
    /// The child process's current working directory. For a shell this tracks
    /// the user's `cd`s, so it can be snapshotted and restored. None if
    /// unavailable (no pid, unsupported OS, the process is gone, or the read
    /// fails). Backed by `procinfo::cwd_of` (Linux `/proc`, macOS `libc`).
    pub fn live_cwd(&self) -> Option<std::path::PathBuf> {
        self.pid.and_then(crate::procinfo::cwd_of)
    }
```

- [ ] **Step 3: Delegate `is_running_claude`**

Replace the `is_running_claude` method body. Old:

```rust
    /// True if a `claude` process is currently a descendant of the child (i.e.
    /// the user started claude by hand inside this shell). Used to decide
    /// whether to relaunch the pane as a supervised, resumable claude on
    /// restore. Linux-only (`/proc`); false elsewhere.
    pub fn is_running_claude(&self) -> bool {
        self.pid.map(claude_descends_from).unwrap_or(false)
    }
```

New:

```rust
    /// True if a `claude` process is currently a descendant of the child (i.e.
    /// the user started claude by hand inside this shell). Used to decide
    /// whether to relaunch the pane as a supervised, resumable claude on
    /// restore. Backed by `procinfo` (Linux `/proc`, macOS `libc`); false on
    /// unsupported OSes.
    pub fn is_running_claude(&self) -> bool {
        match self.pid {
            Some(pid) => {
                crate::procinfo::claude_descends_from_table(&crate::procinfo::process_table(), pid)
            }
            None => false,
        }
    }
```

- [ ] **Step 4: Verify no stale references remain**

Run: `grep -n 'is_claude_pid\|claude_descends_from\b\|/proc' crates/amber/src/pty.rs`
Expected: only the doc-comment mention at `pty.rs:68` (`via /proc/<pid>/cwd…`) if still present — no code references to the deleted functions, no `read_dir("/proc")`. If line 68's comment is now misleading, update it to `via procinfo::cwd_of`.

- [ ] **Step 5: Build, test, lint**

Run: `cargo test -p amber 2>&1 | tail -25`
Expected: PASS — full amber suite, including `manager::…::snapshot_persists_a_shells_live_cwd_after_cd` (still green on Linux).

Run: `cargo clippy --workspace --all-targets 2>&1 | tail -15`
Expected: no warnings.

- [ ] **Step 6: Commit**

```bash
git add crates/amber/src/pty.rs
git commit -m "refactor(pty): route process introspection through procinfo"
```

---

### Task 4: macOS compile gate — `cargo check --target x86_64-apple-darwin`

**Files:**
- Modify: `crates/amber/src/procinfo.rs` (only if the cross-check surfaces a libc symbol/field error)

**Interfaces:** none (verification task).

- [ ] **Step 1: Add the Intel-macOS target**

Run: `rustup target add x86_64-apple-darwin`
Expected: `info: component 'rust-std' for target 'x86_64-apple-darwin' installed` (or "up to date").

- [ ] **Step 2: Cross-check the whole crate (typechecks the macOS cfg branch)**

Run: `cargo check --target x86_64-apple-darwin -p amber 2>&1 | tail -30`
Expected: `Finished`. `cargo check` does not link, so no macOS SDK/linker is required — this compiles the `#[cfg(target_os = "macos")]` code (structs, `libc` symbols, field names) on Linux.

- [ ] **Step 3: If it fails on a `libc` symbol/field, fix and re-run**

Likely fixes if a symbol is missing in the pinned `libc`:
- `proc_pidinfo` / `proc_listpids` not found → bump `libc` in `Cargo.toml` (e.g. `libc = "0.2.155"`) and re-run.
- A field name differs (`pbi_ppid`, `pbi_comm`, `pvi_cdir`, `vip_path`) → check the installed `libc` source with
  `find ~/.cargo -path '*libc*/src/unix/bsd/apple/mod.rs' | head -1` and grep it for `proc_bsdinfo` / `proc_vnodepathinfo` / `vnode_info_path`, then align the field access.
- Last resort (still no third-party dep): declare the needed `extern "C"` fns/structs in a `#[cfg(target_os = "macos")]` block inside `procinfo.rs`.

Re-run Step 2 until it prints `Finished`.

- [ ] **Step 4: Confirm Linux is still green**

Run: `cargo test -p amber 2>&1 | tail -10 && cargo clippy --workspace --all-targets 2>&1 | tail -5`
Expected: tests PASS, clippy clean.

- [ ] **Step 5: Commit (only if Step 3 changed files)**

```bash
git add crates/amber/src/procinfo.rs Cargo.toml Cargo.lock
git commit -m "fix(procinfo): align macos libc bindings so x86_64-apple-darwin checks"
```

If nothing changed, skip the commit.

---

### Task 5: Intel-only daemon build path in `scripts/dist.sh`

**Files:**
- Modify: `scripts/dist.sh` (add an Intel-macOS branch)

**Interfaces:** none (build tooling).

- [ ] **Step 1: Read the current dist script**

Run: `cat scripts/dist.sh`
Note the existing `build_macos()` (universal via `lipo`) and the `case "$(uname -s)"` dispatch.

- [ ] **Step 2: Add an Intel-only build function**

In `scripts/dist.sh`, add this function next to `build_macos()`:

```bash
# Intel-only macOS build (x86_64). Use on an Intel Mac when a universal binary
# is not needed — avoids requiring the aarch64-apple-darwin target.
build_macos_intel() {
    rustup target add x86_64-apple-darwin
    cargo build --release --target x86_64-apple-darwin --bin amber
    cp "$ROOT/target/x86_64-apple-darwin/release/amber" "$OUT/amber-x86_64-apple-darwin"
    echo "dist: $OUT/amber-x86_64-apple-darwin (intel)"
}
```

- [ ] **Step 3: Make it selectable**

Locate the `Darwin)` arm of the `case "$(uname -s)"` dispatch. Change it so an
env var picks the Intel path, defaulting to the existing universal build:

```bash
        Darwin)
            if [ "${AMBER_MACOS_INTEL:-0}" = "1" ]; then
                build_macos_intel
            else
                build_macos
            fi
            ;;
```

- [ ] **Step 4: Syntax-check the script**

Run: `bash -n scripts/dist.sh && echo OK`
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add scripts/dist.sh
git commit -m "build: intel-only macOS daemon build path (AMBER_MACOS_INTEL=1)"
```

---

### Task 6: Intel-Mac verification checklist doc

**Files:**
- Create: `infra/daemon/macos-intel-verification.md`

**Interfaces:** none (documentation — the behavioral acceptance criteria the user runs).

- [ ] **Step 1: Write the checklist**

Create `infra/daemon/macos-intel-verification.md`:

```markdown
# macOS (Intel) verification checklist

Behavioral acceptance criteria for macOS Intel (`x86_64-apple-darwin`) support.
Run on a real Intel Mac — these cannot be checked from Linux. The Linux CI
already covers the pure logic and the macOS *compile* gate
(`cargo check --target x86_64-apple-darwin`); this doc covers *behavior*.

## Build & unit tests

1. `rustup target add x86_64-apple-darwin`
2. `AMBER_MACOS_INTEL=1 ./scripts/dist.sh`  → produces `dist/amber-x86_64-apple-darwin`.
3. `cargo test -p amber`  → host target is x86_64; unit + integration green,
   including `procinfo` self-introspection and `snapshot_persists_a_shells_live_cwd_after_cd`.

## Install (launchd)

4. `infra/daemon/install.sh`  → launchd agent loaded.
5. `launchctl print gui/$(id -u)/com.amber-ide.daemon`  → shows the agent running.

## Live-cwd parity  (validates `procinfo::cwd_of`)

6. Create a shell session, then inside it `cd` into a deep directory
   (e.g. `mkdir -p ~/amber-cwd-test/a/b/c && cd $_`).
7. `amber ctl snapshot-now`.
8. Restart the daemon (`launchctl kickstart -k gui/$(id -u)/com.amber-ide.daemon`).
9. Re-attach the session → it restores at `~/amber-cwd-test/a/b/c`, NOT the
   original creation cwd. ✅ if the `cd` survived.

## Ad-hoc-claude parity  (validates `procinfo::process_table` + walk)

10. In a shell session, hand-run `claude` (not via `amber run`).
11. `amber ctl snapshot-now`, then restart the daemon (step 8).
12. Re-attach → the pane comes back as a supervised, resumable claude, not a
    bare shell. ✅ if it resumed claude.

## Reboot torture

13. Follow `infra/daemon/README.md`'s reboot procedure → sessions survive a
    real reboot via the launchd agent + final SIGTERM snapshot.

## App (dmg)

14. `app/scripts/dist.sh` → build the dmg; launch it.
15. Confirm end-to-end: daemon → utilityProcess → xterm renders; keystrokes
    reach the pty. ✅ if a pane is interactive.

Record pass/fail per step. Any failure at 9 or 12 means the corresponding
macOS `procinfo` primitive is wrong despite the compile gate — capture
`amber ctl doctor` output and the daemon log.
```

- [ ] **Step 2: Verify it renders**

Run: `head -20 infra/daemon/macos-intel-verification.md`
Expected: the header + intro render as written.

- [ ] **Step 3: Commit**

```bash
git add infra/daemon/macos-intel-verification.md
git commit -m "docs: intel-mac behavioral verification checklist"
```

---

## Self-Review

**Spec coverage:**
- macOS `/proc` parity via cfg-split primitives → Tasks 1-3. ✅
- Shared pure ancestor walk, unit-tested on Linux → Task 1. ✅
- `libc` as the only new dep, macOS-gated → Task 2. ✅
- Degrade-never-panic contract → primitives return `None`/empty; no `?` on syscalls → Task 2. ✅
- Compile-verify macOS on Linux (`cargo check --target x86_64-apple-darwin`) → Task 4. ✅
- Intel-only build path → Task 5. ✅
- Behavioral checklist the user runs → Task 6. ✅
- Non-goals (no aarch64/universal/protocol changes) → enforced by Global Constraints; no task adds them. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every command has expected output. ✅

**Type consistency:** `ProcEntry{pid,ppid,comm}`, `process_table() -> Vec<ProcEntry>`, `cwd_of(u32) -> Option<PathBuf>`, `argv0_basename(u32) -> Option<String>`, `claude_descends_from_table(&[ProcEntry], u32) -> bool` — used identically in Tasks 1-3. ✅
```
