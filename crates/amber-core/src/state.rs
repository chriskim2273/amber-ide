//! State store + config: atomic session/scrollback persistence. TDD packet.
//!
//! Layout under a root dir:
//! ```text
//! config.toml
//! sessions/<name>.json     { name, cwd, kind: "shell"|"claude", updated }
//! claude/<name>.json       { session_id, cwd, updated }
//! scrollback/<name>.bin     raw bytes
//! ```
//! All writes are atomic: write to a `.tmp` file in the same directory as the
//! final file, then `fs::rename` over it. Missing/partial files are tolerated
//! at restore (see [`StateStore::list_sessions`], [`StateStore::read_session`]).

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Kind of a persisted session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionKind {
    Shell,
    Claude,
}

/// Metadata for a session, persisted as `sessions/<name>.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionMeta {
    pub name: String,
    pub cwd: PathBuf,
    pub kind: SessionKind,
    pub updated: u64,
}

/// Metadata for a Claude sub-session, persisted as `claude/<name>.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClaudeMeta {
    pub session_id: String,
    pub cwd: PathBuf,
    pub updated: u64,
}

/// Daemon-wide configuration, persisted as `config.toml`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Config {
    pub claude_path: Option<PathBuf>,
    pub snapshot_interval_secs: u64,
    pub scrollback_bytes: usize,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            claude_path: None,
            snapshot_interval_secs: 10,
            scrollback_bytes: 2 * 1024 * 1024,
        }
    }
}

/// Filesystem-backed state store rooted at a directory.
pub struct StateStore {
    root: PathBuf,
}

