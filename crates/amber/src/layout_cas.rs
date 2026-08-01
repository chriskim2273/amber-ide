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
//! cannot false-positive. Each writer only ever compares its OWN token
//! against its own re-read, so this side and the TypeScript side never need
//! to agree on an algorithm — only on the JSON wire shape `web.rs` exposes.
//!
//! Core rule #3 (CLAUDE.md): split geometry stays app-owned, not daemon
//! state. This keeps the sidecar a plain file with two writers, made safe by
//! CAS instead of moving ownership into the daemon (spec §6 explicitly
//! rejects that escalation without the user's sign-off).

use std::fs;
use std::path::Path;

use crate::mosaic::LAYOUT_FILE;

/// Read result: both fields `None` when the sidecar doesn't exist yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Loaded {
    pub text: Option<String>,
    pub version: Option<String>,
}

/// Read the sidecar. Never fails — a missing/unreadable file is `None`/`None`,
/// matching the "no sidecar yet" first-run case.
pub fn load(root: &Path) -> Loaded {
    match fs::read_to_string(root.join(LAYOUT_FILE)) {
        Ok(text) => Loaded { version: Some(text.clone()), text: Some(text) },
        Err(_) => Loaded { text: None, version: None },
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SaveResult {
    Ok { version: String },
    /// The on-disk version has moved since the caller last read it. Carries
    /// the fresh content so the caller can merge without a second read.
    Conflict { text: Option<String>, version: Option<String> },
    Error(String),
}

/// CAS write: re-reads the file under the SAME call that does the atomic
/// rename, so the check-then-write race window is the read itself, not a
/// separate round trip.
pub fn save(root: &Path, text: &str, expected_version: Option<&str>) -> SaveResult {
    let path = root.join(LAYOUT_FILE);
    let current = fs::read_to_string(&path).ok();
    if current.as_deref() != expected_version {
        return SaveResult::Conflict { version: current.clone(), text: current };
    }
    if let Err(e) = fs::create_dir_all(root) {
        return SaveResult::Error(e.to_string());
    }
    // pid + a per-call atomic counter (mirrors `amber_core::state`'s
    // `atomic_write` discipline): a pid-only name lets two threads of this
    // same process (two concurrent HTTP requests) share a tmp path.
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = root.join(format!("{LAYOUT_FILE}.{}.{seq}.tmp", std::process::id()));
    if let Err(e) = fs::write(&tmp, text) {
        return SaveResult::Error(e.to_string());
    }
    if let Err(e) = fs::rename(&tmp, &path) {
        return SaveResult::Error(e.to_string());
    }
    SaveResult::Ok { version: text.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_returns_none_none_when_the_sidecar_is_absent() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()), Loaded { text: None, version: None });
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
        assert_eq!(r, SaveResult::Ok { version: "v1".into() });
        assert_eq!(fs::read_to_string(dir.path().join(LAYOUT_FILE)).unwrap(), "v1");
    }

    #[test]
    fn save_round_trips_load_then_edit_then_save() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), "v1", None);
        let loaded = load(dir.path());
        let r = save(dir.path(), "v2", loaded.version.as_deref());
        assert_eq!(r, SaveResult::Ok { version: "v2".into() });
    }

    #[test]
    fn save_rejects_a_stale_version_without_touching_the_file() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), "v1", None);
        let r = save(dir.path(), "stale-write", None); // still claims "no file existed"
        assert_eq!(r, SaveResult::Conflict { text: Some("v1".into()), version: Some("v1".into()) });
        assert_eq!(fs::read_to_string(dir.path().join(LAYOUT_FILE)).unwrap(), "v1");
    }

    /// The genuine interleaving: two independent readers of the SAME version,
    /// one writes first and succeeds, the second (now stale) must be
    /// rejected without clobbering the first writer's content.
    #[test]
    fn a_stale_writer_is_rejected_after_a_concurrent_write_lands() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), "v0", None);
        let reader_a = load(dir.path());
        let reader_b = load(dir.path());
        assert_eq!(reader_a, reader_b);

        let write_b = save(dir.path(), "v1-from-b", reader_b.version.as_deref());
        assert_eq!(write_b, SaveResult::Ok { version: "v1-from-b".into() });

        let write_a = save(dir.path(), "v1-from-a", reader_a.version.as_deref());
        assert_eq!(
            write_a,
            SaveResult::Conflict { text: Some("v1-from-b".into()), version: Some("v1-from-b".into()) }
        );
        assert_eq!(fs::read_to_string(dir.path().join(LAYOUT_FILE)).unwrap(), "v1-from-b");
    }

    #[test]
    fn save_creates_the_root_dir_on_first_write() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("nested");
        let r = save(&nested, "{}", None);
        assert_eq!(r, SaveResult::Ok { version: "{}".into() });
    }
}
