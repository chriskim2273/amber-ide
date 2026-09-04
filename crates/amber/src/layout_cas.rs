//! Compare-and-swap file IO for the app's `ui-layout.json` sidecar (spec
//! 2026-08-01 §6). Pure Rust — no `Hub`/HTTP — unit-testable directly against
//! a temp dir; `web.rs` wires this into `/api/layout`.
//!
//! Mirrors `app/src/main/layoutIO.ts` exactly (same file, two writers): the
//! "version" is the file's exact previous content, not a derived digest.
//! mtimeMs+length (the design's first idea) collides trivially — two writes
//! landing in the same wall-clock millisecond, or two edits of identical
//! byte length (e.g. a split ratio's last digit changing) — and a false
//! version match there is exactly the silent-clobber bug this exists to
//! prevent. The sidecar is a few KB (~3.2 KB measured on a real install), so
//! comparing full content costs nothing a hash would meaningfully save and
//! cannot false-positive. Rust and TypeScript writers share the same bounded,
//! stale-recoverable lock file, making compare + replace one cross-process
//! critical section while content remains the authoritative version token.
//!
//! Core rule #3 (CLAUDE.md): split geometry stays app-owned, not daemon
//! state. This keeps the sidecar a plain file with two writers, made safe by
//! CAS instead of moving ownership into the daemon (spec §6 explicitly
//! rejects that escalation without the user's sign-off).

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::process::Command;

use crate::{layout_file, mosaic::LAYOUT_FILE};

/// Read result: both fields `None` when the sidecar doesn't exist yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Loaded {
    pub text: Option<String>,
    pub version: Option<String>,
}

/// Read the sidecar. Never fails — a missing/unreadable file is `None`/`None`,
/// matching the "no sidecar yet" first-run case.
pub fn load(root: &Path) -> Loaded {
    match layout_file::read_bounded_regular_file(&root.join(LAYOUT_FILE)) {
        Ok(Some(text)) => Loaded {
            version: Some(text.clone()),
            text: Some(text),
        },
        Ok(None) | Err(_) => Loaded {
            text: None,
            version: None,
        },
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SaveResult {
    Ok {
        version: String,
    },
    /// The on-disk version has moved since the caller last read it. Carries
    /// the fresh content so the caller can merge without a second read.
    Conflict {
        text: Option<String>,
        version: Option<String>,
    },
    Error(String),
}

const LOCK_WAIT: Duration = Duration::from_secs(2);
const LOCK_RECORD_MAX_BYTES: u64 = 4096;
const LOCK_PROTOCOL: &str = "amber-layout-lock-v1";

#[derive(Debug, Clone, PartialEq, Eq)]
struct LayoutLockRecord {
    pid: u32,
    start: String,
    token: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OwnerState {
    Live,
    Dead,
    Unknown,
}

struct LockSnapshot {
    record: Option<LayoutLockRecord>,
    text: String,
    metadata: fs::Metadata,
}

struct LayoutLock {
    path: PathBuf,
    record: LayoutLockRecord,
    text: String,
    metadata: fs::Metadata,
    file: Option<fs::File>,
}

impl Drop for LayoutLock {
    fn drop(&mut self) {
        // Close before unlinking for Windows, where an open handle can deny a
        // pathname removal. The token and unchanged-record checks prevent an
        // owner from deleting a successor that reclaimed/replaced this lock.
        let _ = self.file.take();
        if let Ok(Some(current)) = read_lock(&self.path) {
            if current.record.as_ref() == Some(&self.record)
                && current.text == self.text
                && same_lock_metadata(&current.metadata, &self.metadata)
            {
                let _ = fs::remove_file(&self.path);
            }
        }
    }
}

fn format_lock_record(record: &LayoutLockRecord) -> String {
    format!(
        "{LOCK_PROTOCOL}\npid={}\nstart={}\ntoken={}\n",
        record.pid, record.start, record.token
    )
}

fn valid_lock_field(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte))
}

fn parse_lock_record(text: &str) -> Option<LayoutLockRecord> {
    if !text.ends_with('\n') {
        return None;
    }
    let body = text.strip_suffix('\n')?;
    let mut lines = body.split('\n');
    if lines.next()? != LOCK_PROTOCOL {
        return None;
    }
    let mut pid = None;
    let mut start = None;
    let mut token = None;
    for line in lines {
        if line.is_empty() {
            return None;
        }
        let (key, value) = line.split_once('=')?;
        if value.is_empty() || line.matches('=').count() != 1 {
            return None;
        }
        match key {
            "pid" if pid.is_none() => pid = value.parse::<u32>().ok().filter(|value| *value > 0),
            "start" if start.is_none() && valid_lock_field(value) => start = Some(value.to_string()),
            "token" if token.is_none() && valid_lock_field(value) => token = Some(value.to_string()),
            _ => return None,
        }
    }
    Some(LayoutLockRecord {
        pid: pid?,
        start: start?,
        token: token?,
    })
}

#[cfg(target_os = "linux")]
fn linux_process_start(text: &str) -> Option<String> {
    let end = text.rfind(") ")?;
    let fields: Vec<&str> = text[end + 2..].split_whitespace().collect();
    let start = fields.get(19)?;
    if start.bytes().all(|byte| byte.is_ascii_digit()) {
        Some(format!("linux:{start}"))
    } else {
        None
    }
}

#[cfg(target_os = "linux")]
fn process_start_identity(pid: u32) -> Result<Option<String>, ()> {
    match fs::read(format!("/proc/{pid}/stat")) {
        Ok(bytes) => Ok(linux_process_start(&String::from_utf8(bytes).map_err(|_| ())?)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(()),
    }
}

#[cfg(target_os = "macos")]
fn process_start_identity(pid: u32) -> Result<Option<String>, ()> {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "lstart="])
        .output()
        .map_err(|_| ())?;
    if !output.status.success() {
        return Ok(None);
    }
    let text = String::from_utf8(output.stdout).map_err(|_| ())?;
    let value = text.split_whitespace().collect::<Vec<_>>().join("_");
    Ok((!value.is_empty()).then(|| format!("darwin:{value}")))
}