impl StateStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        StateStore { root: root.into() }
    }

    fn sessions_dir(&self) -> PathBuf {
        self.root.join("sessions")
    }

    fn claude_dir(&self) -> PathBuf {
        self.root.join("claude")
    }

    fn scrollback_dir(&self) -> PathBuf {
        self.root.join("scrollback")
    }

    fn session_path(&self, name: &str) -> PathBuf {
        self.sessions_dir().join(format!("{name}.json"))
    }

    fn claude_path(&self, name: &str) -> PathBuf {
        self.claude_dir().join(format!("{name}.json"))
    }

    fn scrollback_path(&self, name: &str) -> PathBuf {
        self.scrollback_dir().join(format!("{name}.bin"))
    }

    fn config_path(&self) -> PathBuf {
        self.root.join("config.toml")
    }

    /// Atomically write `bytes` to `path`: create parent dirs, write a
    /// same-directory temp file (named with the pid to avoid collisions),
    /// then rename over the final path.
    fn atomic_write(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
        let parent = path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("path has no parent: {}", path.display()))?;
        fs::create_dir_all(parent)?;
        let file_name = path
            .file_name()
            .ok_or_else(|| anyhow::anyhow!("path has no file name: {}", path.display()))?
            .to_string_lossy();
        let tmp_path = parent.join(format!("{file_name}.{}.tmp", std::process::id()));
        fs::write(&tmp_path, bytes)?;
        fs::rename(&tmp_path, path)?;
        Ok(())
    }

    /// Read and deserialize a JSON file, returning `Ok(None)` if it doesn't
    /// exist and `Err` if it exists but fails to parse.
    fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> anyhow::Result<Option<T>> {
        match fs::read(path) {
            Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn write_json<T: Serialize>(path: &Path, value: &T) -> anyhow::Result<()> {
        let bytes = serde_json::to_vec_pretty(value)?;
        Self::atomic_write(path, &bytes)
    }

    /// Remove a file if it exists; missing files are not an error.
    fn remove_if_exists(path: &Path) -> anyhow::Result<()> {
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    pub fn write_session(&self, m: &SessionMeta) -> anyhow::Result<()> {
        Self::write_json(&self.session_path(&m.name), m)
    }

    pub fn read_session(&self, name: &str) -> anyhow::Result<Option<SessionMeta>> {
        Self::read_json(&self.session_path(name))
    }

    pub fn list_sessions(&self) -> anyhow::Result<Vec<SessionMeta>> {
        let dir = self.sessions_dir();
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };

        let mut sessions = Vec::new();
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(bytes) = fs::read(&path) {
                if let Ok(meta) = serde_json::from_slice::<SessionMeta>(&bytes) {
                    sessions.push(meta);
                }
            }
        }
        Ok(sessions)
    }

    pub fn remove_session(&self, name: &str) -> anyhow::Result<()> {
        Self::remove_if_exists(&self.session_path(name))?;
        Self::remove_if_exists(&self.claude_path(name))?;
        Self::remove_if_exists(&self.scrollback_path(name))?;
        Ok(())
    }

    pub fn write_scrollback(&self, name: &str, bytes: &[u8]) -> anyhow::Result<()> {
        Self::atomic_write(&self.scrollback_path(name), bytes)
    }

    pub fn read_scrollback(&self, name: &str) -> anyhow::Result<Option<Vec<u8>>> {
        match fs::read(self.scrollback_path(name)) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn write_claude(&self, name: &str, m: &ClaudeMeta) -> anyhow::Result<()> {
        Self::write_json(&self.claude_path(name), m)
    }

    pub fn read_claude(&self, name: &str) -> anyhow::Result<Option<ClaudeMeta>> {
        Self::read_json(&self.claude_path(name))
    }

    pub fn load_config(&self) -> anyhow::Result<Config> {
        match fs::read_to_string(self.config_path()) {
            Ok(s) => Ok(toml::from_str(&s)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
            Err(e) => Err(e.into()),
        }
    }

    pub fn save_config(&self, c: &Config) -> anyhow::Result<()> {
        let s = toml::to_string_pretty(c)?;
        Self::atomic_write(&self.config_path(), s.as_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn sample_session(name: &str) -> SessionMeta {
        SessionMeta {
            name: name.to_string(),
            cwd: PathBuf::from("/tmp/proj"),
            kind: SessionKind::Shell,
            updated: 1_700_000_000,
        }
    }

    #[test]
    fn session_round_trip() {
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());
        let meta = sample_session("alpha");

        store.write_session(&meta).unwrap();
        let read = store.read_session("alpha").unwrap();

        assert_eq!(read, Some(meta));
    }

    #[test]
    fn read_session_missing_returns_none() {
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());

        let read = store.read_session("nope").unwrap();

        assert_eq!(read, None);
    }

    #[test]
    fn read_session_corrupt_is_err() {
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());
        let sessions_dir = dir.path().join("sessions");
        fs::create_dir_all(&sessions_dir).unwrap();
        fs::write(sessions_dir.join("broken.json"), b"{ not json").unwrap();

        let result = store.read_session("broken");

        assert!(result.is_err());
    }

    #[test]
    fn list_sessions_skips_corrupt_files() {
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());
        store.write_session(&sample_session("good-a")).unwrap();
        store.write_session(&sample_session("good-b")).unwrap();
        let sessions_dir = dir.path().join("sessions");
        fs::write(sessions_dir.join("bad.json"), b"not valid json at all").unwrap();

        let mut names: Vec<String> = store
            .list_sessions()
            .unwrap()
            .into_iter()
            .map(|m| m.name)
            .collect();
        names.sort();

        assert_eq!(names, vec!["good-a".to_string(), "good-b".to_string()]);
    }

    #[test]
    fn list_sessions_empty_dir_is_empty() {
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());

        let sessions = store.list_sessions().unwrap();

        assert!(sessions.is_empty());
    }

    #[test]
    fn write_session_atomic_overwrite_second_wins() {
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());
        let mut meta = sample_session("alpha");
        store.write_session(&meta).unwrap();

        meta.updated = 1_800_000_000;
        meta.kind = SessionKind::Claude;
        store.write_session(&meta).unwrap();

        let read = store.read_session("alpha").unwrap().unwrap();
        assert_eq!(read.updated, 1_800_000_000);
        assert_eq!(read.kind, SessionKind::Claude);

        // No leftover temp files in the sessions dir.
        let sessions_dir = dir.path().join("sessions");
        let entries: Vec<_> = fs::read_dir(&sessions_dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(entries, vec!["alpha.json".to_string()]);
    }

    #[test]
    fn scrollback_round_trip() {
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());
        let bytes = b"hello scrollback\x00\x01\x02".to_vec();

        store.write_scrollback("alpha", &bytes).unwrap();
        let read = store.read_scrollback("alpha").unwrap();

        assert_eq!(read, Some(bytes));
    }

    #[test]
    fn scrollback_empty_round_trip() {
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());

        store.write_scrollback("alpha", &[]).unwrap();
        let read = store.read_scrollback("alpha").unwrap();

        assert_eq!(read, Some(Vec::new()));
    }

    #[test]
    fn scrollback_missing_returns_none() {
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());

        let read = store.read_scrollback("nope").unwrap();

        assert_eq!(read, None);
    }

    #[test]
    fn claude_meta_round_trip() {
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());
        let meta = ClaudeMeta {
            session_id: "sess-123".to_string(),
            cwd: PathBuf::from("/tmp/proj"),
            updated: 1_700_000_001,
        };

        store.write_claude("alpha", &meta).unwrap();
        let read = store.read_claude("alpha").unwrap();

        assert_eq!(read, Some(meta));
    }

    #[test]
    fn claude_meta_missing_returns_none() {
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());

        let read = store.read_claude("nope").unwrap();

        assert_eq!(read, None);
    }

    #[test]
    fn config_default_when_missing() {
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());

        let cfg = store.load_config().unwrap();

        assert_eq!(cfg, Config::default());
        // Loading a missing config must not write one.
        assert!(!dir.path().join("config.toml").exists());
    }

    #[test]
    fn config_corrupt_is_err() {
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());
        fs::write(dir.path().join("config.toml"), b"not = [valid toml").unwrap();

        let result = store.load_config();

        assert!(result.is_err());
    }

    #[test]
    fn config_save_load_round_trip() {
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());
        let cfg = Config {
            claude_path: Some(PathBuf::from("/usr/local/bin/claude")),
            snapshot_interval_secs: 42,
            scrollback_bytes: 4096,
        };

        store.save_config(&cfg).unwrap();
        let read = store.load_config().unwrap();

        assert_eq!(read, cfg);
    }

    #[test]
    fn remove_session_deletes_all_three_artifacts() {
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());
        store.write_session(&sample_session("alpha")).unwrap();
        store
            .write_claude(
                "alpha",
                &ClaudeMeta {
                    session_id: "sess-1".to_string(),
                    cwd: PathBuf::from("/tmp"),
                    updated: 1,
                },
            )
            .unwrap();
        store.write_scrollback("alpha", b"data").unwrap();

        store.remove_session("alpha").unwrap();

        assert_eq!(store.read_session("alpha").unwrap(), None);
        assert_eq!(store.read_claude("alpha").unwrap(), None);
        assert_eq!(store.read_scrollback("alpha").unwrap(), None);
    }

    #[test]
    fn remove_session_missing_is_not_an_error() {
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());

        let result = store.remove_session("never-existed");

        assert!(result.is_ok());
    }
}
