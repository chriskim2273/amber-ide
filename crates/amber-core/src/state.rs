//! State store + config: atomic session/scrollback persistence. TDD packet.
//!
//! Layout under a root dir:
//! ```text
//! config.toml
//! sessions/<name>.json     { name, cwd, kind: "shell"|"claude"|"grok"|"codex", updated }
//! claude/<name>.json       { session_id, cwd, updated }   (grok/codex ids live here too)
//! scrollback/<name>.bin     raw bytes
//! ```
//! All writes are atomic: write to a `.tmp` file in the same directory as the
//! final file, then `fs::rename` over it. Missing/partial files are tolerated
//! at restore (see [`StateStore::list_sessions`], [`StateStore::read_session`]).

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// Kind of a persisted session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionKind {
    Shell,
    Claude,
    Grok,
    Codex,
}

impl SessionKind {
    /// True for a supervised coding-agent session — one whose pty runs
    /// `amber run <name>` instead of a bare shell. These share every behaviour
    /// that is about "an agent TUI on the alt screen", not about claude
    /// specifically: backlog suppression for raw clients, run-state reporting,
    /// suspend/resume. Adding another agent means adding one arm here, not
    /// hunting `== SessionKind::Claude` across the daemon.
    pub fn is_agent(self) -> bool {
        matches!(
            self,
            SessionKind::Claude | SessionKind::Grok | SessionKind::Codex
        )
    }

    /// The wire spelling (what `SessionInfo.kind` carries and the app matches on).
    pub fn as_str(self) -> &'static str {
        match self {
            SessionKind::Shell => "shell",
            SessionKind::Claude => "claude",
            SessionKind::Grok => "grok",
            SessionKind::Codex => "codex",
        }
    }
}

/// Metadata for a session, persisted as `sessions/<name>.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionMeta {
    pub name: String,
    pub cwd: PathBuf,
    pub kind: SessionKind,
    pub updated: u64,
    /// A `Shell` session that was running a hand-started `claude` at snapshot
    /// time. On restore it is relaunched as a supervised claude (resuming that
    /// conversation) instead of a bare shell. Defaulted for older records.
    #[serde(default)]
    pub resume_as_claude: bool,
    /// Last-known claude supervision phase (see
    /// [`amber_core::proto::SessionInfo::run_state`]). Persisted so a snapshot
    /// round-trips; on restore a claude session is reset to `"claude"` (its
    /// supervisor re-reports), so the stored value is never read back — it
    /// exists for wire/format completeness. Defaulted for older records.
    #[serde(default)]
    pub run_state: Option<String>,
    /// Stable per-session number: what `amber ls` prints and `amber attach <n>`
    /// resolves. Assigned lowest-free at creation, carried unchanged across a
    /// rename and a daemon restart, and freed only when the session leaves the
    /// live table. `0` = unassigned — older records predating this field, or a
    /// hand-edited store; `SessionManager::restore` repairs those.
    #[serde(default)]
    pub slot: u32,
}

/// Metadata for a Claude sub-session, persisted as `claude/<name>.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClaudeMeta {
    pub session_id: String,
    pub cwd: PathBuf,
    pub updated: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct RenameJournal {
    from: String,
    to: String,
    source: SessionMeta,
}

/// Daemon-wide configuration, persisted as `config.toml`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Config {
    pub claude_path: Option<PathBuf>,
    /// Resolved `grok` binary, cached the same way `claude_path` is (login-shell
    /// resolution, never the daemon's own PATH). Defaulted so a config.toml
    /// written before grok support still loads.
    #[serde(default)]
    pub grok_path: Option<PathBuf>,
    /// Resolved `codex` binary (OpenAI Codex CLI). Defaulted for older configs.
    #[serde(default)]
    pub codex_path: Option<PathBuf>,
    pub snapshot_interval_secs: u64,
    pub scrollback_bytes: usize,
    #[serde(default)]
    pub memory: MemoryConfig,
    /// Host PSI thresholds and timing for automatic resource-pressure parking.
    /// `#[serde(default)]` keeps configuration files written before this
    /// policy valid.
    #[serde(default)]
    pub pressure: PressureConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryConfig {
    pub enabled: bool,
    pub budget_mb: Option<u64>,
    pub session_high_mb: u64,
}

impl Default for MemoryConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            budget_mb: None,
            session_high_mb: 4096,
        }
    }
}

impl MemoryConfig {
    pub fn budget_kb(&self, physical_kb: Option<u64>, cgroup_limit_kb: Option<u64>) -> Option<u64> {
        let requested = self
            .budget_mb
            .map(|mb| mb.saturating_mul(1024))
            .or_else(|| physical_kb.map(|kb| kb / 2))
            .or(cgroup_limit_kb)?
            .max(512 * 1024);
        Some(cgroup_limit_kb.map_or(requested, |limit| requested.min(limit)))
    }

    pub fn session_high_kb(&self, budget_kb: Option<u64>) -> u64 {
        let requested = self.session_high_mb.saturating_mul(1024).max(256 * 1024);
        budget_kb.map_or(requested, |budget| requested.min(budget))
    }
}

/// Configurable Linux PSI policy thresholds and timings.
///
/// Percentages are PSI `avg10` percentages. They are normalized while
/// deserializing so malformed configuration cannot accidentally create a
/// permanently disabled or hot-looping policy.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PressureConfig {
    pub cpu_some_percent: f64,
    pub io_full_percent: f64,
    pub memory_full_percent: f64,
    pub sustain_seconds: u64,
    pub cooldown_seconds: u64,
}

impl Default for PressureConfig {
    fn default() -> Self {
        Self {
            cpu_some_percent: 25.0,
            io_full_percent: 20.0,
            memory_full_percent: 2.0,
            sustain_seconds: 120,
            cooldown_seconds: 10,
        }
    }
}

#[derive(Deserialize)]
struct RawPressureConfig {
    cpu_some_percent: Option<f64>,
    io_full_percent: Option<f64>,
    memory_full_percent: Option<f64>,
    sustain_seconds: Option<u64>,
    cooldown_seconds: Option<u64>,
}

