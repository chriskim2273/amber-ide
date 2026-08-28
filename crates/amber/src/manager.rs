//! Session table + save/restore. Owns the live [`PtySession`]s and mediates
//! between them and the [`StateStore`]. This is the piece that replaces
//! tmux-resurrect (restore) and tmux-continuum (snapshot).

use std::collections::{BTreeSet, HashMap, HashSet};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use amber_core::proto::{ControlMsg, RecoveryEvent, SearchResult, SessionInfo};
use amber_core::state::{Config, SessionKind, SessionMeta, StateStore};
use portable_pty::CommandBuilder;

use crate::cgroup::{CgroupManager, CgroupRole};
use crate::memory_guardian::{Candidate, HostPressureCandidate, RECENT_USE_MS};
use crate::pty::{PtySession, SuspendOrigin};
use crate::watchers::Watchers;

const DEFAULT_ROWS: u16 = 24;
const DEFAULT_COLS: u16 = 80;
const CHILD_EXIT_TIMEOUT: Duration = Duration::from_secs(5);

/// `current_exe()` returns a `<path> (deleted)`-suffixed string, forever, once
/// this process's own backing binary inode is unlinked (e.g. an in-place
/// `cp`/`mv` reinstall while the daemon stayed up) — the kernel bakes that
/// suffix into `/proc/self/exe`'s target text. That literal string doesn't
/// exist on the filesystem, so every subsequent claude/grok spawn using it
/// fails permanently for this process's lifetime, even after the reinstall
/// finishes and a valid binary sits at the original path again. If the exe
/// itself is gone but the plain path (suffix stripped) is a real file, use
/// that instead of the poisoned reading.
pub fn resolve_current_exe() -> anyhow::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    if exe.exists() {
        return Ok(exe);
    }
    Ok(repair_deleted_exe(&exe).unwrap_or(exe))
}

/// If `path` carries the kernel's `" (deleted)"` suffix and the underlying
/// path (suffix stripped) exists on disk, return it. Pure/testable half of
/// [`resolve_current_exe`].
fn repair_deleted_exe(path: &Path) -> Option<PathBuf> {
    let repaired = PathBuf::from(path.to_str()?.strip_suffix(" (deleted)")?);
    repaired.exists().then_some(repaired)
}

/// The user's login-shell PATH, captured ONCE per process (it doesn't change).
/// Computing it per-manager would spawn a login shell on every `new()`, which
/// under the parallel test run overloads fork/exec.
fn login_path() -> Option<&'static String> {
    static LOGIN_PATH: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    LOGIN_PATH.get_or_init(capture_login_path).as_ref()
}

/// Capture the user's login-shell PATH so spawned panes resolve tools (nvm/node,
/// ~/.local/bin, …) that the daemon's minimal systemd PATH lacks — otherwise a
/// pane's programs and claude's own hooks (which run `node`) fail.
fn capture_login_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let out = std::process::Command::new(&shell)
        .arg("-lic")
        .arg("printf %s \"$PATH\"")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

/// Graphical-session env for spawned panes, read FRESH from the systemd user
/// manager on every spawn (Linux only).
///
/// The daemon is boot-started, BEFORE the graphical session imports `DISPLAY`
/// into the user manager, so the daemon's own env has none — and a pane
/// inherits the daemon's env. Anything in a pane that talks to the display
/// server therefore fails; the one that bites is `claude`'s image paste, which
/// shells out to `xclip`/`wl-paste` (`Can't open display`, stderr swallowed by
/// its own `2>/dev/null`), so Ctrl-V silently pastes nothing. Same class as
/// `login_path()` above: the daemon's minimal systemd env is not the env a
/// pane needs.
///
/// Read per spawn and deliberately NOT cached: at boot restore the manager env
/// is still empty, and a cache would freeze that for the daemon's whole life.
/// This way a pane created after login gets the live values, and an X restart
/// self-heals for panes created after it. No systemd / non-zero exit / missing
/// key degrades to exactly today's behaviour (nothing is set — never an empty
/// `DISPLAY=`, which fails differently and worse than absent).
#[cfg(target_os = "linux")]
fn display_env() -> Vec<(String, String)> {
    const KEYS: [&str; 3] = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"];
    let out = std::process::Command::new("systemctl")
        .args(["--user", "show-environment"])
        .output();
    match out {
        Ok(out) if out.status.success() => pick_env(&String::from_utf8_lossy(&out.stdout), &KEYS),
        _ => Vec::new(),
    }
}

/// Pull an allowlist of `KEY=VALUE` lines out of an environment block. systemd
/// quotes a value that needs it, so surrounding quotes are stripped; an empty
/// value is dropped rather than exported blank.
#[cfg(target_os = "linux")]
fn pick_env(block: &str, keys: &[&str]) -> Vec<(String, String)> {
    block
        .lines()
        .filter_map(|line| line.split_once('='))
        .filter(|(k, _)| keys.contains(k))
        .filter_map(|(k, v)| {
            let v = v.trim().trim_matches('"');
            (!v.is_empty()).then(|| (k.to_string(), v.to_string()))
        })
        .collect()
}

pub struct SessionManager {
    store: StateStore,
    cfg: Config,
    root: PathBuf,
    sessions: Mutex<HashMap<String, Arc<PtySession>>>,
    /// Stable slot of the terminal most recently focused or written to. Zero
    /// means no foreground session yet; slots make rename unable to drop this
    /// protection by changing only the session name.
    foreground_slot: AtomicU32,
    /// Serializes each O(session-count) CPU-weight pass. Foreground changes
    /// happen before taking this lock; the pass reads the latest slot only
    /// after acquiring it, so the last queued pass always repairs the whole
    /// tree to one coherent generation.
    cpu_reconciliation: Mutex<()>,
    /// Test-only observation point around the real cgroup reconciliation. It
    /// lets concurrency tests control interleaving without replacing the
    /// filesystem behavior under test.
    #[cfg(test)]
    cpu_reconcile_hook: Mutex<Option<CpuReconcileHook>>,
    /// The guardian's LIVE aggregate budget in KiB (0 = none). An
    /// `Arc<AtomicU64>` so `SetMemoryBudget` can move it while the guardian
    /// thread reads it every tick — a budget change takes effect without a
    /// daemon restart. Seeded from config at startup by `run_daemon`.
    budget_kb: Arc<AtomicU64>,
    /// Effective metadata that could not yet be persisted because a retained
    /// rename journal still validates the pre-repair bytes. The weak identity
    /// prevents a later session reusing the same name from inheriting it.
    deferred_meta: Mutex<HashMap<String, LiveMetaOverride>>,
    /// The daemon socket path, passed to each claude session's `amber run`
    /// supervisor (via `AMBER_SOCK`) so it can report its supervision phase
    /// back (`ReportRunState`). `None` in tests / hand-started managers — the
    /// supervisor then reconstructs the default socket from its state root.
    socket: Option<PathBuf>,
    /// Watcher registry, so each spawned session can broadcast rate-limited
    /// output `Activity` to watchers. `None` in tests / hand-started managers —
    /// no activity notifications are wired then (harmless; the app is absent).
    watchers: Option<Arc<Watchers>>,
    /// Per-shell-session count of CONSECUTIVE periodic snapshots that saw no
    /// hand-started claude, for the `resume_as_claude` downgrade hysteresis. A
    /// single transient miss (Claude Code briefly rotating its process) must not
    /// drop a live claude pane back to a bare shell on the next restart; only a
    /// sustained absence downgrades. See `decide_resume`.
    claude_absent: Mutex<HashMap<String, u32>>,
    /// Per-session ring write-counter as of the last scrollback we successfully
    /// persisted. A session whose counter is unchanged has an unchanged
    /// scrollback, so the next snapshot skips it entirely — no 2 MiB clone, no
    /// atomic file rewrite. Measured before this: 18 full rings meant 36 MiB
    /// cloned AND 36 MiB written every 10 s, almost all of it identical bytes.
    /// Pruned alongside `claude_absent` so a removed session leaves nothing.
    persisted_scrollback: Mutex<HashMap<String, u64>>,
    cgroups: CgroupManager,
    #[cfg(test)]
    test_shell: Option<OsString>,
    /// Serialises snapshot against the operations that MOVE a session's stored
    /// artifacts (remove/rename). The snapshot deliberately writes to disk with
    /// `sessions` released — holding it there is what froze typing — so without
    /// this a snapshot could write `scrollback/<name>.bin` for a session that
    /// was removed or renamed a moment earlier, resurrecting a file nothing
    /// will ever clean up. Taken OUTERMOST (before `sessions`), and never on
    /// the `write()`/`resize()` path, so keystrokes still never wait on a
    /// snapshot.
    maintenance: Mutex<()>,
}

