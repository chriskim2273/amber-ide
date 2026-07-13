//! Session table + save/restore. Owns the live [`PtySession`]s and mediates
//! between them and the [`StateStore`]. This is the piece that replaces
//! tmux-resurrect (restore) and tmux-continuum (snapshot).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use amber_core::state::{Config, SessionKind, SessionMeta, StateStore};
use portable_pty::CommandBuilder;

use crate::pty::PtySession;

const DEFAULT_ROWS: u16 = 24;
const DEFAULT_COLS: u16 = 80;

pub struct SessionManager {
    store: StateStore,
    cfg: Config,
    root: PathBuf,
    sessions: Mutex<HashMap<String, Arc<PtySession>>>,
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
        })
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
                Ok(cmd)
            }
            SessionKind::Claude => {
                let exe = std::env::current_exe()?;
                let mut cmd = CommandBuilder::new(exe);
                cmd.args(["run", name]);
                cmd.cwd(cwd);
                cmd.env("AMBER_STATE_DIR", self.root.to_string_lossy().to_string());
                Ok(cmd)
            }
        }
    }

    fn spawn(&self, kind: SessionKind, name: &str, cwd: &Path) -> anyhow::Result<Arc<PtySession>> {
        let cmd = self.command_for(kind, name, cwd)?;
        Ok(Arc::new(PtySession::spawn(
            cmd,
            DEFAULT_ROWS,
            DEFAULT_COLS,
            self.cfg.scrollback_bytes,
        )?))
    }

    /// Create a new session, persist its metadata, and track it live.
    pub fn create(
        &self,
        name: &str,
        cwd: impl Into<PathBuf>,
        kind: SessionKind,
    ) -> anyhow::Result<Arc<PtySession>> {
        Self::validate_name(name)?;
        let cwd = cwd.into();
        let sess = self.spawn(kind, name, &cwd)?;
        let meta = SessionMeta {
            name: name.to_string(),
            cwd,
            kind,
            updated: Self::now(),
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
    pub fn snapshot(&self) -> anyhow::Result<()> {
        let sessions = self.sessions.lock().unwrap();
        for (name, sess) in sessions.iter() {
            self.store.write_scrollback(name, &sess.scrollback())?;
        }
        Ok(())
    }

    /// Recreate every persisted session, seeding its ring with saved scrollback.
    pub fn restore(&self) -> anyhow::Result<()> {
        let metas = self.store.list_sessions()?;
        let mut sessions = self.sessions.lock().unwrap();
        for meta in metas {
            let sess = self.spawn(meta.kind, &meta.name, &meta.cwd)?;
            if let Some(bytes) = self.store.read_scrollback(&meta.name)? {
                sess.preload(&bytes);
            }
            sessions.insert(meta.name.clone(), sess);
        }
        Ok(())
    }

    pub fn session(&self, name: &str) -> Option<Arc<PtySession>> {
        self.sessions.lock().unwrap().get(name).cloned()
    }

    pub fn names(&self) -> Vec<String> {
        let mut v: Vec<String> = self.sessions.lock().unwrap().keys().cloned().collect();
        v.sort();
        v
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
    fn create_rejects_absurdly_long_names() {
        // Data-frame headers carry the name length as u16; cap well below it.
        let dir = tempdir().unwrap();
        let mgr = SessionManager::new(dir.path()).unwrap();
        let long = "x".repeat(256);
        assert!(mgr.create(&long, "/tmp", SessionKind::Shell).is_err());
    }
}