#[cfg(target_os = "windows")]
fn process_start_identity(pid: u32) -> Result<Option<String>, ()> {
    let script = format!(
        "$p = Get-Process -Id {pid} -ErrorAction SilentlyContinue; "
            + "if ($null -eq $p) {{ Write-Output AMBER_PROCESS_NOT_FOUND }} "
            + "else {{ try {{ Write-Output $p.StartTime.ToFileTimeUtc() }} catch {{ exit 2 }} }}"
    );
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|_| ())?;
    if !output.status.success() {
        // Access denial, a PowerShell failure, and a process exiting during
        // StartTime lookup are not proof that the owner is dead.
        return Err(());
    }
    let text = String::from_utf8(output.stdout).map_err(|_| ())?;
    let value = text.trim();
    if value == "AMBER_PROCESS_NOT_FOUND" {
        return Ok(None);
    }
    Ok((!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| format!("windows:{value}")))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn process_start_identity(_pid: u32) -> Result<Option<String>, ()> {
    Err(())
}

fn current_process_start() -> String {
    process_start_identity(std::process::id())
        .ok()
        .flatten()
        .unwrap_or_else(|| format!("unknown:{}", std::process::id()))
}

fn owner_state(record: &LayoutLockRecord) -> OwnerState {
    let identity = match process_start_identity(record.pid) {
        Ok(identity) => identity,
        Err(()) => return OwnerState::Unknown,
    };
    if record.start == "unknown" || record.start.starts_with("unknown:") {
        return OwnerState::Unknown;
    }
    match identity {
        None => OwnerState::Dead,
        Some(identity) if identity == record.start => OwnerState::Live,
        Some(_) => OwnerState::Dead,
    }
}

fn same_lock_metadata(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    if left.len() != right.len() || left.modified().ok() != right.modified().ok() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        left.dev() == right.dev()
            && left.ino() == right.ino()
            && left.ctime() == right.ctime()
            && left.ctime_nsec() == right.ctime_nsec()
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        left.creation_time() == right.creation_time()
            && left.last_write_time() == right.last_write_time()
            && left.file_size() == right.file_size()
    }
    #[cfg(not(any(unix, windows)))]
    {
        true
    }
}