struct LiveMetaOverride {
    session: Weak<PtySession>,
    meta: SessionMeta,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResumeCause {
    Manual,
    Focus,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AutomaticSuspendRecency {
    /// The existing aggregate-memory guardian protects recent output too.
    Memory,
    /// Host PSI policy protects only direct focus and terminal input.
    Host,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CpuReconcilePoint {
    Start,
    Finish,
}

#[cfg(test)]
type CpuReconcileHook = Arc<dyn Fn(CpuReconcilePoint, u32) + Send + Sync>;

/// Consecutive absent periodic snapshots before `resume_as_claude` downgrades
/// true→false. At the default ~10 s snapshot cadence this is ~20 s of a shell
/// with no claude before it stops being restored as claude.
const CLAUDE_ABSENT_THRESHOLD: u32 = 2;

/// The memory-budget truth as one struct — the body of `BudgetApplied` and
/// what `amber ctl budget` prints. All KiB fields are 0/None when the
/// corresponding limit does not exist.
pub struct BudgetStatus {
    /// Configured budget in MiB; `None` = auto (half of physical, capped).
    pub configured_mb: Option<u64>,
    /// What the guardian actually uses right now.
    pub effective_budget_kb: Option<u64>,
    /// The live lowest finite ancestor cap on the daemon's cgroup.
    pub cgroup_limit_kb: Option<u64>,
    /// Each session leaf's soft ceiling (`memory.high`).
    pub session_high_kb: u64,
    /// Total physical RAM, when the platform reports it.
    pub physical_kb: Option<u64>,
    /// Whether automatic parking acts on pressure at all.
    pub enabled: bool,
}

/// Decide a shell session's `resume_as_claude` on a PERIODIC snapshot, with
/// downgrade hysteresis. Upgrades immediately when claude is detected; downgrades
/// true→false only after `threshold` CONSECUTIVE absences, so one transient miss
/// (Claude Code briefly between processes) can't drop a live pane. Returns
/// (new_flag, new_absent_streak). Pure.
fn decide_resume(current: bool, detected: bool, streak: u32, threshold: u32) -> (bool, u32) {
    if detected {
        (true, 0)
    } else if !current {
        (false, 0)
    } else {
        let next = streak + 1;
        if next >= threshold {
            (false, 0)
        } else {
            (true, next)
        }
    }
}

/// The lowest-free session slot: the smallest integer `>= 1` not in `used`
/// (spec §3.2). Pure. Numbers stay small and a freed one may be reused by a
/// LATER create — deliberately not a forever-unique id, which would grow
/// without bound for a long-lived daemon.
fn alloc_slot(used: &BTreeSet<u32>) -> u32 {
    (1..)
        .find(|n| !used.contains(n))
        .expect("session slots exhausted")
}

fn require_cgroup_aggregate(current_kb: Option<u64>) -> anyhow::Result<u64> {
    current_kb.ok_or_else(|| {
        anyhow::anyhow!("cgroup containment is enabled but aggregate memory.current is unavailable")
    })
}

impl SessionManager {
    /// Open a manager rooted at `root`, loading config (defaults if absent).
    pub fn new(root: impl Into<PathBuf>) -> anyhow::Result<Self> {
        let root = root.into();
        let cfg = StateStore::new(&root).load_config()?;
        Self::new_with_cgroups(root, cfg, CgroupManager::disabled())
    }

    pub fn new_with_cgroups(
        root: impl Into<PathBuf>,
        cfg: Config,
        cgroups: CgroupManager,
    ) -> anyhow::Result<Self> {
        let root = root.into();
        Ok(SessionManager {
            store: StateStore::new(&root),
            cfg,
            root,
            sessions: Mutex::new(HashMap::new()),
            foreground_slot: AtomicU32::new(0),
            cpu_reconciliation: Mutex::new(()),
            #[cfg(test)]
            cpu_reconcile_hook: Mutex::new(None),
            budget_kb: Arc::new(AtomicU64::new(0)),
            deferred_meta: Mutex::new(HashMap::new()),
            socket: None,
            watchers: None,
            claude_absent: Mutex::new(HashMap::new()),
            persisted_scrollback: Mutex::new(HashMap::new()),
            cgroups,
            #[cfg(test)]
            test_shell: None,
            maintenance: Mutex::new(()),
        })
    }

    /// Wire the watcher registry so spawned sessions emit rate-limited output
    /// `Activity` to watchers. Builder-style so existing callers/tests that
    /// don't care keep using `new`.
    pub fn with_watchers(mut self, watchers: Arc<Watchers>) -> Self {
        self.watchers = Some(watchers);
        self
    }

    /// Record the daemon socket path so claude supervisors learn where to send
    /// their `ReportRunState` updates (`AMBER_SOCK`). Builder-style so existing
    /// callers/tests that don't care keep using `new`.
    pub fn with_socket(mut self, socket: impl Into<PathBuf>) -> Self {
        self.socket = Some(socket.into());
        self
    }

    #[cfg(test)]
    fn with_test_shell(mut self, shell: impl Into<OsString>) -> Self {
        self.test_shell = Some(shell.into());
        self
    }

    /// The state directory this manager (and its spawned supervisors) is
    /// rooted at.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Configured snapshot cadence in seconds (daemon's periodic-flush timer).
    pub fn snapshot_interval_secs(&self) -> u64 {
        self.cfg.snapshot_interval_secs
    }

    /// Session names become persisted filenames, so use the portable platform
    /// grammar even when this daemon happens to run on Unix.
    fn validate_name(name: &str) -> anyhow::Result<()> {
        crate::platform::validate_session_name(name)
    }

    fn now() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }

    /// Best-effort lifecycle journal append. Once an authoritative session
    /// mutation has succeeded, a diagnostic-file failure must never turn that
    /// success into an API failure or trigger a destructive rollback.
    pub fn record_recovery_event(
        &self,
        level: &str,
        event: &str,
        session: Option<&str>,
        detail: impl Into<String>,
        code: Option<i32>,
    ) {
        let record = RecoveryEvent {
            at: Self::now(),
            sequence: 0,
            level: level.to_string(),
            event: event.to_string(),
            session: session.map(str::to_string),
            detail: detail.into(),
            code,
        };
        if let Err(error) = self.store.append_recovery_event(record) {
            eprintln!("amber daemon: could not append recovery event: {error}");
        }
    }

    pub fn recovery_events(&self, limit: u16) -> anyhow::Result<Vec<RecoveryEvent>> {
        self.store.list_recovery_events(limit)
    }

    pub fn clear_recovery_events(&self) -> anyhow::Result<()> {
        self.store.clear_recovery_events()
    }

    /// Resolve a session cwd to a STABLE absolute directory. A relative cwd
    /// (e.g. `.`) would resolve against whatever dir the daemon happened to be
    /// launched from — which differs between a hand-started daemon and the
    /// systemd unit — so `claude --resume <id>` (conversations are scoped by
    /// project cwd) breaks after a reboot. Relative or missing dirs fall back
    /// to `$HOME` (also the constitution's "dir no longer exists" rule).
    fn resolve_cwd(cwd: &Path) -> PathBuf {
        if cwd.is_absolute() && cwd.is_dir() {
            cwd.to_path_buf()
        } else {
            std::env::var("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|_| PathBuf::from("/"))
        }
    }

    /// The command a session of `kind` runs. `Shell` spawns the user's shell
    /// directly; `Claude` spawns this same binary as `amber run <name>`,
    /// which supervises the real `claude --resume/--continue` process (and
    /// falls back to a shell) inside the pty (spec §6.2).
    fn command_for(
        &self,
        kind: SessionKind,
        name: &str,
        cwd: &Path,
        slot: u32,
        start_suspended: bool,
    ) -> anyhow::Result<CommandBuilder> {
        let (program, args, role): (OsString, Vec<OsString>, CgroupRole) = match kind {
            SessionKind::Shell => {
                #[cfg(test)]
                let shell = self.test_shell.clone().unwrap_or_else(|| {
                    std::env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into())
                });
                #[cfg(not(test))]
                let shell = std::env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into());
                (shell, Vec::new(), CgroupRole::Workload)
            }
            // All agents run the SAME `amber run <name>` supervisor; it reads
            // the kind from argv to decide which binary to launch and how.
            SessionKind::Claude
            | SessionKind::Grok
            | SessionKind::Codex
            | SessionKind::OpenCode
            | SessionKind::Hermes
            | SessionKind::Pi => {
                let exe = resolve_current_exe()?;
                // The kind is passed EXPLICITLY, not looked up from the store:
                // `create` spawns the pty before it persists the metadata (the
                // slot is allocated under the sessions lock, which the spawn
                // must stay outside of), so a supervisor that read the store
                // would race it and fall back to the wrong agent.
                let args = vec![
                    "run".into(),
                    name.into(),
                    "--kind".into(),
                    kind.as_str().into(),
                    "--slot".into(),
                    slot.to_string().into(),
                ];
                (exe.into_os_string(), args, CgroupRole::Supervisor)
            }
        };
        let mut cmd = if self.cgroups.is_enabled() {
            let mut wrapped = CommandBuilder::new(resolve_current_exe()?);
            wrapped.arg("__cgroup-exec");
            wrapped.arg("--slot");
            wrapped.arg(slot.to_string());
            wrapped.arg("--role");
            wrapped.arg(match role {
                CgroupRole::Supervisor => "supervisor",
                CgroupRole::Workload => "workload",
            });
            wrapped.arg("--");
            wrapped.arg(&program);
            wrapped.args(&args);
            wrapped
        } else {
            let mut direct = CommandBuilder::new(program);
            direct.args(args);
            direct
        };
        cmd.cwd(cwd);
        cmd.env("AMBER_STATE_DIR", self.root.to_string_lossy().to_string());
        if start_suspended {
            cmd.env("AMBER_START_SUSPENDED", "1");
        }
        match kind {
            SessionKind::Shell => {
                // A hand-started agent inherits the session identity for hooks.
                cmd.env("AMBER_SESSION", name);
            }
            SessionKind::Claude
            | SessionKind::Grok
            | SessionKind::Codex
            | SessionKind::OpenCode
            | SessionKind::Hermes
            | SessionKind::Pi => {
                if let Some(sock) = &self.socket {
                    cmd.env("AMBER_SOCK", sock.to_string_lossy().to_string());
                }
            }
        }
        Ok(cmd)
    }

    fn spawn(
        &self,
        kind: SessionKind,
        name: &str,
        cwd: &Path,
        slot: u32,
        start_suspended: bool,
    ) -> anyhow::Result<Arc<PtySession>> {
        let cwd = Self::resolve_cwd(cwd);
        let mut cmd = self.command_for(kind, name, &cwd, slot, start_suspended)?;
        // The daemon may run under systemd, which has no TERM — without a
        // color-capable terminal, claude (and any colored program) renders
        // monochrome. Force one on the pty regardless of the daemon's own env.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // Give panes the user's login PATH so their tools + claude's hooks
        // (node) resolve, not just the daemon's minimal systemd PATH.
        if let Some(path) = login_path() {
            cmd.env("PATH", path);
        }
        // Give panes the graphical session's display vars — a pane's clipboard
        // tools (claude's image paste: `xclip`/`wl-paste`) are unreachable
        // without them. See `display_env`.
        #[cfg(target_os = "linux")]
        for (k, v) in display_env() {
            cmd.env(k, v);
        }
        let sess = Arc::new(PtySession::spawn(
            cmd,
            DEFAULT_ROWS,
            DEFAULT_COLS,
            self.cfg.scrollback_bytes,
        )?);
        // Rate-limited output-activity notification (background-activity dots).
        // The hook only fires on the pty batcher's ~2/sec gate and rides the
        // non-blocking watcher broadcast, so it never stalls the fan-out.
        if let Some(watchers) = &self.watchers {
            let watchers = Arc::clone(watchers);
            let name = name.to_string();
            sess.set_activity_hook(Box::new(move || {
                watchers.broadcast(&ControlMsg::Activity { name: name.clone() });
            }));
        }
        Ok(sess)
    }

    /// Create a new session, persist its metadata, and track it live.
    pub fn create(
        &self,
        name: &str,
        cwd: impl Into<PathBuf>,
        kind: SessionKind,
    ) -> anyhow::Result<Arc<PtySession>> {
        Self::validate_name(name)?;
        // Store an absolute, stable cwd (not a relative `.`) so claude resume
        // works across daemon restarts / reboots regardless of launch context.
        let cwd = Self::resolve_cwd(&cwd.into());
        let _maint = self.maintenance.lock().unwrap();
        self.finish_pending_rename()?;
        if self.sessions.lock().unwrap().contains_key(name) {
            anyhow::bail!("session {name} already exists");
        }
        let stored = self.store.list_sessions()?;
        if stored.iter().any(|meta| meta.name == name) {
            anyhow::bail!("session {name} already exists");
        }
        if self.sessions.lock().unwrap().contains_key(name) {
            anyhow::bail!("session {name} already exists");
        }
        let slot = alloc_slot(&Self::used_slots(&stored));
        self.cgroups.prepare_session(slot)?;
        let sess = match self.spawn(kind, name, &cwd, slot, false) {
            Ok(sess) => sess,
            Err(error) => {
                if let Err(cleanup) = self.stop_session(slot, None) {
                    eprintln!("amber daemon: failed-create cleanup for slot {slot}: {cleanup}");
                }
                return Err(error);
            }
        };
        let meta = SessionMeta {
            name: name.to_string(),
            cwd,
            kind,
            updated: Self::now(),
            resume_as_claude: false,
            run_state: None,
            slot,
        };
        if let Err(error) = self.store.write_session(&meta) {
            if let Err(cleanup) = self.stop_session(slot, Some(&sess)) {
                eprintln!("amber daemon: failed-create cleanup for slot {slot}: {cleanup}");
            }
            return Err(error);
        }
        self.sessions
            .lock()
            .unwrap()
            .insert(name.to_string(), Arc::clone(&sess));
        self.reconcile_cpu_weights();
        Ok(sess)
    }

    /// Slots held by every session in the live table — **including one whose
    /// child has exited but has not been reaped yet**. `ls`/`attach` have no
    /// alive filter, so a dead-but-listed session is still addressable by its
    /// number; handing that number to a new session would make `attach <n>`
    /// ambiguous, which is the exact bug slots exist to remove. A slot frees
    /// only when the session leaves the table (kill/reap).
    fn used_slots(metas: &[SessionMeta]) -> BTreeSet<u32> {
        metas
            .iter()
            .filter(|meta| meta.slot >= 1)
            .map(|meta| meta.slot)
            .collect()
    }

    /// Retry rename garbage collection before any metadata mutation. Restore
    /// may proceed once recovery has selected one authoritative metadata name,
    /// but mutation must wait until the journal releases both names.
    fn finish_pending_rename(&self) -> anyhow::Result<()> {
        if !self.store.recover_pending_rename()? {
            anyhow::bail!("pending session rename cleanup is incomplete");
        }
        let pending = {
            let sessions = self.sessions.lock().unwrap();
            let mut deferred = self.deferred_meta.lock().unwrap();
            deferred.retain(|name, entry| {
                sessions
                    .get(name)
                    .is_some_and(|session| Weak::ptr_eq(&entry.session, &Arc::downgrade(session)))
            });
            deferred
                .values()
                .map(|entry| entry.meta.clone())
                .collect::<Vec<_>>()
        };
        for meta in &pending {
            self.store.write_session(meta)?;
        }
        self.deferred_meta.lock().unwrap().clear();
        Ok(())
    }

    fn deferred_meta_for(&self, name: &str, session: &Arc<PtySession>) -> Option<SessionMeta> {
        let mut deferred = self.deferred_meta.lock().unwrap();
        let entry = deferred.get(name)?;
        if Weak::ptr_eq(&entry.session, &Arc::downgrade(session)) {
            return Some(entry.meta.clone());
        }
        deferred.remove(name);
        None
    }

    fn effective_meta_for(
        &self,
        name: &str,
        session: &Arc<PtySession>,
    ) -> anyhow::Result<Option<SessionMeta>> {
        if let Some(meta) = self.deferred_meta_for(name, session) {
            return Ok(Some(meta));
        }
        self.store.read_session(name)
    }

    fn stop_session(&self, slot: u32, session: Option<&Arc<PtySession>>) -> anyhow::Result<()> {
        let _transition = session.map(|session| session.lock_suspend_transition());
        self.stop_session_locked(slot, session)
    }

    fn stop_session_locked(
        &self,
        slot: u32,
        session: Option<&Arc<PtySession>>,
    ) -> anyhow::Result<()> {
        let mut empty = self.cgroups.kill_session(slot).unwrap_or(false);
        if let Some(session) = session {
            if session.is_alive() {
                if let Err(error) = session.kill() {
                    let gone = error.chain().any(|cause| {
                        cause
                            .downcast_ref::<std::io::Error>()
                            .and_then(std::io::Error::raw_os_error)
                            == Some(libc::ESRCH)
                    });
                    if !gone {
                        return Err(error);
                    }
                }
            }
            if !session.wait_for_exit(CHILD_EXIT_TIMEOUT) {
                anyhow::bail!("session child {slot} did not exit after termination");
            }
        }
        if !empty {
            empty = self.cgroups.kill_session(slot).unwrap_or(false);
        }
        if self.cgroups.is_enabled() && !empty {
            anyhow::bail!("session cgroup {slot} remained populated");
        }
        self.cgroups.remove_session(slot)?;
        Ok(())
    }

    fn rollback_agent_rename(
        &self,
        from: &str,
        to: &str,
        old_meta: &SessionMeta,
        size: Option<(u16, u16)>,
        suspension: Option<(SuspendOrigin, u64)>,
        store_moved: bool,
    ) -> anyhow::Result<()> {
        let cleanup_error = self.stop_session(old_meta.slot, None).err();
        if store_moved {
            self.finish_pending_rename()?;
            self.store.rename_session(to, from)?;
        }
        self.cgroups.prepare_session(old_meta.slot)?;
        let restored = self.restore_one_with_suspension(old_meta, suspension)?;
        if let Some((rows, cols)) = size {
            let _ = restored.resize(rows, cols);
        }
        self.sessions
            .lock()
            .unwrap()
            .insert(from.to_string(), restored);
        if let Some(error) = cleanup_error {
            eprintln!("amber daemon: rename rollback initial cleanup failed: {error}");
        }
        Ok(())
    }

    /// Flush every live session's scrollback + metadata to the state store.
    /// Periodic snapshot (daemon healthy): re-detects hand-started claude with
    /// downgrade hysteresis.
    pub fn snapshot(&self) -> anyhow::Result<()> {
        self.snapshot_inner(false)
    }

    /// Final snapshot on SIGTERM/SIGINT (pre-reboot / pre-restart). `is_final`
    /// makes it PRESERVE each shell's `resume_as_claude` instead of re-detecting
    /// it: `systemctl restart` SIGTERMs the whole cgroup at once, so claude is
    /// already being killed when this runs — re-detecting would see "no claude"
    /// and wrongly drop a live claude pane to a bare shell on restore. The last
    /// periodic snapshot holds the truth; this one must not clobber it.
    pub fn snapshot_final(&self) -> anyhow::Result<()> {
        self.snapshot_inner(true)
    }

    fn snapshot_inner(&self, is_final: bool) -> anyhow::Result<()> {
        let _maint = self.maintenance.lock().unwrap();
        self.finish_pending_rename()?;
        // Take a CHEAP COPY of the session handles and release the lock at once.
        //
        // This loop writes up to `scrollback_bytes` per session to disk and reads
        // /proc; holding `sessions` across that blocks `write()` — the path an
        // `Input` frame takes — so on a live daemon every snapshot froze typing
        // for seconds while output (whose fan-out needs no lock) kept flowing.
        // The sessions are `Arc`s, so cloning the map is a refcount bump each.
        let handles: Vec<(String, Arc<PtySession>)> = {
            let sessions = self.sessions.lock().unwrap();
            self.claude_absent
                .lock()
                .unwrap()
                .retain(|k, _| sessions.contains_key(k));
            self.persisted_scrollback
                .lock()
                .unwrap()
                .retain(|k, _| sessions.contains_key(k));
            sessions
                .iter()
                .map(|(n, s)| (n.clone(), Arc::clone(s)))
                .collect()
        };

        // One process-table scan for the whole snapshot, not one per session,
        // and without the RSS reads the claude check never looks at. Skipped
        // entirely for a final snapshot, which does not re-detect.
        let table = if is_final || !handles.iter().any(|(_, s)| s.pid().is_some()) {
            Vec::new()
        } else {
            crate::procinfo::process_table_lite()
        };

        for (name, sess) in &handles {
            self.persist_scrollback_if_changed(name, sess)?;
            self.persist_live_cwd(name, sess, is_final, &table);
        }
        Ok(())
    }

    /// Write `name`'s scrollback — unless nothing has been pushed into its ring
    /// since the last time we wrote it.
    ///
    /// The ring's `written()` counter is monotonic and counts PUSHED bytes, so
    /// an unchanged counter means byte-identical contents; skipping is a pure
    /// no-op on what ends up on disk, and reboot survival (core rule #6) is
    /// untouched. What it removes is the per-tick 2 MiB clone + atomic rewrite
    /// for a pane that printed nothing — which, on the measured box, was
    /// essentially all of them.
    ///
    /// The counter is recorded only on a SUCCESSFUL write, so a failed snapshot
    /// is retried on the next tick rather than silently skipped forever.
    fn persist_scrollback_if_changed(&self, name: &str, sess: &PtySession) -> anyhow::Result<()> {
        let written = sess.scrollback_written();
        if self.persisted_scrollback.lock().unwrap().get(name) == Some(&written) {
            return Ok(());
        }
        self.store.write_scrollback(name, &sess.scrollback())?;
        self.persisted_scrollback
            .lock()
            .unwrap()
            .insert(name.to_string(), written);
        Ok(())
    }

    /// Persist a Shell session's live working directory so an in-shell `cd`
    /// survives restart (the shell respawns where the user left it, not its
    /// original cwd). Read from the child's `/proc/<pid>/cwd`. Claude sessions
    /// are left alone — their cwd is the authoritative, pre-trusted folder the
    /// pane was created in, which `amber run` never `cd`s out of. `is_final`
    /// preserves `resume_as_claude` (see `snapshot_final`).
    fn persist_live_cwd(
        &self,
        name: &str,
        sess: &PtySession,
        is_final: bool,
        table: &[crate::procinfo::ProcEntry],
    ) {
        let Ok(Some(meta)) = self.store.read_session(name) else {
            return;
        };
        if meta.kind != SessionKind::Shell {
            return;
        }
        let new_cwd = sess
            .live_cwd()
            .filter(|d| d.is_dir())
            .unwrap_or_else(|| meta.cwd.clone());
        // Was the user running claude by hand in this shell? If so, restore it as
        // a resumable claude instead of a bare shell. Final snapshots preserve the
        // stored flag (detection is unreliable mid-shutdown); periodic snapshots
        // re-detect with hysteresis so one transient miss can't downgrade.
        let new_resume = if is_final {
            meta.resume_as_claude
        } else {
            let detected = sess.is_running_claude_in(table);
            let mut streaks = self.claude_absent.lock().unwrap();
            let streak = streaks.get(name).copied().unwrap_or(0);
            let (flag, next) = decide_resume(
                meta.resume_as_claude,
                detected,
                streak,
                CLAUDE_ABSENT_THRESHOLD,
            );
            if next == 0 {
                streaks.remove(name);
            } else {
                streaks.insert(name.to_string(), next);
            }
            flag
        };
        if new_cwd != meta.cwd || new_resume != meta.resume_as_claude {
            let updated = SessionMeta {
                cwd: new_cwd,
                resume_as_claude: new_resume,
                updated: Self::now(),
                ..meta
            };
            let _ = self.store.write_session(&updated);
        }
    }

    /// Recreate every persisted session, seeding its ring with saved
    /// scrollback. One unrestorable session (unreadable scrollback, spawn
    /// failure) is logged and skipped — it must never abort the rest, which
    /// would leave the daemon dead on startup with zero sessions restored
    /// (mirrors [`StateStore::list_sessions`]' tolerance of corrupt JSON).
    ///
    /// Slots are restored from the store and **repaired in passing**: the store
    /// is user-visible JSON that can predate the field (`slot: 0`) or be
    /// hand-edited into duplicates, so an unassigned or already-taken slot is
    /// reassigned lowest-free. Restore order is by name, so the repair is
    /// deterministic; a failure to persist a repair is logged, never fatal.
    pub fn restore(&self) -> anyhow::Result<()> {
        let _maint = self.maintenance.lock().unwrap();
        let recovery_complete = self.store.recover_pending_rename()?;
        if !recovery_complete {
            eprintln!(
                "amber daemon: restored authoritative rename while orphan cleanup remains pending"
            );
        }
        // Written on a clean SIGTERM/SIGINT exit (main.rs), consumed here.
        // Still present at startup means this boot follows an unclean death
        // (SIGKILL, oomd, power loss) rather than a normal restart/reinstall.
        let marker = self.root.join("clean-shutdown");
        let clean_shutdown = marker.exists();
        let _ = std::fs::remove_file(&marker);

        let mut metas = self.store.list_sessions()?;
        metas.sort_by(|a, b| a.name.cmp(&b.name));
        let restore_total = metas.len();
        let mut used: BTreeSet<u32> = BTreeSet::new();
        let mut lost = Vec::new();

        // Phase A — SERIAL preparation. Slot repair, kind normalization and
        // cgroup-leaf creation mutate shared store/slot state and must run
        // deterministically in name order.
        let mut ready = Vec::new();
        for mut meta in metas {
            if meta.slot < 1 || !used.insert(meta.slot) {
                meta.slot = alloc_slot(&used);
                used.insert(meta.slot);
                if recovery_complete {
                    if let Err(e) = self.store.write_session(&meta) {
                        eprintln!(
                            "amber daemon: could not persist repaired slot for {}: {e}",
                            meta.name
                        );
                    }
                } else {
                    eprintln!(
                        "amber daemon: deferred repaired slot for {} until rename cleanup completes",
                        meta.name
                    );
                }
            }
            let restore_name = meta.name.clone();
            meta = match self.normalize_restored_meta(meta, recovery_complete) {
                Ok(meta) => meta,
                Err(error) => {
                    eprintln!("amber daemon: restore skipped session {restore_name}: {error}");
                    self.record_recovery_event(
                        "error", "session.restore_failed", Some(&restore_name),
                        error.to_string(), None,
                    );
                    lost.push(restore_name);
                    continue;
                }
            };
            if let Err(error) = self.cgroups.prepare_session(meta.slot) {
                eprintln!(
                    "amber daemon: restore skipped session {}: {error}",
                    meta.name
                );
                self.record_recovery_event(
                    "error", "session.restore_failed", Some(&meta.name),
                    error.to_string(), None,
                );
                lost.push(meta.name.clone());
                continue;
            }
            ready.push(meta);
        }

        // Phase B — CONCURRENT spawns. Each spawn is a pty open + fork/exec +
        // a login-shell PATH probe (+ supervisor setup for agent kinds), so
        // serially the cost multiplied by pane count landed exactly at boot —
        // the busiest moment this machine ever sees. Results stay keyed to
        // their metadata so the commit phase below is deterministic.
        //
        // Concurrency is capped: a dozen simultaneous claude forks would
        // spike load worse than the serial boot they replace.
        let workers = ready
            .len()
            .min(8)
            .min(std::thread::available_parallelism().map_or(1, |n| n.get()))
            .max(1);
        let chunk_len = ready.len().div_ceil(workers).max(1);
        let outcomes: Vec<(SessionMeta, anyhow::Result<Arc<PtySession>>)> =
            std::thread::scope(|scope| {
                let handles: Vec<_> = ready
                    .chunks(chunk_len)
                    .map(|chunk| {
                        let chunk = chunk.to_vec();
                        scope.spawn(move || {
                            chunk
                                .into_iter()
                                .map(|meta| {
                                    let res = self.restore_one(&meta);
                                    (meta, res)
                                })
                                .collect::<Vec<_>>()
                        })
                    })
                    .collect();
                handles
                    .into_iter()
                    .flat_map(|h| h.join().unwrap_or_default())
                    .collect()
            });

        // Phase C — SERIAL commit: register under the live-table lock, apply
        // deferred overrides, clean up failures — in the original name order.
        let mut restored_count = 0usize;
        for (meta, result) in outcomes {
            match result {
                Ok(sess) => {
                    let mut sessions = self.sessions.lock().unwrap();
                    if !recovery_complete {
                        self.deferred_meta.lock().unwrap().insert(
                            meta.name.clone(),
                            LiveMetaOverride {
                                session: Arc::downgrade(&sess),
                                meta: meta.clone(),
                            },
                        );
                    }
                    sessions.insert(meta.name.clone(), sess);
                    restored_count += 1;
                }
                Err(e) => {
                    eprintln!("amber daemon: restore skipped session {}: {e}", meta.name);
                    self.record_recovery_event(
                        "error", "session.restore_failed", Some(&meta.name),
                        e.to_string(), None,
                    );
                    if let Err(cleanup) = self.stop_session(meta.slot, None) {
                        eprintln!(
                            "amber daemon: restore cleanup failed for {}: {cleanup}",
                            meta.name
                        );
                    }
                    lost.push(meta.name.clone());
                }
            }
        }
        if !clean_shutdown && !lost.is_empty() {
            let report = serde_json::json!({
                "timestamp": Self::now(),
                "lost_sessions": &lost,
            });
            if let Ok(body) = serde_json::to_string_pretty(&report) {
                let _ = std::fs::write(self.root.join("last-crash-report.json"), body);
            }
        }
        self.record_recovery_event(
            if lost.is_empty() { "info" } else { "warning" },
            "daemon.restore",
            None,
            format!(
                "restored {restored_count} of {restore_total} sessions; skipped {}",
                lost.len()
            ),
            None,
        );
        self.reconcile_cpu_weights();
        Ok(())
    }

    fn normalize_restored_meta(
        &self,
        mut meta: SessionMeta,
        persist: bool,
    ) -> anyhow::Result<SessionMeta> {
        if meta.resume_as_claude {
            if meta.kind == SessionKind::Shell {
                meta.kind = SessionKind::Claude;
            }
            meta.resume_as_claude = false;
            if persist {
                self.store.write_session(&meta)?;
            }
        }
        Ok(meta)
    }

    /// Called on a clean SIGTERM/SIGINT exit, right after the final snapshot
    /// — arms the next boot's clean/unclean detection in [`Self::restore`].
    pub fn mark_clean_shutdown(&self) -> anyhow::Result<()> {
        std::fs::write(self.root.join("clean-shutdown"), Self::now().to_string())?;
        Ok(())
    }

    /// Restore a single persisted session. The scrollback is read BEFORE the
    /// child is spawned so a read failure cannot leak a freshly-spawned
    /// process.
    fn restore_one(&self, meta: &SessionMeta) -> anyhow::Result<Arc<PtySession>> {
        self.restore_one_with_suspension(meta, None)
    }

    fn restore_one_with_suspension(
        &self,
        meta: &SessionMeta,
        suspension: Option<(SuspendOrigin, u64)>,
    ) -> anyhow::Result<Arc<PtySession>> {
        #[cfg(test)]
        {
            let fail = self.root.join(".fail-restore");
            if fail.exists() {
                std::fs::remove_file(fail)?;
                anyhow::bail!("injected restore failure");
            }
        }
        let scrollback = self.store.read_scrollback(&meta.name)?;
        let sess = self.spawn(
            meta.kind,
            &meta.name,
            &meta.cwd,
            meta.slot,
            suspension.is_some(),
        )?;
        if let Some(bytes) = scrollback {
            sess.preload(&bytes);
        }
        if let Some((origin, started)) = suspension {
            debug_assert_ne!(origin, SuspendOrigin::None);
            sess.claim_suspend(origin)
                .expect("fresh session cannot already be suspended");
            sess.set_memory_suspend_started_ms(started);
            sess.set_run_state(Some("suspended".to_string()));
            sess.await_initial_suspend_ready();
        }
        // Do not infer "claude" merely because the supervisor process spawned:
        // the agent child may still fail to launch. The supervisor reports the
        // running phase only after its agent spawn succeeds. Persisted state is
        // deliberately discarded, leaving None until that authoritative report.
        Ok(sess)
    }

    pub fn session(&self, name: &str) -> Option<Arc<PtySession>> {
        self.sessions.lock().unwrap().get(name).cloned()
    }

    fn ensure_current_session(&self, name: &str, session: &Arc<PtySession>) -> anyhow::Result<()> {
        let current = self.sessions.lock().unwrap().get(name).cloned();
        if !current
            .as_ref()
            .is_some_and(|live| Arc::ptr_eq(live, session))
            || !session.is_alive()
        {
            anyhow::bail!("no such session: {name}");
        }
        Ok(())
    }

    /// (name, child pid) for every live session with a pid — the memory monitor
    /// sums each pid's process-tree RSS. Snapshotted under the lock, which is
    /// then released: the caller does its `/proc` reads WITHOUT holding the
    /// session lock (a slow read must never stall create/kill/attach).
    pub fn live_pids(&self) -> Vec<(String, u32)> {
        self.sessions
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(name, sess)| sess.pid().map(|p| (name.clone(), p)))
            .collect()
    }

