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
        let cwd = cwd.into();
        let sess = self.spawn(kind, name, &cwd)?;
        let meta = SessionMeta {
            name: name.to_string(),
            cwd,
            kind,
            updated: Self::now(),
        };
        self.store.write_session(&meta)?;
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

    /// Kill and forget a session, removing its persisted artifacts.
    pub fn remove(&self, name: &str) -> anyhow::Result<()> {
        if let Some(sess) = self.sessions.lock().unwrap().remove(name) {
            let _ = sess.kill();
        }
        self.store.remove_session(name)?;
        Ok(())
    }
}