impl PressureConfig {
    fn normalized_percent(value: Option<f64>, default: f64) -> f64 {
        value
            .filter(|value| value.is_finite())
            .map(|value| value.clamp(0.0, 100.0))
            .unwrap_or(default)
    }

    fn normalized_interval(value: Option<u64>, default: u64) -> u64 {
        value.filter(|value| *value != 0).unwrap_or(default)
    }
}

impl<'de> Deserialize<'de> for PressureConfig {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = RawPressureConfig::deserialize(deserializer)?;
        let defaults = Self::default();
        Ok(Self {
            cpu_some_percent: Self::normalized_percent(
                raw.cpu_some_percent,
                defaults.cpu_some_percent,
            ),
            io_full_percent: Self::normalized_percent(
                raw.io_full_percent,
                defaults.io_full_percent,
            ),
            memory_full_percent: Self::normalized_percent(
                raw.memory_full_percent,
                defaults.memory_full_percent,
            ),
            sustain_seconds: Self::normalized_interval(
                raw.sustain_seconds,
                defaults.sustain_seconds,
            ),
            cooldown_seconds: Self::normalized_interval(
                raw.cooldown_seconds,
                defaults.cooldown_seconds,
            ),
        })
    }
}

impl Default for Config {
    fn default() -> Self {
        Config {
            claude_path: None,
            grok_path: None,
            codex_path: None,
            snapshot_interval_secs: 10,
            scrollback_bytes: 2 * 1024 * 1024,
            memory: MemoryConfig::default(),
            pressure: PressureConfig::default(),
        }
    }
}

/// Filesystem-backed state store rooted at a directory.
pub struct StateStore {
    root: PathBuf,
    /// Stat-keyed parse caches for the small per-session metadata JSON files.
    /// `session_infos()` reads every one of them on every control gesture, and
    /// the web mosaic re-reads them once a second; a stat (one syscall) then
    /// replaces an open+read+parse per file per call. See [`FileCache`].
    session_cache: FileCache<SessionMeta>,
    claude_cache: FileCache<ClaudeMeta>,
}

/// Stat-keyed parse cache for small metadata files that are read far more
/// often than they are written.
///
/// A hit is one `stat` (mtime + len match) returning the previously parsed
/// value; anything else — created, rewritten, deleted, recreated — falls
/// through to `load`, whose result is cached under the stat observed BEFORE
/// the load. That ordering is deliberately conservative: if the file changes
/// between the stat and the load, the stale stamp guarantees the NEXT call
/// re-reads (one wasted read, never a wrong value served twice).
///
/// Correctness does not depend on writers cooperating: every write path here
/// is an atomic tmp+rename, so a changed file always has a new inode/mtime,
/// and an externally deleted file fails its stat and is evicted.
/// (mtime, len) stamp paired with the parsed value — the cache key + payload.
type CacheEntry<T> = (Option<std::time::SystemTime>, u64, T);

struct FileCache<T> {
    entries: Mutex<HashMap<PathBuf, CacheEntry<T>>>,
}

impl<T: Clone> FileCache<T> {
    fn new() -> Self {
        FileCache { entries: Mutex::new(HashMap::new()) }
    }
    /// Return the parsed contents of `path`, re-running `load` only when the
    /// file's (mtime, len) no longer matches the cached entry. `load` mirrors
    /// [`StateStore::read_json`]: `Ok(None)` for a missing file.
    fn get<F>(&self, path: &Path, load: F) -> anyhow::Result<Option<T>>
    where
        F: FnOnce(&Path) -> anyhow::Result<Option<T>>,
    {
        let stamp = fs::metadata(path).ok().map(|m| (m.modified().ok(), m.len()));
        if let Some((Some(mtime), len)) = &stamp {
            if let Some((cached_mtime, cached_len, value)) =
                self.entries.lock().unwrap().get(path)
            {
                if *cached_mtime == Some(*mtime) && *cached_len == *len {
                    return Ok(Some(value.clone()));
                }
            }
        }
        let loaded = load(path)?;
        let mut entries = self.entries.lock().unwrap();
        match (&stamp, &loaded) {
            (Some((Some(mtime), len)), Some(value)) => {
                entries.insert(path.to_path_buf(), (Some(*mtime), *len, value.clone()));
            }
            _ => {
                // Deleted/unstattable, or nothing to remember: drop any stale
                // entry so it cannot outlive its file.
                entries.remove(path);
            }
        }
        Ok(loaded)
    }
}

