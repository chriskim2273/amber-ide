# amber-ide App — Slices 1–3 Implementation Plan (daemon protocol → walking skeleton)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first working amber-ide app increment — an Electron window that renders one live daemon pane over the real unix socket, plus the daemon protocol extension it needs.

**Architecture:** Slice 1 extends the Rust daemon with metadata-carrying session discovery + pushed change events (broadcasting lives in the daemon layer; the manager gains only a read-only projection). Slices 2–3 build the Electron client per the constitution: a single multiplexed `utilityProcess` holds the only socket, demuxes pty bytes by session name, and forwards them over a per-pane `MessagePort` straight into an xterm.js+WebGL instance. Main process brokers ports and does window/lifecycle only; React renders chrome, never terminal bytes.

**Tech Stack:** Rust (existing `amber` workspace: `portable-pty`, `serde`, `nix`, `anyhow`). Electron 43 + electron-vite 5 + TypeScript strict + React + `@xterm/xterm` 6 + `@xterm/addon-webgl` 0.19 + `@xterm/addon-fit` 0.11 + vitest. Node `net` for the unix socket. No native Node addons.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-13-amber-ide-app-design.md`. Constitution: `CLAUDE.md`. Do not violate core rules without asking.
- **Worktree:** `~/Projects/amber-ide-app`, branch `feat/electron-app`. The Rust daemon lives in `crates/` in this same worktree.
- **Bytes never touch the main process.** The raw-byte path is renderer pane `MessagePort` ↔ utilityProcess router ↔ socket. Main brokers ports only.
- **One-way data flow.** Pane existence/grouping mutates only from daemon events (`Sessions`/`SessionsChanged`/`Exit`). Never optimistically create/destroy locally.
- **TypeScript strict** (`"strict": true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). ESM modules. No `any` in committed code.
- **TDD, every task:** write the failing test, watch it fail, minimal code, watch it pass, commit. Conventional commits, **no `Co-Authored-By` lines** (user global rule).
- **Socket path (verified against `crates/amber/src/main.rs`):** `$XDG_RUNTIME_DIR/amber-ide/amberd.sock`; if `XDG_RUNTIME_DIR` unset/empty, `<root>/amberd.sock` where `root` = `$XDG_STATE_HOME/amber-ide` else `$HOME/.local/state/amber-ide`.
- **Wire format:** `[u32 BE body_len][u8 tag][body]`; tag 0 = Control (JSON of `ControlMsg`, serde **externally-tagged**), tag 1 = Data (`[u16 BE name_len][name utf8][raw bytes]`). `MAX_FRAME_LEN = 64*1024*1024`.
- **Rust checks:** `cargo test --workspace` and `cargo clippy --workspace --all-targets -- -D warnings` clean. **TS checks:** `npm run test`, `npm run typecheck` (`tsc --noEmit`), `npm run lint` clean.

---

## File Structure

**Slice 1 (Rust, existing crates):**
- `crates/amber-core/src/proto.rs` — add `SessionInfo` + 4 `ControlMsg` variants (modify).
- `crates/amber/src/manager.rs` — add `session_infos()` (modify).
- `crates/amber/src/watchers.rs` — new: `Watchers` registry + broadcast.
- `crates/amber/src/daemon.rs` — thread `Watchers`, handle new control msgs, broadcast on create/kill (modify).
- `crates/amber/src/lib.rs` — expose `watchers` module (modify).
- `crates/amber/src/main.rs` — build `Watchers` in `run_daemon`, broadcast removed on reap (modify).

**Slices 2–3 (new `app/` subtree in the worktree root):**
- `app/package.json`, `app/electron.vite.config.ts`, `app/tsconfig.json`, `app/tsconfig.node.json`, `app/.eslintrc.cjs`, `app/vitest.config.ts` — scaffold.
- `app/src/shared/proto.ts` — TS wire codec (pure). `app/src/shared/proto.test.ts`.
- `app/src/shared/names.ts` (socket path + session-name parse stub used in slice 3). `app/src/shared/socketPath.ts` + `.test.ts`.
- `app/src/client/index.ts` — utilityProcess entry (receives port, owns connection+router).
- `app/src/client/connection.ts` + `.test.ts` — net socket + Decoder feed.
- `app/src/client/router.ts` + `.test.ts` — demux/mux by session name (slice 3).
- `app/src/main/index.ts` — app lifecycle, daemon-boot, fork utilityProcess, port broker.
- `app/src/main/daemonBoot.ts` + `.test.ts` — connect-probe + decision logic.
- `app/src/preload/index.ts` — MessagePort bridge into the renderer main world.
- `app/src/renderer/index.html`, `app/src/renderer/main.tsx`, `app/src/renderer/App.tsx` — React chrome.
- `app/src/renderer/Pane.tsx` — xterm instance wired to a MessagePort (slice 3).
- `app/test/fakeDaemon.ts` — in-memory unix-socket server speaking real `proto`.

---

# SLICE 1 — Daemon protocol extension (Rust)

*Proves: two client connections, the watcher sees create/kill deltas, the non-watcher stays silent.*

## Task 1: proto — `SessionInfo` + discovery/watch variants

**Files:**
- Modify: `crates/amber-core/src/proto.rs`
- Test: same file `#[cfg(test)] mod tests`

**Interfaces:**
- Produces: `pub struct SessionInfo { pub name: String, pub cwd: String, pub kind: String, pub alive: bool }`; `ControlMsg::{WatchSessions, ListSessionsDetailed, Sessions{sessions:Vec<SessionInfo>}, SessionsChanged{added:Vec<SessionInfo>, removed:Vec<String>}}`.

- [ ] **Step 1: Write the failing test** — append to `crates/amber-core/src/proto.rs` tests module:

```rust
    #[test]
    fn session_info_variants_roundtrip() {
        let info = SessionInfo {
            name: "amber-1-1-0-abc".into(),
            cwd: "/home/u/proj".into(),
            kind: "claude".into(),
            alive: true,
        };
        let full = Frame::Control(ControlMsg::Sessions { sessions: vec![info.clone()] });
        assert_eq!(roundtrip(&full), full);

        let delta = Frame::Control(ControlMsg::SessionsChanged {
            added: vec![info],
            removed: vec!["amber-1-1-1-def".into()],
        });
        assert_eq!(roundtrip(&delta), delta);

        for unit in [ControlMsg::WatchSessions, ControlMsg::ListSessionsDetailed] {
            let f = Frame::Control(unit);
            assert_eq!(roundtrip(&f), f);
        }
    }

    #[test]
    fn control_enum_is_externally_tagged() {
        // The TS client mirrors this exact JSON. Lock the shape so a serde
        // change that breaks the wire is caught here.
        let json = serde_json::to_string(&ControlMsg::WatchSessions).unwrap();
        assert_eq!(json, "\"WatchSessions\"");
        let json = serde_json::to_string(&ControlMsg::SessionsChanged {
            added: vec![],
            removed: vec!["x".into()],
        })
        .unwrap();
        assert_eq!(json, r#"{"SessionsChanged":{"added":[],"removed":["x"]}}"#);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p amber-core proto::tests::session_info_variants_roundtrip`
Expected: FAIL — `SessionInfo` and the new variants do not exist (compile error).