fn read_lock(path: &Path) -> std::io::Result<Option<LockSnapshot>> {
    let initial = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if initial.file_type().is_symlink() || !initial.is_file() {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid layout lock"));
    }
    if initial.len() > LOCK_RECORD_MAX_BYTES {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "layout lock too large"));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000);
    }
    let mut file = options.open(path)?;
    let opened = file.metadata()?;
    if !opened.is_file() || !same_lock_metadata(&opened, &initial) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "layout lock changed"));
    }
    // Read at most MAX+1 bytes. A same-user writer can append while this
    // inspection runs; read_to_end would turn that race into an unbounded
    // allocation before the size check gets a chance to reject it.
    let mut bytes = vec![0u8; LOCK_RECORD_MAX_BYTES as usize + 1];
    let mut length = 0;
    while length < bytes.len() {
        let count = file.read(&mut bytes[length..])?;
        if count == 0 {
            break;
        }
        length += count;
    }
    if length as u64 > LOCK_RECORD_MAX_BYTES {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "layout lock too large"));
    }
    bytes.truncate(length);
    let after = file.metadata()?;
    let path_after = fs::symlink_metadata(path)?;
    if path_after.file_type().is_symlink()
        || !same_lock_metadata(&opened, &after)
        || !same_lock_metadata(&after, &path_after)
        || bytes.len() as u64 != opened.len()
    {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "layout lock changed"));
    }
    let text = String::from_utf8(bytes)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "layout lock is not UTF-8"))?;
    let record = parse_lock_record(&text);
    Ok(Some(LockSnapshot { record, text, metadata: path_after }))
}

fn remove_lock_if_unchanged(path: &Path, expected: &LockSnapshot) -> bool {
    let Ok(Some(current)) = read_lock(path) else {
        return false;
    };
    if current.record != expected.record
        || current.text != expected.text
        || !same_lock_metadata(&current.metadata, &expected.metadata)
    {
        return false;
    }
    match fs::remove_file(path) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => false,
    }
}

fn acquire_lock(root: &Path) -> std::io::Result<LayoutLock> {
    acquire_lock_with_wait(root, LOCK_WAIT)
}

fn acquire_lock_with_wait(root: &Path, lock_wait: Duration) -> std::io::Result<LayoutLock> {
    let path = root.join(format!("{LAYOUT_FILE}.lock"));
    let started = Instant::now();
    let record = LayoutLockRecord {
        pid: std::process::id(),
        start: current_process_start(),
        token: format!("{:032x}", random_token()),
    };
    let text = format_lock_record(&record);
    loop {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(mut file) => {
                let result = (|| -> std::io::Result<fs::Metadata> {
                    file.write_all(text.as_bytes())?;
                    file.sync_all()?;
                    file.metadata()
                })();
                let metadata = match result {
                    Ok(metadata) => metadata,
                    Err(error) => {
                        drop(file);
                        let _ = fs::remove_file(&path);
                        return Err(error);
                    }
                };
                return Ok(LayoutLock {
                    path,
                    record,
                    text,
                    metadata,
                    file: Some(file),
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if let Ok(Some(current)) = read_lock(&path) {
                    if let Some(record) = current.record.as_ref() {
                        if owner_state(record) == OwnerState::Dead {
                            remove_lock_if_unchanged(&path, &current);
                            continue;
                        }
                    }
                }
                if started.elapsed() >= lock_wait {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "layout write lock timeout",
                    ));
                }
                std::thread::sleep(Duration::from_millis(1).min(lock_wait.saturating_sub(started.elapsed())));
            }
            Err(error) => return Err(error),
        }
    }
}

// A dependency-free token source is sufficient here: uniqueness is provided
// by exclusive creation and the record's start identity; the token's job is
// to make release ownership explicit. Two clocks/counters are mixed so a
// same-process rapid retry does not reuse a record string.
fn random_token() -> u128 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos() as u64);
    ((std::process::id() as u128) << 64) | ((count ^ nanos) as u128)
}

