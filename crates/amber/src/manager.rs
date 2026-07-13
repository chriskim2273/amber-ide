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
    sessions: Mutex<HashMap<String, Arc<PtySession>>>,
}

impl SessionManager {
    /// Open a manager rooted at `root`, loading config (defaults if absent).
    pub fn new(root: impl Into<PathBuf>) -> anyhow::Result<Self> {
        let store = StateStore::new(root);
        let cfg = store.load_config()?;
        Ok(SessionManager {
            store,
            cfg,
            sessions: Mutex::new(HashMap::new()),
        })
    }

    fn now() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }

    /// The command a session of `kind` runs. Slice 2 replaces the Claude arm
    /// with the real `claude --resume/--continue` supervisor; for now it spawns
    /// a shell so the session exists.
    fn command_for(kind: SessionKind, cwd: &Path) -> CommandBuilder {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        let mut cmd = CommandBuilder::new(shell);
        cmd.cwd(cwd);
        let _ = kind; // both kinds spawn a shell in Slice 0
        cmd
    }

    fn spawn(&self, kind: SessionKind, cwd: &Path) -> anyhow::Result<Arc<PtySession>> {
        let cmd = Self::command_for(kind, cwd);
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
        let sess = self.spawn(kind, &cwd)?;
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
            let sess = self.spawn(meta.kind, &meta.cwd)?;
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