- [ ] **Step 3: Write minimal implementation** — in `crates/amber-core/src/proto.rs`, add the struct above the `ControlMsg` enum:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionInfo {
    pub name: String,
    pub cwd: String,
    pub kind: String,
    pub alive: bool,
}
```

Add these variants inside `enum ControlMsg` (after `SnapshotOk`):

```rust
    /// Client -> daemon: opt this connection in to pushed session-change events.
    WatchSessions,
    /// Client -> daemon: request the full session set with metadata.
    ListSessionsDetailed,
    /// Daemon -> client: the full session set (reply to ListSessionsDetailed
    /// and sent once after WatchSessions).
    Sessions { sessions: Vec<SessionInfo> },
    /// Daemon -> watchers: an incremental session-set delta.
    SessionsChanged { added: Vec<SessionInfo>, removed: Vec<String> },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p amber-core proto`
Expected: PASS (all proto tests, including the two new ones).

- [ ] **Step 5: Commit**

```bash
git add crates/amber-core/src/proto.rs
git commit -m "feat(proto): SessionInfo + WatchSessions/ListSessionsDetailed/Sessions/SessionsChanged"
```

## Task 2: manager — `session_infos()`

**Files:**
- Modify: `crates/amber/src/manager.rs`
- Test: same file tests module

**Interfaces:**
- Consumes: `amber_core::proto::SessionInfo`; existing `self.sessions` map, `self.store.list_sessions()`, `PtySession::is_alive()`.
- Produces: `pub fn session_infos(&self) -> anyhow::Result<Vec<SessionInfo>>` — one entry per live session, sorted by name, `kind` = `"shell"`/`"claude"`, `alive` = child not yet exited.

- [ ] **Step 1: Write the failing test** — append to the `manager.rs` tests module:

```rust
    #[test]
    fn session_infos_projects_metadata_for_live_sessions() {
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        mgr.create("amber-1-1-0-a", "/tmp", SessionKind::Shell).unwrap();
        mgr.create("amber-1-1-1-b", dir.path(), SessionKind::Claude).unwrap();

        let mut infos = mgr.session_infos().unwrap();
        infos.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(infos.len(), 2);
        assert_eq!(infos[0].name, "amber-1-1-0-a");
        assert_eq!(infos[0].kind, "shell");
        assert_eq!(infos[0].cwd, "/tmp");
        assert!(infos[0].alive);
        assert_eq!(infos[1].kind, "claude");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p amber session_infos_projects_metadata_for_live_sessions`
Expected: FAIL — `session_infos` not found.

- [ ] **Step 3: Write minimal implementation** — add `use amber_core::state::{...}` already imports `SessionKind, SessionMeta, StateStore`; add `SessionInfo` import at top: change the `use amber_core::state::...` line's sibling — add `use amber_core::proto::SessionInfo;`. Then add the method inside `impl SessionManager` (after `names`):

```rust
    /// One [`SessionInfo`] per live session, joining the live table (existence
    /// + liveness) with the persisted metadata (cwd/kind). Sorted by name.
    pub fn session_infos(&self) -> anyhow::Result<Vec<SessionInfo>> {
        let sessions = self.sessions.lock().unwrap();
        let mut infos: Vec<SessionInfo> = self
            .store
            .list_sessions()?
            .into_iter()
            .filter_map(|meta| {
                sessions.get(&meta.name).map(|sess| SessionInfo {
                    name: meta.name.clone(),
                    cwd: meta.cwd.to_string_lossy().into_owned(),
                    kind: match meta.kind {
                        SessionKind::Shell => "shell".to_string(),
                        SessionKind::Claude => "claude".to_string(),
                    },
                    alive: sess.is_alive(),
                })
            })
            .collect();
        infos.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(infos)
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p amber manager`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/amber/src/manager.rs
git commit -m "feat(manager): session_infos() projects live sessions to SessionInfo"
```

## Task 3: `Watchers` registry + broadcast

**Files:**
- Create: `crates/amber/src/watchers.rs`
- Modify: `crates/amber/src/lib.rs` (add `pub mod watchers;`)
- Test: in `watchers.rs`

**Interfaces:**
- Produces: `pub struct Watchers` with `pub fn new() -> Self`, `pub fn register(&self, writer: &Arc<Mutex<UnixStream>>)`, `pub fn broadcast(&self, msg: &ControlMsg)`. Dead/dropped writers are pruned on broadcast.

- [ ] **Step 1: Write the failing test** — create `crates/amber/src/watchers.rs`:

```rust
//! Registry of client connections that opted in (via `WatchSessions`) to
//! pushed `SessionsChanged` events. Holds weak references to each watcher's
//! shared write half, so a vanished connection is pruned automatically.

use std::io::Write;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex, Weak};

use amber_core::proto::{self, ControlMsg, Frame};

#[derive(Default)]
pub struct Watchers {
    writers: Mutex<Vec<Weak<Mutex<UnixStream>>>>,
}

impl Watchers {
    pub fn new() -> Self {
        Watchers::default()
    }

    /// Register a connection's shared write half as a watcher.
    pub fn register(&self, writer: &Arc<Mutex<UnixStream>>) {
        self.writers.lock().unwrap().push(Arc::downgrade(writer));
    }

    /// Encode `msg` once and write it to every live watcher. Snapshots the
    /// live set under the registry lock, then writes with the lock released
    /// (rule: registry lock before writer lock, never nested the other way).
    pub fn broadcast(&self, msg: &ControlMsg) {
        let frame = proto::encode(&Frame::Control(msg.clone()));
        let live: Vec<Arc<Mutex<UnixStream>>> = {
            let mut ws = self.writers.lock().unwrap();
            ws.retain(|w| w.strong_count() > 0);
            ws.iter().filter_map(Weak::upgrade).collect()
        };
        for w in live {
            let mut s = w.lock().unwrap();
            let _ = s.write_all(&frame).and_then(|_| s.flush());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use amber_core::proto::Decoder;
    use std::io::Read;
    use std::time::Duration;

    fn read_one(stream: &mut UnixStream) -> Option<Frame> {
        stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut dec = Decoder::new();
        let mut buf = [0u8; 4096];
        loop {
            if let Some(f) = dec.next_frame().unwrap() {
                return Some(f);
            }
            match stream.read(&mut buf) {
                Ok(0) => return None,
                Ok(n) => dec.feed(&buf[..n]),
                Err(_) => return None,
            }
        }
    }

    #[test]
    fn broadcast_reaches_live_watchers_and_prunes_dropped_ones() {
        let watchers = Watchers::new();
        let (mut client_a, server_a) = UnixStream::pair().unwrap();
        let (mut client_b, server_b) = UnixStream::pair().unwrap();
        let wa = Arc::new(Mutex::new(server_a));
        let wb = Arc::new(Mutex::new(server_b));
        watchers.register(&wa);
        watchers.register(&wb);

        let msg = ControlMsg::SessionsChanged { added: vec![], removed: vec!["x".into()] };
        watchers.broadcast(&msg);
        assert_eq!(read_one(&mut client_a), Some(Frame::Control(msg.clone())));
        assert_eq!(read_one(&mut client_b), Some(Frame::Control(msg.clone())));

        // Drop watcher B's server writer: the Weak can no longer upgrade, so
        // the next broadcast prunes it and only A receives.
        drop(wb);
        let msg2 = ControlMsg::SessionsChanged { added: vec![], removed: vec!["y".into()] };
        watchers.broadcast(&msg2);
        assert_eq!(read_one(&mut client_a), Some(Frame::Control(msg2)));
        assert_eq!(watchers.writers.lock().unwrap().len(), 1, "dropped watcher pruned");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p amber watchers`
Expected: FAIL — `watchers` module not declared in `lib.rs` (compile error / unresolved module).

- [ ] **Step 3: Write minimal implementation** — the module body above is the implementation. Now declare it: in `crates/amber/src/lib.rs` add (alongside the other `pub mod` lines):

```rust
pub mod watchers;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p amber watchers`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/amber/src/watchers.rs crates/amber/src/lib.rs
git commit -m "feat(daemon): Watchers registry with pruning broadcast"
```

## Task 4: daemon — handle watch/list-detailed + broadcast on create/kill

**Files:**
- Modify: `crates/amber/src/daemon.rs`
- Test: `crates/amber/tests/watch.rs` (new integration test)

**Interfaces:**
- Consumes: `crate::watchers::Watchers`, `SessionManager::session_infos()`, existing `ControlMsg` handlers.
- Produces: `Daemon::new(manager, watchers)` now takes an `Arc<Watchers>`; `WatchSessions` registers the connection + replies `Sessions`; `ListSessionsDetailed` replies `Sessions`; `Create`/`Kill` broadcast `SessionsChanged`.

- [ ] **Step 1: Write the failing test** — create `crates/amber/tests/watch.rs`:

```rust
//! A watcher connection sees session create/kill deltas; a non-watcher does not.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::time::Duration;

use amber::daemon::{prepare_socket, Daemon};
use amber::manager::SessionManager;
use amber::watchers::Watchers;
use amber_core::proto::{self, ControlMsg, Decoder, Frame};

fn send(stream: &UnixStream, msg: ControlMsg) {
    let mut w = stream;
    w.write_all(&proto::encode(&Frame::Control(msg))).unwrap();
    w.flush().unwrap();
}

fn read_control_until<F: Fn(&ControlMsg) -> bool>(stream: &mut UnixStream, pred: F) -> ControlMsg {
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut dec = Decoder::new();
    let mut buf = [0u8; 8192];
    loop {
        while let Some(Frame::Control(msg)) = dec.next_frame().unwrap() {
            if pred(&msg) {
                return msg;
            }
        }
        let n = stream.read(&mut buf).expect("timed out waiting for control frame");
        assert!(n > 0, "connection closed unexpectedly");
        dec.feed(&buf[..n]);
    }
}

#[test]
fn watcher_sees_create_and_kill_deltas() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("amberd.sock");
    let manager = Arc::new(SessionManager::new(dir.path()).unwrap());
    let watchers = Arc::new(Watchers::new());
    let listener = prepare_socket(&sock).unwrap();
    let daemon = Daemon::new(Arc::clone(&manager), Arc::clone(&watchers));
    std::thread::spawn(move || {
        let _ = daemon.serve(listener);
    });

    let watcher = UnixStream::connect(&sock).unwrap();
    let bystander = UnixStream::connect(&sock).unwrap();

    let mut w = watcher.try_clone().unwrap();
    send(&watcher, ControlMsg::WatchSessions);
    // WatchSessions replies with the (empty) full set first.
    read_control_until(&mut w, |m| matches!(m, ControlMsg::Sessions { .. }));

    // Create a shell session over the bystander connection.
    send(
        &bystander,
        ControlMsg::Create {
            name: "amber-1-1-0-a".into(),
            cwd: dir.path().to_string_lossy().into_owned(),
            kind: "shell".into(),
        },
    );

    let delta = read_control_until(&mut w, |m| matches!(m, ControlMsg::SessionsChanged { .. }));
    match delta {
        ControlMsg::SessionsChanged { added, removed } => {
            assert_eq!(added.len(), 1);
            assert_eq!(added[0].name, "amber-1-1-0-a");
            assert_eq!(added[0].kind, "shell");
            assert!(removed.is_empty());
        }
        other => panic!("expected SessionsChanged, got {other:?}"),
    }

    // Kill it; watcher sees a removal delta.
    send(&bystander, ControlMsg::Kill { name: "amber-1-1-0-a".into() });
    let delta = read_control_until(&mut w, |m| {
        matches!(m, ControlMsg::SessionsChanged { removed, .. } if !removed.is_empty())
    });
    match delta {
        ControlMsg::SessionsChanged { removed, .. } => {
            assert_eq!(removed, vec!["amber-1-1-0-a".to_string()]);
        }
        other => panic!("expected removal, got {other:?}"),
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p amber --test watch`
Expected: FAIL — `Daemon::new` takes one arg, not two; `amber::watchers` path and control handlers do not broadcast yet (compile error first).

- [ ] **Step 3: Write minimal implementation** — in `crates/amber/src/daemon.rs`:

Change the struct and constructor to carry watchers:

```rust
pub struct Daemon {
    manager: Arc<SessionManager>,
    watchers: Arc<crate::watchers::Watchers>,
}

impl Daemon {
    pub fn new(manager: Arc<SessionManager>, watchers: Arc<crate::watchers::Watchers>) -> Self {
        Daemon { manager, watchers }
    }
```

In `serve`, pass `watchers` into the connection handler:

```rust
                Ok(stream) => {
                    let manager = Arc::clone(&self.manager);
                    let watchers = Arc::clone(&self.watchers);
                    thread::spawn(move || {
                        if let Err(e) = handle_connection(manager, watchers, stream) {
                            eprintln!("amber daemon: connection error: {e}");
                        }
                    });
                }
```

Thread `watchers` through `handle_connection` → `connection_loop` → `handle_frame` → `handle_control`. Update each signature to take `watchers: &Arc<crate::watchers::Watchers>` and pass it along (mirror how `writer` is threaded). Then in `handle_control`, add arms and augment `Create`/`Kill`:

```rust
        ControlMsg::Create { name, cwd, kind } => {
            let result = parse_kind(&kind).and_then(|k| manager.create(&name, cwd, k));
            let reply = match &result {
                Ok(_) => ControlMsg::Created { name: name.clone() },
                Err(e) => ControlMsg::Error { msg: e.to_string() },
            };
            let _ = write_frame(writer, &Frame::Control(reply));
            if result.is_ok() {
                if let Ok(infos) = manager.session_infos() {
                    if let Some(info) = infos.into_iter().find(|i| i.name == name) {
                        watchers.broadcast(&ControlMsg::SessionsChanged {
                            added: vec![info],
                            removed: vec![],
                        });
                    }
                }
            }
        }
        ControlMsg::Kill { name } => {
            let existed = manager.session(&name).is_some();
            let _ = manager.remove(&name);
            if existed {
                watchers.broadcast(&ControlMsg::SessionsChanged {
                    added: vec![],
                    removed: vec![name],
                });
            }
        }
        ControlMsg::WatchSessions => {
            watchers.register(writer);
            let sessions = manager.session_infos().unwrap_or_default();
            let _ = write_frame(writer, &Frame::Control(ControlMsg::Sessions { sessions }));
        }
        ControlMsg::ListSessionsDetailed => {
            let sessions = manager.session_infos().unwrap_or_default();
            let _ = write_frame(writer, &Frame::Control(ControlMsg::Sessions { sessions }));
        }
```

(Remove the old `Kill` arm — the new one replaces it. Leave the existing `Resize`/`Detach`/`Attach`/`Snapshot`/`Rename`/`ListSessions` arms unchanged. `WatchSessions`/`ListSessionsDetailed`/`Sessions`/`SessionsChanged` were previously falling through the `_ => {}` catch-all; the two client-sent ones now have explicit arms.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p amber --test watch` then `cargo test --workspace`
Expected: PASS (watch test green; the existing suite still green — note `Daemon::new` callers in `main.rs` are updated in Task 5, so `cargo test --workspace` compiles only after Task 5; run just `--test watch` here, which uses the two-arg `new` directly).

> Note: `main.rs` still calls `Daemon::new` with one arg until Task 5. Compile the library + integration test in isolation now (`cargo test -p amber --test watch`); the full-workspace build passes after Task 5.

- [ ] **Step 5: Commit**

```bash
git add crates/amber/src/daemon.rs crates/amber/tests/watch.rs
git commit -m "feat(daemon): watch/list-detailed control msgs + create/kill broadcast"
```

## Task 5: main — wire Watchers into run_daemon + broadcast on reap

**Files:**
- Modify: `crates/amber/src/main.rs`

**Interfaces:**
- Consumes: `amber::watchers::Watchers`, updated `Daemon::new(manager, watchers)`, `manager.reap()`, `manager.session_infos()` is not needed here (reap returns names).

- [ ] **Step 1: Update `run_daemon` to build and share `Watchers`.** In `crates/amber/src/main.rs`, inside `run_daemon`, after the manager `Arc` is created and before constructing the `Daemon`, add:

```rust
    let watchers = std::sync::Arc::new(amber::watchers::Watchers::new());
```

Change the `Daemon::new(...)` call to `Daemon::new(Arc::clone(&manager), Arc::clone(&watchers))`.

In the periodic snapshot thread, clone `watchers` in and broadcast removals after reap. Replace the reap match body:

```rust
            match manager.reap() {
                Ok(reaped) => {
                    if !reaped.is_empty() {
                        for name in &reaped {
                            eprintln!("amber daemon: session {name} ended; reaped");
                        }
                        watchers.broadcast(&amber_core::proto::ControlMsg::SessionsChanged {
                            added: vec![],
                            removed: reaped,
                        });
                    }
                }
                Err(e) => eprintln!("amber daemon: reap failed: {e}"),
            }
```

Ensure the thread `move` closure captures a clone: before `thread::spawn(move || loop {`, add `let watchers = Arc::clone(&watchers);` (alongside the existing `let manager = Arc::clone(&manager);`).

- [ ] **Step 1b: Update the other `Daemon::new` callers.** `crates/amber/tests/socket.rs` constructs the daemon at two sites (lines ~25 and ~90) with the old one-arg signature; they must pass a `Watchers` too, or the workspace test build fails. At the top of `socket.rs` add `use amber::watchers::Watchers;` (if not present), then change:
  - `let daemon = Daemon::new(manager);` → `let daemon = Daemon::new(manager, std::sync::Arc::new(Watchers::new()));`
  - `let daemon = Daemon::new(Arc::clone(&manager));` → `let daemon = Daemon::new(Arc::clone(&manager), std::sync::Arc::new(Watchers::new()));`
  Grep first to catch any others: `grep -rn "Daemon::new" crates/` — every caller must pass two args. (`main.rs` was updated in Step 1; `tests/watch.rs` already uses the two-arg form.)

- [ ] **Step 2: Verify the workspace compiles and all tests pass**

Run: `cargo build --workspace && cargo test --workspace`
Expected: PASS — the whole workspace now compiles with the two-arg `Daemon::new`, and every test (incl. `watch`) is green.

- [ ] **Step 3: Clippy clean**

Run: `cargo clippy --workspace --all-targets -- -D warnings`
Expected: `Finished` with no warnings. Fix any (e.g. needless clones) before committing.

- [ ] **Step 4: Commit**

```bash
git add crates/amber/src/main.rs
git commit -m "feat(daemon): share Watchers with reap loop; broadcast removed on child death"
```

- [ ] **Step 5: Manual sanity (optional, not a gate).** Build `amber`, start the daemon, connect two `nc -U` clients (or two `amber ls` in a loop is insufficient — use a quick script) and confirm a `create`/`kill` on one surfaces a `SessionsChanged` on the watcher. Skip if the integration test suffices.

---

# SLICE 2 — App scaffold + connection spine

*Proves: the window handshakes with the daemon — a blank window whose utilityProcess connects to the real socket and logs the `Sessions` set.*

## Task 6: electron-vite scaffold

**Files:**
- Create: `app/package.json`, `app/electron.vite.config.ts`, `app/tsconfig.json`, `app/tsconfig.node.json`, `app/vitest.config.ts`, `app/.eslintrc.cjs`, `app/.gitignore`, `app/src/main/index.ts`, `app/src/preload/index.ts`, `app/src/renderer/index.html`, `app/src/renderer/main.tsx`.

**Interfaces:**
- Produces: `npm --prefix app run typecheck`, `npm --prefix app run test`, `npm --prefix app run build` all succeed; `npm --prefix app run dev` opens a blank window (manual).

- [ ] **Step 1: Write `app/package.json`.**

```json
{
  "name": "amber-ide-app",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.node.json",
    "lint": "eslint . --ext .ts,.tsx",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "@typescript-eslint/parser": "^8.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "electron": "^43.0.0",
    "electron-vite": "^5.0.0",
    "eslint": "^9.0.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0",
    "vitest": "^2.0.0"
  },
  "dependencies": {
    "@xterm/addon-fit": "^0.11.0",
    "@xterm/addon-webgl": "^0.19.0",
    "@xterm/xterm": "^6.0.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  }
}
```

- [ ] **Step 2: Write the TypeScript + tooling configs.**

`app/tsconfig.json` (renderer + shared, DOM libs):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/shared", "src/renderer", "src/preload"]
}
```

`app/tsconfig.node.json` (main + client, Node libs):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node", "electron"]
  },
  "include": ["src/main", "src/client", "src/shared"]
}
```

`app/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['src/**/*.test.ts', 'test/**/*.test.ts'], environment: 'node' },
})
```

`app/.eslintrc.cjs`:

```js
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, browser: true, es2022: true },
  ignorePatterns: ['out', 'node_modules', 'dist'],
}
```

`app/.gitignore`:

```
node_modules
out
dist
*.log
```

- [ ] **Step 3: Write `app/electron.vite.config.ts`** — three builds; the utilityProcess script is a second input of the `main` build (electron-vite has no separate utility entry):

```ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          client: resolve('src/client/index.ts'),
        },
      },
    },
  },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    plugins: [react()],
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
  },
})
```

- [ ] **Step 4: Write the minimal main/preload/renderer so a window opens.**

`app/src/main/index.ts`:

```ts
import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
```

`app/src/preload/index.ts`:

```ts
// Bridge lives here in later tasks. Empty for the scaffold.
export {}
```

`app/src/renderer/index.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'" />
    <title>amber-ide</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

`app/src/renderer/main.tsx`:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

function App(): JSX.Element {
  return <h1>amber-ide</h1>
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<StrictMode><App /></StrictMode>)
```

- [ ] **Step 5: Install, typecheck, build, commit.**

```bash
cd app && npm install
npm run typecheck
npm run build
```
Expected: install succeeds; `typecheck` clean; `build` emits `out/main/index.js`, `out/main/client.js`, `out/preload/index.js`, `out/renderer/…`.

```bash
cd .. && git add app && git commit -m "chore(app): electron-vite + TS strict + React scaffold"
```

## Task 7: shared `proto.ts` — the TS wire codec

**Files:**
- Create: `app/src/shared/proto.ts`, `app/src/shared/proto.test.ts`

**Interfaces:**
- Produces:
  - Types: `type ControlMsg = ...` (discriminated union mirroring the Rust externally-tagged JSON), `type Frame = { type: 'control'; msg: ControlMsg } | { type: 'data'; session: string; bytes: Uint8Array }`.
  - `function encode(frame: Frame): Uint8Array`
  - `class Decoder { feed(chunk: Uint8Array): void; next(): Frame | null }`
- Consumed by: `connection.ts` (Task 9), `router.ts` (Task 11), `fakeDaemon.ts` (Task 8).

- [ ] **Step 1: Write the failing test** — `app/src/shared/proto.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { encode, Decoder, type Frame } from './proto'

function roundtrip(f: Frame): Frame {
  const d = new Decoder()
  d.feed(encode(f))
  const out = d.next()
  if (!out) throw new Error('no frame')
  return out
}

describe('proto', () => {
  it('roundtrips a control frame', () => {
    const f: Frame = { type: 'control', msg: { kind: 'WatchSessions' } }
    expect(roundtrip(f)).toEqual(f)
  })

  it('roundtrips a data frame preserving raw bytes', () => {
    const bytes = new Uint8Array([0, 1, 255, 0, 27, 91, 50, 74])
    const f: Frame = { type: 'data', session: 's', bytes }
    const out = roundtrip(f)
    expect(out).toEqual({ type: 'data', session: 's', bytes })
  })

  it('encodes control JSON externally-tagged to match serde', () => {
    // Attach{name} -> {"Attach":{"name":"a"}}; body = [tag=0][json]
    const f: Frame = { type: 'control', msg: { kind: 'Attach', name: 'a' } }
    const wire = encode(f)
    const bodyLen = new DataView(wire.buffer).getUint32(0, false)
    const body = wire.slice(4, 4 + bodyLen)
    expect(body[0]).toBe(0) // TAG_CONTROL
    const json = new TextDecoder().decode(body.slice(1))
    expect(json).toBe('{"Attach":{"name":"a"}}')
  })

  it('parses a Sessions reply', () => {
    const f: Frame = {
      type: 'control',
      msg: { kind: 'Sessions', sessions: [{ name: 'amber-1-1-0-a', cwd: '/tmp', kind: 'shell', alive: true }] },
    }
    expect(roundtrip(f)).toEqual(f)
  })

  it('decodes byte-at-a-time and across chunk splits', () => {
    const f: Frame = { type: 'data', session: 's', bytes: new Uint8Array([10, 13, 0, 255]) }
    const wire = encode(f)
    const d = new Decoder()
    for (const b of wire) {
      expect(d.next()).toBeNull()
      d.feed(new Uint8Array([b]))
    }
    expect(d.next()).toEqual(f)
  })

  it('rejects an oversized length prefix', () => {
    const d = new Decoder()
    const bad = new Uint8Array(5)
    new DataView(bad.buffer).setUint32(0, 64 * 1024 * 1024 + 1, false)
    d.feed(bad)
    expect(() => d.next()).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run src/shared/proto.test.ts`
Expected: FAIL — `./proto` has no exports.

- [ ] **Step 3: Write minimal implementation** — `app/src/shared/proto.ts`:

```ts
// TS port of amber-core::proto. Wire: [u32 BE body_len][u8 tag][body].
// tag 0 = Control (JSON of ControlMsg, serde externally-tagged).
// tag 1 = Data ([u16 BE name_len][name utf8][raw bytes]).

export interface SessionInfo {
  name: string
  cwd: string
  kind: string
  alive: boolean
}

export type ControlMsg =
  | { kind: 'Hello' }
  | { kind: 'ListSessions' }
  | { kind: 'WatchSessions' }
  | { kind: 'ListSessionsDetailed' }
  | { kind: 'Snapshot' }
  | { kind: 'SnapshotOk' }
  | { kind: 'Create'; name: string; cwd: string; sessionKind: string }
  | { kind: 'Attach'; name: string }
  | { kind: 'Detach'; name: string }
  | { kind: 'Kill'; name: string }
  | { kind: 'Resize'; name: string; cols: number; rows: number }
  | { kind: 'SessionList'; names: string[] }
  | { kind: 'Sessions'; sessions: SessionInfo[] }
  | { kind: 'SessionsChanged'; added: SessionInfo[]; removed: string[] }
  | { kind: 'Created'; name: string }
  | { kind: 'Exit'; name: string; code: number }
  | { kind: 'Error'; msg: string }

export type Frame =
  | { type: 'control'; msg: ControlMsg }
  | { type: 'data'; session: string; bytes: Uint8Array }

const TAG_CONTROL = 0
const TAG_DATA = 1
const MAX_FRAME_LEN = 64 * 1024 * 1024

// ControlMsg <-> serde-externally-tagged JSON value.
function msgToJson(m: ControlMsg): unknown {
  switch (m.kind) {
    case 'Hello':
    case 'ListSessions':
    case 'WatchSessions':
    case 'ListSessionsDetailed':
    case 'Snapshot':
    case 'SnapshotOk':
      return m.kind // unit variant -> bare string
    case 'Create':
      return { Create: { name: m.name, cwd: m.cwd, kind: m.sessionKind } }
    case 'Attach':
      return { Attach: { name: m.name } }
    case 'Detach':
      return { Detach: { name: m.name } }
    case 'Kill':
      return { Kill: { name: m.name } }
    case 'Resize':
      return { Resize: { name: m.name, cols: m.cols, rows: m.rows } }
    case 'SessionList':
      return { SessionList: { names: m.names } }
    case 'Sessions':
      return { Sessions: { sessions: m.sessions } }
    case 'SessionsChanged':
      return { SessionsChanged: { added: m.added, removed: m.removed } }
    case 'Created':
      return { Created: { name: m.name } }
    case 'Exit':
      return { Exit: { name: m.name, code: m.code } }
    case 'Error':
      return { Error: { msg: m.msg } }
  }
}

function jsonToMsg(v: unknown): ControlMsg {
  if (typeof v === 'string') {
    if (v === 'Hello' || v === 'ListSessions' || v === 'WatchSessions' ||
        v === 'ListSessionsDetailed' || v === 'Snapshot' || v === 'SnapshotOk') {
      return { kind: v }
    }
    throw new Error(`unknown unit control: ${v}`)
  }
  if (v && typeof v === 'object') {
    const [key, body] = Object.entries(v as Record<string, unknown>)[0] as [string, Record<string, unknown>]
    switch (key) {
      case 'Create': return { kind: 'Create', name: body['name'] as string, cwd: body['cwd'] as string, sessionKind: body['kind'] as string }
      case 'Attach': return { kind: 'Attach', name: body['name'] as string }
      case 'Detach': return { kind: 'Detach', name: body['name'] as string }
      case 'Kill': return { kind: 'Kill', name: body['name'] as string }
      case 'Resize': return { kind: 'Resize', name: body['name'] as string, cols: body['cols'] as number, rows: body['rows'] as number }
      case 'SessionList': return { kind: 'SessionList', names: body['names'] as string[] }
      case 'Sessions': return { kind: 'Sessions', sessions: body['sessions'] as SessionInfo[] }
      case 'SessionsChanged': return { kind: 'SessionsChanged', added: body['added'] as SessionInfo[], removed: body['removed'] as string[] }
      case 'Created': return { kind: 'Created', name: body['name'] as string }
      case 'Exit': return { kind: 'Exit', name: body['name'] as string, code: body['code'] as number }
      case 'Error': return { kind: 'Error', msg: body['msg'] as string }
      default: throw new Error(`unknown control: ${key}`)
    }
  }
  throw new Error('malformed control value')
}

export function encode(frame: Frame): Uint8Array {
  let body: Uint8Array
  if (frame.type === 'control') {
    const json = new TextEncoder().encode(JSON.stringify(msgToJson(frame.msg)))
    body = new Uint8Array(1 + json.length)
    body[0] = TAG_CONTROL
    body.set(json, 1)
  } else {
    const name = new TextEncoder().encode(frame.session)
    body = new Uint8Array(1 + 2 + name.length + frame.bytes.length)
    body[0] = TAG_DATA
    new DataView(body.buffer).setUint16(1, name.length, false)
    body.set(name, 3)
    body.set(frame.bytes, 3 + name.length)
  }
  const out = new Uint8Array(4 + body.length)
  new DataView(out.buffer).setUint32(0, body.length, false)
  out.set(body, 4)
  return out
}

export class Decoder {
  private buf = new Uint8Array(0)

  feed(chunk: Uint8Array): void {
    const next = new Uint8Array(this.buf.length + chunk.length)
    next.set(this.buf, 0)
    next.set(chunk, this.buf.length)
    this.buf = next
  }

  next(): Frame | null {
    if (this.buf.length < 4) return null
    const len = new DataView(this.buf.buffer, this.buf.byteOffset, 4).getUint32(0, false)
    if (len > MAX_FRAME_LEN) throw new Error(`frame length ${len} exceeds max`)
    if (this.buf.length < 4 + len) return null
    const body = this.buf.slice(4, 4 + len)
    this.buf = this.buf.slice(4 + len)
    const tag = body[0]
    if (tag === TAG_CONTROL) {
      const json = new TextDecoder().decode(body.slice(1))
      return { type: 'control', msg: jsonToMsg(JSON.parse(json)) }
    }
    if (tag === TAG_DATA) {
      const nameLen = new DataView(body.buffer, body.byteOffset + 1, 2).getUint16(0, false)
      const session = new TextDecoder().decode(body.slice(3, 3 + nameLen))
      const bytes = body.slice(3 + nameLen)
      return { type: 'data', session, bytes }
    }
    throw new Error(`unknown frame tag ${tag}`)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && npx vitest run src/shared/proto.test.ts`
Expected: PASS (all 6).

- [ ] **Step 5: Commit**

```bash
git add app/src/shared/proto.ts app/src/shared/proto.test.ts
git commit -m "feat(app): TS wire codec byte-compatible with amber-core::proto"
```

## Task 8: socket-path resolution + in-memory fake daemon

**Files:**
- Create: `app/src/shared/socketPath.ts`, `app/src/shared/socketPath.test.ts`, `app/test/fakeDaemon.ts`

**Interfaces:**
- Produces: `function resolveSocketPath(env: NodeJS.ProcessEnv): string`; `class FakeDaemon` with `listen(): Promise<string>` (returns socket path), `close(): Promise<void>`, `push(frame: Frame): void` (send to all clients), `onClient(cb: (send:(f:Frame)=>void)=>void)`, and it decodes inbound frames exposing `received: Frame[]`.
- Consumed by: `daemonBoot.ts` (Task 10), `connection.test.ts` (Task 9).

- [ ] **Step 1: Write the failing test** — `app/src/shared/socketPath.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolveSocketPath } from './socketPath'

describe('resolveSocketPath', () => {
  it('prefers XDG_RUNTIME_DIR', () => {
    expect(resolveSocketPath({ XDG_RUNTIME_DIR: '/run/user/1000' }))
      .toBe('/run/user/1000/amber-ide/amberd.sock')
  })
  it('falls back to XDG_STATE_HOME when runtime dir is empty', () => {
    expect(resolveSocketPath({ XDG_RUNTIME_DIR: '', XDG_STATE_HOME: '/x/state' }))
      .toBe('/x/state/amber-ide/amberd.sock')
  })
  it('falls back to HOME/.local/state when neither set', () => {
    expect(resolveSocketPath({ HOME: '/home/u' }))
      .toBe('/home/u/.local/state/amber-ide/amberd.sock')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run src/shared/socketPath.test.ts`
Expected: FAIL — `./socketPath` missing.

- [ ] **Step 3: Write minimal implementation** — `app/src/shared/socketPath.ts`:

```ts
import { join } from 'node:path'

// Mirror crates/amber/src/main.rs default_socket()/default_root().
export function resolveSocketPath(env: NodeJS.ProcessEnv): string {
  const runtime = env['XDG_RUNTIME_DIR']
  if (runtime && runtime.length > 0) {
    return join(runtime, 'amber-ide', 'amberd.sock')
  }
  const stateHome = env['XDG_STATE_HOME']
  const root = stateHome && stateHome.length > 0
    ? join(stateHome, 'amber-ide')
    : join(env['HOME'] ?? '.', '.local/state/amber-ide')
  return join(root, 'amberd.sock')
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && npx vitest run src/shared/socketPath.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the fake daemon (no test of its own — it is a test fixture, exercised in Task 9).** `app/test/fakeDaemon.ts`:

```ts
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encode, Decoder, type Frame } from '../src/shared/proto'

let counter = 0

// In-memory unix-socket server speaking the real wire protocol. Test fixture
// for the utilityProcess connection/router without a real daemon.
export class FakeDaemon {
  private server = net.createServer()
  private clients = new Set<net.Socket>()
  readonly received: Frame[] = []
  private clientCb: ((send: (f: Frame) => void) => void) | null = null

  onClient(cb: (send: (f: Frame) => void) => void): void {
    this.clientCb = cb
  }

  listen(): Promise<string> {
    counter += 1
    const path = join(tmpdir(), `amber-fake-${process.pid}-${counter}.sock`)
    this.server.on('connection', (sock) => {
      this.clients.add(sock)
      const dec = new Decoder()
      sock.on('data', (chunk) => {
        dec.feed(new Uint8Array(chunk))
        for (let f = dec.next(); f; f = dec.next()) this.received.push(f)
      })
      sock.on('close', () => this.clients.delete(sock))
      sock.on('error', () => this.clients.delete(sock))
      this.clientCb?.((f) => sock.write(encode(f)))
    })
    return new Promise((res) => this.server.listen(path, () => res(path)))
  }

  push(frame: Frame): void {
    for (const c of this.clients) c.write(encode(frame))
  }

  close(): Promise<void> {
    for (const c of this.clients) c.destroy()
    return new Promise((res) => this.server.close(() => res()))
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add app/src/shared/socketPath.ts app/src/shared/socketPath.test.ts app/test/fakeDaemon.ts
git commit -m "feat(app): socket-path resolution + in-memory fake daemon fixture"
```

## Task 9: utilityProcess `connection.ts`

**Files:**
- Create: `app/src/client/connection.ts`, `app/src/client/connection.test.ts`

**Interfaces:**
- Consumes: `net`, `proto.ts` (`encode`, `Decoder`, `Frame`), the fake daemon.
- Produces: `class Connection` with `constructor(path: string)`, `on(event: 'frame', cb: (f: Frame) => void)`, `on(event: 'close', cb: () => void)`, `send(frame: Frame): void`, `connect(): void`, `close(): void`. (Reconnect loop is added in a later slice; this task is connect + frame decode + send.)

- [ ] **Step 1: Write the failing test** — `app/src/client/connection.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { FakeDaemon } from '../../test/fakeDaemon'
import { Connection } from './connection'
import type { Frame } from '../shared/proto'

let daemon: FakeDaemon | null = null
afterEach(async () => { await daemon?.close(); daemon = null })

function waitFor<T>(fn: () => T | null, ms = 2000): Promise<T> {
  return new Promise((res, rej) => {
    const started = Date.now()
    const tick = () => {
      const v = fn()
      if (v != null) return res(v)
      if (Date.now() - started > ms) return rej(new Error('timeout'))
      setTimeout(tick, 10)
    }
    tick()
  })
}

describe('Connection', () => {
  it('receives decoded frames and sends encoded frames', async () => {
    daemon = new FakeDaemon()
    daemon.onClient((send) => {
      send({ type: 'control', msg: { kind: 'Sessions', sessions: [] } })
    })
    const path = await daemon.listen()

    const frames: Frame[] = []
    const conn = new Connection(path)
    conn.on('frame', (f) => frames.push(f))
    conn.connect()

    const first = await waitFor(() => frames[0] ?? null)
    expect(first).toEqual({ type: 'control', msg: { kind: 'Sessions', sessions: [] } })

    conn.send({ type: 'control', msg: { kind: 'WatchSessions' } })
    await waitFor(() => daemon!.received.find((f) => f.type === 'control' && f.msg.kind === 'WatchSessions') ?? null)

    conn.close()
  })

  it('fires close when the daemon goes away', async () => {
    daemon = new FakeDaemon()
    const path = await daemon.listen()
    let closed = false
    const conn = new Connection(path)
    conn.on('close', () => { closed = true })
    conn.connect()
    await new Promise((r) => setTimeout(r, 50))
    await daemon.close()
    await waitFor(() => (closed ? true : null))
    expect(closed).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run src/client/connection.test.ts`
Expected: FAIL — `./connection` missing.

- [ ] **Step 3: Write minimal implementation** — `app/src/client/connection.ts`:

```ts
import net from 'node:net'
import { encode, Decoder, type Frame } from '../shared/proto'

type FrameCb = (f: Frame) => void
type CloseCb = () => void

export class Connection {
  private socket: net.Socket | null = null
  private readonly decoder = new Decoder()
  private frameCbs: FrameCb[] = []
  private closeCbs: CloseCb[] = []

  constructor(private readonly path: string) {}

  on(event: 'frame', cb: FrameCb): void
  on(event: 'close', cb: CloseCb): void
  on(event: 'frame' | 'close', cb: FrameCb | CloseCb): void {
    if (event === 'frame') this.frameCbs.push(cb as FrameCb)
    else this.closeCbs.push(cb as CloseCb)
  }

  connect(): void {
    const socket = net.createConnection({ path: this.path })
    this.socket = socket
    socket.on('data', (chunk: Buffer) => {
      this.decoder.feed(new Uint8Array(chunk))
      for (let f = this.decoder.next(); f; f = this.decoder.next()) {
        for (const cb of this.frameCbs) cb(f)
      }
    })
    socket.on('close', () => { for (const cb of this.closeCbs) cb() })
    socket.on('error', () => { /* 'close' follows */ })
  }

  send(frame: Frame): void {
    this.socket?.write(encode(frame))
  }

  close(): void {
    this.socket?.destroy()
    this.socket = null
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && npx vitest run src/client/connection.test.ts`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add app/src/client/connection.ts app/src/client/connection.test.ts
git commit -m "feat(app): utilityProcess Connection — decode/send frames over the unix socket"
```

## Task 10: daemon-boot decision logic + main wiring

**Files:**
- Create: `app/src/main/daemonBoot.ts`, `app/src/main/daemonBoot.test.ts`
- Modify: `app/src/main/index.ts`, `app/src/client/index.ts` (new utilityProcess entry)

**Interfaces:**
- Produces: `async function probeSocket(path: string, connect = net.connect): Promise<boolean>` (true if a daemon answers); `async function ensureDaemon(path: string, deps): Promise<void>` (probe; if down, run the install command; retry with backoff). `deps = { probe, install, delayMs, attempts }` so the loop is unit-testable without spawning.

- [ ] **Step 1: Write the failing test** — `app/src/main/daemonBoot.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { ensureDaemon } from './daemonBoot'

describe('ensureDaemon', () => {
  it('returns immediately when the daemon already answers', async () => {
    let installs = 0
    await ensureDaemon('/x.sock', {
      probe: async () => true,
      install: async () => { installs += 1 },
      delayMs: () => 0,
      attempts: 5,
    })
    expect(installs).toBe(0)
  })

  it('installs then retries until the daemon answers', async () => {
    let installs = 0
    const answers = [false, false, true]
    let i = 0
    await ensureDaemon('/x.sock', {
      probe: async () => answers[i++] ?? true,
      install: async () => { installs += 1 },
      delayMs: () => 0,
      attempts: 5,
    })
    expect(installs).toBe(1)
  })

  it('throws after exhausting attempts', async () => {
    await expect(ensureDaemon('/x.sock', {
      probe: async () => false,
      install: async () => {},
      delayMs: () => 0,
      attempts: 3,
    })).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run src/main/daemonBoot.test.ts`
Expected: FAIL — `./daemonBoot` missing.

- [ ] **Step 3: Write minimal implementation** — `app/src/main/daemonBoot.ts`:

```ts
import net from 'node:net'

export function probeSocket(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ path })
    sock.on('connect', () => { sock.destroy(); resolve(true) })
    sock.on('error', () => resolve(false))
  })
}

export interface EnsureDeps {
  probe: (path: string) => Promise<boolean>
  install: () => Promise<void>
  delayMs: (attempt: number) => number
  attempts: number
}

export async function ensureDaemon(path: string, deps: EnsureDeps): Promise<void> {
  if (await deps.probe(path)) return
  await deps.install()
  for (let attempt = 0; attempt < deps.attempts; attempt++) {
    await new Promise((r) => setTimeout(r, deps.delayMs(attempt)))
    if (await deps.probe(path)) return
  }
  throw new Error(`amber daemon did not come up at ${path}`)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && npx vitest run src/main/daemonBoot.test.ts`
Expected: PASS (all 3).

- [ ] **Step 5: Wire it into main + create the utilityProcess entry (manual smoke, not unit-tested).**

`app/src/client/index.ts` (utilityProcess entry — receives a control MessagePort from main, opens the connection, forwards `Sessions`/`SessionsChanged` back to main for now):

```ts
import { resolveSocketPath } from '../shared/socketPath'
import { Connection } from './connection'
import type { Frame } from '../shared/proto'

// The utility process receives one control MessagePortMain from main.
process.parentPort.on('message', (event) => {
  const [controlPort] = event.ports
  if (!controlPort) return
  controlPort.start()

  const conn = new Connection(resolveSocketPath(process.env))
  conn.on('frame', (f: Frame) => {
    if (f.type === 'control') controlPort.postMessage({ frame: f })
  })
  conn.on('close', () => controlPort.postMessage({ closed: true }))
  conn.connect()
  conn.send({ type: 'control', msg: { kind: 'WatchSessions' } })
  conn.send({ type: 'control', msg: { kind: 'ListSessionsDetailed' } })
})
```

Update `app/src/main/index.ts` to ensure the daemon, fork the utility, and open a control channel:

```ts
import { app, BrowserWindow, utilityProcess, MessageChannelMain } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { resolveSocketPath } from '../shared/socketPath'
import { ensureDaemon, probeSocket } from './daemonBoot'
import clientPath from '../client/index?modulePath'

const __dirname = dirname(fileURLToPath(import.meta.url))

function amberBinary(): string {
  // Dev: rely on PATH. Packaging (slice 7) swaps this for the bundled binary.
  return process.env['AMBER_BIN'] ?? 'amber'
}

async function installDaemon(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const p = spawn(amberBinary(), ['ctl', 'install'], { stdio: 'ignore' })
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ctl install exit ${code}`))))
    p.on('error', reject)
  })
}

async function main(): Promise<void> {
  const socket = resolveSocketPath(process.env)
  await ensureDaemon(socket, {
    probe: probeSocket,
    install: installDaemon,
    delayMs: (a) => Math.min(2000, 100 * 2 ** a),
    attempts: 8,
  })

  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  if (process.env['ELECTRON_RENDERER_URL']) await win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else await win.loadFile(join(__dirname, '../renderer/index.html'))

  const child = utilityProcess.fork(clientPath)
  const { port1, port2 } = new MessageChannelMain()
  child.postMessage({ kind: 'control' }, [port2])
  // Forward daemon control events to the renderer for logging (slice 2 proof).
  port1.on('message', (e) => win.webContents.send('daemon-event', e.data))
  port1.start()
}

app.whenReady().then(main).catch((e) => {
  console.error(e)
  app.quit()
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
```

Add a tiny preload log bridge in `app/src/preload/index.ts`:

```ts
import { ipcRenderer, contextBridge } from 'electron'

contextBridge.exposeInMainWorld('amber', {
  onDaemonEvent: (cb: (data: unknown) => void) =>
    ipcRenderer.on('daemon-event', (_e, data) => cb(data)),
})
```

And log in `app/src/renderer/main.tsx` (replace the App body):

```tsx
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

declare global {
  interface Window { amber: { onDaemonEvent: (cb: (d: unknown) => void) => void } }
}

function App(): JSX.Element {
  const [events, setEvents] = useState<string[]>([])
  useEffect(() => {
    window.amber.onDaemonEvent((d) => setEvents((prev) => [...prev, JSON.stringify(d)]))
  }, [])
  return (
    <div>
      <h1>amber-ide</h1>
      <pre>{events.join('\n')}</pre>
    </div>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<StrictMode><App /></StrictMode>)
```

- [ ] **Step 6: Typecheck, build, manual smoke.**

Run: `cd app && npm run typecheck && npm run build`
Expected: clean.

Manual: ensure a daemon is running (`amber daemon` in another terminal, or let self-heal run if `amber` is installed), then `npm run dev`. The window should print a `{ frame: { type: 'control', msg: { kind: 'Sessions', … } } }` line. If sessions exist, they appear. This proves the window↔daemon handshake.

- [ ] **Step 7: Commit**

```bash
cd .. && git add app && git commit -m "feat(app): self-healing daemon boot + utilityProcess handshake logs Sessions"
```

---

# SLICE 3 — One live pane (walking skeleton)

*Proves: the risky data-plane spine — attach one existing session, stream raw bytes into xterm.js+WebGL both ways, resize.*

## Task 11: `router.ts` — demux/mux by session name

**Files:**
- Create: `app/src/client/router.ts`, `app/src/client/router.test.ts`

**Interfaces:**
- Consumes: `Connection` (Task 9), `Frame`, Electron `MessagePortMain` (typed structurally in the test as a minimal port).
- Produces: `class Router` with `constructor(conn: { send: (f: Frame) => void; on: (e: 'frame', cb: (f: Frame) => void) => void })`, `attach(session: string, port: PortLike): void` (sends `Attach`, routes that session's `Data` frames to `port`, forwards the port's outbound `{data}`/`{resize}` messages as frames), `detach(session: string): void`. `PortLike = { postMessage(m: unknown): void; on(e: 'message', cb: (e: { data: unknown }) => void): void; start(): void }`.

- [ ] **Step 1: Write the failing test** — `app/src/client/router.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Router, type PortLike } from './router'
import type { Frame } from '../shared/proto'

class FakeConn {
  sent: Frame[] = []
  private cb: ((f: Frame) => void) | null = null
  send(f: Frame): void { this.sent.push(f) }
  on(_e: 'frame', cb: (f: Frame) => void): void { this.cb = cb }
  emit(f: Frame): void { this.cb?.(f) }
}

class FakePort implements PortLike {
  posted: unknown[] = []
  private cb: ((e: { data: unknown }) => void) | null = null
  postMessage(m: unknown): void { this.posted.push(m) }
  on(_e: 'message', cb: (e: { data: unknown }) => void): void { this.cb = cb }
  start(): void {}
  fromRenderer(data: unknown): void { this.cb?.({ data }) }
}

describe('Router', () => {
  it('sends Attach and routes that session\'s data to its port only', () => {
    const conn = new FakeConn()
    const router = new Router(conn)
    const portA = new FakePort()
    const portB = new FakePort()
    router.attach('sA', portA)
    router.attach('sB', portB)

    expect(conn.sent.filter((f) => f.type === 'control' && f.msg.kind === 'Attach')).toHaveLength(2)

    conn.emit({ type: 'data', session: 'sA', bytes: new Uint8Array([1, 2, 3]) })
    expect(portA.posted).toEqual([{ data: new Uint8Array([1, 2, 3]) }])
    expect(portB.posted).toEqual([])
  })

  it('forwards renderer keystrokes and resize as frames', () => {
    const conn = new FakeConn()
    const router = new Router(conn)
    const port = new FakePort()
    router.attach('s', port)
    conn.sent.length = 0

    port.fromRenderer({ data: new Uint8Array([97, 98]) })
    port.fromRenderer({ resize: { cols: 100, rows: 40 } })

    expect(conn.sent).toEqual([
      { type: 'data', session: 's', bytes: new Uint8Array([97, 98]) },
      { type: 'control', msg: { kind: 'Resize', name: 's', cols: 100, rows: 40 } },
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run src/client/router.test.ts`
Expected: FAIL — `./router` missing.

- [ ] **Step 3: Write minimal implementation** — `app/src/client/router.ts`:

```ts
import type { Frame } from '../shared/proto'

export interface PortLike {
  postMessage(m: unknown): void
  on(e: 'message', cb: (e: { data: unknown }) => void): void
  start(): void
}

interface ConnLike {
  send(f: Frame): void
  on(e: 'frame', cb: (f: Frame) => void): void
}

// Renderer -> utility messages over a pane port.
type Outbound = { data: Uint8Array } | { resize: { cols: number; rows: number } }

export class Router {
  private readonly ports = new Map<string, PortLike>()

  constructor(private readonly conn: ConnLike) {
    this.conn.on('frame', (f) => {
      if (f.type === 'data') {
        this.ports.get(f.session)?.postMessage({ data: f.bytes })
      }
    })
  }

  attach(session: string, port: PortLike): void {
    this.ports.set(session, port)
    port.on('message', (e) => {
      const msg = e.data as Outbound
      if ('data' in msg) {
        this.conn.send({ type: 'data', session, bytes: msg.data })
      } else if ('resize' in msg) {
        this.conn.send({ type: 'control', msg: { kind: 'Resize', name: session, cols: msg.resize.cols, rows: msg.resize.rows } })
      }
    })
    port.start()
    this.conn.send({ type: 'control', msg: { kind: 'Attach', name: session } })
  }

  detach(session: string): void {
    this.ports.delete(session)
    this.conn.send({ type: 'control', msg: { kind: 'Detach', name: session } })
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && npx vitest run src/client/router.test.ts`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add app/src/client/router.ts app/src/client/router.test.ts
git commit -m "feat(app): Router demuxes pty data by session, muxes input/resize"
```

## Task 12: wire per-pane MessagePort through preload into the renderer

**Files:**
- Modify: `app/src/client/index.ts`, `app/src/main/index.ts`, `app/src/preload/index.ts`

**Interfaces:**
- Produces: main mints a `MessageChannelMain` per pane; `port2` → utility (tagged `{ kind: 'pane', session }`), `port1` → renderer via `webContents.postMessage('pane-port', { session }, [port1])`. Preload catches `'pane-port'` and re-dispatches the live `MessagePort` into the page with `window.postMessage`. Utility's `parentPort` handler routes a pane port into the `Router`.

- [ ] **Step 1: Extend the utility entry to own a `Router` and accept pane ports.** Replace `app/src/client/index.ts`:

```ts
import { resolveSocketPath } from '../shared/socketPath'
import { Connection } from './connection'
import { Router, type PortLike } from './router'
import type { Frame } from '../shared/proto'

const conn = new Connection(resolveSocketPath(process.env))
const router = new Router(conn)
let controlPort: Electron.MessagePortMain | null = null

conn.on('frame', (f: Frame) => {
  if (f.type === 'control') controlPort?.postMessage({ frame: f })
})
conn.on('close', () => controlPort?.postMessage({ closed: true }))

process.parentPort.on('message', (event) => {
  const msg = event.data as { kind: 'control' } | { kind: 'pane'; session: string }
  const [port] = event.ports
  if (!port) return
  if (msg.kind === 'control') {
    controlPort = port
    port.start()
    conn.connect()
    conn.send({ type: 'control', msg: { kind: 'WatchSessions' } })
    conn.send({ type: 'control', msg: { kind: 'ListSessionsDetailed' } })
  } else {
    // MessagePortMain matches PortLike structurally (postMessage/on/start).
    router.attach(msg.session, port as unknown as PortLike)
  }
})
```

- [ ] **Step 2: Add a main-process helper to open a pane port and expose it to the renderer.** In `app/src/main/index.ts`, after the control channel setup in `main()`, add an IPC handler so the renderer can request a pane. Add near the top imports: `import { ipcMain } from 'electron'`. Then inside `main()` after `port1.start()`:

```ts
  ipcMain.on('open-pane', (_e, session: string) => {
    const { port1: rPort, port2: uPort } = new MessageChannelMain()
    child.postMessage({ kind: 'pane', session }, [uPort])
    win.webContents.postMessage('pane-port', { session }, [rPort])
  })
```

- [ ] **Step 3: Bridge the pane port through preload.** Replace `app/src/preload/index.ts`:

```ts
import { ipcRenderer, contextBridge } from 'electron'

contextBridge.exposeInMainWorld('amber', {
  onDaemonEvent: (cb: (data: unknown) => void) =>
    ipcRenderer.on('daemon-event', (_e, data) => cb(data)),
  openPane: (session: string) => ipcRenderer.send('open-pane', session),
})

// A transferred MessagePort cannot cross contextBridge; re-dispatch the live
// port into the page's main world, tagged with its session.
ipcRenderer.on('pane-port', (e, meta: { session: string }) => {
  const port = e.ports[0]
  window.postMessage({ amberPanePort: true, session: meta.session }, '*', [port])
})
```

- [ ] **Step 4: Typecheck + build (no automated test — this is Electron glue, covered by the manual smoke in Task 13).**

Run: `cd app && npm run typecheck && npm run build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
cd .. && git add app && git commit -m "feat(app): per-pane MessagePort brokered main->preload->renderer and main->utility"
```

## Task 13: `Pane.tsx` — xterm wired to a pane port

**Files:**
- Create: `app/src/renderer/Pane.tsx`
- Modify: `app/src/renderer/main.tsx` (mount one pane for the first session)

**Interfaces:**
- Consumes: the `window.postMessage` pane-port bridge; `@xterm/xterm`, `@xterm/addon-webgl`, `@xterm/addon-fit`.
- Produces: `<Pane session={string} />` — receives its `MessagePort`, opens an xterm+WebGL, writes inbound bytes, sends keystrokes + resize outbound.

- [ ] **Step 1: Write `app/src/renderer/Pane.tsx`.**

```tsx
import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'

// Wait for the preload bridge to hand us this session's MessagePort.
function awaitPort(session: string): Promise<MessagePort> {
  return new Promise((resolve) => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { amberPanePort?: boolean; session?: string }
      if (d?.amberPanePort && d.session === session && e.ports[0]) {
        window.removeEventListener('message', onMsg)
        resolve(e.ports[0])
      }
    }
    window.addEventListener('message', onMsg)
  })
}

export function Pane({ session }: { session: string }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({ convertEol: false, fontFamily: 'monospace', fontSize: 13 })
    const fit = new FitAddon()
    term.open(host)
    term.loadAddon(fit)
    const webgl = new WebglAddon()
    webgl.onContextLoss(() => webgl.dispose())
    term.loadAddon(webgl)
    fit.fit()

    let port: MessagePort | null = null
    let disposed = false

    void awaitPort(session).then((p) => {
      if (disposed) { p.close(); return }
      port = p
      p.onmessage = (e) => {
        const d = e.data as { data?: Uint8Array }
        if (d.data) term.write(d.data) // xterm.write accepts Uint8Array (UTF-8)
      }
      p.start()
      term.onData((s) => p.postMessage({ data: new TextEncoder().encode(s) }))
      const sendResize = () => { fit.fit(); p!.postMessage({ resize: { cols: term.cols, rows: term.rows } }) }
      sendResize()
      window.addEventListener('resize', sendResize)
    })

    window.amber.openPane(session)

    return () => {
      disposed = true
      port?.close()
      term.dispose()
    }
  }, [session])

  return <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
}
```

- [ ] **Step 2: Mount one pane for the first live session in `app/src/renderer/main.tsx`.** Replace the file:

```tsx
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Pane } from './Pane'

declare global {
  interface Window {
    amber: {
      onDaemonEvent: (cb: (d: unknown) => void) => void
      openPane: (session: string) => void
    }
  }
}

interface Frame { type: string; msg?: { kind: string; sessions?: { name: string }[] } }

function App(): JSX.Element {
  const [session, setSession] = useState<string | null>(null)
  useEffect(() => {
    window.amber.onDaemonEvent((d) => {
      const evt = d as { frame?: Frame }
      const f = evt.frame
      if (f?.type === 'control' && f.msg?.kind === 'Sessions') {
        const first = f.msg.sessions?.[0]
        if (first) setSession(first.name)
      }
    })
  }, [])
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      {session ? <Pane session={session} /> : <p>waiting for a session… (create one: <code>amber create amber-1-1-0-a --kind shell</code>)</p>}
    </div>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<StrictMode><App /></StrictMode>)
```

- [ ] **Step 3: Typecheck + build.**

Run: `cd app && npm run typecheck && npm run build`
Expected: clean.

- [ ] **Step 4: Manual smoke — the walking-skeleton proof.**

1. Start a daemon: `AMBER_STATE_DIR unset; amber daemon &` (or rely on installed daemon).
2. Create a shell session: `amber create amber-1-1-0-a --cwd "$HOME" --kind shell`.
3. `cd app && npm run dev`.
4. The window mounts a pane; type `ls` + Enter → output renders. Resize the window → the shell reflows (run `tput cols` to confirm the pty size changed).
5. Kill the daemon, confirm the pane freezes (reconnect is slice-4 work); restart daemon + app → the pane repaints from replayed scrollback on attach.

Expected: keystrokes reach the shell and output renders through WebGL. This proves the end-to-end data plane.

- [ ] **Step 5: Commit**

```bash
cd .. && git add app && git commit -m "feat(app): live pane — xterm+webgl streams pty bytes both ways over a MessagePort"
```

---

## Definition of done (slices 1–3)

- Rust: `cargo test --workspace` + `cargo clippy --workspace --all-targets -- -D warnings` clean; the `watch` integration test proves watcher deltas.
- App: `npm run test` (proto, socketPath, connection, daemonBoot, router) green; `npm run typecheck` + `npm run build` clean.
- Manual: the window renders a live shell pane over the real daemon, bytes both ways, resize honored.
- **Not yet built (slices 4–7, separate plan):** reducer + multi-pane tabs, split tree + geometry sidecar, workspaces + claude panes + reconnect banner, packaging. Slice 3 having de-risked the electron-vite/utilityProcess/MessagePort/xterm stack, those slices get planned next.