/// Cross-process CAS write. Node and Rust writers share the same short-lived
/// lock file, so the content check and atomic replace are one critical section.
pub fn save(root: &Path, text: &str, expected_version: Option<&str>) -> SaveResult {
    if text.len() as u64 > layout_file::LAYOUT_FILE_MAX_BYTES {
        return SaveResult::Error("LAYOUT_FILE_LIMIT".into());
    }
    if let Err(e) = fs::create_dir_all(root) {
        return SaveResult::Error(e.to_string());
    }
    let _lock = match acquire_lock(root) {
        Ok(lock) => lock,
        Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {
            return SaveResult::Error("LAYOUT_LOCK_TIMEOUT".into())
        }
        Err(error) => return SaveResult::Error(error.to_string()),
    };
    let path = root.join(LAYOUT_FILE);
    let current = match layout_file::read_bounded_regular_file(&path) {
        Ok(value) => value,
        Err(error) => return SaveResult::Error(error.code().into()),
    };
    if current.as_deref() != expected_version {
        return SaveResult::Conflict {
            version: current.clone(),
            text: current,
        };
    }
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = root.join(format!("{LAYOUT_FILE}.{}.{seq}.tmp", std::process::id()));
    let write = (|| -> std::io::Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "LAYOUT_SYMLINK"));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        fs::rename(&tmp, &path)?;
        #[cfg(unix)]
        fs::File::open(root)?.sync_all()?;
        Ok(())
    })();
    if let Err(error) = write {
        let _ = fs::remove_file(&tmp);
        return SaveResult::Error(error.to_string());
    }
    SaveResult::Ok {
        version: text.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_returns_none_none_when_the_sidecar_is_absent() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            load(dir.path()),
            Loaded {
                text: None,
                version: None
            }
        );
    }

    #[test]
    fn load_returns_text_and_version_equal_to_it() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(LAYOUT_FILE), "hello").unwrap();
        let l = load(dir.path());
        assert_eq!(l.text.as_deref(), Some("hello"));
        assert_eq!(l.version.as_deref(), Some("hello"));
    }

    #[test]
    fn save_writes_when_expected_matches_including_the_absent_case() {
        let dir = tempfile::tempdir().unwrap();
        let r = save(dir.path(), "v1", None);
        assert_eq!(
            r,
            SaveResult::Ok {
                version: "v1".into()
            }
        );
        assert_eq!(
            fs::read_to_string(dir.path().join(LAYOUT_FILE)).unwrap(),
            "v1"
        );
    }

    #[test]
    fn save_round_trips_load_then_edit_then_save() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), "v1", None);
        let loaded = load(dir.path());
        let r = save(dir.path(), "v2", loaded.version.as_deref());
        assert_eq!(
            r,
            SaveResult::Ok {
                version: "v2".into()
            }
        );
    }

    #[test]
    fn save_rejects_a_stale_version_without_touching_the_file() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), "v1", None);
        let r = save(dir.path(), "stale-write", None); // still claims "no file existed"
        assert_eq!(
            r,
            SaveResult::Conflict {
                text: Some("v1".into()),
                version: Some("v1".into())
            }
        );
        assert_eq!(
            fs::read_to_string(dir.path().join(LAYOUT_FILE)).unwrap(),
            "v1"
        );
    }

    /// The genuine interleaving: two independent readers of the SAME version,
    /// one writes first and succeeds, the second (now stale) must be
    /// rejected without clobbering the first writer's content.
    #[test]
    fn simultaneous_writers_with_the_same_version_cannot_both_commit() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), "v0", None);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let mut workers = Vec::new();
        for text in ["from-a", "from-b"] {
            let root = dir.path().to_path_buf();
            let barrier = barrier.clone();
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                save(&root, text, Some("v0"))
            }));
        }
        barrier.wait();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, SaveResult::Ok { .. }))
                .count(),
            1
        );
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, SaveResult::Conflict { .. }))
                .count(),
            1
        );
    }

    #[test]
    fn a_stale_writer_is_rejected_after_a_concurrent_write_lands() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), "v0", None);
        let reader_a = load(dir.path());
        let reader_b = load(dir.path());
        assert_eq!(reader_a, reader_b);

        let write_b = save(dir.path(), "v1-from-b", reader_b.version.as_deref());
        assert_eq!(
            write_b,
            SaveResult::Ok {
                version: "v1-from-b".into()
            }
        );

        let write_a = save(dir.path(), "v1-from-a", reader_a.version.as_deref());
        assert_eq!(
            write_a,
            SaveResult::Conflict {
                text: Some("v1-from-b".into()),
                version: Some("v1-from-b".into())
            }
        );
        assert_eq!(
            fs::read_to_string(dir.path().join(LAYOUT_FILE)).unwrap(),
            "v1-from-b"
        );
    }

    #[test]
    fn save_creates_the_root_dir_on_first_write() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("nested");
        let r = save(&nested, "{}", None);
        assert_eq!(
            r,
            SaveResult::Ok {
                version: "{}".into()
            }
        );
    }

    #[test]
    fn load_accepts_the_eight_mib_boundary_but_cas_never_returns_oversized_text() {
        let dir = tempfile::tempdir().unwrap();
        let boundary = vec![b'x'; crate::layout_file::LAYOUT_FILE_MAX_BYTES as usize];
        fs::write(dir.path().join(LAYOUT_FILE), &boundary).unwrap();
        assert_eq!(load(dir.path()).text.as_deref().map(str::len), Some(boundary.len()));

        fs::write(
            dir.path().join(LAYOUT_FILE),
            vec![b'y'; crate::layout_file::LAYOUT_FILE_MAX_BYTES as usize + 1],
        )
        .unwrap();
        let loaded = load(dir.path());
        assert_eq!(loaded.text, None);
        assert_eq!(loaded.version, None);
        assert_eq!(
            save(dir.path(), "replacement", None),
            SaveResult::Error("LAYOUT_FILE_LIMIT".into())
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn does_not_reclaim_an_old_lock_when_its_pid_start_identity_is_live() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(format!("{LAYOUT_FILE}.lock"));
        let record = LayoutLockRecord {
            pid: std::process::id(),
            start: current_process_start(),
            token: "old-but-live".into(),
        };
        fs::write(&path, format_lock_record(&record)).unwrap();
        let raw = CString::new(path.as_os_str().as_bytes()).unwrap();
        let old = [
            libc::timespec { tv_sec: 1, tv_nsec: 0 },
            libc::timespec { tv_sec: 1, tv_nsec: 0 },
        ];
        assert_eq!(unsafe { libc::utimensat(libc::AT_FDCWD, raw.as_ptr(), old.as_ptr(), 0) }, 0);

        let error = match acquire_lock_with_wait(dir.path(), Duration::from_millis(40)) {
            Err(error) => error,
            Ok(lock) => {
                drop(lock);
                panic!("live lock was reclaimed")
            }
        };
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        assert_eq!(parse_lock_record(&fs::read_to_string(path).unwrap()), Some(record));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn does_not_reclaim_a_lock_with_unknown_process_identity() {
        let record = LayoutLockRecord {
            pid: std::process::id(),
            start: "unknown:owner".into(),
            token: "unknown-owner".into(),
        };
        assert_eq!(owner_state(&record), OwnerState::Unknown);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reclaims_a_lock_when_the_pid_start_identity_is_not_the_owner() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(format!("{LAYOUT_FILE}.lock"));
        let record = LayoutLockRecord {
            pid: std::process::id(),
            start: "linux:0".into(),
            token: "dead-owner".into(),
        };
        fs::write(&path, format_lock_record(&record)).unwrap();
        let lock = acquire_lock_with_wait(dir.path(), Duration::from_millis(200)).unwrap();
        drop(lock);
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn an_old_owner_cannot_release_a_successor_lock() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(format!("{LAYOUT_FILE}.lock"));
        let old = acquire_lock_with_wait(dir.path(), Duration::from_millis(200)).unwrap();
        fs::remove_file(&path).unwrap();
        let successor = LayoutLockRecord {
            pid: std::process::id(),
            start: current_process_start(),
            token: "successor-token".into(),
        };
        let successor_text = format_lock_record(&successor);
        fs::write(&path, &successor_text).unwrap();
        drop(old);
        assert_eq!(fs::read_to_string(&path).unwrap(), successor_text);
        fs::remove_file(path).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn cas_rejects_a_symlink_current_file_instead_of_following_or_replacing_it() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        fs::write(&target, "keep").unwrap();
        symlink(&target, dir.path().join(LAYOUT_FILE)).unwrap();
        assert_eq!(
            save(dir.path(), "overwrite", Some("keep")),
            SaveResult::Error("LAYOUT_SYMLINK".into())
        );
        assert_eq!(fs::read_to_string(target).unwrap(), "keep");
    }
}
