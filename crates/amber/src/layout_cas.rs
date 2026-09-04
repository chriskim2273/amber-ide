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
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

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

const LOCK_STALE: Duration = Duration::from_secs(30);
const LOCK_WAIT: Duration = Duration::from_secs(2);

struct LayoutLock(PathBuf);
impl Drop for LayoutLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn acquire_lock(root: &Path) -> std::io::Result<LayoutLock> {
    let path = root.join(format!("{LAYOUT_FILE}.lock"));
    let started = Instant::now();
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
                writeln!(file, "{}", std::process::id())?;
                return Ok(LayoutLock(path));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let stale = fs::metadata(&path)
                    .and_then(|meta| meta.modified())
                    .ok()
                    .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                    .is_some_and(|age| age > LOCK_STALE);
                if stale {
                    let _ = fs::remove_file(&path);
                    continue;
                }
                if started.elapsed() >= LOCK_WAIT {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "layout write lock timeout",
                    ));
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(error),
        }
    }
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
