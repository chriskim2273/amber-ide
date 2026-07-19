//! Session table + save/restore. Owns the live [`PtySession`]s and mediates
//! between them and the [`StateStore`]. This is the piece that replaces
//! tmux-resurrect (restore) and tmux-continuum (snapshot).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use amber_core::proto::{ControlMsg, SessionInfo};
use amber_core::state::{Config, SessionKind, SessionMeta, StateStore};
use portable_pty::CommandBuilder;

use crate::pty::PtySession;
use crate::watchers::Watchers;

const DEFAULT_ROWS: u16 = 24;
const DEFAULT_COLS: u16 = 80;

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

pub struct SessionManager {
    store: StateStore,
    cfg: Config,
    root: PathBuf,
    sessions: Mutex<HashMap<String, Arc<PtySession>>>,
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
}

/// Consecutive absent periodic snapshots before `resume_as_claude` downgrades
/// true→false. At the default ~10 s snapshot cadence this is ~20 s of a shell
/// with no claude before it stops being restored as claude.
const CLAUDE_ABSENT_THRESHOLD: u32 = 2;

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

impl SessionManager {
    /// Open a manager rooted at `root`, loading config (defaults if absent).
    pub fn new(root: impl Into<PathBuf>) -> anyhow::Result<Self> {
        let root = root.into();
        let store = StateStore::new(root.clone());
        let cfg = store.load_config()?;
        Ok(SessionManager {
            store,
            cfg,
            root,
            sessions: Mutex::new(HashMap::new()),
            socket: None,
            watchers: None,
            claude_absent: Mutex::new(HashMap::new()),
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

    /// The state directory this manager (and its spawned supervisors) is
    /// rooted at.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Configured snapshot cadence in seconds (daemon's periodic-flush timer).
    pub fn snapshot_interval_secs(&self) -> u64 {
        self.cfg.snapshot_interval_secs
    }

    /// Session names become file names in the state store and travel in
    /// data-frame headers, so they must be non-empty, contain no path
    /// separators/NULs, not be `.`/`..`, and stay short enough for any
    /// filesystem (NAME_MAX) and the u16 wire header.
    fn validate_name(name: &str) -> anyhow::Result<()> {
        if name.is_empty() {
            anyhow::bail!("session name must not be empty");
        }
        if name.len() > 200 {
            anyhow::bail!("session name too long ({} bytes, max 200)", name.len());
        }
        if name == "." || name == ".." || name.contains('/') || name.contains('\0') {
            anyhow::bail!("invalid session name: {name:?}");
        }
        Ok(())
    }

    fn now() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
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
    fn command_for(&self, kind: SessionKind, name: &str, cwd: &Path) -> anyhow::Result<CommandBuilder> {
        match kind {
            SessionKind::Shell => {
                let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
                let mut cmd = CommandBuilder::new(shell);
                cmd.cwd(cwd);
                // A claude the user starts by hand in this shell inherits these,
                // so the global SessionStart hook can record its resume id
                // against this session name.
                cmd.env("AMBER_SESSION", name);
                cmd.env("AMBER_STATE_DIR", self.root.to_string_lossy().to_string());
                Ok(cmd)
            }
            SessionKind::Claude => {
                let exe = std::env::current_exe()?;
                let mut cmd = CommandBuilder::new(exe);
                cmd.args(["run", name]);
                cmd.cwd(cwd);
                cmd.env("AMBER_STATE_DIR", self.root.to_string_lossy().to_string());
                // Tell the supervisor where to report its phase back. If unset
                // (hand-started manager / tests), the supervisor falls back to
                // the default socket derived from AMBER_STATE_DIR.
                if let Some(sock) = &self.socket {
                    cmd.env("AMBER_SOCK", sock.to_string_lossy().to_string());
                }
                Ok(cmd)
            }
        }
    }

    fn spawn(&self, kind: SessionKind, name: &str, cwd: &Path) -> anyhow::Result<Arc<PtySession>> {
        let cwd = Self::resolve_cwd(cwd);
        let mut cmd = self.command_for(kind, name, &cwd)?;
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
        let sess = self.spawn(kind, name, &cwd)?;
        let meta = SessionMeta {
            name: name.to_string(),
            cwd,
            kind,
            updated: Self::now(),
            resume_as_claude: false,
            run_state: None,
        };
        if let Err(e) = self.store.write_session(&meta) {
            // Don't leak the freshly-spawned child if persisting fails.
            let _ = sess.kill();
            return Err(e);
        }
        self.sessions
            .lock()
            .unwrap()
            .insert(name.to_string(), Arc::clone(&sess));
        Ok(sess)
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
        let sessions = self.sessions.lock().unwrap();
        for (name, sess) in sessions.iter() {
            self.store.write_scrollback(name, &sess.scrollback())?;
            self.persist_live_cwd(name, sess, is_final);
        }
        // Drop hysteresis counters for sessions that no longer exist (bounded).
        self.claude_absent.lock().unwrap().retain(|k, _| sessions.contains_key(k));
        Ok(())
    }

    /// Persist a Shell session's live working directory so an in-shell `cd`
    /// survives restart (the shell respawns where the user left it, not its
    /// original cwd). Read from the child's `/proc/<pid>/cwd`. Claude sessions
    /// are left alone — their cwd is the authoritative, pre-trusted folder the
    /// pane was created in, which `amber run` never `cd`s out of. `is_final`
    /// preserves `resume_as_claude` (see `snapshot_final`).
    fn persist_live_cwd(&self, name: &str, sess: &PtySession, is_final: bool) {
        let Ok(Some(meta)) = self.store.read_session(name) else { return };
        if meta.kind != SessionKind::Shell {
            return;
        }
        let new_cwd = sess.live_cwd().filter(|d| d.is_dir()).unwrap_or_else(|| meta.cwd.clone());
        // Was the user running claude by hand in this shell? If so, restore it as
        // a resumable claude instead of a bare shell. Final snapshots preserve the
        // stored flag (detection is unreliable mid-shutdown); periodic snapshots
        // re-detect with hysteresis so one transient miss can't downgrade.
        let new_resume = if is_final {
            meta.resume_as_claude
        } else {
            let detected = sess.is_running_claude();
            let mut streaks = self.claude_absent.lock().unwrap();
            let streak = streaks.get(name).copied().unwrap_or(0);
            let (flag, next) =
                decide_resume(meta.resume_as_claude, detected, streak, CLAUDE_ABSENT_THRESHOLD);
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
    pub fn restore(&self) -> anyhow::Result<()> {
        let metas = self.store.list_sessions()?;
        let mut sessions = self.sessions.lock().unwrap();
        for meta in metas {
            match self.restore_one(&meta) {
                Ok(sess) => {
                    sessions.insert(meta.name.clone(), sess);
                }
                Err(e) => {
                    eprintln!("amber daemon: restore skipped session {}: {e}", meta.name);
                }
            }
        }
        Ok(())
    }

    /// Restore a single persisted session. The scrollback is read BEFORE the
    /// child is spawned so a read failure cannot leak a freshly-spawned
    /// process.
    fn restore_one(&self, meta: &SessionMeta) -> anyhow::Result<Arc<PtySession>> {
        let scrollback = self.store.read_scrollback(&meta.name)?;
        // A shell that was running a hand-started claude comes back as a
        // supervised, resumable claude (which falls back to a shell when
        // claude exits — so the pane never regresses).
        let kind = if meta.resume_as_claude { SessionKind::Claude } else { meta.kind };
        let sess = self.spawn(kind, &meta.name, &meta.cwd)?;
        if let Some(bytes) = scrollback {
            sess.preload(&bytes);
        }
        // A restored claude session starts back in the `claude` phase; its
        // freshly-spawned supervisor re-reports on any later transition. Any
        // persisted run_state is deliberately discarded here.
        if kind == SessionKind::Claude {
            sess.set_run_state(Some("claude".to_string()));
        }
        Ok(sess)
    }

    pub fn session(&self, name: &str) -> Option<Arc<PtySession>> {
        self.sessions.lock().unwrap().get(name).cloned()
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

    /// The persisted kind of a session, from the state store (None if the
    /// metadata is missing/unreadable). Consulted on Attach to apply the
    /// spec-§5 reconnect semantics for raw clients.
    pub fn session_kind(&self, name: &str) -> Option<SessionKind> {
        self.store.read_session(name).ok().flatten().map(|m| m.kind)
    }

    /// Record a claude session's supervision phase (from `ReportRunState`).
    /// Errors — surfaced to the client as an `Error` reply — if the session is
    /// unknown, is not a claude session, or `state` is not one of the three
    /// allowed values. A restored hand-started claude (`resume_as_claude`) runs
    /// the supervisor too, so it counts as claude here.
    pub fn set_run_state(&self, name: &str, state: &str) -> anyhow::Result<()> {
        // "suspended" (Slice 3): claude parked by a freeze grace — child killed
        // to free RAM, pty held idle, resumable.
        if !matches!(state, "claude" | "claude-retrying" | "shell-fallback" | "suspended") {
            anyhow::bail!("invalid run_state: {state}");
        }
        let sess = self
            .session(name)
            .ok_or_else(|| anyhow::anyhow!("no such session: {name}"))?;
        let is_claude = self
            .store
            .read_session(name)
            .ok()
            .flatten()
            .map(|m| m.kind == SessionKind::Claude || m.resume_as_claude)
            .unwrap_or(false);
        if !is_claude {
            anyhow::bail!("run_state applies only to claude sessions: {name}");
        }
        sess.set_run_state(Some(state.to_string()));
        Ok(())
    }

    /// Signal a claude session's supervisor (`amber run`) to suspend (SIGUSR1 —
    /// kill claude, free its RAM, idle) or resume (SIGUSR2 — relaunch
    /// `claude --resume`). Slice 3 freeze-to-free-RAM. Errors if the session is
    /// unknown, not a claude session, or has no child pid. The supervisor
    /// reports the resulting phase back via `ReportRunState`, so this does not
    /// itself set run_state.
    pub fn signal_suspend(&self, name: &str, resume: bool) -> anyhow::Result<()> {
        let sess = self
            .session(name)
            .ok_or_else(|| anyhow::anyhow!("no such session: {name}"))?;
        let is_claude = self
            .store
            .read_session(name)
            .ok()
            .flatten()
            .map(|m| m.kind == SessionKind::Claude || m.resume_as_claude)
            .unwrap_or(false);
        if !is_claude {
            anyhow::bail!("suspend applies only to claude sessions: {name}");
        }
        let pid = sess
            .pid()
            .ok_or_else(|| anyhow::anyhow!("session {name} has no child pid"))?;
        let sig = if resume { nix::libc::SIGUSR2 } else { nix::libc::SIGUSR1 };
        // SAFETY: kill(2) with our own child's pid and a fixed valid signal;
        // failure is reported via errno, never UB.
        let rc = unsafe { nix::libc::kill(pid as nix::libc::pid_t, sig) };
        if rc != 0 {
            anyhow::bail!(
                "failed to signal session {name}: {}",
                std::io::Error::last_os_error()
            );
        }
        Ok(())
    }

    pub fn names(&self) -> Vec<String> {
        let mut v: Vec<String> = self.sessions.lock().unwrap().keys().cloned().collect();
        v.sort();
        v
    }

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
                    updated: meta.updated,
                    run_state: sess.run_state(),
                    claude_id: self.store.read_claude(&meta.name).ok().flatten().map(|c| c.session_id),
                    cols: sess.size().map(|(_, c)| c).unwrap_or(0),
                    rows: sess.size().map(|(r, _)| r).unwrap_or(0),
                })
            })
            .collect();
        infos.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(infos)
    }

    pub fn write(&self, name: &str, bytes: &[u8]) -> anyhow::Result<()> {
        let sess = self
            .session(name)
            .ok_or_else(|| anyhow::anyhow!("no such session: {name}"))?;
        sess.write(bytes)
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
        let mut sessions = self.sessions.lock().unwrap();
        let dead: Vec<String> = sessions
            .iter()
            .filter(|(_, s)| !s.is_alive())
            .map(|(n, _)| n.clone())
            .collect();
        for name in &dead {
            sessions.remove(name);
            self.store.remove_session(name)?;
        }
        Ok(dead)
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
    /// The whole operation is done under the `sessions` lock so a concurrent
    /// snapshot can never observe (or persist) a half-rename.
    pub fn rename(&self, from: &str, to: &str) -> anyhow::Result<SessionInfo> {
        Self::validate_name(to)?;
        // Lock order matches `snapshot_inner` (sessions, then claude_absent) —
        // reversing it would deadlock against the snapshot timer.
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.contains_key(to) || self.store.read_session(to)?.is_some() {
            anyhow::bail!("session already exists: {to}");
        }
        let sess = sessions
            .remove(from)
            .ok_or_else(|| anyhow::anyhow!("no such session: {from}"))?;
        self.claude_absent.lock().unwrap().remove(from);

        if let Err(e) = self.store.rename_session(from, to) {
            sessions.insert(from.to_string(), sess); // leave the session as it was
            return Err(e);
        }

        let meta = self
            .store
            .read_session(to)?
            .ok_or_else(|| anyhow::anyhow!("renamed session {to} vanished from the store"))?;
        let sess = if meta.kind == SessionKind::Claude {
            // Deliberately keyed on the persisted kind, NOT on
            // `kind || resume_as_claude`: a shell that merely HAS a hand-started
            // claude inside it must not have its user's shell killed.
            let size = sess.size();
            let _ = sess.kill();
            // If this spawn fails (pty/fork exhaustion — rare) the store is
            // already consistent under `to`, so nothing is lost and the session
            // comes back on the next daemon start; until then the client sees an
            // Error and a stale `from` pane. Not worth an un-rename dance.
            let fresh = self.restore_one(&meta)?;
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
            sess
        };
        sessions.insert(to.to_string(), Arc::clone(&sess));

        Ok(SessionInfo {
            name: meta.name,
            cwd: meta.cwd.to_string_lossy().into_owned(),
            kind: match meta.kind {
                SessionKind::Shell => "shell".to_string(),
                SessionKind::Claude => "claude".to_string(),
            },
            alive: sess.is_alive(),
            updated: meta.updated,
            run_state: sess.run_state(),
            claude_id: self.store.read_claude(to).ok().flatten().map(|c| c.session_id),
            cols: sess.size().map(|(_, c)| c).unwrap_or(0),
            rows: sess.size().map(|(r, _)| r).unwrap_or(0),
        })
    }

    /// Kill and forget a session, removing its persisted artifacts.
    pub fn remove(&self, name: &str) -> anyhow::Result<()> {
        if let Some(sess) = self.sessions.lock().unwrap().remove(name) {
            let _ = sess.kill();
        }
        self.store.remove_session(name)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

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
    fn snapshot_persists_a_shells_live_cwd_after_cd() {
        // A `cd` inside a shell must survive restart: snapshot reads the child's
        // live /proc/<pid>/cwd and updates the stored cwd.
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        mgr.create("sh", "/tmp", SessionKind::Shell).unwrap();
        let sess = mgr.session("sh").unwrap();

        let target = std::fs::canonicalize(dir.path()).unwrap();
        sess.write(format!("cd '{}'\n", target.display()).as_bytes()).unwrap();

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
    fn create_stores_absolute_cwd_for_relative_input() {
        // A relative `.` would resolve against the daemon's launch dir (which
        // differs between hand-start and systemd), breaking claude resume.
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        mgr.create("amber-1-1-0-a", ".", SessionKind::Shell).unwrap();
        let cwd = mgr.session_infos().unwrap()[0].cwd.clone();
        let home = std::env::var("HOME").unwrap_or_default();
        assert_eq!(cwd, home, "'.' must resolve to an absolute, stable $HOME");
        assert!(Path::new(&cwd).is_absolute());
    }

    #[test]
    fn reap_removes_dead_sessions_and_their_persisted_state() {
        // "Child exits -> session ends" (spec §6.1): a dead session must
        // leave the live table and the state store, while live ones stay.
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

        let reaped = mgr.reap().unwrap();
        assert_eq!(reaped, vec!["dies".to_string()]);
        assert_eq!(mgr.names(), vec!["lives".to_string()]);
        assert!(!dir.path().join("sessions/dies.json").exists());
        assert!(dir.path().join("sessions/lives.json").exists());
    }

    #[test]
    fn create_fails_cleanly_when_metadata_cannot_be_persisted() {
        // If the state store is unwritable, create must error, track nothing,
        // and kill the just-spawned child rather than leaking it.
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
        let result = mgr.create("orphan", "/tmp", SessionKind::Shell);
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(result.is_err(), "create must fail when the store is unwritable");
        assert!(mgr.names().is_empty(), "failed create must not be tracked");
        assert!(!dir.path().join("sessions/orphan.json").exists());
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
                })
                .unwrap();
        }
        store.write_scrollback("good-a", b"history-a").unwrap();
        // The poison pill: a directory where the scrollback file should be.
        std::fs::create_dir_all(dir.path().join("scrollback/poison.bin")).unwrap();

        let mgr = SessionManager::new(dir.path()).unwrap();
        mgr.restore().expect("restore must not abort on one bad session");
        assert_eq!(
            mgr.names(),
            vec!["good-a".to_string(), "good-b".to_string()],
            "healthy sessions restored, poison one skipped"
        );
        assert!(
            mgr.session("good-a").unwrap().scrollback().windows(9).any(|w| w == b"history-a"),
            "healthy session's scrollback preloaded"
        );
    }

    #[test]
    fn set_run_state_stores_on_claude_and_surfaces_in_session_infos() {
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        mgr.create("amber-1-1-0-c", dir.path(), SessionKind::Claude).unwrap();

        mgr.set_run_state("amber-1-1-0-c", "claude-retrying").unwrap();
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
        mgr.create("amber-1-1-0-s", "/tmp", SessionKind::Shell).unwrap();
        mgr.create("amber-1-1-1-c", dir.path(), SessionKind::Claude).unwrap();

        // Shell session: run_state does not apply.
        assert!(mgr.set_run_state("amber-1-1-0-s", "claude").is_err());
        // Unknown session.
        assert!(mgr.set_run_state("nope", "claude").is_err());
        // Invalid state string, even on a claude session.
        assert!(mgr.set_run_state("amber-1-1-1-c", "bogus").is_err());
    }

    #[test]
    fn rename_rekeys_a_shell_session_and_keeps_its_child() {
        // Spec §3.2: a shell moves tab in place — same pty, same child, same
        // scrollback; only the key and the store files change.
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        mgr.create("amber-1-1-0-a", "/tmp", SessionKind::Shell).unwrap();
        let before = mgr.session("amber-1-1-0-a").unwrap();

        let info = mgr.rename("amber-1-1-0-a", "amber-1-2-0-a").unwrap();

        assert_eq!(info.name, "amber-1-2-0-a");
        assert_eq!(mgr.names(), vec!["amber-1-2-0-a".to_string()]);
        let after = mgr.session("amber-1-2-0-a").unwrap();
        assert!(Arc::ptr_eq(&before, &after), "shell must keep its live pty");
        assert_eq!(before.pid(), after.pid(), "shell must keep its child");
        assert!(after.is_alive());
        assert!(dir.path().join("sessions/amber-1-2-0-a.json").exists());
        assert!(!dir.path().join("sessions/amber-1-1-0-a.json").exists());
    }

    #[test]
    fn rename_respawns_a_claude_session_under_the_new_name() {
        // Spec §3.2: a claude supervisor is env-bound to its name, so a rename
        // respawns it under the new name (same conversation resumes via the
        // migrated claude/<to>.json) — a NEW child, preserving cwd.
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        mgr.create("amber-1-1-0-c", dir.path(), SessionKind::Claude).unwrap();
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
        assert_eq!(
            mgr.store.read_claude("amber-1-2-0-c").unwrap().unwrap().session_id,
            "conv-42",
            "the conversation id must follow the rename so --resume still works"
        );
        assert_eq!(
            mgr.store.read_session("amber-1-2-0-c").unwrap().unwrap().cwd,
            std::fs::canonicalize(dir.path()).unwrap_or_else(|_| dir.path().to_path_buf()),
            "cwd preserved"
        );
    }

    #[test]
    fn rename_refuses_bad_target_missing_source_and_existing_target() {
        // Spec §7: a rename must never clobber another session.
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        mgr.create("amber-1-1-0-a", "/tmp", SessionKind::Shell).unwrap();
        mgr.create("amber-1-1-1-b", "/tmp", SessionKind::Shell).unwrap();

        assert!(mgr.rename("ghost", "amber-1-2-0-z").is_err(), "missing source");
        assert!(
            mgr.rename("amber-1-1-0-a", "amber-1-1-1-b").is_err(),
            "must not clobber an existing session"
        );
        assert!(mgr.rename("amber-1-1-0-a", "../evil").is_err(), "invalid target");
        assert!(mgr.rename("amber-1-1-0-a", "").is_err(), "empty target");

        // Every refusal leaves both sessions intact.
        assert_eq!(
            mgr.names(),
            vec!["amber-1-1-0-a".to_string(), "amber-1-1-1-b".to_string()]
        );
        assert!(mgr.session("amber-1-1-1-b").unwrap().is_alive());
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