impl StateStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        StateStore {
            root: root.into(),
            session_cache: FileCache::new(),
            claude_cache: FileCache::new(),
        }
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

    fn rename_journal_path(&self) -> PathBuf {
        self.root.join("rename.json")
    }

    fn config_path(&self) -> PathBuf {
        self.root.join("config.toml")
    }

    /// Atomically write `bytes` to `path`: create parent dirs, write a
    /// same-directory temp file, then rename over the final path. The temp
    /// name carries the pid (unique across processes) AND a per-call atomic
    /// counter (unique across threads) — a pid-only name let two threads of
    /// the same process share a tmp path and interleave write/rename.
    fn atomic_write(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let parent = path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("path has no parent: {}", path.display()))?;
        fs::create_dir_all(parent)?;
        let file_name = path
            .file_name()
            .ok_or_else(|| anyhow::anyhow!("path has no file name: {}", path.display()))?
            .to_string_lossy();
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let tmp_path = parent.join(format!("{file_name}.{}.{seq}.tmp", std::process::id()));
        let mut tmp = fs::File::create(&tmp_path)?;
        tmp.write_all(bytes)?;
        tmp.sync_all()?;
        drop(tmp);
        fs::rename(&tmp_path, path)?;
        Self::sync_dir(parent)?;
        Ok(())
    }

    fn sync_dir(path: &Path) -> anyhow::Result<()> {
        fs::File::open(path)?.sync_all()?;
        Ok(())
    }

    fn remove_durable(path: &Path) -> anyhow::Result<()> {
        match fs::remove_file(path) {
            Ok(()) => {
                if let Some(parent) = path.parent() {
                    Self::sync_dir(parent)?;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
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
        self.session_cache.get(&self.session_path(name), Self::read_json)
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
            // Tolerate a corrupt/unreadable file exactly like the original
            // inline read did: skip it, never fail the whole listing (a single
            // bad JSON must not abort daemon start).
            if let Ok(Some(meta)) = self.session_cache.get(&path, Self::read_json) {
                sessions.push(meta);
            }
        }
        Ok(sessions)
    }

    /// Resolve a rename interrupted before its two metadata names can be
    /// mistaken for independent sessions. The journal is durable before any
    /// destination artifact is published. Callers must serialize this with
    /// rename; the manager does so with its outer maintenance lock. Returns
    /// `false` when the authoritative metadata is safe to restore but orphan
    /// cleanup remains retryable under the durable journal.
    pub fn recover_pending_rename(&self) -> anyhow::Result<bool> {
        let journal_path = self.rename_journal_path();
        let Some(journal) = Self::read_json::<RenameJournal>(&journal_path)? else {
            return Ok(true);
        };
        if journal.from == journal.to
            || journal.source.name != journal.from
            || [&journal.from, &journal.to].into_iter().any(|name| {
                name.is_empty()
                    || name.len() > 200
                    || name == "."
                    || name == ".."
                    || name.contains('/')
                    || name.contains('\0')
            })
        {
            anyhow::bail!("invalid pending rename journal");
        }

        let from = self.read_session(&journal.from)?;
        let to = self.read_session(&journal.to)?;
        let mut expected_to = journal.source.clone();
        expected_to.name = journal.to.clone();
        if from.as_ref().is_some_and(|meta| meta != &journal.source)
            || to.as_ref().is_some_and(|meta| meta != &expected_to)
        {
            anyhow::bail!("pending rename metadata does not match its journal");
        }

        match (from.is_some(), to.is_some()) {
            // Destination metadata is published only after every matching
            // artifact is durable, so it wins deterministically.
            (_, true) => {
                let from_path = self.session_path(&journal.from);
                if let Err(error) = Self::remove_durable(&from_path) {
                    // remove_file may have succeeded before its directory
                    // fsync failed. In that case one authoritative metadata
                    // record is already visible and the journal makes the
                    // durability warning safely retryable.
                    if self.read_session(&journal.from)?.is_some() {
                        return Err(error);
                    }
                    eprintln!(
                        "amber state: recovered rename but could not sync {}: {error}",
                        from_path.display()
                    );
                }
                if self.cleanup_rename_artifacts(&journal.from).is_err() {
                    return Ok(false);
                }
            }
            // Destination metadata was never published: retain the complete
            // source and discard any unreferenced destination copies.
            (true, false) => {
                if self.cleanup_rename_artifacts(&journal.to).is_err() {
                    return Ok(false);
                }
            }
            (false, false) => anyhow::bail!("pending rename has no session metadata"),
        }
        match Self::remove_durable(&journal_path) {
            Ok(()) => Ok(true),
            Err(error) => {
                eprintln!("amber state: recovered rename but could not remove journal: {error}");
                Ok(false)
            }
        }
    }

    fn cleanup_rename_artifacts(&self, name: &str) -> anyhow::Result<()> {
        let mut first_error = None;
        for path in [
            self.claude_path(name),
            self.claude_settings_path(name),
            self.scrollback_path(name),
        ] {
            if let Err(error) = Self::remove_durable(&path) {
                let error = anyhow::anyhow!("could not remove {}: {error}", path.display());
                eprintln!("amber state: recovered rename but {error}");
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    pub fn remove_session(&self, name: &str) -> anyhow::Result<()> {
        Self::remove_if_exists(&self.claude_path(name))?;
        // The generated per-session claude settings file. Missed originally, so
        // every killed claude pane left one behind forever — `rename_session`
        // moves it, and only removal was blind to it.
        Self::remove_if_exists(&self.claude_settings_path(name))?;
        Self::remove_if_exists(&self.scrollback_path(name))?;
        // Authoritative metadata is the retry record (including the cgroup
        // slot), so remove it only after every optional artifact is gone.
        Self::remove_if_exists(&self.session_path(name))?;
        Ok(())
    }

    /// Path of a session's generated claude settings file (the `SessionStart`
    /// hook). Its CONTENT is name-independent (the hook command is
    /// `<exe> hook`; the name reaches it via `AMBER_SESSION`), so a rename only
    /// has to move the file — nothing inside it needs rewriting.
    fn claude_settings_path(&self, name: &str) -> PathBuf {
        self.claude_dir().join(format!("{name}.settings.json"))
    }

    /// Move every name-keyed artifact of `from` to `to`, rewriting the embedded
    /// `SessionMeta.name`. Used by a cross-tab pane move: the tab is encoded in
    /// the session name, so moving a pane IS a rename.
    ///
    /// Destination artifacts are preflighted and any completed artifact copies
    /// are rolled back on a pre-commit error. A durable intent journal links
    /// the names across a crash; crash-safe ordering then copies the optional
    /// artifacts while retaining their sources, writes `sessions/<to>.json`,
    /// and removes `sessions/<from>.json`. The old artifacts are
    /// garbage-collected only after that metadata commit.
    /// `sessions/*.json` is what `list_sessions` (and therefore restore)
    /// enumerates, so a crash at any point leaves either the old fully
    /// restorable session or the new one — never metadata without its matching
    /// resume record. A crash between publishing `to` and removing `from`
    /// leaves both files, but startup recovery consumes the journal before
    /// listing sessions, so one conversation is never resumed twice.
    pub fn rename_session(&self, from: &str, to: &str) -> anyhow::Result<()> {
        self.rename_session_with_checkpoint(from, to, |_| Ok(()))
    }

    fn rename_session_with_checkpoint(
        &self,
        from: &str,
        to: &str,
        mut checkpoint: impl FnMut(usize) -> anyhow::Result<()>,
    ) -> anyhow::Result<()> {
        let mut meta = self
            .read_session(from)?
            .ok_or_else(|| anyhow::anyhow!("no such session: {from}"))?;
        let copies = [
            (self.claude_path(from), self.claude_path(to)),
            (self.claude_settings_path(from), self.claude_settings_path(to)),
            (self.scrollback_path(from), self.scrollback_path(to)),
        ];
        let journal_path = self.rename_journal_path();
        let to_meta = self.session_path(to);
        if journal_path.exists() {
            anyhow::bail!("another session rename is pending recovery");
        }
        if to_meta.exists() {
            anyhow::bail!("target session artifact already exists: {}", to_meta.display());
        }
        if let Some((_, path)) = copies.iter().find(|(_, path)| path.exists()) {
            anyhow::bail!("target session artifact already exists: {}", path.display());
        }

        let journal = RenameJournal {
            from: from.to_string(),
            to: to.to_string(),
            source: meta.clone(),
        };
        if let Err(error) = Self::write_json(&journal_path, &journal) {
            let created = journal_path
                .exists()
                .then(|| journal_path.clone())
                .into_iter()
                .collect::<Vec<_>>();
            return self.rename_precommit_error(error, &created);
        }
        checkpoint(0)?;

        // PRE-COMMIT: copy every optional artifact while leaving the source
        // completely intact. A process crash here restores `from`; destination
        // copies are unreferenced because no destination metadata exists yet.
        let mut created = vec![journal_path.clone()];
        for (index, (old, new)) in copies.iter().enumerate() {
            let bytes = match fs::read(old) {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return self.rename_precommit_error(error.into(), &created),
            };
            if let Err(error) = Self::atomic_write(new, &bytes) {
                let mut rollback = created.clone();
                // `atomic_write` may have completed its rename and then failed
                // the directory fsync. Include that visible destination in the
                // rollback instead of stranding an orphan that blocks retries.
                if new.exists() {
                    rollback.push(new.clone());
                }
                return self.rename_precommit_error(error, &rollback);
            }
            created.push(new.clone());
            checkpoint(index + 1)?;
        }

        // COMMIT PREPARATION: publish `to` only after all of its artifacts are
        // durable. Until `from` metadata is removed, both listed names are
        // fully restorable and point at matching resume records.
        meta.name = to.to_string();
        if let Err(error) = self.write_session(&meta) {
            let mut rollback = created.clone();
            if to_meta.exists() {
                rollback.push(to_meta.clone());
            }
            return self.rename_precommit_error(error, &rollback);
        }
        checkpoint(4)?;

        // COMMIT POINT: remove and durably record disappearance of the source
        // metadata. If this normal operation fails, destination publication is
        // rolled back while the source is still authoritative.
        let from_meta = self.session_path(from);
        if let Err(error) = Self::remove_if_exists(&from_meta) {
            let mut rollback = created.clone();
            rollback.push(to_meta);
            return self.rename_precommit_error(error, &rollback);
        }
        // Once remove_file succeeds the transaction is committed in the live
        // filesystem. A directory-fsync error makes crash durability uncertain
        // but must NOT trigger pre-commit rollback: deleting destination then
        // could leave no metadata at all. Keep the new authoritative record and
        // surface the durability warning in logs.
        if let Some(parent) = from_meta.parent() {
            if let Err(error) = Self::sync_dir(parent) {
                eprintln!(
                    "amber state: renamed session but could not sync metadata directory: {error}"
                );
            }
        }
        checkpoint(5)?;

        // POST-COMMIT garbage collection. Failure here must not report the
        // rename as failed: the manager would attempt an in-memory rollback
        // even though `to` is now authoritative. The durable journal retains
        // ownership of leftover source artifacts until recovery removes them.
        let mut cleanup_failed = false;
        for (offset, (old, _)) in copies.iter().enumerate() {
            if let Err(error) = Self::remove_durable(old) {
                eprintln!(
                    "amber state: renamed session but could not remove {}: {error}",
                    old.display()
                );
                cleanup_failed = true;
            }
            checkpoint(6 + offset)?;
        }
        if !cleanup_failed {
            if let Err(error) = Self::remove_durable(&journal_path) {
                eprintln!("amber state: renamed session but could not remove journal: {error}");
            }
        }
        checkpoint(9)?;
        Ok(())
    }

    fn rename_precommit_error<T>(
        &self,
        error: anyhow::Error,
        destination_paths: &[PathBuf],
    ) -> anyhow::Result<T> {
        for path in destination_paths.iter().rev() {
            if let Err(rollback) = Self::remove_durable(path) {
                anyhow::bail!("{error}; rename rollback failed: {rollback}");
            }
        }
        Err(error)
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
        self.claude_cache.get(&self.claude_path(name), Self::read_json)
    }

    /// Remove a session's recorded agent id, if any. Missing file is not an
    /// error (mirrors `remove_if_exists` discipline of the other removers).
    pub fn remove_claude(&self, name: &str) -> anyhow::Result<()> {
        Self::remove_if_exists(&self.claude_path(name))
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
    use std::sync::{Arc, Barrier};
    use tempfile::tempdir;

    fn sample_session(name: &str) -> SessionMeta {
        SessionMeta {
            name: name.to_string(),
            cwd: PathBuf::from("/tmp/proj"),
            kind: SessionKind::Shell,
            updated: 1_700_000_000,
            resume_as_claude: false,
            run_state: None,
            slot: 1,
        }
    }

    #[test]
    fn file_cache_loads_once_until_the_file_changes() {
        // The whole point: a stat match must NOT re-run the loader (the
        // open+read+parse this cache exists to skip), and any real change —
        // content rewrite, deletion, recreation — must be seen on the next get.
        let dir = tempdir().unwrap();
        let path = dir.path().join("meta.json");
        fs::write(&path, b"one").unwrap();
        let cache: FileCache<Vec<u8>> = FileCache::new();
        let loads = std::cell::Cell::new(0u32);
        let load = |p: &Path| {
            loads.set(loads.get() + 1);
            Ok(fs::read(p).ok())
        };

        assert_eq!(cache.get(&path, load).unwrap(), Some(b"one".to_vec()));
        assert_eq!(cache.get(&path, load).unwrap(), Some(b"one".to_vec()));
        assert_eq!(loads.get(), 1, "second get re-ran the loader");

        // Rewrite with a DIFFERENT size (deterministic stat change; a same-size
        // same-mtime write is not distinguishable by stat alone and does not
        // need to be — every writer here goes through atomic rename).
        fs::write(&path, b"three-bytes-longer").unwrap();
        assert_eq!(
            cache.get(&path, load).unwrap(),
            Some(b"three-bytes-longer".to_vec())
        );
        assert_eq!(loads.get(), 2);

        fs::remove_file(&path).unwrap();
        assert_eq!(cache.get(&path, load).unwrap(), None);
        assert_eq!(loads.get(), 3);

        fs::write(&path, b"reborn").unwrap();
        assert_eq!(cache.get(&path, load).unwrap(), Some(b"reborn".to_vec()));
        assert_eq!(loads.get(), 4);
    }

    #[test]
    fn file_cache_is_shareable_across_threads() {
        // session_infos runs on connection threads while the snapshot timer
        // runs in its own thread — the cache must tolerate that sharing.
        let dir = tempdir().unwrap();
        let path = dir.path().join("x.json");
        fs::write(&path, b"data").unwrap();
        let cache: FileCache<String> = FileCache::new();
        let cache = std::sync::Arc::new(cache);
        let mut handles = Vec::new();
        for _ in 0..8 {
            let cache = Arc::clone(&cache);
            let path = path.clone();
            handles.push(std::thread::spawn(move || {
                cache
                    .get(&path, |p| Ok(fs::read_to_string(p).ok()))
                    .unwrap()
                    .unwrap()
            }));
        }
        for h in handles {
            assert_eq!(h.join().unwrap(), "data");
        }
    }

    #[test]
    fn list_sessions_reflects_rewrites_and_removals_without_stale_entries() {
        // The cache must never resurrect a removed session or serve a stale
        // rewrite — session_infos() feeds the app's grouping on every control
        // gesture and the web mosaic's 1 s poll.
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());
        let mut a = sample_session("amber-1-1-0-a");
        a.slot = 1;
        store.write_session(&a).unwrap();
        let mut b = sample_session("amber-1-1-1-b");
        b.slot = 2;
        store.write_session(&b).unwrap();

        let names = || -> Vec<String> {
            let mut v: Vec<String> =
                store.list_sessions().unwrap().into_iter().map(|m| m.name).collect();
            v.sort();
            v
        };
        assert_eq!(names(), vec!["amber-1-1-0-a", "amber-1-1-1-b"]);

        a.updated += 5;
        store.write_session(&a).unwrap();
        let listed = store
            .list_sessions()
            .unwrap()
            .into_iter()
            .find(|m| m.name == a.name)
            .unwrap();
        assert_eq!(listed.updated, a.updated, "stale rewrite served");

        store.remove_session("amber-1-1-1-b").unwrap();
        assert_eq!(names(), vec!["amber-1-1-0-a"], "removed session resurrected");

        store.write_session(&b).unwrap();
        assert_eq!(names(), vec!["amber-1-1-0-a", "amber-1-1-1-b"]);
    }

    #[test]
    fn read_claude_sees_hook_rewrites_and_deletions() {
        // The SessionStart hook rewrites claude/<name>.json while the daemon
        // runs; a cached read that missed the rewrite would offer a stale
        // `--resume` id (and memory_candidates would misjudge parkability).
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());
        let mk = |id: &str| ClaudeMeta {
            session_id: id.to_string(),
            cwd: PathBuf::from("/tmp"),
            updated: 1,
        };
        store.write_claude("s", &mk("id-one")).unwrap();
        assert_eq!(store.read_claude("s").unwrap().unwrap().session_id, "id-one");
        assert_eq!(store.read_claude("s").unwrap().unwrap().session_id, "id-one");

        store.write_claude("s", &mk("id-two")).unwrap();
        assert_eq!(store.read_claude("s").unwrap().unwrap().session_id, "id-two");

        store.remove_claude("s").unwrap();
        assert_eq!(store.read_claude("s").unwrap(), None);
    }

    #[test]
    fn budget_kb_explicit_setting_overrides_the_physical_half() {
        // Auto (None): half of physical. Explicit: the setting itself — both
        // still capped by the OS cgroup limit, floored at 512 MiB. This pins
        // the semantics `amber ctl budget` relies on before any wiring exists.
        let cfg = MemoryConfig::default(); // budget_mb: None
        assert_eq!(cfg.budget_kb(Some(8_388_608), None), Some(4_194_304));

        let explicit = MemoryConfig { budget_mb: Some(20_480), ..MemoryConfig::default() };
        assert_eq!(explicit.budget_kb(Some(8_388_608), None), Some(20_971_520));
        // Capped by the service MemoryHigh when the explicit ask exceeds it.
        assert_eq!(
            explicit.budget_kb(Some(8_388_608), Some(8_388_608)),
            Some(8_388_608)
        );
        // Floor holds even for a tiny explicit value.
        let tiny = MemoryConfig { budget_mb: Some(1), ..MemoryConfig::default() };
        assert_eq!(tiny.budget_kb(None, None), Some(512 * 1024));
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
    fn session_meta_tolerates_snapshots_without_run_state() {
        // An older snapshot's JSON has no `run_state` key; `#[serde(default)]`
        // must decode it as None rather than failing the whole restore.
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());
        let sessions_dir = dir.path().join("sessions");
        fs::create_dir_all(&sessions_dir).unwrap();
        fs::write(
            sessions_dir.join("legacy.json"),
            br#"{"name":"legacy","cwd":"/tmp","kind":"claude","updated":1}"#,
        )
        .unwrap();

        let meta = store.read_session("legacy").unwrap().unwrap();
        assert_eq!(meta.run_state, None);
        assert!(!meta.resume_as_claude);
        assert_eq!(meta.kind, SessionKind::Claude);
    }

    #[test]
    fn session_meta_run_state_round_trips() {
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());
        let mut meta = sample_session("phased");
        meta.kind = SessionKind::Claude;
        meta.run_state = Some("shell-fallback".to_string());
        store.write_session(&meta).unwrap();
        assert_eq!(store.read_session("phased").unwrap(), Some(meta));
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
    fn concurrent_atomic_writes_to_same_path_never_error_or_interleave() {
        // Two threads in the same process hammering atomic_write on the same
        // target must not share a tmp path: sharing one lets writes
        // interleave (torn content) or lets one thread rename the tmp away
        // under the other (NotFound). The final file must be exactly one
        // thread's complete payload and no call may error.
        let dir = tempdir().unwrap();
        let target = dir.path().join("state/contended.bin");
        const ROUNDS: usize = 500;
        const LEN: usize = 64 * 1024;

        let mut handles = Vec::new();
        for byte in [b'a', b'b'] {
            let target = target.clone();
            handles.push(std::thread::spawn(move || {
                let payload = vec![byte; LEN];
                for _ in 0..ROUNDS {
                    StateStore::atomic_write(&target, &payload)?;
                }
                anyhow::Ok(())
            }));
        }
        for h in handles {
            h.join().unwrap().expect("atomic_write errored under contention");
        }

        let final_bytes = fs::read(&target).unwrap();
        assert_eq!(final_bytes.len(), LEN, "torn/truncated final file");
        assert!(
            final_bytes.iter().all(|&b| b == b'a') || final_bytes.iter().all(|&b| b == b'b'),
            "final file interleaves both threads' payloads"
        );
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
    fn config_written_before_grok_support_still_loads() {
        // `grok_path` was added after this file format shipped; an existing
        // config.toml has no such key and must still deserialize.
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());
        fs::write(
            dir.path().join("config.toml"),
            b"claude_path = \"/usr/bin/claude\"\nsnapshot_interval_secs = 10\nscrollback_bytes = 2048\n",
        )
        .unwrap();

        let cfg = store.load_config().unwrap();

        assert_eq!(cfg.claude_path, Some(PathBuf::from("/usr/bin/claude")));
        assert_eq!(cfg.grok_path, None);
    }

    #[test]
    fn agent_kinds_are_the_supervised_ones() {
        assert!(SessionKind::Claude.is_agent());
        assert!(SessionKind::Grok.is_agent());
        assert!(SessionKind::Codex.is_agent());
        assert!(!SessionKind::Shell.is_agent());
    }

    #[test]
    fn grok_kind_serializes_lowercase() {
        // The wire/JSON spelling is what `parse_kind` and the app both use.
        let json = serde_json::to_string(&SessionKind::Grok).unwrap();
        assert_eq!(json, "\"grok\"");
    }

    #[test]
    fn codex_kind_serializes_lowercase() {
        let json = serde_json::to_string(&SessionKind::Codex).unwrap();
        assert_eq!(json, "\"codex\"");
    }

    #[test]
    fn config_written_before_codex_support_still_loads() {
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());
        fs::write(
            dir.path().join("config.toml"),
            b"claude_path = \"/usr/bin/claude\"\ngrok_path = \"/usr/bin/grok\"\nsnapshot_interval_secs = 10\nscrollback_bytes = 2048\n",
        )
        .unwrap();

        let cfg = store.load_config().unwrap();

        assert_eq!(cfg.claude_path, Some(PathBuf::from("/usr/bin/claude")));
        assert_eq!(cfg.grok_path, Some(PathBuf::from("/usr/bin/grok")));
        assert_eq!(cfg.codex_path, None);
    }

    #[test]
    fn config_written_before_memory_guardian_still_loads() {
        let dir = tempfile::tempdir().unwrap();
        let store = StateStore::new(dir.path());
        std::fs::create_dir_all(dir.path()).unwrap();
        std::fs::write(
            dir.path().join("config.toml"),
            "claude_path = \"/usr/bin/claude\"\nsnapshot_interval_secs = 10\nscrollback_bytes = 2097152\n",
        )
        .unwrap();

        let cfg = store.load_config().unwrap();
        assert_eq!(cfg.memory, MemoryConfig::default());
    }

    #[test]
    fn config_written_before_pressure_guardian_uses_pressure_defaults() {
        // A config from before host-pressure support has no `[pressure]`
        // section, but must still enable the policy with its safe defaults.
        let cfg: Config = toml::from_str(
            "snapshot_interval_secs = 10\nscrollback_bytes = 2048\n",
        )
        .unwrap();

        assert_eq!(cfg.pressure.cpu_some_percent, 25.0);
        assert_eq!(cfg.pressure.io_full_percent, 20.0);
        assert_eq!(cfg.pressure.memory_full_percent, 2.0);
        assert_eq!(cfg.pressure.sustain_seconds, 120);
        assert_eq!(cfg.pressure.cooldown_seconds, 10);
    }

    #[test]
    fn pressure_config_round_trips_explicit_values() {
        // Persisting an operator's non-default policy must retain each value;
        // otherwise a restart can silently change when automatic parking acts.
        let dir = tempfile::tempdir().unwrap();
        let store = StateStore::new(dir.path());
        let mut cfg = Config::default();
        cfg.pressure = PressureConfig {
            cpu_some_percent: 30.5,
            io_full_percent: 12.25,
            memory_full_percent: 4.0,
            sustain_seconds: 240,
            cooldown_seconds: 30,
        };

        store.save_config(&cfg).unwrap();
        assert_eq!(store.load_config().unwrap(), cfg);
    }

    #[test]
    fn pressure_config_normalizes_invalid_thresholds_and_intervals() {
        // Invalid operator input must not create an impossible policy or a
        // zero-duration loop: finite percentages clamp, NaN falls back, and
        // zero intervals fall back to their defaults.
        let cfg: Config = toml::from_str(
            "snapshot_interval_secs = 10\nscrollback_bytes = 2048\n\
             [pressure]\n\
             cpu_some_percent = 150\n\
             io_full_percent = -1\n\
             memory_full_percent = nan\n\
             sustain_seconds = 0\n\
             cooldown_seconds = 0\n",
        )
        .unwrap();

        assert_eq!(cfg.pressure.cpu_some_percent, 100.0);
        assert_eq!(cfg.pressure.io_full_percent, 0.0);
        assert_eq!(cfg.pressure.memory_full_percent, 2.0);
        assert_eq!(cfg.pressure.sustain_seconds, 120);
        assert_eq!(cfg.pressure.cooldown_seconds, 10);
    }

    #[test]
    fn memory_config_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let store = StateStore::new(dir.path());
        let mut cfg = Config::default();
        cfg.memory.enabled = false;
        cfg.memory.budget_mb = Some(6144);
        cfg.memory.session_high_mb = 2048;

        store.save_config(&cfg).unwrap();
        assert_eq!(store.load_config().unwrap(), cfg);
    }

    #[test]
    fn partial_memory_section_uses_defaults() {
        let cfg: Config = toml::from_str(
            "snapshot_interval_secs = 10\nscrollback_bytes = 2048\n[memory]\nenabled = false\n",
        )
        .unwrap();
        assert!(!cfg.memory.enabled);
        assert_eq!(cfg.memory.budget_mb, None);
        assert_eq!(cfg.memory.session_high_mb, 4096);
    }

    #[test]
    fn memory_budget_uses_available_sources_and_clamps_session_high() {
        let cfg = MemoryConfig::default();
        assert_eq!(
            cfg.budget_kb(Some(32 * 1024 * 1024), None),
            Some(16 * 1024 * 1024)
        );
        assert_eq!(
            cfg.budget_kb(None, Some(8 * 1024 * 1024)),
            Some(8 * 1024 * 1024)
        );
        assert_eq!(cfg.budget_kb(None, None), None);
        assert_eq!(cfg.session_high_kb(Some(512 * 1024)), 512 * 1024);
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
            grok_path: Some(PathBuf::from("/usr/local/bin/grok")),
            codex_path: Some(PathBuf::from("/usr/local/bin/codex")),
            snapshot_interval_secs: 42,
            scrollback_bytes: 4096,
            memory: MemoryConfig::default(),
            pressure: PressureConfig::default(),
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
        let settings = store.claude_settings_path("alpha");
        std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
        std::fs::write(&settings, b"{}").unwrap();

        store.remove_session("alpha").unwrap();

        assert_eq!(store.read_session("alpha").unwrap(), None);
        assert_eq!(store.read_claude("alpha").unwrap(), None);
        assert_eq!(store.read_scrollback("alpha").unwrap(), None);
        // The settings file too — otherwise every killed claude pane leaks one.
        assert!(!settings.exists());
    }

    #[test]
    fn remove_session_keeps_authoritative_metadata_until_artifacts_are_deleted() {
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());
        store.write_session(&sample_session("retryable")).unwrap();
        store
            .write_claude(
                "retryable",
                &ClaudeMeta {
                    session_id: "sess-retry".to_string(),
                    cwd: PathBuf::from("/tmp"),
                    updated: 1,
                },
            )
            .unwrap();
        let blocked = store.scrollback_path("retryable");
        std::fs::create_dir_all(&blocked).unwrap();

        assert!(store.remove_session("retryable").is_err());
        assert_eq!(
            store.read_session("retryable").unwrap().unwrap().slot,
            1,
            "failed cleanup must retain the authoritative retry record"
        );

        std::fs::remove_dir(&blocked).unwrap();
        store.remove_session("retryable").unwrap();
        assert_eq!(store.read_session("retryable").unwrap(), None);
    }

    #[test]
    fn rename_session_moves_every_artifact_and_rewrites_the_embedded_name() {
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());
        store.write_session(&sample_session("amber-1-1-0-a")).unwrap();
        store
            .write_claude(
                "amber-1-1-0-a",
                &ClaudeMeta {
                    session_id: "sess-1".to_string(),
                    cwd: PathBuf::from("/tmp"),
                    updated: 1,
                },
            )
            .unwrap();
        store.write_scrollback("amber-1-1-0-a", b"history").unwrap();
        let settings = dir.path().join("claude/amber-1-1-0-a.settings.json");
        fs::write(&settings, b"{}").unwrap();

        store.rename_session("amber-1-1-0-a", "amber-1-2-0-a").unwrap();

        let moved = store.read_session("amber-1-2-0-a").unwrap().unwrap();
        assert_eq!(moved.name, "amber-1-2-0-a", "embedded name must be rewritten");
        assert_eq!(moved.cwd, PathBuf::from("/tmp/proj"), "other fields preserved");
        assert_eq!(store.read_session("amber-1-1-0-a").unwrap(), None);
        assert_eq!(
            store.read_claude("amber-1-2-0-a").unwrap().unwrap().session_id,
            "sess-1"
        );
        assert_eq!(store.read_claude("amber-1-1-0-a").unwrap(), None);
        assert_eq!(
            store.read_scrollback("amber-1-2-0-a").unwrap(),
            Some(b"history".to_vec())
        );
        assert_eq!(store.read_scrollback("amber-1-1-0-a").unwrap(), None);
        assert!(dir.path().join("claude/amber-1-2-0-a.settings.json").exists());
        assert!(!settings.exists());
    }

    #[test]
    fn ordinary_list_does_not_consume_an_in_flight_rename_journal() {
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());
        store.write_session(&sample_session("from")).unwrap();
        let ready = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));

        std::thread::scope(|scope| {
            let root = dir.path().to_path_buf();
            let worker_ready = Arc::clone(&ready);
            let worker_release = Arc::clone(&release);
            let worker = scope.spawn(move || {
                StateStore::new(root).rename_session_with_checkpoint("from", "to", |step| {
                    if step == 0 {
                        worker_ready.wait();
                        worker_release.wait();
                    }
                    Ok(())
                })
            });

            ready.wait();
            let names = store
                .list_sessions()
                .unwrap()
                .into_iter()
                .map(|meta| meta.name)
                .collect::<Vec<_>>();
            let journal_survived = store.rename_journal_path().exists();
            release.wait();
            worker.join().unwrap().unwrap();

            assert_eq!(names, vec!["from"]);
            assert!(journal_survived, "ordinary read consumed the live rename journal");
        });
    }

    #[test]
    fn committed_rename_survives_a_journal_unlink_failure() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());
        let from = "amber-1-1-0-unlink";
        let to = "amber-1-2-0-unlink";
        store.write_session(&sample_session(from)).unwrap();
        let original_mode = fs::metadata(dir.path()).unwrap().permissions().mode();

        store
            .rename_session_with_checkpoint(from, to, |step| {
                if step == 8 {
                    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o555))?;
                } else if step == 9 {
                    fs::set_permissions(dir.path(), fs::Permissions::from_mode(original_mode))?;
                }
                Ok(())
            })
            .unwrap();

        assert!(store.rename_journal_path().exists());
        assert_eq!(
            store.list_sessions().unwrap().into_iter().map(|m| m.name).collect::<Vec<_>>(),
            vec![to]
        );
        assert!(store.recover_pending_rename().unwrap());
        store.rename_session(to, from).unwrap();
        assert!(store.read_session(from).unwrap().is_some());
    }

    #[test]
    fn failed_losing_artifact_cleanup_keeps_journal_until_safe_retry() {
        const FROM: &str = "amber-1-1-0-cleanup";
        const TO: &str = "amber-1-2-0-cleanup";

        for artifact in 0..3 {
            let dir = tempdir().unwrap();
            let store = StateStore::new(dir.path());
            let mut meta = sample_session(FROM);
            meta.kind = SessionKind::Claude;
            store.write_session(&meta).unwrap();
            store
                .write_claude(
                    FROM,
                    &ClaudeMeta {
                        session_id: "conversation-survives".into(),
                        cwd: PathBuf::from("/tmp/proj"),
                        updated: 1,
                    },
                )
                .unwrap();
            fs::create_dir_all(store.claude_dir()).unwrap();
            fs::write(store.claude_settings_path(FROM), b"{}").unwrap();
            store.write_scrollback(FROM, b"history").unwrap();
            let losing = [
                store.claude_path(FROM),
                store.claude_settings_path(FROM),
                store.scrollback_path(FROM),
            ][artifact]
                .clone();

            store
                .rename_session_with_checkpoint(FROM, TO, |step| {
                    if step == 5 {
                        fs::remove_file(&losing)?;
                        fs::create_dir(&losing)?;
                    }
                    Ok(())
                })
                .unwrap();

            assert!(store.rename_journal_path().exists(), "artifact {artifact} lost ownership");
            assert_eq!(
                store.list_sessions().unwrap().into_iter().map(|m| m.name).collect::<Vec<_>>(),
                vec![TO]
            );
            assert!(!store.recover_pending_rename().unwrap());
            assert!(store.rename_journal_path().exists());

            fs::remove_dir(&losing).unwrap();
            assert!(store.recover_pending_rename().unwrap());
            assert!(!store.rename_journal_path().exists());
            store.rename_session(TO, FROM).unwrap();
            assert_eq!(
                store.read_claude(FROM).unwrap().map(|meta| meta.session_id),
                Some("conversation-survives".into())
            );
            assert_eq!(store.read_scrollback(FROM).unwrap(), Some(b"history".to_vec()));
            assert!(store.claude_settings_path(FROM).exists());
        }
    }

    #[test]
    fn every_rename_crash_point_restores_exactly_one_name_with_its_resume_record() {
        const FROM: &str = "amber-1-1-0-crash";
        const TO: &str = "amber-1-2-0-crash";

        // Rename intent, three destination artifact copies, destination
        // metadata commit, source metadata removal, three source-artifact
        // cleanups, then intent cleanup.
        // Interrupt immediately after each mutation, as a process crash would:
        // no in-process rollback gets a chance to run.
        for stop_after in 0..10 {
            let dir = tempdir().unwrap();
            let store = StateStore::new(dir.path());
            let mut meta = sample_session(FROM);
            meta.kind = SessionKind::Claude;
            store.write_session(&meta).unwrap();
            store
                .write_claude(
                    FROM,
                    &ClaudeMeta {
                        session_id: "conversation-survives".to_string(),
                        cwd: PathBuf::from("/tmp/proj"),
                        updated: 1,
                    },
                )
                .unwrap();
            fs::create_dir_all(store.claude_dir()).unwrap();
            fs::write(store.claude_settings_path(FROM), b"{}").unwrap();
            store.write_scrollback(FROM, b"history").unwrap();

            let mut step = 0;
            let result = store.rename_session_with_checkpoint(FROM, TO, |_| {
                let should_stop = step == stop_after;
                step += 1;
                if should_stop {
                    anyhow::bail!("injected crash")
                }
                Ok(())
            });
            assert!(result.is_err(), "checkpoint {stop_after} did not interrupt");

            store.recover_pending_rename().unwrap();
            let restored = store.list_sessions().unwrap();
            assert_eq!(
                restored.len(),
                1,
                "checkpoint {stop_after} must restore exactly one session"
            );
            let session = &restored[0];
            assert!(session.name == FROM || session.name == TO);
            assert_eq!(
                store.read_claude(&session.name).unwrap().map(|m| m.session_id),
                Some("conversation-survives".to_string()),
                "checkpoint {stop_after}: {} metadata has no matching resume record",
                session.name
            );
        }
    }

    #[test]
    fn rename_session_never_clobbers_orphaned_destination_metadata() {
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());
        store.write_session(&sample_session("from")).unwrap();
        let mut occupied = sample_session("to");
        occupied.updated = 99;
        store.write_session(&occupied).unwrap();

        assert!(store.rename_session("from", "to").is_err());
        assert_eq!(store.read_session("from").unwrap().unwrap().name, "from");
        assert_eq!(store.read_session("to").unwrap().unwrap().updated, 99);
    }

    #[test]
    fn rename_session_tolerates_missing_optional_artifacts() {
        // A plain shell has no claude meta, no settings, and (before its first
        // snapshot) no scrollback — renaming it must still succeed.
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());
        store.write_session(&sample_session("bare")).unwrap();

        store.rename_session("bare", "bare-moved").unwrap();

        assert_eq!(store.read_session("bare").unwrap(), None);
        assert_eq!(store.read_session("bare-moved").unwrap().unwrap().name, "bare-moved");
    }

    #[test]
    fn rename_session_errors_when_the_source_is_missing() {
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());
        assert!(store.rename_session("ghost", "somewhere").is_err());
    }

    #[test]
    fn remove_session_missing_is_not_an_error() {
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());

        let result = store.remove_session("never-existed");

        assert!(result.is_ok());
    }
}