    /// Snapshot the live/session-store facts the pure memory policy needs.
    /// Session handles are cloned first so state and cgroup reads never hold
    /// the live-table lock.
    pub fn memory_candidates(&self, per_session_kb: &HashMap<String, u64>) -> Vec<Candidate> {
        let sessions: Vec<(String, Arc<PtySession>)> = self
            .sessions
            .lock()
            .unwrap()
            .iter()
            .map(|(name, session)| (name.clone(), Arc::clone(session)))
            .collect();
        sessions
            .into_iter()
            .filter_map(|(name, session)| {
                let meta = match self.effective_meta_for(&name, &session) {
                    Ok(Some(meta)) => meta,
                    Ok(None) => return None,
                    Err(error) => {
                        eprintln!("amber daemon: memory candidate {name} metadata failed: {error}");
                        return None;
                    }
                };
                let has_resume_id = match self.store.read_claude(&name) {
                    Ok(recorded) => {
                        recorded.is_some_and(|recorded| !recorded.session_id.is_empty())
                    }
                    Err(error) => {
                        eprintln!(
                            "amber daemon: memory candidate {name} resume id failed: {error}"
                        );
                        false
                    }
                };
                Some(Candidate {
                    memory_kb: per_session_kb.get(&name).copied().unwrap_or(0),
                    last_used_ms: session.last_used_ms(),
                    is_agent: meta.kind.is_agent(),
                    running: session.is_alive() && session.run_state().as_deref() == Some("claude"),
                    has_resume_id,
                    suspended: session.suspend_origin() != SuspendOrigin::None,
                    name,
                })
            })
            .collect()
    }

    /// The stable slot protected from host-pressure parking. Exposed for the
    /// optional cgroup CPU weighting pass as well as candidate selection.
    pub fn foreground_slot(&self) -> u32 {
        self.foreground_slot.load(Ordering::SeqCst)
    }

    fn set_foreground_locked(
        &self,
        name: &str,
        session: &Arc<PtySession>,
    ) -> anyhow::Result<bool> {
        let meta = self
            .effective_meta_for(name, session)?
            .ok_or_else(|| anyhow::anyhow!("session {name} vanished from the store"))?;
        Ok(self.foreground_slot.swap(meta.slot, Ordering::SeqCst) != meta.slot)
    }

    fn clear_foreground_slot(&self, slot: u32) {
        let _ = self
            .foreground_slot
            .compare_exchange(slot, 0, Ordering::SeqCst, Ordering::SeqCst);
    }

    /// CPU weighting is best-effort; its controller writes must not alter the
    /// foreground slot, lifecycle, or suspend-transition semantics.
    fn reconcile_cpu_weights(&self) {
        let _reconciliation = self.cpu_reconciliation.lock().unwrap();
        let foreground_slot = self.foreground_slot();
        #[cfg(test)]
        self.call_cpu_reconcile_hook(CpuReconcilePoint::Start, foreground_slot);
        self.cgroups.reconcile_cpu_weights(foreground_slot);
        #[cfg(test)]
        self.call_cpu_reconcile_hook(CpuReconcilePoint::Finish, foreground_slot);
    }

    #[cfg(test)]
    fn set_cpu_reconcile_hook(&self, hook: CpuReconcileHook) {
        *self.cpu_reconcile_hook.lock().unwrap() = Some(hook);
    }

    #[cfg(test)]
    fn call_cpu_reconcile_hook(&self, point: CpuReconcilePoint, foreground_slot: u32) {
        let hook = self.cpu_reconcile_hook.lock().unwrap().clone();
        if let Some(hook) = hook {
            hook(point, foreground_slot);
        }
    }

    /// Snapshot host-pressure-safe candidates. This is intentionally separate
    /// from [`memory_candidates`]: memory policy preserves output recency,
    /// while host policy ranks only focus/input and excludes the foreground
    /// stable slot.
    pub fn host_pressure_candidates(
        &self,
        now_ms: u64,
        per_session_kb: &HashMap<String, u64>,
    ) -> Vec<HostPressureCandidate> {
        let foreground_slot = self.foreground_slot();
        let sessions: Vec<(String, Arc<PtySession>)> = self
            .sessions
            .lock()
            .unwrap()
            .iter()
            .map(|(name, session)| (name.clone(), Arc::clone(session)))
            .collect();
        let mut candidates: Vec<HostPressureCandidate> = sessions
            .into_iter()
            .filter_map(|(name, session)| {
                let meta = match self.effective_meta_for(&name, &session) {
                    Ok(Some(meta)) => meta,
                    Ok(None) => return None,
                    Err(error) => {
                        eprintln!(
                            "amber daemon: host-pressure candidate {name} metadata failed: {error}"
                        );
                        return None;
                    }
                };
                if meta.slot == foreground_slot
                    || !meta.kind.is_agent()
                    || !session.is_alive()
                    || session.run_state().as_deref() != Some("claude")
                    || session.suspend_origin() != SuspendOrigin::None
                    || now_ms.saturating_sub(session.last_user_ms()) < RECENT_USE_MS
                {
                    return None;
                }
                let has_resume_id = match self.store.read_claude(&name) {
                    Ok(recorded) => {
                        recorded.is_some_and(|recorded| !recorded.session_id.is_empty())
                    }
                    Err(error) => {
                        eprintln!(
                            "amber daemon: host-pressure candidate {name} resume id failed: {error}"
                        );
                        false
                    }
                };
                has_resume_id.then(|| HostPressureCandidate {
                    memory_kb: per_session_kb.get(&name).copied().unwrap_or(0),
                    last_user_ms: session.last_user_ms(),
                    name,
                })
            })
            .collect();
        candidates.sort_by(|left, right| {
            left.last_user_ms
                .cmp(&right.last_user_ms)
                .then_with(|| right.memory_kb.cmp(&left.memory_kb))
                .then_with(|| left.name.cmp(&right.name))
        });
        candidates
    }

    /// Preserve the aggregate-memory path's conservative output-recency check.
    pub fn suspend_for_memory(&self, name: &str, now_ms: u64) -> anyhow::Result<()> {
        self.suspend_for_automatic_with_clock(
            name,
            AutomaticSuspendRecency::Memory,
            || now_ms,
        )
        .map(|_| ())
    }

    /// Host PSI parking uses user recency only and refuses the stable
    /// foreground slot. All checks run under the session transition lock. The
    /// returned timestamp is sampled only after the supervisor signal succeeds
    /// and is therefore the sole correct origin for the host cooldown.
    pub fn suspend_for_pressure(&self, name: &str) -> anyhow::Result<u64> {
        self.suspend_for_automatic_with_clock(
            name,
            AutomaticSuspendRecency::Host,
            crate::pty::monotonic_ms,
        )
    }

    #[cfg(test)]
    pub(crate) fn suspend_for_pressure_with_clock(
        &self,
        name: &str,
        now_ms: impl FnMut() -> u64,
    ) -> anyhow::Result<u64> {
        self.suspend_for_automatic_with_clock(name, AutomaticSuspendRecency::Host, now_ms)
    }

    fn suspend_for_automatic_with_clock(
        &self,
        name: &str,
        recency: AutomaticSuspendRecency,
        mut now_ms: impl FnMut() -> u64,
    ) -> anyhow::Result<u64> {
        let session = self
            .session(name)
            .ok_or_else(|| anyhow::anyhow!("no such session: {name}"))?;
        let _transition = session.lock_suspend_transition();
        self.ensure_current_session(name, &session)?;
        let meta = self
            .effective_meta_for(name, &session)?
            .ok_or_else(|| anyhow::anyhow!("session {name} vanished from the store"))?;
        if !meta.kind.is_agent() {
            anyhow::bail!("automatic pressure suspend applies only to agent sessions: {name}");
        }
        if session.run_state().as_deref() != Some("claude") {
            anyhow::bail!("session {name} no longer has a running agent");
        }
        let has_resume_id = self
            .store
            .read_claude(name)?
            .is_some_and(|recorded| !recorded.session_id.is_empty());
        if !has_resume_id {
            anyhow::bail!("session {name} has no recorded resume id");
        }
        if session.suspend_origin() != SuspendOrigin::None {
            anyhow::bail!("session {name} is already suspended");
        }
        if recency == AutomaticSuspendRecency::Host && meta.slot == self.foreground_slot() {
            anyhow::bail!("session {name} is the foreground session");
        }
        let last_activity_ms = match recency {
            AutomaticSuspendRecency::Memory => session.last_used_ms(),
            AutomaticSuspendRecency::Host => session.last_user_ms(),
        };
        // Metadata and resume-id reads may block on storage. Sample only after
        // they finish and while the transition lock is held, immediately
        // before the final eligibility/claim boundary.
        let pending_started_ms = now_ms().max(1);
        if pending_started_ms.saturating_sub(last_activity_ms) < RECENT_USE_MS {
            anyhow::bail!("session {name} received recent activity");
        }
        // This is deliberately the final check before claiming the automatic
        // origin: a selected process may have exited while snapshotting or
        // while the preceding metadata/recency checks ran.
        if !session.is_alive() {
            anyhow::bail!("session {name} no longer has a running agent");
        }

        session
            .claim_suspend(SuspendOrigin::Pressure)
            .map_err(|origin| {
                anyhow::anyhow!("session {name} is already suspended by {origin:?}")
            })?;
        let previous_started = session.memory_suspend_started_ms();
        session.set_memory_suspend_started_ms(pending_started_ms);
        if let Err(error) = Self::signal_supervisor(name, &session, nix::libc::SIGUSR1) {
            session.restore_suspend_origin(SuspendOrigin::Pressure, SuspendOrigin::None);
            session.set_memory_suspend_started_ms(previous_started);
            return Err(error);
        }
        Ok(now_ms().max(pending_started_ms))
    }

    pub fn pressure_suspend_pending_since(&self) -> Option<u64> {
        let sessions: Vec<Arc<PtySession>> =
            self.sessions.lock().unwrap().values().cloned().collect();
        sessions
            .into_iter()
            .filter(|session| {
                session.suspend_origin() == SuspendOrigin::Pressure
                    && session.run_state().as_deref() != Some("suspended")
            })
            .map(|session| session.memory_suspend_started_ms())
            .filter(|started| *started != 0)
            .min()
    }

    /// Compatibility name for the existing memory guardian; automatic
    /// suspension is now shared by memory-budget and host-PSI policy.
    pub fn memory_suspend_pending_since(&self) -> Option<u64> {
        self.pressure_suspend_pending_since()
    }

    pub fn cgroup_memory_sample(&self) -> anyhow::Result<Option<(u64, HashMap<String, u64>)>> {
        if !self.cgroups.is_enabled() {
            return Ok(None);
        }
        let sessions: Vec<(String, Arc<PtySession>)> = self
            .sessions
            .lock()
            .unwrap()
            .iter()
            .map(|(name, session)| (name.clone(), Arc::clone(session)))
            .collect();
        let current_kb = require_cgroup_aggregate(self.cgroups.aggregate_current_kb()?)?;
        let mut per_session = HashMap::new();
        for (name, session) in sessions {
            if !session.is_alive() {
                continue;
            }
            let Some(meta) = self.effective_meta_for(&name, &session)? else {
                continue;
            };
            if let Some(current_kb) = self.cgroups.session_current_kb(meta.slot)? {
                per_session.insert(name, current_kb);
            }
        }
        Ok(Some((current_kb, per_session)))
    }

    pub(crate) fn cgroup_memory_enabled(&self) -> bool {
        self.cgroups.is_enabled()
    }

    /// Seed the guardian's live budget handle (startup). `None` = no usable
    /// aggregate: automatic parking stays off until a budget is set.
    pub fn store_effective_budget_kb(&self, kb: Option<u64>) {
        self.budget_kb.store(kb.unwrap_or(0), Ordering::SeqCst);
    }

    /// The guardian's current aggregate budget in KiB, read fresh every tick.
    pub fn effective_budget_kb(&self) -> Option<u64> {
        let value = self.budget_kb.load(Ordering::SeqCst);
        (value != 0).then_some(value)
    }

    /// The full memory-budget truth, without changing anything. Re-reads the
    /// persisted config (not the startup copy) so a `SetMemoryBudget` from
    /// any connection is immediately visible here; the read is one small
    /// file on a rare call. Also the reply body for `GetMemoryBudget`.
    pub fn get_memory_budget(&self) -> anyhow::Result<BudgetStatus> {
        let cfg = self.store.load_config()?;
        let physical_kb = crate::procinfo::total_memory_kb();
        let cgroup_limit_kb = self.cgroups.lowest_finite_limit_kb().ok().flatten();
        let effective = cfg.memory.budget_kb(physical_kb, cgroup_limit_kb);
        Ok(BudgetStatus {
            configured_mb: cfg.memory.budget_mb,
            effective_budget_kb: effective,
            cgroup_limit_kb,
            session_high_kb: cfg.memory.session_high_kb(effective),
            physical_kb,
            enabled: cfg.memory.enabled,
        })
    }

    /// Change the aggregate memory budget (`None` = auto) and make it LIVE:
    /// persist to config, re-derive against the CURRENT service cap (a
    /// `systemctl --user set-property` may have moved it under us), move
    /// every existing session leaf's `memory.high`, and flip the guardian's
    /// handle — all without a restart. Returns the new truth.
    pub fn set_memory_budget(&self, mb: Option<u64>) -> anyhow::Result<BudgetStatus> {
        const MAX_BUDGET_MB: u64 = 1024 * 1024; // 1 TiB: only rejects nonsense
        if let Some(mb) = mb {
            if mb > MAX_BUDGET_MB {
                anyhow::bail!("budget {mb} MiB exceeds the sanity ceiling of {MAX_BUDGET_MB} MiB");
            }
        }
        let mut cfg = self.cfg.clone();
        cfg.memory.budget_mb = mb;
        self.store.save_config(&cfg)?;
        let status = self.get_memory_budget()?;
        self.cgroups.set_session_high_kb(status.session_high_kb);
        self.store_effective_budget_kb(status.effective_budget_kb);
        // Move existing leaves to the new ceiling. Best-effort per slot: one
        // unwritable leaf must not stop the others.
        let slots: Vec<u32> = {
            let sessions = self.sessions.lock().unwrap();
            sessions
                .iter()
                .filter_map(|(name, sess)| {
                    self.effective_meta_for(name, sess)
                        .ok()
                        .flatten()
                        .map(|meta| meta.slot)
                })
                .collect()
        };
        for slot in slots {
            if let Err(error) = self.cgroups.rewrite_session_high(slot) {
                eprintln!("amber daemon: could not move session-{slot} memory.high: {error}");
            }
        }
        Ok(status)
    }

    /// The effective live kind of a session. During pending rename cleanup it
    /// may intentionally be newer than the journal-owned persisted metadata.
    /// Consulted on Attach to apply the spec-§5 reconnect semantics.
    pub fn session_kind(&self, name: &str) -> Option<SessionKind> {
        let session = self.session(name);
        match session {
            Some(session) => self
                .effective_meta_for(name, &session)
                .ok()
                .flatten()
                .map(|m| m.kind),
            None => self.store.read_session(name).ok().flatten().map(|m| m.kind),
        }
    }

    /// Record an agent session's supervision phase (from `ReportRunState`).
    /// Errors — surfaced to the client as an `Error` reply — if the session is
    /// unknown, is not an agent session, or `state` is not one of the four
    /// allowed values.
    ///
    /// The phase strings stay spelled `claude*` for every agent: they name the
    /// supervision phase, not the binary, and grok's supervisor reports the
    /// same four. Minting `grok-*` variants would mean new vocabulary here, in
    /// the app's kind-dot, and in the tab label for no behaviour gain.
    pub fn set_run_state(&self, name: &str, state: &str) -> anyhow::Result<()> {
        self.set_run_state_report(name, state, 0).map(|_| ())
    }

    /// Apply an ordered supervisor report. A stale or duplicate sequence is
    /// successfully acknowledged but does not overwrite newer state. Legacy
    /// sequence-zero reporters remain supported until a versioned report has
    /// established authority for this live supervisor.
    pub fn set_run_state_report(&self, name: &str, state: &str, seq: u64) -> anyhow::Result<bool> {
        // "suspended" (Slice 3): the agent parked by a freeze grace — child
        // killed to free RAM, pty held idle, resumable.
        if !matches!(
            state,
            "claude" | "claude-retrying" | "shell-fallback" | "suspended" | "suspend-failed"
        ) {
            anyhow::bail!("invalid run_state: {state}");
        }
        let sess = self
            .session(name)
            .ok_or_else(|| anyhow::anyhow!("no such session: {name}"))?;
        let _transition = sess.lock_suspend_transition();
        let is_agent = self
            .effective_meta_for(name, &sess)
            .ok()
            .flatten()
            .map(|m| m.kind.is_agent())
            .unwrap_or(false);
        if !is_agent {
            anyhow::bail!("run_state applies only to agent sessions: {name}");
        }
        let current = sess.run_state_seq();
        if (seq == 0 && current > 0) || (seq > 0 && seq <= current) {
            return Ok(false);
        }
        // A renamed parked session inherits its suspension before the replacement
        // supervisor has confirmed it parked its child. A terminal fallback at
        // that point means there is nothing left to resume, so release the
        // inherited gate instead of leaving input blocked forever. `suspend-failed`
        // is the same reconciliation for a live cgroup reclaim failure.
        let release_suspension = state == "suspend-failed"
            || (state == "shell-fallback" && !sess.initial_suspend_ready());
        let projected_state = if state == "suspend-failed" {
            "claude"
        } else {
            state
        };
        sess.set_run_state(Some(projected_state.to_string()));
        if seq > 0 {
            sess.set_run_state_seq(seq);
        }
        if state == "suspended" {
            sess.mark_initial_suspend_ready();
            // A second suspend can race a failed reclaim after the daemon has
            // already rolled back its origin. If that later request succeeds,
            // keep the parked workload recoverable. Manual is conservative:
            // focus must never wake work the user may have explicitly parked.
            if sess.suspend_origin() == SuspendOrigin::None {
                let _ = sess.claim_suspend(SuspendOrigin::Manual);
            }
            if sess.take_pending_resume() {
                if let Err(error) = Self::signal_supervisor(name, &sess, nix::libc::SIGUSR2) {
                    sess.restore_pending_resume();
                    return Err(error);
                }
                sess.clear_suspend_origin();
                sess.set_memory_suspend_started_ms(0);
            }
        } else if release_suspension {
            sess.mark_initial_suspend_ready();
            let _ = sess.take_pending_resume();
            sess.clear_suspend_origin();
            sess.set_memory_suspend_started_ms(0);
        }
        Ok(true)
    }

    fn signal_supervisor(name: &str, session: &PtySession, signal: i32) -> anyhow::Result<()> {
        let pid = session
            .pid()
            .ok_or_else(|| anyhow::anyhow!("session {name} has no child pid"))?;
        // SAFETY: kill(2) with our own child's pid and a fixed valid signal;
        // failure is reported via errno, never UB.
        let rc = unsafe { nix::libc::kill(pid as nix::libc::pid_t, signal) };
        if rc != 0 {
            anyhow::bail!(
                "failed to signal session {name}: {}",
                std::io::Error::last_os_error()
            );
        }
        Ok(())
    }

    pub fn suspend(&self, name: &str, origin: SuspendOrigin) -> anyhow::Result<()> {
        if origin == SuspendOrigin::None {
            anyhow::bail!("invalid suspend origin for session {name}");
        }
        let session = self
            .session(name)
            .ok_or_else(|| anyhow::anyhow!("no such session: {name}"))?;
        let _transition = session.lock_suspend_transition();
        self.ensure_current_session(name, &session)?;
        let meta = self
            .effective_meta_for(name, &session)?
            .ok_or_else(|| anyhow::anyhow!("session {name} vanished from the store"))?;
        if !meta.kind.is_agent() {
            anyhow::bail!("suspend applies only to agent sessions: {name}");
        }

        let state = session.run_state();
        if matches!(state.as_deref(), Some("claude-retrying" | "shell-fallback")) {
            anyhow::bail!(
                "cannot suspend session {name} while it is {}",
                state.unwrap()
            );
        }
        if !matches!(state.as_deref(), Some("claude" | "suspended")) {
            anyhow::bail!("cannot suspend session {name} without a running agent");
        }

        let current = session.suspend_origin();
        if current == SuspendOrigin::Manual && origin == SuspendOrigin::Manual {
            if state.as_deref() == Some("suspended") {
                return Ok(());
            }
            return Self::signal_supervisor(name, &session, nix::libc::SIGUSR1);
        }
        if current != SuspendOrigin::None
            && !(current == SuspendOrigin::Pressure && origin == SuspendOrigin::Manual)
        {
            anyhow::bail!("session {name} is already suspended by {current:?}");
        }
        if current == SuspendOrigin::None && state.as_deref() != Some("claude") {
            anyhow::bail!("cannot newly suspend session {name} while it is suspended");
        }

        let previous = session.claim_suspend(origin).map_err(|existing| {
            anyhow::anyhow!("session {name} is already suspended by {existing:?}")
        })?;
        let previous_started = session.memory_suspend_started_ms();
        match origin {
            SuspendOrigin::Pressure => {
                session.set_memory_suspend_started_ms(crate::pty::monotonic_ms().max(1));
            }
            SuspendOrigin::Manual => session.set_memory_suspend_started_ms(0),
            SuspendOrigin::None => unreachable!(),
        }

        if previous == SuspendOrigin::Pressure && state.as_deref() == Some("suspended") {
            return Ok(());
        }
        if let Err(error) = Self::signal_supervisor(name, &session, nix::libc::SIGUSR1) {
            session.restore_suspend_origin(origin, previous);
            session.set_memory_suspend_started_ms(previous_started);
            return Err(error);
        }
        Ok(())
    }

    fn resume_locked(
        &self,
        name: &str,
        session: &Arc<PtySession>,
        cause: ResumeCause,
    ) -> anyhow::Result<bool> {
        let origin = session.suspend_origin();
        let eligible = match cause {
            ResumeCause::Manual => origin != SuspendOrigin::None,
            ResumeCause::Focus => origin == SuspendOrigin::Pressure,
        };
        if !eligible {
            return Ok(false);
        }
        let is_agent = self
            .effective_meta_for(name, session)?
            .map(|meta| meta.kind.is_agent())
            .unwrap_or(false);
        if !is_agent {
            anyhow::bail!("resume applies only to agent sessions: {name}");
        }
        if !session.initial_suspend_ready() || session.run_state().as_deref() != Some("suspended") {
            session.queue_pending_resume();
            return Ok(true);
        }
        Self::signal_supervisor(name, session, nix::libc::SIGUSR2)?;
        session.clear_suspend_origin();
        session.set_memory_suspend_started_ms(0);
        Ok(true)
    }

    fn resume_for_focus_locked(
        &self,
        name: &str,
        session: &Arc<PtySession>,
    ) -> anyhow::Result<bool> {
        self.resume_locked(name, session, ResumeCause::Focus)
    }

    pub fn resume(&self, name: &str, cause: ResumeCause) -> anyhow::Result<bool> {
        let session = self
            .session(name)
            .ok_or_else(|| anyhow::anyhow!("no such session: {name}"))?;
        let _transition = session.lock_suspend_transition();
        self.ensure_current_session(name, &session)?;
        session.mark_user_activity();
        self.resume_locked(name, &session, cause)
    }

    pub fn focus_session(&self, name: &str) -> anyhow::Result<bool> {
        let session = self
            .session(name)
            .ok_or_else(|| anyhow::anyhow!("no such session: {name}"))?;
        let foreground_changed;
        let result;
        {
            let _transition = session.lock_suspend_transition();
            self.ensure_current_session(name, &session)?;
            foreground_changed = self.set_foreground_locked(name, &session)?;
            session.mark_user_activity();
            result = self.resume_for_focus_locked(name, &session);
        }
        if foreground_changed {
            self.reconcile_cpu_weights();
        }
        result
    }

    pub fn names(&self) -> Vec<String> {
        let mut v: Vec<String> = self.sessions.lock().unwrap().keys().cloned().collect();
        v.sort();
        v
    }

    /// Search point-in-time copies of retained rings. The session-table lock is
    /// held only while cloning Arcs; each ring is copied with that lock released,
    /// and text processing occurs after every daemon-wide lock is gone.
    pub fn search_scrollback(
        &self,
        query: &str,
        names: &[String],
        limit: u16,
    ) -> anyhow::Result<Vec<SearchResult>> {
        Ok(self.search_scrollback_cancellable(query, names, limit, &|| false)?.unwrap_or_default())
    }

    pub fn search_scrollback_cancellable(
        &self,
        query: &str,
        names: &[String],
        limit: u16,
        cancelled: &dyn Fn() -> bool,
    ) -> anyhow::Result<Option<Vec<SearchResult>>> {
        // Reject bad requests before copying a single retained ring.
        crate::search::validate_query(query)?;
        let wanted: HashSet<&str> = names.iter().map(String::as_str).collect();
        let handles: Vec<(String, Arc<PtySession>)> = self
            .sessions
            .lock()
            .unwrap()
            .iter()
            .filter(|(name, _)| wanted.is_empty() || wanted.contains(name.as_str()))
            .map(|(name, session)| (name.clone(), Arc::clone(session)))
            .collect();
        let mut snapshots = Vec::with_capacity(handles.len());
        for (name, session) in handles {
            if cancelled() { return Ok(None) }
            snapshots.push((name, session.scrollback()));
        }
        crate::search::search_snapshots_cancellable(query, &snapshots, names, limit, cancelled)
    }

    /// One [`SessionInfo`] per live session, joining the live table (existence
    /// + liveness) with the persisted metadata (cwd/kind). Sorted by name.
    pub fn session_infos(&self) -> anyhow::Result<Vec<SessionInfo>> {
        let sessions: HashMap<String, Arc<PtySession>> = self
            .sessions
            .lock()
            .unwrap()
            .iter()
            .map(|(name, session)| (name.clone(), Arc::clone(session)))
            .collect();
        let mut infos: Vec<SessionInfo> = self
            .store
            .list_sessions()?
            .into_iter()
            .filter_map(|persisted| {
                let sess = sessions.get(&persisted.name)?;
                let meta = self
                    .deferred_meta_for(&persisted.name, sess)
                    .unwrap_or(persisted);
                Some(SessionInfo {
                    name: meta.name.clone(),
                    cwd: meta.cwd.to_string_lossy().into_owned(),
                    kind: meta.kind.as_str().to_string(),
                    alive: sess.is_alive(),
                    updated: meta.updated,
                    run_state: match (sess.run_state(), sess.suspend_origin()) {
                        (Some(state), SuspendOrigin::Pressure) if state == "suspended" => {
                            Some("resource-suspended".to_string())
                        }
                        (state, _) => state,
                    },
                    claude_id: self
                        .store
                        .read_claude(&meta.name)
                        .ok()
                        .flatten()
                        .map(|c| c.session_id),
                    cols: sess.size().map(|(_, c)| c).unwrap_or(0),
                    rows: sess.size().map(|(r, _)| r).unwrap_or(0),
                    slot: meta.slot,
                })
            })
            .collect();
        infos.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(infos)
    }

    pub fn write(&self, name: &str, bytes: &[u8]) -> anyhow::Result<()> {
        let session = self
            .session(name)
            .ok_or_else(|| anyhow::anyhow!("no such session: {name}"))?;
        let foreground_changed;
        let result;
        {
            let _transition = session.lock_suspend_transition();
            self.ensure_current_session(name, &session)?;
            foreground_changed = self.set_foreground_locked(name, &session)?;
            session.mark_user_activity();
            result = (|| {
                self.resume_for_focus_locked(name, &session)?;
                if session.suspend_origin() == SuspendOrigin::Manual {
                    anyhow::bail!("session is manually suspended: {name}");
                }
                session.write(bytes)
            })();
        }
        if foreground_changed {
            self.reconcile_cpu_weights();
        }
        result
    }

    pub fn resize(&self, name: &str, rows: u16, cols: u16) -> anyhow::Result<()> {
        let sess = self
            .session(name)
            .ok_or_else(|| anyhow::anyhow!("no such session: {name}"))?;
        sess.resize(rows, cols)
    }

    /// Remove sessions whose child has exited ("child exits -> session
    /// ends", spec §6.1), deleting their persisted artifacts so they are not
    /// respawned on the next daemon start. Returns the reaped names.
    pub fn reap(&self) -> anyhow::Result<Vec<String>> {
        let _maint = self.maintenance.lock().unwrap();
        self.finish_pending_rename()?;
        let dead: Vec<(String, Arc<PtySession>)> = self
            .sessions
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, session)| !session.is_alive())
            .map(|(name, session)| (name.clone(), Arc::clone(session)))
            .collect();
        let mut reaped = Vec::new();
        for (name, session) in dead {
            let exit_code = session.exit_code();
            let result = (|| -> anyhow::Result<()> {
                let _transition = session.lock_suspend_transition();
                let meta = self
                    .effective_meta_for(&name, &session)?
                    .ok_or_else(|| anyhow::anyhow!("dead session {name} has no metadata"))?;
                self.stop_session_locked(meta.slot, Some(&session))?;
                self.store.remove_session(&name)?;
                self.sessions.lock().unwrap().remove(&name);
                self.clear_foreground_slot(meta.slot);
                Ok(())
            })();
            match result {
                Ok(()) => {
                    self.record_recovery_event(
                        "warning", "session.exited", Some(&name),
                        "session child exited and was reaped", exit_code,
                    );
                    reaped.push(name);
                }
                Err(error) => {
                    eprintln!("amber daemon: could not reap session {name}: {error}");
                }
            }
        }
        if !reaped.is_empty() {
            self.reconcile_cpu_weights();
        }
        Ok(reaped)
    }

    /// Rename a session — the daemon-side half of a cross-tab pane move (the
    /// tab lives in the session name, core rule #2, so a move IS a rename).
    /// Returns the renamed session's fresh [`SessionInfo`].
    ///
    /// A **shell** moves in place: same pty, same child, same scrollback — only
    /// the key and the store files change. Its already-running shell keeps a now
    /// stale `AMBER_SESSION` env; that only matters to a claude the user starts
    /// BY HAND inside it (its SessionStart hook records under the old name until
    /// the shell restarts) — accepted edge case.
    ///
    /// A **claude** session is respawned under the new name: its supervisor is
    /// env-bound to its name (`amber run <name>`, fixed at spawn), so the child
    /// is killed and re-spawned via the normal restore path. The migrated
    /// `claude/<to>.json` makes it `--resume` the SAME conversation; claude is a
    /// full-screen TUI, so the redraw is the only visible cost.
    ///
    pub fn rename(&self, from: &str, to: &str) -> anyhow::Result<SessionInfo> {
        Self::validate_name(to)?;
        let _maint = self.maintenance.lock().unwrap();
        self.finish_pending_rename()?;
        if self.sessions.lock().unwrap().contains_key(to) || self.store.read_session(to)?.is_some()
        {
            anyhow::bail!("session already exists: {to}");
        }
        let sess = self
            .sessions
            .lock()
            .unwrap()
            .get(from)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("no such session: {from}"))?;
        let old_meta = self
            .effective_meta_for(from, &sess)?
            .ok_or_else(|| anyhow::anyhow!("session {from} vanished from the store"))?;
        let size = sess.size();
        let _transition = old_meta
            .kind
            .is_agent()
            .then(|| sess.lock_suspend_transition());
        let suspension = (sess.suspend_origin() != SuspendOrigin::None)
            .then(|| (sess.suspend_origin(), sess.memory_suspend_started_ms()));

        if old_meta.kind.is_agent() {
            self.stop_session_locked(old_meta.slot, Some(&sess))?;
        }
        if let Err(error) = self.store.rename_session(from, to) {
            if old_meta.kind.is_agent() {
                let rollback =
                    self.rollback_agent_rename(from, to, &old_meta, size, suspension, false);
                drop(_transition);
                self.reconcile_cpu_weights();
                if let Err(rollback) = rollback {
                    anyhow::bail!("{error}; rename rollback failed: {rollback}");
                }
            }
            return Err(error);
        }

        let meta = SessionMeta {
            name: to.to_string(),
            ..old_meta.clone()
        };
        let sess = if meta.kind.is_agent() {
            let fresh = match self
                .cgroups
                .prepare_session(meta.slot)
                .map_err(anyhow::Error::from)
                .and_then(|_| self.restore_one_with_suspension(&meta, suspension))
            {
                Ok(fresh) => fresh,
                Err(error) => {
                    let rollback =
                        self.rollback_agent_rename(from, to, &old_meta, size, suspension, true);
                    drop(_transition);
                    self.reconcile_cpu_weights();
                    if let Err(rollback) = rollback {
                        anyhow::bail!("{error}; rename rollback failed: {rollback}");
                    }
                    return Err(error);
                }
            };
            if let Some((rows, cols)) = size {
                let _ = fresh.resize(rows, cols);
            }
            fresh
        } else {
            // Only the name baked into the activity hook's closure is stale.
            if let Some(watchers) = &self.watchers {
                let watchers = Arc::clone(watchers);
                let name = to.to_string();
                sess.set_activity_hook(Box::new(move || {
                    watchers.broadcast(&ControlMsg::Activity { name: name.clone() });
                }));
            }
            Arc::clone(&sess)
        };
        {
            let mut sessions = self.sessions.lock().unwrap();
            sessions.remove(from);
            sessions.insert(to.to_string(), Arc::clone(&sess));
        }
        self.claude_absent.lock().unwrap().remove(from);
        drop(_transition);
        self.reconcile_cpu_weights();

        Ok(SessionInfo {
            name: meta.name,
            cwd: meta.cwd.to_string_lossy().into_owned(),
            kind: meta.kind.as_str().to_string(),
            alive: sess.is_alive(),
            updated: meta.updated,
            run_state: sess.run_state(),
            claude_id: self
                .store
                .read_claude(to)
                .ok()
                .flatten()
                .map(|c| c.session_id),
            cols: sess.size().map(|(_, c)| c).unwrap_or(0),
            rows: sess.size().map(|(r, _)| r).unwrap_or(0),
            // A rename carries the slot across unchanged (spec §2): the slot
            // keys off the session, not its name.
            slot: meta.slot,
        })
    }

    /// Kill and forget a session, removing its persisted artifacts.
    pub fn remove(&self, name: &str) -> anyhow::Result<()> {
        // Held across the whole removal so a snapshot that is mid-write cannot
        // recreate the artifacts this is deleting (lock order: maintenance
        // before sessions, matching `snapshot_inner`).
        let _maint = self.maintenance.lock().unwrap();
        self.finish_pending_rename()?;
        let sess = self.sessions.lock().unwrap().get(name).cloned();
        let meta = match &sess {
            Some(session) => self.effective_meta_for(name, session)?,
            None => self.store.read_session(name)?,
        };
        {
            let _transition = sess
                .as_ref()
                .map(|session| session.lock_suspend_transition());
            if let Some(ref meta) = meta {
                self.stop_session_locked(meta.slot, sess.as_ref())?;
            } else if let Some(sess) = &sess {
                sess.kill()?;
                if !sess.wait_for_exit(CHILD_EXIT_TIMEOUT) {
                    anyhow::bail!("session child {name} did not exit after termination");
                }
            }
            self.store.remove_session(name)?;
            self.sessions.lock().unwrap().remove(name);
            if let Some(ref meta) = meta {
                self.clear_foreground_slot(meta.slot);
            }
        }
        self.reconcile_cpu_weights();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cgroup::CgroupManager;
    use crate::pty::SuspendOrigin;
    use portable_pty::CommandBuilder;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicBool, AtomicUsize};
    use std::sync::{mpsc, Barrier, Condvar};
    use tempfile::tempdir;

    fn with_fake_cgroups(state: &Path, cgroup_root: &Path) -> SessionManager {
        SessionManager::new_with_cgroups(
            state,
            Config::default(),
            CgroupManager::test_root(cgroup_root),
        )
        .unwrap()
    }

    fn with_fake_cpu_cgroups(state: &Path, cgroup_root: &Path) -> SessionManager {
        SessionManager::new_with_cgroups(
            state,
            Config::default(),
            CgroupManager::test_root_with_cpu(cgroup_root),
        )
        .unwrap()
    }

    #[test]
    fn set_memory_budget_persists_and_moves_the_live_handle_and_leaves() {
        // The whole feature: a budget change survives (config write) AND takes
        // effect immediately (guardian handle + existing session leaves),
        // without a daemon restart.
        let dir = tempdir().unwrap();
        let state = dir.path().join("state");
        std::fs::create_dir_all(&state).unwrap();
        let cgroup_root = dir.path().join("cg");
        std::fs::create_dir_all(&cgroup_root).unwrap();
        let shell = dir.path().join("quiet-shell");
        std::fs::write(&shell, "#!/bin/sh\nprintf READY\\n\nsleep 60\n").unwrap();
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mgr = SessionManager::new_with_cgroups(
            &state,
            Config::default(),
            CgroupManager::test_root(&cgroup_root),
        )
        .unwrap()
        .with_test_shell(shell.into_os_string());
        mgr.store_effective_budget_kb(Some(4 * 1024 * 1024));

        // A live session so one materialised leaf exists to be moved.
        let sess = mgr
            .create("amber-1-1-0-a", "/tmp", SessionKind::Shell)
            .unwrap();
        wait_for_output(&sess, b"READY");
        let high = cgroup_root.join("session-1").join("memory.high");
        assert!(high.exists(), "prepare_session must have written the leaf");
        assert_eq!(std::fs::read_to_string(&high).unwrap().trim(), "0");

        let status = mgr.set_memory_budget(Some(20_480)).unwrap();
        assert_eq!(status.configured_mb, Some(20_480));
        assert_eq!(
            mgr.effective_budget_kb(),
            status.effective_budget_kb,
            "the guardian handle must move with the set"
        );

        // Persisted: a fresh manager loads the same configured value.
        let reloaded = SessionManager::new(&state).unwrap();
        assert_eq!(
            reloaded.get_memory_budget().unwrap().configured_mb,
            Some(20_480)
        );

        // Auto clears the override.
        let auto = mgr.set_memory_budget(None).unwrap();
        assert_eq!(auto.configured_mb, None);
    }

    fn wait_for_output(session: &PtySession, needle: &[u8]) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !session
            .scrollback()
            .windows(needle.len())
            .any(|bytes| bytes == needle)
        {
            assert!(
                std::time::Instant::now() < deadline,
                "missing output {needle:?}"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    fn fake_agent(mgr: &SessionManager, name: &str) -> Arc<PtySession> {
        fake_agent_with_slot(mgr, name, 1)
    }

    fn fake_agent_with_slot(mgr: &SessionManager, name: &str, slot: u32) -> Arc<PtySession> {
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg(
            "trap 'printf RESUME_SIGNAL\\n' USR2; \
             trap 'printf SUSPEND_SIGNAL\\n' USR1; \
             printf READY\\n; \
             while :; do \
               if IFS= read -r line; then printf 'INPUT:%s\\n' \"$line\"; \
               else sleep 0.05; fi; \
             done",
        );
        let session = Arc::new(PtySession::spawn(cmd, 24, 80, 4096).unwrap());
        wait_for_output(&session, b"READY");
        mgr.store
            .write_session(&SessionMeta {
                name: name.to_string(),
                cwd: PathBuf::from("/tmp"),
                kind: SessionKind::Claude,
                updated: 1,
                resume_as_claude: false,
                run_state: None,
                slot,
            })
            .unwrap();
        session.set_run_state(Some("claude".into()));
        mgr.sessions
            .lock()
            .unwrap()
            .insert(name.to_string(), Arc::clone(&session));
        session
    }

    fn record_resume_id(mgr: &SessionManager, name: &str, cwd: &Path) {
        mgr.store
            .write_claude(
                name,
                &amber_core::state::ClaudeMeta {
                    session_id: format!("resume-{name}"),
                    cwd: cwd.to_path_buf(),
                    updated: 1,
                },
            )
            .unwrap();
    }

    fn write_rename_journal(root: &Path, from: &str, to: &str, mut source: SessionMeta) {
        source.name = from.to_string();
        std::fs::write(
            root.join("rename.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "from": from,
                "to": to,
                "source": source,
            }))
            .unwrap(),
        )
        .unwrap();
    }

    /// The display allowlist: takes only the wanted keys, unquotes a systemd
    /// quoted value, and drops an empty one (a blank `DISPLAY=` fails
    /// differently — and worse — than no `DISPLAY` at all).
    #[cfg(target_os = "linux")]
    #[test]
    fn picks_display_env_from_a_manager_block() {
        let block = "LANG=en_US.UTF-8\n\
                     DISPLAY=:1\n\
                     XAUTHORITY=\"/run/user/1000/.mutter-Xwaylandauth.ABC123\"\n\
                     WAYLAND_DISPLAY=\n\
                     PATH=/usr/bin\n\
                     not-an-assignment\n";
        let got = pick_env(block, &["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"]);
        assert_eq!(
            got,
            vec![
                ("DISPLAY".to_string(), ":1".to_string()),
                (
                    "XAUTHORITY".to_string(),
                    "/run/user/1000/.mutter-Xwaylandauth.ABC123".to_string()
                ),
            ]
        );
    }

    /// Persist a shell session's metadata directly (no live spawn) with an
    /// unreadable scrollback file, so `restore_one` fails on the read step —
    /// a real, spawn-independent way to force a restore loss.
    fn seed_unrestorable_session(root: &Path, name: &str) {
        let store = StateStore::new(root);
        store
            .write_session(&SessionMeta {
                name: name.to_string(),
                cwd: PathBuf::from("/"),
                kind: SessionKind::Shell,
                updated: 0,
                resume_as_claude: false,
                run_state: None,
                slot: 1,
            })
            .unwrap();
        store.write_scrollback(name, b"junk").unwrap();
        let path = root.join("scrollback").join(format!("{name}.bin"));
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
    }

    #[test]
    fn restore_writes_crash_report_after_unclean_shutdown_with_losses() {
        let dir = tempdir().unwrap();
        seed_unrestorable_session(dir.path(), "victim");

        let mgr = SessionManager::new(dir.path()).unwrap();
        // No mark_clean_shutdown() call — this boot looks like a crash.
        mgr.restore().unwrap();

        let report = dir.path().join("last-crash-report.json");
        let body = std::fs::read_to_string(&report).expect("crash report written");
        assert!(body.contains("victim"));
    }

    #[test]
    fn restore_stays_silent_after_a_clean_shutdown() {
        let dir = tempdir().unwrap();
        seed_unrestorable_session(dir.path(), "victim");

        let mgr = SessionManager::new(dir.path()).unwrap();
        mgr.mark_clean_shutdown().unwrap();
        mgr.restore().unwrap();

        // A loss right after a CLEAN shutdown isn't a crash — don't cry wolf.
        assert!(!dir.path().join("last-crash-report.json").exists());
    }

    #[test]
    fn clean_shutdown_marker_is_single_use() {
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        mgr.mark_clean_shutdown().unwrap();
        assert!(dir.path().join("clean-shutdown").exists());
        mgr.restore().unwrap();
        assert!(!dir.path().join("clean-shutdown").exists());
    }

    #[test]
    fn repair_deleted_exe_strips_suffix_when_path_reappears() {
        let dir = tempdir().unwrap();
        let real = dir.path().join("amber");
        std::fs::write(&real, b"stand-in binary").unwrap();
        let ghost = PathBuf::from(format!("{} (deleted)", real.display()));
        assert_eq!(repair_deleted_exe(&ghost), Some(real));
    }

    #[test]
    fn repair_deleted_exe_none_when_path_never_comes_back() {
        let dir = tempdir().unwrap();
        let ghost = PathBuf::from(format!("{}/amber (deleted)", dir.path().display()));
        assert_eq!(repair_deleted_exe(&ghost), None);
    }

    #[test]
    fn repair_deleted_exe_none_without_the_suffix() {
        // A path that just plain doesn't exist (no reinstall race) must not
        // be misread as a deleted-and-reinstalled binary.
        let dir = tempdir().unwrap();
        let missing = dir.path().join("amber");
        assert_eq!(repair_deleted_exe(&missing), None);
    }

    #[test]
    fn decide_resume_upgrades_immediately_on_detection() {
        // claude seen => true, streak reset — from either prior state.
        assert_eq!(decide_resume(false, true, 0, 2), (true, 0));
        assert_eq!(decide_resume(true, true, 1, 2), (true, 0));
    }

    #[test]
    fn decide_resume_holds_through_one_transient_miss() {
        // A live claude pane (current=true) that misses ONCE stays true (streak 1).
        assert_eq!(decide_resume(true, false, 0, 2), (true, 1));
        // The SECOND consecutive miss reaches the threshold and downgrades.
        assert_eq!(decide_resume(true, false, 1, 2), (false, 0));
    }

    #[test]
    fn decide_resume_stays_false_when_never_claude() {
        // A plain shell that was never claude stays false, streak stays 0.
        assert_eq!(decide_resume(false, false, 0, 2), (false, 0));
    }

    #[test]
    fn session_infos_projects_metadata_for_live_sessions() {
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        mgr.create("amber-1-1-0-a", "/tmp", SessionKind::Shell)
            .unwrap();
        mgr.create("amber-1-1-1-b", dir.path(), SessionKind::Claude)
            .unwrap();

        let mut infos = mgr.session_infos().unwrap();
        infos.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(infos.len(), 2);
        assert_eq!(infos[0].name, "amber-1-1-0-a");
        assert_eq!(infos[0].kind, "shell");
        assert_eq!(infos[0].cwd, "/tmp");
        assert!(infos[0].alive);
        assert_eq!(infos[1].kind, "claude");
    }

    #[test]
    fn create_rejects_names_that_escape_the_state_dir() {
        // Session names become file paths (`sessions/<name>.json`,
        // `scrollback/<name>.bin`); a hostile name must never write outside
        // the state root or spawn anything.
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        for bad in ["../evil", "a/b", "/abs", "", ".", "..", "nul\0byte"] {
            assert!(
                mgr.create(bad, "/tmp", SessionKind::Shell).is_err(),
                "name {bad:?} should be rejected"
            );
        }
        assert!(mgr.names().is_empty(), "no session may be tracked");
        assert!(
            !dir.path().parent().unwrap().join("evil.json").exists(),
            "traversal name escaped the state dir"
        );
    }

    #[test]
    fn create_refuses_an_existing_name_and_leaves_the_live_session_alone() {
        // Creating over a live name used to overwrite the table entry, orphaning
        // the running child — reachable without meaning to now that bare `amber`
        // picks its own `s<n>` from a listing (two racing invocations can choose
        // the same one). A duplicate must be an error, and the ORIGINAL session
        // must still be the one in the table.
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        mgr.create("s1", "/tmp", SessionKind::Shell).unwrap();
        let first = mgr.session("s1").unwrap();

        assert!(mgr.create("s1", "/tmp", SessionKind::Shell).is_err());
        let still = mgr.session("s1").unwrap();
        assert!(Arc::ptr_eq(&first, &still), "the live session was replaced");
        assert_eq!(mgr.names().len(), 1);
    }

    #[test]
    fn snapshot_persists_a_shells_live_cwd_after_cd() {
        // A `cd` inside a shell must survive restart: snapshot reads the child's
        // live /proc/<pid>/cwd and updates the stored cwd.
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        mgr.create("sh", "/tmp", SessionKind::Shell).unwrap();
        let sess = mgr.session("sh").unwrap();

        let target = std::fs::canonicalize(dir.path()).unwrap();
        sess.write(format!("cd '{}'\n", target.display()).as_bytes())
            .unwrap();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while sess.live_cwd() != Some(target.clone()) {
            assert!(std::time::Instant::now() < deadline, "shell never cd'd");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        mgr.snapshot().unwrap();
        let meta = mgr.store.read_session("sh").unwrap().unwrap();
        assert_eq!(meta.cwd, target, "snapshot did not capture the cd'd dir");
    }

    #[test]
    fn periodic_snapshot_does_not_mutate_metadata_while_rename_cleanup_is_pending() {
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        let from = "amber-1-1-0-snapshot";
        let to = "amber-1-2-0-snapshot";
        mgr.create(to, "/tmp", SessionKind::Shell).unwrap();
        let sess = mgr.session(to).unwrap();
        let expected = mgr.store.read_session(to).unwrap().unwrap();
        mgr.store
            .write_session(&SessionMeta {
                name: from.to_string(),
                ..expected.clone()
            })
            .unwrap();
        write_rename_journal(dir.path(), from, to, expected.clone());
        let obstruction = dir.path().join(format!("claude/{from}.json"));
        std::fs::create_dir_all(&obstruction).unwrap();

        let target = std::fs::canonicalize(dir.path()).unwrap();
        sess.write(format!("cd '{}'\n", target.display()).as_bytes())
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while sess.live_cwd() != Some(target.clone()) {
            assert!(std::time::Instant::now() < deadline, "shell never cd'd");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        assert!(
            mgr.snapshot().is_err(),
            "snapshot ignored pending rename cleanup"
        );
        assert_eq!(mgr.store.read_session(to).unwrap(), Some(expected));
        assert!(dir.path().join("rename.json").exists());

        std::fs::remove_dir(obstruction).unwrap();
        mgr.snapshot().unwrap();
        assert_eq!(mgr.store.read_session(to).unwrap().unwrap().cwd, target);
        assert!(!dir.path().join("rename.json").exists());
    }

    #[test]
    fn snapshot_skips_a_session_whose_scrollback_did_not_change() {
        // The snapshot ran every 10 s and unconditionally cloned + rewrote every
        // ring. Measured live: 18 sessions all at their 2 MiB cap = 36 MiB of
        // transient allocation AND 36 MiB of disk writes every tick (~3.6 MB/s
        // forever) for panes that were idle. An unchanged ring must cost nothing.
        //
        // Observed directly rather than via mtime (too coarse to be non-flaky):
        // delete the file after the first snapshot; if the second snapshot skips
        // the write, it stays deleted.
        let dir = tempdir().unwrap();
        let shell = dir.path().join("quiet-shell");
        std::fs::write(&shell, "#!/bin/sh\nprintf READY\\n\nsleep 60\n").unwrap();
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mgr = SessionManager::new(dir.path())
            .unwrap()
            .with_test_shell(shell.into_os_string());
        mgr.create("idle", "/tmp", SessionKind::Shell).unwrap();
        let sess = mgr.session("idle").unwrap();
        wait_for_output(&sess, b"READY");
        // Wait for the shell's startup output (prompt, rc-file noise) to STOP,
        // rather than sleeping a fixed span: under a loaded parallel test run a
        // slow shell can emit its prompt after any constant we would pick, and
        // then the second snapshot is *correctly* not a skip. Poll the ring's
        // write counter until it holds still.
        let mut last = sess.scrollback_written();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            std::thread::sleep(std::time::Duration::from_millis(250));
            let now = sess.scrollback_written();
            if now == last {
                break;
            }
            last = now;
            assert!(
                std::time::Instant::now() < deadline,
                "shell never went quiet"
            );
        }

        mgr.snapshot().unwrap();
        let path = dir.path().join("scrollback").join("idle.bin");
        assert!(path.exists(), "first snapshot must write the scrollback");
        std::fs::remove_file(&path).unwrap();

        let before = sess.scrollback_written();
        mgr.snapshot().unwrap();
        // Precondition, checked explicitly so a late byte reports itself instead
        // of masquerading as a failure of the skip.
        assert_eq!(
            before,
            sess.scrollback_written(),
            "the session emitted output between the two snapshots — not an idle window"
        );
        assert!(
            !path.exists(),
            "an idle session's unchanged scrollback was rewritten"
        );

        // ...and real output must still be persisted: the skip is keyed on the
        // ring's monotonic write counter, not on a timer.
        let before = sess.scrollback_written();
        sess.write(b"printf SNAPSHOT_MARKER\n").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while sess.scrollback_written() == before {
            assert!(
                std::time::Instant::now() < deadline,
                "no output reached the ring"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        mgr.snapshot().unwrap();
        assert!(
            path.exists(),
            "a changed scrollback must still be persisted"
        );
    }

    #[test]
    fn create_stores_absolute_cwd_for_relative_input() {
        // A relative `.` would resolve against the daemon's launch dir (which
        // differs between hand-start and systemd), breaking claude resume.
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        mgr.create("amber-1-1-0-a", ".", SessionKind::Shell)
            .unwrap();
        let cwd = mgr.session_infos().unwrap()[0].cwd.clone();
        let home = std::env::var("HOME").unwrap_or_default();
        assert_eq!(cwd, home, "'.' must resolve to an absolute, stable $HOME");
        assert!(Path::new(&cwd).is_absolute());
    }

    #[test]
    fn reap_and_remove_clear_session_cgroups() {
        // "Child exits -> session ends" (spec §6.1): a dead session must
        // leave the live table and the state store, while live ones stay.
        let dir = tempdir().unwrap();
        let cgroups = tempdir().unwrap();
        let mgr = with_fake_cgroups(dir.path(), cgroups.path());
        mgr.create("removed", "/tmp", SessionKind::Shell).unwrap();
        let removed_slot = mgr.store.read_session("removed").unwrap().unwrap().slot;
        assert!(cgroups
            .path()
            .join(format!("session-{removed_slot}"))
            .exists());
        mgr.remove("removed").unwrap();
        assert!(!cgroups
            .path()
            .join(format!("session-{removed_slot}"))
            .exists());

        mgr.create("dies", "/tmp", SessionKind::Shell).unwrap();
        mgr.create("lives", "/tmp", SessionKind::Shell).unwrap();
        let dead_slot = mgr.store.read_session("dies").unwrap().unwrap().slot;

        mgr.write("dies", b"exit\n").unwrap();
        let sess = mgr.session("dies").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while sess.is_alive() {
            assert!(std::time::Instant::now() < deadline, "shell never exited");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }

        let reaped = mgr.reap().unwrap();
        assert_eq!(reaped, vec!["dies".to_string()]);
        assert_eq!(mgr.names(), vec!["lives".to_string()]);
        assert!(!dir.path().join("sessions/dies.json").exists());
        assert!(dir.path().join("sessions/lives.json").exists());
        assert!(!cgroups.path().join(format!("session-{dead_slot}")).exists());
    }

    #[test]
    fn cpu_weight_failures_do_not_block_session_create_or_focus() {
        let dir = tempdir().unwrap();
        let cgroups = tempdir().unwrap();
        let mgr = with_fake_cpu_cgroups(dir.path(), cgroups.path());

        mgr.create("background", "/tmp", SessionKind::Shell)
            .unwrap();
        mgr.create("foreground", "/tmp", SessionKind::Shell)
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(cgroups.path().join("session-1/cpu.weight")).unwrap(),
            "100",
            "new sessions must start with background CPU priority",
        );

        assert!(!mgr.focus_session("foreground").unwrap());
        assert_eq!(
            std::fs::read_to_string(cgroups.path().join("session-2/cpu.weight")).unwrap(),
            "1000",
            "the focused stable slot gets the foreground CPU priority",
        );

        std::fs::remove_file(cgroups.path().join("session-2/cpu.weight")).unwrap();
        assert!(
            mgr.focus_session("background").is_ok(),
            "a missing optional cpu.weight must not break focus",
        );
        assert_eq!(mgr.foreground_slot(), 1);
    }

    #[test]
    fn concurrent_focus_reconciliation_uses_latest_slot_without_holding_transition_lock() {
        // Regression: two Focus handlers used to scan/write the cgroup tree
        // concurrently. This hook holds the slot-1 scan until the slot-2 scan
        // finishes, which deterministically left the older slot promoted.
        #[derive(Default)]
        struct RaceState {
            first_started: bool,
            second_finished: bool,
        }

        let dir = tempdir().unwrap();
        let cgroups = tempdir().unwrap();
        let mgr = Arc::new(with_fake_cpu_cgroups(dir.path(), cgroups.path()));
        mgr.create("first", dir.path(), SessionKind::Shell)
            .unwrap();
        mgr.create("second", dir.path(), SessionKind::Shell)
            .unwrap();
        let first_session = mgr.session("first").unwrap();
        let coordination = Arc::new((Mutex::new(RaceState::default()), Condvar::new()));
        let transition_was_held = Arc::new(AtomicBool::new(false));
        let events = Arc::new(Mutex::new(Vec::new()));
        mgr.set_cpu_reconcile_hook({
            let cgroup_root = cgroups.path().to_path_buf();
            let coordination = Arc::clone(&coordination);
            let first_session = Arc::clone(&first_session);
            let transition_was_held = Arc::clone(&transition_was_held);
            let events = Arc::clone(&events);
            Arc::new(move |point, foreground_slot| {
                events.lock().unwrap().push((point, foreground_slot));
                if point == CpuReconcilePoint::Start {
                    // Regular fake files retain the trailing byte when "100"
                    // overwrites "1000"; real cgroup control files do not.
                    // Clear them at each pass boundary so assertions model the
                    // kernel control-file semantics rather than regular-file
                    // overwrite semantics.
                    for slot in [1, 2] {
                        std::fs::write(
                            cgroup_root.join(format!("session-{slot}/cpu.weight")),
                            "",
                        )
                        .unwrap();
                    }
                }
                let (state, changed) = &*coordination;
                match (point, foreground_slot) {
                    (CpuReconcilePoint::Start, 1) => {
                        transition_was_held.store(
                            first_session.suspend_transition_locked_for_test(),
                            Ordering::SeqCst,
                        );
                        let mut state = state.lock().unwrap();
                        state.first_started = true;
                        changed.notify_all();
                        let _ = changed
                            .wait_timeout_while(
                                state,
                                Duration::from_millis(500),
                                |state| !state.second_finished,
                            )
                            .unwrap();
                    }
                    (CpuReconcilePoint::Finish, 2) => {
                        let mut state = state.lock().unwrap();
                        state.second_finished = true;
                        changed.notify_all();
                    }
                    _ => {}
                }
            })
        });

        let first_start = Arc::new(Barrier::new(2));
        let first_focus = {
            let mgr = Arc::clone(&mgr);
            let first_start = Arc::clone(&first_start);
            std::thread::spawn(move || {
                first_start.wait();
                mgr.focus_session("first")
            })
        };
        first_start.wait();
        {
            let (state, changed) = &*coordination;
            let state = state.lock().unwrap();
            let (state, timeout) = changed
                .wait_timeout_while(state, Duration::from_secs(5), |state| {
                    !state.first_started
                })
                .unwrap();
            assert!(state.first_started && !timeout.timed_out());
        }
        let second_focus = {
            let mgr = Arc::clone(&mgr);
            std::thread::spawn(move || mgr.focus_session("second"))
        };

        assert!(!second_focus.join().unwrap().unwrap());
        assert!(!first_focus.join().unwrap().unwrap());
        assert_eq!(mgr.foreground_slot(), 2);
        assert_eq!(
            *events.lock().unwrap(),
            [
                (CpuReconcilePoint::Start, 1),
                (CpuReconcilePoint::Finish, 1),
                (CpuReconcilePoint::Start, 2),
                (CpuReconcilePoint::Finish, 2),
            ],
            "reconciliation passes must not overlap",
        );
        assert_eq!(
            std::fs::read_to_string(cgroups.path().join("session-1/cpu.weight")).unwrap(),
            "100",
            "an older concurrent reconciliation must not leave its slot promoted",
        );
        assert_eq!(
            std::fs::read_to_string(cgroups.path().join("session-2/cpu.weight")).unwrap(),
            "1000",
            "the latest foreground slot must own the final weight set",
        );
        assert!(
            !transition_was_held.load(Ordering::SeqCst),
            "the O(session-count) scan must run after releasing the per-session transition lock",
        );
    }

    #[test]
    fn repeated_input_on_the_foreground_slot_skips_cpu_reconciliation() {
        let dir = tempdir().unwrap();
        let cgroups = tempdir().unwrap();
        let mgr = with_fake_cpu_cgroups(dir.path(), cgroups.path());
        mgr.create("foreground", dir.path(), SessionKind::Shell)
            .unwrap();
        assert!(!mgr.focus_session("foreground").unwrap());

        let reconciliations = Arc::new(AtomicUsize::new(0));
        mgr.set_cpu_reconcile_hook({
            let reconciliations = Arc::clone(&reconciliations);
            Arc::new(move |point, _| {
                if point == CpuReconcilePoint::Start {
                    reconciliations.fetch_add(1, Ordering::SeqCst);
                }
            })
        });

        for input in [b"one\n".as_slice(), b"two\n", b"three\n"] {
            mgr.write("foreground", input).unwrap();
        }
        assert_eq!(
            reconciliations.load(Ordering::SeqCst),
            0,
            "input in the already-foreground pane must stay O(1)",
        );
    }

    #[test]
    fn reap_returns_successes_while_failed_cleanup_stays_retryable() {
        let dir = tempdir().unwrap();
        let cgroups = tempdir().unwrap();
        let mgr = with_fake_cgroups(dir.path(), cgroups.path());
        for name in ["blocked", "clean"] {
            mgr.create(name, "/tmp", SessionKind::Shell).unwrap();
            mgr.write(name, b"exit\n").unwrap();
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while ["blocked", "clean"]
            .iter()
            .any(|name| mgr.session(name).unwrap().is_alive())
        {
            assert!(std::time::Instant::now() < deadline, "shells never exited");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let blocked_slot = mgr.store.read_session("blocked").unwrap().unwrap().slot;
        let clean_slot = mgr.store.read_session("clean").unwrap().unwrap().slot;
        let obstruction = cgroups
            .path()
            .join(format!("session-{blocked_slot}/workload/obstruction"));
        std::fs::create_dir(&obstruction).unwrap();

        let reaped = mgr.reap().unwrap();
        assert_eq!(reaped, vec!["clean".to_string()]);
        assert_eq!(mgr.names(), vec!["blocked".to_string()]);
        assert!(mgr.store.read_session("blocked").unwrap().is_some());
        assert!(cgroups
            .path()
            .join(format!("session-{blocked_slot}"))
            .exists());
        assert!(!cgroups
            .path()
            .join(format!("session-{clean_slot}"))
            .exists());

        std::fs::remove_dir(obstruction).unwrap();
        assert_eq!(mgr.reap().unwrap(), vec!["blocked".to_string()]);
        assert!(mgr.names().is_empty());
    }

    #[test]
    fn create_allocates_slot_before_spawn_and_rolls_back_cgroup_on_persist_failure() {
        // If the state store is unwritable, create must error, track nothing,
        // and kill the just-spawned child rather than leaking it.
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        let cgroups = tempdir().unwrap();
        let mgr = with_fake_cgroups(dir.path(), cgroups.path());
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
        let result = mgr.create("orphan", "/tmp", SessionKind::Shell);
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            result.is_err(),
            "create must fail when the store is unwritable"
        );
        assert!(mgr.names().is_empty(), "failed create must not be tracked");
        assert!(!dir.path().join("sessions/orphan.json").exists());
        assert!(!cgroups.path().join("session-1").exists());
    }

    #[test]
    fn missing_shell_is_reaped_without_a_cgroup_leak() {
        let dir = tempdir().unwrap();
        let cgroups = tempdir().unwrap();
        let mgr = with_fake_cgroups(dir.path(), cgroups.path())
            .with_test_shell(dir.path().join("missing-shell"));
        let created = mgr.create("missing", "/tmp", SessionKind::Shell);

        if let Ok(session) = created {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while session.is_alive() {
                assert!(
                    std::time::Instant::now() < deadline,
                    "missing shell stayed alive"
                );
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            mgr.reap().unwrap();
        }
        assert!(mgr.names().is_empty());
        assert!(!dir.path().join("sessions/missing.json").exists());
        assert!(!cgroups.path().join("session-1").exists());
    }

    #[test]
    fn concurrent_creates_get_unique_slots_without_persisted_reservations() {
        let dir = tempdir().unwrap();
        let cgroups = tempdir().unwrap();
        let mgr = Arc::new(with_fake_cgroups(dir.path(), cgroups.path()));
        let barrier = Arc::new(Barrier::new(3));
        let mut threads = Vec::new();
        for name in ["one", "two"] {
            let mgr = Arc::clone(&mgr);
            let barrier = Arc::clone(&barrier);
            threads.push(std::thread::spawn(move || {
                barrier.wait();
                mgr.create(name, "/tmp", SessionKind::Shell).unwrap();
            }));
        }
        barrier.wait();
        for thread in threads {
            thread.join().unwrap();
        }

        let slots: BTreeSet<u32> = mgr
            .session_infos()
            .unwrap()
            .into_iter()
            .map(|i| i.slot)
            .collect();
        assert_eq!(slots.len(), 2);
        assert!(!slots.contains(&0));
        assert_eq!(
            StateStore::new(dir.path()).list_sessions().unwrap().len(),
            2
        );
    }

    #[test]
    fn restore_reuses_the_persisted_slot() {
        let dir = tempdir().unwrap();
        let cgroups = tempdir().unwrap();
        let slot = {
            let mgr = with_fake_cgroups(dir.path(), cgroups.path());
            mgr.create("restored", "/tmp", SessionKind::Shell).unwrap();
            let slot = mgr.store.read_session("restored").unwrap().unwrap().slot;
            mgr.snapshot().unwrap();
            slot
        };

        let mgr = with_fake_cgroups(dir.path(), cgroups.path());
        mgr.restore().unwrap();
        assert_eq!(
            mgr.store.read_session("restored").unwrap().unwrap().slot,
            slot
        );
        assert!(cgroups.path().join(format!("session-{slot}")).is_dir());
    }

    #[test]
    fn restore_starts_the_authoritative_name_while_rename_cleanup_is_pending() {
        let dir = tempdir().unwrap();
        let cgroups = tempdir().unwrap();
        let store = StateStore::new(dir.path());
        let from = "amber-1-1-0-pending";
        let to = "amber-1-2-0-pending";
        let source = SessionMeta {
            name: from.to_string(),
            cwd: PathBuf::from("/tmp"),
            kind: SessionKind::Shell,
            updated: 1,
            resume_as_claude: false,
            run_state: None,
            slot: 1,
        };
        store.write_session(&source).unwrap();
        store
            .write_session(&SessionMeta {
                name: to.to_string(),
                ..source.clone()
            })
            .unwrap();
        write_rename_journal(dir.path(), from, to, source);
        let obstruction = dir.path().join(format!("claude/{from}.json"));
        std::fs::create_dir_all(&obstruction).unwrap();

        let mgr = with_fake_cgroups(dir.path(), cgroups.path());
        let restored = mgr.restore();

        assert!(
            restored.is_ok(),
            "retryable cleanup prevented startup: {restored:?}"
        );
        assert_eq!(mgr.names(), vec![to.to_string()]);
        assert!(store.read_session(from).unwrap().is_none());
        assert!(store.read_session(to).unwrap().is_some());
        assert!(dir.path().join("rename.json").exists());

        std::fs::remove_dir(obstruction).unwrap();
        mgr.remove(to).unwrap();
        assert!(!dir.path().join("rename.json").exists());
    }

    #[test]
    fn second_restore_recovers_after_pending_cleanup_deferred_slot_repair() {
        let dir = tempdir().unwrap();
        let cgroups = tempdir().unwrap();
        let store = StateStore::new(dir.path());
        let from = "amber-1-1-0-slot";
        let to = "amber-1-2-0-slot";
        let source = SessionMeta {
            name: from.to_string(),
            cwd: PathBuf::from("/tmp"),
            kind: SessionKind::Shell,
            updated: 1,
            resume_as_claude: false,
            run_state: None,
            slot: 0,
        };
        store.write_session(&source).unwrap();
        store
            .write_session(&SessionMeta {
                name: to.to_string(),
                ..source.clone()
            })
            .unwrap();
        write_rename_journal(dir.path(), from, to, source);
        let obstruction = dir.path().join(format!("claude/{from}.json"));
        std::fs::create_dir_all(&obstruction).unwrap();

        let first = with_fake_cgroups(dir.path(), cgroups.path());
        first.restore().unwrap();
        assert_eq!(first.names(), vec![to.to_string()]);
        assert_eq!(store.read_session(to).unwrap().unwrap().slot, 0);
        let first_session = first.session(to).unwrap();
        first.stop_session(1, Some(&first_session)).unwrap();

        std::fs::remove_dir(obstruction).unwrap();
        let second = with_fake_cgroups(dir.path(), cgroups.path());
        second.restore().unwrap();
        assert_eq!(second.names(), vec![to.to_string()]);
        assert_eq!(store.read_session(to).unwrap().unwrap().slot, 1);
        assert!(!dir.path().join("rename.json").exists());
        second.remove(to).unwrap();
    }

    #[test]
    fn pending_repaired_slot_remains_live_authority_for_sampling_and_remove() {
        let dir = tempdir().unwrap();
        let cgroups = tempdir().unwrap();
        let store = StateStore::new(dir.path());
        let other = "amber-1-1-0-other";
        let from = "amber-1-1-1-from";
        let to = "amber-1-2-0-moved";
        let source = SessionMeta {
            name: from.to_string(),
            cwd: PathBuf::from("/tmp"),
            kind: SessionKind::Shell,
            updated: 1,
            resume_as_claude: false,
            run_state: None,
            slot: 1,
        };
        store
            .write_session(&SessionMeta {
                name: other.to_string(),
                ..source.clone()
            })
            .unwrap();
        store.write_session(&source).unwrap();
        store
            .write_session(&SessionMeta {
                name: to.to_string(),
                ..source.clone()
            })
            .unwrap();
        write_rename_journal(dir.path(), from, to, source);
        let obstruction = dir.path().join(format!("claude/{from}.json"));
        std::fs::create_dir_all(&obstruction).unwrap();

        let mgr = with_fake_cgroups(dir.path(), cgroups.path());
        mgr.restore().unwrap();
        let slots = mgr
            .session_infos()
            .unwrap()
            .into_iter()
            .map(|info| (info.name, info.slot))
            .collect::<HashMap<_, _>>();
        assert_eq!(slots.get(other), Some(&1));
        assert_eq!(slots.get(to), Some(&2));
        let moved = mgr.session(to).unwrap();
        assert_eq!(mgr.effective_meta_for(to, &moved).unwrap().unwrap().slot, 2);

        std::fs::remove_dir(obstruction).unwrap();
        mgr.finish_pending_rename().unwrap();
        assert_eq!(store.read_session(to).unwrap().unwrap().slot, 2);
        assert!(mgr.deferred_meta.lock().unwrap().is_empty());
        mgr.remove(to).unwrap();

        assert!(mgr.session(other).is_some());
        assert!(cgroups.path().join("session-1").exists());
        assert!(!cgroups.path().join("session-2").exists());
        assert_eq!(store.read_session(to).unwrap(), None);
        mgr.remove(other).unwrap();
    }

    #[test]
    fn second_restore_recovers_after_pending_cleanup_deferred_resume_normalization() {
        let dir = tempdir().unwrap();
        let cgroups = tempdir().unwrap();
        let store = StateStore::new(dir.path());
        let from = "amber-1-1-0-resume";
        let to = "amber-1-2-0-resume";
        let source = SessionMeta {
            name: from.to_string(),
            cwd: dir.path().to_path_buf(),
            kind: SessionKind::Shell,
            updated: 1,
            resume_as_claude: true,
            run_state: None,
            slot: 1,
        };
        store.write_session(&source).unwrap();
        store
            .write_session(&SessionMeta {
                name: to.to_string(),
                ..source.clone()
            })
            .unwrap();
        write_rename_journal(dir.path(), from, to, source);
        let obstruction = dir.path().join(format!("claude/{from}.json"));
        std::fs::create_dir_all(&obstruction).unwrap();

        let first = with_fake_cgroups(dir.path(), cgroups.path());
        first.restore().unwrap();
        assert_eq!(first.names(), vec![to.to_string()]);
        let unchanged = store.read_session(to).unwrap().unwrap();
        assert_eq!(unchanged.kind, SessionKind::Shell);
        assert!(unchanged.resume_as_claude);
        assert_eq!(first.session_infos().unwrap()[0].kind, "claude");
        assert_eq!(first.session_kind(to), Some(SessionKind::Claude));
        assert!(first.set_run_state(to, "claude").is_ok());
        assert!(
            first
                .memory_candidates(&HashMap::from([(to.to_string(), 1)]))
                .into_iter()
                .next()
                .unwrap()
                .is_agent
        );
        std::fs::remove_dir(obstruction).unwrap();
        first.finish_pending_rename().unwrap();
        let flushed = store.read_session(to).unwrap().unwrap();
        assert_eq!(flushed.kind, SessionKind::Claude);
        assert!(!flushed.resume_as_claude);
        assert!(first.deferred_meta.lock().unwrap().is_empty());
        let first_session = first.session(to).unwrap();
        first.stop_session(1, Some(&first_session)).unwrap();

        let second = with_fake_cgroups(dir.path(), cgroups.path());
        second.restore().unwrap();
        assert_eq!(second.names(), vec![to.to_string()]);
        let normalized = store.read_session(to).unwrap().unwrap();
        assert_eq!(normalized.kind, SessionKind::Claude);
        assert!(!normalized.resume_as_claude);
        assert!(!dir.path().join("rename.json").exists());
        second.remove(to).unwrap();
    }

    #[test]
    fn deferred_metadata_does_not_follow_a_reused_name() {
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        let name = "reused";
        let old = fake_agent(&mgr, name);
        let mut repaired = mgr.store.read_session(name).unwrap().unwrap();
        repaired.slot = 9;
        repaired.kind = SessionKind::Grok;
        mgr.deferred_meta.lock().unwrap().insert(
            name.to_string(),
            LiveMetaOverride {
                session: Arc::downgrade(&old),
                meta: repaired,
            },
        );

        let replacement = fake_agent(&mgr, name);
        let effective = mgr.effective_meta_for(name, &replacement).unwrap().unwrap();

        assert_eq!(effective.slot, 1);
        assert_eq!(effective.kind, SessionKind::Claude);
        assert!(!mgr.deferred_meta.lock().unwrap().contains_key(name));
        old.kill().unwrap();
        replacement.kill().unwrap();
    }

    #[test]
    fn restore_normalizes_a_hand_started_claude_to_persisted_agent_truth() {
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());
        let name = "restored-agent";
        store
            .write_session(&SessionMeta {
                name: name.to_string(),
                cwd: dir.path().to_path_buf(),
                kind: SessionKind::Shell,
                updated: 1,
                resume_as_claude: true,
                run_state: None,
                slot: 1,
            })
            .unwrap();

        let mgr = SessionManager::new(dir.path()).unwrap();
        mgr.restore().unwrap();

        let restored = mgr.store.read_session(name).unwrap().unwrap();
        assert_eq!(restored.kind, SessionKind::Claude);
        assert!(!restored.resume_as_claude);
        assert_eq!(mgr.session_infos().unwrap()[0].kind, "claude");
    }

    #[test]
    fn restore_does_not_spawn_when_kind_normalization_cannot_be_persisted() {
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());
        store
            .write_session(&SessionMeta {
                name: "blocked-normalize".to_string(),
                cwd: dir.path().to_path_buf(),
                kind: SessionKind::Shell,
                updated: 1,
                resume_as_claude: true,
                run_state: None,
                slot: 1,
            })
            .unwrap();
        let sessions_dir = dir.path().join("sessions");
        std::fs::set_permissions(&sessions_dir, std::fs::Permissions::from_mode(0o555)).unwrap();

        let mgr = SessionManager::new(dir.path()).unwrap();
        mgr.restore().unwrap();
        std::fs::set_permissions(&sessions_dir, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert!(mgr.names().is_empty());
        let meta = store.read_session("blocked-normalize").unwrap().unwrap();
        assert_eq!(meta.kind, SessionKind::Shell);
        assert!(meta.resume_as_claude);
    }

    #[test]
    fn live_resume_flag_does_not_change_a_shells_runtime_kind() {
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        let from = "live-shell";
        let to = "renamed-shell";
        mgr.create(from, dir.path(), SessionKind::Shell).unwrap();
        let mut meta = mgr.store.read_session(from).unwrap().unwrap();
        meta.resume_as_claude = true;
        mgr.store.write_session(&meta).unwrap();
        let before = mgr.session(from).unwrap();

        assert_eq!(mgr.session_infos().unwrap()[0].kind, "shell");
        assert!(mgr.set_run_state(from, "claude").is_err());
        assert!(mgr.set_run_state(from, "suspend-failed").is_err());
        assert!(mgr.suspend(from, SuspendOrigin::Manual).is_err());
        let info = mgr.rename(from, to).unwrap();
        let after = mgr.session(to).unwrap();
        assert_eq!(info.kind, "shell");
        assert_eq!(before.pid(), after.pid());
        assert!(Arc::ptr_eq(&before, &after));
    }

    #[test]
    fn shell_fallback_and_retrying_sessions_refuse_suspend() {
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        let session = fake_agent(&mgr, "agent");

        for state in ["claude-retrying", "shell-fallback"] {
            session.set_run_state(Some(state.into()));
            let error = mgr.suspend("agent", SuspendOrigin::Manual).unwrap_err();
            assert!(error.to_string().contains(state));
            assert_eq!(session.suspend_origin(), SuspendOrigin::None);
        }
    }

    #[test]
    fn memory_suspend_tracks_pending_until_manual_override_and_resume() {
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        let session = fake_agent(&mgr, "agent");

        mgr.suspend("agent", SuspendOrigin::Pressure).unwrap();
        wait_for_output(&session, b"SUSPEND_SIGNAL");
        assert_eq!(session.suspend_origin(), SuspendOrigin::Pressure);
        assert_ne!(session.memory_suspend_started_ms(), 0);

        session.set_run_state(Some("suspended".into()));
        mgr.suspend("agent", SuspendOrigin::Manual).unwrap();
        assert_eq!(session.suspend_origin(), SuspendOrigin::Manual);
        assert_eq!(session.memory_suspend_started_ms(), 0);

        assert!(mgr.resume("agent", ResumeCause::Manual).unwrap());
        wait_for_output(&session, b"RESUME_SIGNAL");
        assert_eq!(session.suspend_origin(), SuspendOrigin::None);
    }

    #[test]
    fn memory_candidates_join_live_state_persisted_identity_and_charge() {
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        let session = fake_agent(&mgr, "agent");
        mgr.store
            .write_claude(
                "agent",
                &amber_core::state::ClaudeMeta {
                    session_id: "resume-id".into(),
                    cwd: dir.path().to_path_buf(),
                    updated: 1,
                },
            )
            .unwrap();

        let candidates = mgr.memory_candidates(&HashMap::from([("agent".to_string(), 321)]));
        assert_eq!(candidates.len(), 1);
        let candidate = &candidates[0];
        assert_eq!(
            (candidate.name.as_str(), candidate.memory_kb),
            ("agent", 321)
        );
        assert!(candidate.is_agent && candidate.running && candidate.has_resume_id);
        assert!(!candidate.suspended);
        assert_eq!(candidate.last_used_ms, session.last_used_ms());

        session.claim_suspend(SuspendOrigin::Manual).unwrap();
        assert!(mgr.memory_candidates(&HashMap::new())[0].suspended);
    }

    #[test]
    fn host_pressure_candidates_ignore_output_but_protect_recent_user_input() {
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        let session = fake_agent_with_slot(&mgr, "background", 1);
        record_resume_id(&mgr, "background", dir.path());

        let eligible_at = session.last_user_ms() + RECENT_USE_MS;
        session.write(b"noisy-background-output\n").unwrap();
        wait_for_output(&session, b"INPUT:noisy-background-output");
        assert_eq!(
            mgr.host_pressure_candidates(
                eligible_at,
                &HashMap::from([("background".to_string(), 321)]),
            )
            .iter()
            .map(|candidate| candidate.name.as_str())
            .collect::<Vec<_>>(),
            vec!["background"],
            "PTY output must not refresh host-pressure recency",
        );

        mgr.write("background", b"actual-user-input\n").unwrap();
        wait_for_output(&session, b"INPUT:actual-user-input");
        mgr.create("foreground-shell", dir.path(), SessionKind::Shell)
            .unwrap();
        mgr.focus_session("foreground-shell").unwrap();
        let too_recent = session.last_user_ms() + RECENT_USE_MS - 1;
        assert!(
            mgr.host_pressure_candidates(
                too_recent,
                &HashMap::from([("background".to_string(), 321)]),
            )
            .is_empty(),
            "actual user input must retain the 120-second protection",
        );
    }

    #[test]
    fn foreground_slot_remains_excluded_after_rename() {
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        let from = "foreground-before-rename";
        let to = "foreground-after-rename";
        mgr.create(from, dir.path(), SessionKind::Shell).unwrap();
        assert!(!mgr.focus_session(from).unwrap());
        let slot = mgr.store.read_session(from).unwrap().unwrap().slot;

        mgr.rename(from, to).unwrap();
        let session = mgr.session(to).unwrap();
        session.set_run_state(Some("claude".into()));
        let mut meta = mgr.store.read_session(to).unwrap().unwrap();
        meta.kind = SessionKind::Claude;
        mgr.store.write_session(&meta).unwrap();
        record_resume_id(&mgr, to, dir.path());

        assert_eq!(mgr.store.read_session(to).unwrap().unwrap().slot, slot);
        assert!(
            mgr.host_pressure_candidates(
                session.last_user_ms() + RECENT_USE_MS,
                &HashMap::from([(to.to_string(), 321)]),
            )
            .is_empty(),
            "the stable foreground slot must survive a name change",
        );
        mgr.remove(to).unwrap();
    }

    #[test]
    fn host_pressure_candidates_keep_existing_automatic_safety_exclusions() {
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        let eligible = fake_agent_with_slot(&mgr, "eligible", 1);
        let manual = fake_agent_with_slot(&mgr, "manual", 2);
        let retrying = fake_agent_with_slot(&mgr, "retrying", 3);
        let missing_id = fake_agent_with_slot(&mgr, "missing-id", 4);
        mgr.create("shell", dir.path(), SessionKind::Shell).unwrap();
        record_resume_id(&mgr, "eligible", dir.path());
        record_resume_id(&mgr, "manual", dir.path());
        record_resume_id(&mgr, "retrying", dir.path());
        manual.claim_suspend(SuspendOrigin::Manual).unwrap();
        retrying.set_run_state(Some("claude-retrying".into()));

        let now_ms = [
            eligible.last_user_ms(),
            manual.last_user_ms(),
            retrying.last_user_ms(),
            missing_id.last_user_ms(),
        ]
        .into_iter()
        .max()
        .unwrap()
            + RECENT_USE_MS;
        assert_eq!(
            mgr.host_pressure_candidates(
                now_ms,
                &HashMap::from([
                    ("eligible".to_string(), 1),
                    ("manual".to_string(), 2),
                    ("retrying".to_string(), 3),
                    ("missing-id".to_string(), 4),
                    ("shell".to_string(), 5),
                ]),
            )
            .iter()
            .map(|candidate| candidate.name.as_str())
            .collect::<Vec<_>>(),
            vec!["eligible"],
        );
    }

    #[test]
    fn automatic_pressure_suspend_rechecks_liveness_under_the_transition_lock() {
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        let session = fake_agent(&mgr, "agent");
        record_resume_id(&mgr, "agent", dir.path());

        session.kill().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while session.is_alive() {
            assert!(std::time::Instant::now() < deadline, "agent never exited");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }

        let error = mgr.suspend_for_pressure("agent").unwrap_err();
        assert!(error.to_string().contains("no such session"));
        assert_eq!(session.suspend_origin(), SuspendOrigin::None);
        assert_eq!(session.memory_suspend_started_ms(), 0);
    }

    #[test]
    fn output_waiting_on_a_saturated_subscriber_blocks_memory_suspend() {
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        let session = fake_agent(&mgr, "agent");
        mgr.store
            .write_claude(
                "agent",
                &amber_core::state::ClaudeMeta {
                    session_id: "resume-id".into(),
                    cwd: dir.path().to_path_buf(),
                    updated: 1,
                },
            )
            .unwrap();

        // Never drain this receiver. Queue-capacity separately-flushed frames
        // fill the bounded subscriber queue; the next reaches the ring and then
        // blocks in fan-out. The final guardian check must still see that output.
        let (_id, _backlog, saturated_rx) = session.subscribe();
        for i in 0..crate::pty::SUBSCRIBER_QUEUE_DEPTH {
            let before_written = session.scrollback_written();
            session.write(format!("fill-{i}\n").as_bytes()).unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while session.scrollback_written() == before_written {
                assert!(
                    std::time::Instant::now() < deadline,
                    "fill frame {i} never flushed"
                );
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }
        session.write(b"blocked-fanout\n").unwrap();
        wait_for_output(&session, b"INPUT:blocked-fanout");

        // The batcher is now stuck delivering the preceding frame. A later
        // pty read must still publish activity before it queues behind that
        // batcher; otherwise a long-lived wedged subscriber can make genuinely
        // fresh output look idle to the guardian.
        std::thread::sleep(std::time::Duration::from_millis(2));
        let before_queued_output = session.last_used_ms();
        session.write(b"queued-behind-fanout\n").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while session.last_used_ms() <= before_queued_output {
            assert!(
                std::time::Instant::now() < deadline,
                "raw pty output queued behind fan-out never published activity"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }

        let error = mgr
            .suspend_for_memory("agent", before_queued_output + RECENT_USE_MS)
            .expect_err("output queued behind fan-out must defeat the final suspend claim");
        assert!(error.to_string().contains("recent activity"));
        assert_eq!(session.suspend_origin(), SuspendOrigin::None);
        drop(saturated_rx);
    }

    #[test]
    fn memory_pending_reports_the_earliest_unconfirmed_memory_suspend() {
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        let first = fake_agent(&mgr, "first");
        let second = fake_agent(&mgr, "second");
        first.claim_suspend(SuspendOrigin::Pressure).unwrap();
        first.set_memory_suspend_started_ms(20);
        second.claim_suspend(SuspendOrigin::Pressure).unwrap();
        second.set_memory_suspend_started_ms(10);
        assert_eq!(mgr.memory_suspend_pending_since(), Some(10));

        second.set_run_state(Some("suspended".into()));
        assert_eq!(mgr.memory_suspend_pending_since(), Some(20));
        first.claim_suspend(SuspendOrigin::Manual).unwrap();
        assert_eq!(mgr.memory_suspend_pending_since(), None);
    }

    #[test]
    fn cgroup_memory_sample_is_absent_when_containment_is_disabled() {
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        assert_eq!(mgr.cgroup_memory_sample().unwrap(), None);
    }

    #[test]
    fn enabled_cgroup_requires_an_aggregate_memory_sample() {
        let error = require_cgroup_aggregate(None).unwrap_err();
        assert!(error.to_string().contains("aggregate memory.current"));
        assert_eq!(require_cgroup_aggregate(Some(321)).unwrap(), 321);
    }

    #[test]
    fn focus_resumes_memory_origin_but_not_manual_origin() {
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        let session = fake_agent(&mgr, "agent");
        session.set_run_state(Some("suspended".into()));
        session.claim_suspend(SuspendOrigin::Pressure).unwrap();

        assert!(mgr.focus_session("agent").unwrap());
        wait_for_output(&session, b"RESUME_SIGNAL");
        assert_eq!(session.suspend_origin(), SuspendOrigin::None);

        session.claim_suspend(SuspendOrigin::Manual).unwrap();
        assert!(!mgr.focus_session("agent").unwrap());
        assert_eq!(session.suspend_origin(), SuspendOrigin::Manual);
    }

    #[test]
    fn input_resumes_memory_but_is_rejected_while_manual() {
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        let session = fake_agent(&mgr, "agent");
        session.set_run_state(Some("suspended".into()));
        session.claim_suspend(SuspendOrigin::Pressure).unwrap();

        mgr.write("agent", b"memory-input\n").unwrap();
        wait_for_output(&session, b"RESUME_SIGNAL");
        wait_for_output(&session, b"INPUT:memory-input");

        session.claim_suspend(SuspendOrigin::Manual).unwrap();
        let error = mgr.write("agent", b"forbidden-input\n").unwrap_err();
        assert!(error.to_string().contains("manually suspended"));
        assert!(!session
            .scrollback()
            .windows(b"forbidden-input".len())
            .any(|bytes| bytes == b"forbidden-input"));
    }

    #[test]
    fn failed_signal_restores_the_previous_origin_and_pending_clock() {
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        let session = fake_agent(&mgr, "agent");
        session.claim_suspend(SuspendOrigin::Pressure).unwrap();
        session.set_memory_suspend_started_ms(77);
        session.kill().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while session.is_alive() {
            assert!(
                std::time::Instant::now() < deadline,
                "fake supervisor stayed alive"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }

        assert!(mgr.resume("agent", ResumeCause::Manual).is_err());
        assert_eq!(session.suspend_origin(), SuspendOrigin::Pressure);
        assert_eq!(session.memory_suspend_started_ms(), 77);

        session.set_run_state(Some("claude".into()));
        assert!(mgr.suspend("agent", SuspendOrigin::Manual).is_err());
        assert_eq!(session.suspend_origin(), SuspendOrigin::Pressure);
        assert_eq!(session.memory_suspend_started_ms(), 77);
    }

    #[test]
    fn focus_waits_for_an_in_progress_suspend_transition() {
        let dir = tempdir().unwrap();
        let mgr = Arc::new(SessionManager::new(dir.path()).unwrap());
        let session = fake_agent(&mgr, "agent");
        session.set_run_state(Some("suspended".into()));
        session.claim_suspend(SuspendOrigin::Pressure).unwrap();
        let guard = session.lock_suspend_transition();
        let (tx, rx) = mpsc::channel();
        let worker = Arc::clone(&mgr);
        std::thread::spawn(move || tx.send(worker.focus_session("agent")).unwrap());

        assert!(rx
            .recv_timeout(std::time::Duration::from_millis(100))
            .is_err());
        drop(guard);
        assert!(rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap()
            .unwrap());
    }

    #[test]
    fn queued_focus_rechecks_identity_after_remove_finishes_teardown() {
        let dir = tempdir().unwrap();
        let mgr = Arc::new(SessionManager::new(dir.path()).unwrap());
        let session = fake_agent(&mgr, "agent");
        session.set_run_state(Some("suspended".into()));
        session.claim_suspend(SuspendOrigin::Pressure).unwrap();

        // Hold the child-killer lock so remove owns the transition lock but
        // cannot finish. Focus then deterministically queues behind teardown.
        let killer = session.lock_killer_for_test();
        let (remove_tx, remove_rx) = mpsc::channel();
        let remover = Arc::clone(&mgr);
        std::thread::spawn(move || remove_tx.send(remover.remove("agent")).unwrap());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !session.suspend_transition_locked_for_test() {
            assert!(
                std::time::Instant::now() < deadline,
                "remove never entered teardown"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let exit_record = session.lock_exit_for_test();

        let (focus_tx, focus_rx) = mpsc::channel();
        let focuser = Arc::clone(&mgr);
        std::thread::spawn(move || focus_tx.send(focuser.focus_session("agent")).unwrap());
        assert!(focus_rx
            .recv_timeout(std::time::Duration::from_millis(100))
            .is_err());

        drop(killer);
        let premature_remove = remove_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .ok();
        let returned_early = premature_remove.is_some();
        drop(exit_record);
        match premature_remove {
            Some(result) => result.unwrap(),
            None => remove_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap()
                .unwrap(),
        }
        let error = focus_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap()
            .unwrap_err();

        assert!(
            !returned_early,
            "remove returned before child exit was confirmed"
        );
        assert!(
            error.to_string().contains("no such session"),
            "unexpected focus result: {error}"
        );
        assert!(mgr.session("agent").is_none());
        assert!(
            !session.is_alive(),
            "remove returned before the child exit was confirmed"
        );
    }

    #[test]
    fn session_infos_distinguishes_memory_from_manual_suspension() {
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        let session = fake_agent(&mgr, "agent");
        session.set_run_state(Some("suspended".into()));
        session.claim_suspend(SuspendOrigin::Pressure).unwrap();
        assert_eq!(
            mgr.session_infos().unwrap()[0].run_state.as_deref(),
            Some("resource-suspended")
        );

        session.claim_suspend(SuspendOrigin::Manual).unwrap();
        assert_eq!(
            mgr.session_infos().unwrap()[0].run_state.as_deref(),
            Some("suspended")
        );
    }

    #[test]
    fn restore_skips_a_poison_session_and_restores_the_healthy_ones() {
        // One unrestorable session (here: its scrollback path is a DIRECTORY,
        // so read_scrollback errors) must be logged and skipped — never abort
        // the whole restore, which would leave the daemon dead on startup
        // with zero sessions. Mirrors state.rs list_sessions' tolerance of
        // corrupt JSON.
        use amber_core::state::{SessionMeta, StateStore};
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());
        for name in ["good-a", "poison", "good-b"] {
            store
                .write_session(&SessionMeta {
                    name: name.to_string(),
                    cwd: PathBuf::from("/tmp"),
                    kind: SessionKind::Shell,
                    updated: 1,
                    resume_as_claude: false,
                    run_state: None,
                    slot: 0,
                })
                .unwrap();
        }
        store.write_scrollback("good-a", b"history-a").unwrap();
        // The poison pill: a directory where the scrollback file should be.
        std::fs::create_dir_all(dir.path().join("scrollback/poison.bin")).unwrap();

        let mgr = SessionManager::new(dir.path()).unwrap();
        mgr.restore()
            .expect("restore must not abort on one bad session");
        assert_eq!(
            mgr.names(),
            vec!["good-a".to_string(), "good-b".to_string()],
            "healthy sessions restored, poison one skipped"
        );
        assert!(
            mgr.session("good-a")
                .unwrap()
                .scrollback()
                .windows(9)
                .any(|w| w == b"history-a"),
            "healthy session's scrollback preloaded"
        );
    }

    #[test]
    fn set_run_state_stores_on_claude_and_surfaces_in_session_infos() {
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        mgr.create("amber-1-1-0-c", dir.path(), SessionKind::Claude)
            .unwrap();

        mgr.set_run_state("amber-1-1-0-c", "claude-retrying")
            .unwrap();
        let info = mgr
            .session_infos()
            .unwrap()
            .into_iter()
            .find(|i| i.name == "amber-1-1-0-c")
            .unwrap();
        assert_eq!(info.run_state.as_deref(), Some("claude-retrying"));
    }

    #[test]
    fn set_run_state_rejects_shell_unknown_and_bad_state() {
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        mgr.create("amber-1-1-0-s", "/tmp", SessionKind::Shell)
            .unwrap();
        mgr.create("amber-1-1-1-c", dir.path(), SessionKind::Claude)
            .unwrap();

        // Shell session: run_state does not apply.
        assert!(mgr.set_run_state("amber-1-1-0-s", "claude").is_err());
        // Unknown session.
        assert!(mgr.set_run_state("nope", "claude").is_err());
        // Invalid state string, even on a claude session.
        assert!(mgr.set_run_state("amber-1-1-1-c", "bogus").is_err());
    }

    #[test]
    fn shell_rename_keeps_pid_and_cgroup_slot() {
        // Spec §3.2: a shell moves tab in place — same pty, same child, same
        // scrollback; only the key and the store files change.
        let dir = tempdir().unwrap();
        let cgroups = tempdir().unwrap();
        let mgr = with_fake_cgroups(dir.path(), cgroups.path());
        mgr.create("amber-1-1-0-a", "/tmp", SessionKind::Shell)
            .unwrap();
        let before = mgr.session("amber-1-1-0-a").unwrap();
        let slot = mgr
            .store
            .read_session("amber-1-1-0-a")
            .unwrap()
            .unwrap()
            .slot;

        let info = mgr.rename("amber-1-1-0-a", "amber-1-2-0-a").unwrap();

        assert_eq!(info.name, "amber-1-2-0-a");
        assert_eq!(mgr.names(), vec!["amber-1-2-0-a".to_string()]);
        let after = mgr.session("amber-1-2-0-a").unwrap();
        assert!(Arc::ptr_eq(&before, &after), "shell must keep its live pty");
        assert_eq!(before.pid(), after.pid(), "shell must keep its child");
        assert_eq!(info.slot, slot);
        assert!(cgroups.path().join(format!("session-{slot}")).is_dir());
        assert!(after.is_alive());
        assert!(dir.path().join("sessions/amber-1-2-0-a.json").exists());
        assert!(!dir.path().join("sessions/amber-1-1-0-a.json").exists());
    }

    #[test]
    fn agent_rename_respawns_but_keeps_cgroup_slot() {
        // Spec §3.2: a claude supervisor is env-bound to its name, so a rename
        // respawns it under the new name (same conversation resumes via the
        // migrated claude/<to>.json) — a NEW child, preserving cwd.
        let dir = tempdir().unwrap();
        let cgroups = tempdir().unwrap();
        let mgr = with_fake_cgroups(dir.path(), cgroups.path());
        mgr.create("amber-1-1-0-c", dir.path(), SessionKind::Claude)
            .unwrap();
        let slot = mgr
            .store
            .read_session("amber-1-1-0-c")
            .unwrap()
            .unwrap()
            .slot;
        mgr.store
            .write_claude(
                "amber-1-1-0-c",
                &amber_core::state::ClaudeMeta {
                    session_id: "conv-42".to_string(),
                    cwd: dir.path().to_path_buf(),
                    updated: 1,
                },
            )
            .unwrap();
        let before = mgr.session("amber-1-1-0-c").unwrap();

        let info = mgr.rename("amber-1-1-0-c", "amber-1-2-0-c").unwrap();

        assert_eq!(info.name, "amber-1-2-0-c");
        assert_eq!(info.kind, "claude");
        assert_eq!(mgr.names(), vec!["amber-1-2-0-c".to_string()]);
        let after = mgr.session("amber-1-2-0-c").unwrap();
        assert!(!Arc::ptr_eq(&before, &after), "claude must be respawned");
        assert_ne!(before.pid(), after.pid(), "claude must get a fresh child");
        assert_eq!(info.slot, slot);
        assert!(cgroups.path().join(format!("session-{slot}")).is_dir());
        assert_eq!(
            mgr.store
                .read_claude("amber-1-2-0-c")
                .unwrap()
                .unwrap()
                .session_id,
            "conv-42",
            "the conversation id must follow the rename so --resume still works"
        );
        assert_eq!(
            mgr.store
                .read_session("amber-1-2-0-c")
                .unwrap()
                .unwrap()
                .cwd,
            std::fs::canonicalize(dir.path()).unwrap_or_else(|_| dir.path().to_path_buf()),
            "cwd preserved"
        );
    }

    #[test]
    fn agent_rename_keeps_manual_suspension_parked() {
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        let from = "amber-1-1-0-manual";
        let to = "amber-1-2-0-manual";
        let before = fake_agent(&mgr, from);
        before.set_run_state(Some("suspended".into()));
        before.claim_suspend(SuspendOrigin::Manual).unwrap();

        mgr.rename(from, to).unwrap();

        let after = mgr.session(to).unwrap();
        assert_eq!(after.suspend_origin(), SuspendOrigin::Manual);
        assert_eq!(after.memory_suspend_started_ms(), 0);
        assert!(
            !mgr.focus_session(to).unwrap(),
            "focus must not resume a manual park"
        );
    }

    #[test]
    fn agent_rename_keeps_memory_suspension_resumable_on_focus() {
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        let from = "amber-1-1-0-memory";
        let to = "amber-1-2-0-memory";
        let before = fake_agent(&mgr, from);
        before.set_run_state(Some("suspended".into()));
        before.claim_suspend(SuspendOrigin::Pressure).unwrap();
        before.set_memory_suspend_started_ms(77);

        mgr.rename(from, to).unwrap();

        let after = mgr.session(to).unwrap();
        assert_eq!(after.suspend_origin(), SuspendOrigin::Pressure);
        assert_eq!(after.memory_suspend_started_ms(), 77);
        assert!(
            mgr.focus_session(to).unwrap(),
            "memory suspension must resume on focus"
        );
        assert_eq!(
            after.suspend_origin(),
            SuspendOrigin::Pressure,
            "focus waits for the new supervisor"
        );
        assert!(after.pending_resume_for_test());
    }

    #[test]
    fn initial_parked_resume_waits_for_the_supervisor_ready_report() {
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        let session = fake_agent(&mgr, "agent");
        session.set_run_state(Some("suspended".into()));
        session.claim_suspend(SuspendOrigin::Pressure).unwrap();
        session.await_initial_suspend_ready();

        assert!(mgr.focus_session("agent").unwrap());
        assert_eq!(session.suspend_origin(), SuspendOrigin::Pressure);
        assert!(session.pending_resume_for_test());

        mgr.set_run_state("agent", "suspended").unwrap();
        wait_for_output(&session, b"RESUME_SIGNAL");
        assert_eq!(session.suspend_origin(), SuspendOrigin::None);
        assert!(!session.pending_resume_for_test());
    }

    #[test]
    fn focus_waits_for_the_supervisor_to_confirm_suspension() {
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        let session = fake_agent(&mgr, "agent");
        session.claim_suspend(SuspendOrigin::Pressure).unwrap();

        assert!(mgr.focus_session("agent").unwrap());
        assert_eq!(session.suspend_origin(), SuspendOrigin::Pressure);
        assert!(session.pending_resume_for_test());
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(
            !session
                .scrollback()
                .windows(b"RESUME_SIGNAL".len())
                .any(|bytes| bytes == b"RESUME_SIGNAL"),
            "the supervisor has not yet parked the agent"
        );

        assert!(mgr.set_run_state_report("agent", "suspended", 1).unwrap());
        wait_for_output(&session, b"RESUME_SIGNAL");
        assert_eq!(session.suspend_origin(), SuspendOrigin::None);
        assert!(!session.pending_resume_for_test());
    }

    #[test]
    fn terminal_reports_release_an_inherited_initial_suspension() {
        for (report, expected_state) in [
            ("shell-fallback", "shell-fallback"),
            ("suspend-failed", "claude"),
        ] {
            for (origin, queue_resume) in [
                (SuspendOrigin::Manual, false),
                (SuspendOrigin::Manual, true),
                (SuspendOrigin::Pressure, false),
                (SuspendOrigin::Pressure, true),
            ] {
                let dir = tempdir().unwrap();
                let mgr = SessionManager::new(dir.path()).unwrap();
                let name = format!("{report}-{origin:?}-{queue_resume}");
                let session = fake_agent(&mgr, &name);
                session.set_run_state(Some("suspended".into()));
                session.claim_suspend(origin).unwrap();
                session.set_memory_suspend_started_ms(77);
                session.await_initial_suspend_ready();
                if queue_resume {
                    assert!(mgr.resume(&name, ResumeCause::Manual).unwrap());
                    assert!(session.pending_resume_for_test());
                }

                assert!(mgr.set_run_state_report(&name, report, 1).unwrap());
                assert!(session.initial_suspend_ready());
                assert!(!session.pending_resume_for_test());
                assert_eq!(session.suspend_origin(), SuspendOrigin::None);
                assert_eq!(session.memory_suspend_started_ms(), 0);
                assert_eq!(session.run_state().as_deref(), Some(expected_state));
                assert!(!mgr.resume(&name, ResumeCause::Manual).unwrap());
                mgr.write(&name, b"after-terminal-report\n").unwrap();
                wait_for_output(&session, b"INPUT:after-terminal-report");
            }
        }
    }

    #[test]
    fn ordinary_or_stale_reports_do_not_release_manual_suspension() {
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        let session = fake_agent(&mgr, "agent");
        assert!(mgr.set_run_state_report("agent", "claude", 7).unwrap());
        session.set_run_state(Some("suspended".into()));
        session.claim_suspend(SuspendOrigin::Manual).unwrap();

        assert!(mgr.set_run_state_report("agent", "claude", 8).unwrap());
        assert_eq!(session.suspend_origin(), SuspendOrigin::Manual);
        assert_eq!(session.memory_suspend_started_ms(), 0);
        let error = mgr.write("agent", b"still-parked\n").unwrap_err();
        assert!(error.to_string().contains("manually suspended"));

        for report in ["shell-fallback", "suspend-failed"] {
            assert!(!mgr.set_run_state_report("agent", report, 8).unwrap());
            assert_eq!(session.suspend_origin(), SuspendOrigin::Manual);
            assert_eq!(session.run_state().as_deref(), Some("claude"));
        }
    }

    #[test]
    fn suspended_after_failed_reclaim_recovers_as_manual() {
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        let session = fake_agent(&mgr, "agent");
        assert!(mgr
            .set_run_state_report("agent", "suspend-failed", 1)
            .unwrap());
        assert_eq!(session.suspend_origin(), SuspendOrigin::None);

        assert!(mgr.set_run_state_report("agent", "suspended", 2).unwrap());

        assert_eq!(session.suspend_origin(), SuspendOrigin::Manual);
        assert_eq!(session.run_state().as_deref(), Some("suspended"));
        assert!(!mgr.focus_session("agent").unwrap());
        assert!(mgr.resume("agent", ResumeCause::Manual).unwrap());
    }

    #[test]
    fn agent_rename_rolls_back_a_partial_store_move() {
        let dir = tempdir().unwrap();
        let cgroups = tempdir().unwrap();
        let mgr = with_fake_cgroups(dir.path(), cgroups.path());
        let from = "amber-1-1-0-partial";
        let to = "amber-1-2-0-partial";
        mgr.create(from, dir.path(), SessionKind::Claude).unwrap();
        let slot = mgr.store.read_session(from).unwrap().unwrap().slot;
        mgr.store
            .write_claude(
                from,
                &amber_core::state::ClaudeMeta {
                    session_id: "conv-partial".to_string(),
                    cwd: dir.path().to_path_buf(),
                    updated: 1,
                },
            )
            .unwrap();
        let old_settings = dir.path().join(format!("claude/{from}.settings.json"));
        std::fs::write(&old_settings, b"{}").unwrap();
        // A conflicting target artifact must abort before mutating any source
        // artifact; the stopped agent must still be restored under `from`.
        std::fs::create_dir(dir.path().join(format!("claude/{to}.settings.json"))).unwrap();

        assert!(mgr.rename(from, to).is_err());
        assert!(mgr.session(from).is_some());
        assert!(mgr.session(to).is_none());
        assert_eq!(mgr.store.read_session(from).unwrap().unwrap().slot, slot);
        assert_eq!(
            mgr.store.read_claude(from).unwrap().unwrap().session_id,
            "conv-partial"
        );
        assert!(old_settings.is_file());
        assert!(mgr.store.read_session(to).unwrap().is_none());
        assert!(cgroups.path().join(format!("session-{slot}")).is_dir());
    }

    #[test]
    fn agent_rename_rolls_back_after_prepare_failure() {
        let dir = tempdir().unwrap();
        let cgroups = tempdir().unwrap();
        let mgr = with_fake_cgroups(dir.path(), cgroups.path());
        let from = "amber-1-1-0-prepare";
        let to = "amber-1-2-0-prepare";
        mgr.create(from, dir.path(), SessionKind::Claude).unwrap();
        let slot = mgr.store.read_session(from).unwrap().unwrap().slot;
        mgr.store
            .write_claude(
                from,
                &amber_core::state::ClaudeMeta {
                    session_id: "conv-prepare".to_string(),
                    cwd: dir.path().to_path_buf(),
                    updated: 1,
                },
            )
            .unwrap();
        std::fs::write(cgroups.path().join(format!(".fail-prepare-{slot}")), b"").unwrap();

        assert!(mgr.rename(from, to).is_err());
        assert!(mgr.session(from).is_some());
        assert!(mgr.session(to).is_none());
        assert_eq!(mgr.store.read_session(from).unwrap().unwrap().slot, slot);
        assert_eq!(
            mgr.store.read_claude(from).unwrap().unwrap().session_id,
            "conv-prepare"
        );
        assert!(mgr.store.read_session(to).unwrap().is_none());
        assert!(cgroups.path().join(format!("session-{slot}")).is_dir());
    }

    #[test]
    fn agent_rename_rolls_back_after_restore_failure() {
        let dir = tempdir().unwrap();
        let cgroups = tempdir().unwrap();
        let mgr = with_fake_cgroups(dir.path(), cgroups.path());
        let from = "amber-1-1-0-restore";
        let to = "amber-1-2-0-restore";
        mgr.create(from, dir.path(), SessionKind::Claude).unwrap();
        let slot = mgr.store.read_session(from).unwrap().unwrap().slot;
        mgr.store
            .write_claude(
                from,
                &amber_core::state::ClaudeMeta {
                    session_id: "conv-restore".to_string(),
                    cwd: dir.path().to_path_buf(),
                    updated: 1,
                },
            )
            .unwrap();
        std::fs::write(dir.path().join(".fail-restore"), b"").unwrap();

        assert!(mgr.rename(from, to).is_err());
        assert!(mgr.session(from).is_some());
        assert!(mgr.session(to).is_none());
        assert_eq!(mgr.store.read_session(from).unwrap().unwrap().slot, slot);
        assert_eq!(
            mgr.store.read_claude(from).unwrap().unwrap().session_id,
            "conv-restore"
        );
        assert!(mgr.store.read_session(to).unwrap().is_none());
        assert!(cgroups.path().join(format!("session-{slot}")).is_dir());
    }

    #[test]
    fn agent_rename_rollback_restores_the_original_suspension() {
        for (origin, started) in [(SuspendOrigin::Manual, 0), (SuspendOrigin::Pressure, 91)] {
            let dir = tempdir().unwrap();
            let mgr = SessionManager::new(dir.path()).unwrap();
            let from = "amber-1-1-0-rollback";
            let to = "amber-1-2-0-rollback";
            let before = fake_agent(&mgr, from);
            before.set_run_state(Some("suspended".into()));
            before.claim_suspend(origin).unwrap();
            before.set_memory_suspend_started_ms(started);
            std::fs::write(dir.path().join(".fail-restore"), b"").unwrap();

            assert!(mgr.rename(from, to).is_err(), "{origin:?}");

            let restored = mgr.session(from).unwrap();
            assert_eq!(restored.suspend_origin(), origin);
            assert_eq!(restored.memory_suspend_started_ms(), started);
            assert!(mgr.session(to).is_none());
        }
    }

    #[test]
    fn agent_rollback_recovers_committed_journal_before_reverse_rename() {
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        let from = "amber-1-1-0-stale";
        let to = "amber-1-2-0-stale";
        let session = fake_agent(&mgr, from);
        mgr.store
            .write_claude(
                from,
                &amber_core::state::ClaudeMeta {
                    session_id: "conv-stale".into(),
                    cwd: dir.path().to_path_buf(),
                    updated: 1,
                },
            )
            .unwrap();
        let old_meta = mgr.store.read_session(from).unwrap().unwrap();
        let size = session.size();
        mgr.stop_session_locked(old_meta.slot, Some(&session))
            .unwrap();
        mgr.store.rename_session(from, to).unwrap();
        // Recreate the exact durable state left when a committed rename could
        // not unlink its journal before the replacement supervisor failed.
        write_rename_journal(dir.path(), from, to, old_meta.clone());

        let first_ok = mgr
            .rollback_agent_rename(from, to, &old_meta, size, None, true)
            .is_ok();
        if !first_ok {
            std::fs::remove_file(dir.path().join("rename.json")).unwrap();
            mgr.rollback_agent_rename(from, to, &old_meta, size, None, true)
                .unwrap();
        }

        assert!(first_ok, "stale committed journal blocked reverse rollback");
        assert!(mgr.session(from).is_some());
        assert!(mgr.session(to).is_none());
        assert_eq!(
            mgr.store.read_claude(from).unwrap().unwrap().session_id,
            "conv-stale"
        );
    }

    #[test]
    fn create_waits_for_pending_rename_cleanup_before_reusing_losing_name() {
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        let from = "amber-1-1-0-orphan";
        let to = "amber-1-2-0-orphan";
        mgr.create(to, "/tmp", SessionKind::Shell).unwrap();
        let to_meta = mgr.store.read_session(to).unwrap().unwrap();
        write_rename_journal(dir.path(), from, to, to_meta);
        let orphan = dir.path().join(format!("claude/{from}.json"));
        std::fs::create_dir_all(&orphan).unwrap();

        let first_ok = mgr.create(from, "/tmp", SessionKind::Shell).is_ok();
        std::fs::remove_dir(&orphan).unwrap();
        if first_ok {
            mgr.remove(from).unwrap();
        }
        assert!(
            !first_ok,
            "name was reused while its old artifact was still owned"
        );
        assert!(dir.path().join("rename.json").exists());

        mgr.create(from, "/tmp", SessionKind::Shell).unwrap();
        assert_eq!(mgr.store.read_claude(from).unwrap(), None);
        assert!(!dir.path().join("rename.json").exists());
    }

    #[test]
    fn rename_refuses_bad_target_missing_source_and_existing_target() {
        // Spec §7: a rename must never clobber another session.
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        mgr.create("amber-1-1-0-a", "/tmp", SessionKind::Shell)
            .unwrap();
        mgr.create("amber-1-1-1-b", "/tmp", SessionKind::Shell)
            .unwrap();

        assert!(
            mgr.rename("ghost", "amber-1-2-0-z").is_err(),
            "missing source"
        );
        assert!(
            mgr.rename("amber-1-1-0-a", "amber-1-1-1-b").is_err(),
            "must not clobber an existing session"
        );
        assert!(
            mgr.rename("amber-1-1-0-a", "../evil").is_err(),
            "invalid target"
        );
        assert!(mgr.rename("amber-1-1-0-a", "").is_err(), "empty target");

        // Every refusal leaves both sessions intact.
        assert_eq!(
            mgr.names(),
            vec!["amber-1-1-0-a".to_string(), "amber-1-1-1-b".to_string()]
        );
        assert!(mgr.session("amber-1-1-1-b").unwrap().is_alive());
    }

    // ---- stable slots (spec 2026-07-19) ---------------------------------

    /// (name, slot) for every session in the live table, by name.
    fn slots(mgr: &SessionManager) -> Vec<(String, u32)> {
        mgr.session_infos()
            .unwrap()
            .into_iter()
            .map(|i| (i.name, i.slot))
            .collect()
    }

    #[test]
    fn alloc_slot_takes_the_lowest_free_number() {
        assert_eq!(alloc_slot(&BTreeSet::new()), 1);
        assert_eq!(alloc_slot(&BTreeSet::from([1, 2, 4])), 3);
        assert_eq!(alloc_slot(&BTreeSet::from([1, 2, 3])), 4);
        assert_eq!(alloc_slot(&BTreeSet::from([2, 3])), 1);
    }

    #[test]
    fn slots_are_stable_across_another_sessions_death() {
        // THE regression this feature exists for: create three, kill the
        // middle one, the other two keep their numbers (a positional index
        // would have renumbered the third from 3 to 2).
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        for n in ["a", "b", "c"] {
            mgr.create(n, "/tmp", SessionKind::Shell).unwrap();
        }
        assert_eq!(
            slots(&mgr),
            vec![("a".into(), 1), ("b".into(), 2), ("c".into(), 3)]
        );

        mgr.remove("b").unwrap();
        assert_eq!(slots(&mgr), vec![("a".into(), 1), ("c".into(), 3)]);

        // The freed number is reused by a LATER create (accepted tradeoff).
        mgr.create("d", "/tmp", SessionKind::Shell).unwrap();
        assert_eq!(
            slots(&mgr),
            vec![("a".into(), 1), ("c".into(), 3), ("d".into(), 2)]
        );
    }

    #[test]
    fn a_dead_but_unreaped_session_keeps_its_slot_reserved() {
        // `ls`/`attach` have no alive filter, so a dead-but-listed session is
        // still addressable — its slot must NOT be handed to a new session
        // (that would make `attach <n>` ambiguous, the very bug this removes).
        // The number frees only when the session leaves the table (reap).
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        mgr.create("dies", "/tmp", SessionKind::Shell).unwrap();
        mgr.create("lives", "/tmp", SessionKind::Shell).unwrap();

        mgr.write("dies", b"exit\n").unwrap();
        let sess = mgr.session("dies").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while sess.is_alive() {
            assert!(std::time::Instant::now() < deadline, "shell never exited");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }

        // Dead, but still in the table and still listed.
        mgr.create("fresh", "/tmp", SessionKind::Shell).unwrap();
        assert_eq!(
            slots(&mgr),
            vec![("dies".into(), 1), ("fresh".into(), 3), ("lives".into(), 2)],
            "a dead-but-unreaped session must keep its slot reserved"
        );

        // Reaped: now the number is free for the next create.
        assert_eq!(mgr.reap().unwrap(), vec!["dies".to_string()]);
        mgr.create("after", "/tmp", SessionKind::Shell).unwrap();
        assert_eq!(
            slots(&mgr),
            vec![
                ("after".into(), 1),
                ("fresh".into(), 3),
                ("lives".into(), 2)
            ]
        );
    }

    #[test]
    fn rename_carries_the_slot_across_unchanged() {
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        mgr.create("amber-1-1-0-a", "/tmp", SessionKind::Shell)
            .unwrap();
        mgr.create("amber-1-1-1-b", "/tmp", SessionKind::Shell)
            .unwrap();

        let info = mgr.rename("amber-1-1-1-b", "amber-1-2-0-b").unwrap();
        assert_eq!(info.slot, 2, "a rename must not change the slot");
        assert_eq!(
            slots(&mgr),
            vec![("amber-1-1-0-a".into(), 1), ("amber-1-2-0-b".into(), 2)]
        );
    }

    #[test]
    fn restore_keeps_stored_slots_and_repairs_missing_or_duplicate_ones() {
        // The store is user-visible JSON: it can predate this feature (slot 0)
        // or be hand-edited into duplicates. Restore must repair, never panic
        // or abort, and do it deterministically (by-name order).
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());
        let write = |name: &str, slot: u32| {
            store
                .write_session(&SessionMeta {
                    name: name.to_string(),
                    cwd: PathBuf::from("/tmp"),
                    kind: SessionKind::Shell,
                    updated: 1,
                    resume_as_claude: false,
                    run_state: None,
                    slot,
                })
                .unwrap()
        };
        write("keeps", 7); // valid, must survive untouched
        write("zero", 0); // predates slots -> repaired to the lowest free
        write("dupe", 7); // collides with "keeps" -> repaired

        let mgr = SessionManager::new(dir.path()).unwrap();
        mgr.restore().unwrap();

        // By-name restore order: dupe, keeps, zero.
        //   dupe takes 7 first (it is valid at that point),
        //   keeps then collides and is repaired to 1,
        //   zero is unassigned and takes 2.
        assert_eq!(
            slots(&mgr),
            vec![("dupe".into(), 7), ("keeps".into(), 1), ("zero".into(), 2)]
        );
        // The repair is persisted, so it survives the next restart too.
        assert_eq!(store.read_session("keeps").unwrap().unwrap().slot, 1);
        assert_eq!(store.read_session("zero").unwrap().unwrap().slot, 2);
    }

    #[test]
    fn create_rejects_absurdly_long_names() {
        // Data-frame headers carry the name length as u16; cap well below it.
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        let long = "x".repeat(256);
        assert!(mgr.create(&long, "/tmp", SessionKind::Shell).is_err());
    }
}
