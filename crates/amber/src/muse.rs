//! Muse (Muse Code CLI) supervision helpers: build resume/fresh argv and
//! discover the session id from Muse's own session store. Pure/testable; the
//! supervisor loop lives in `supervisor`.
//!
//! Muse is Claude-shaped, not Grok-shaped: amber cannot assign the id. The
//! interactive TUI rejects `--session-id` outright (`invalid TUI options:
//! unexpected argument '--session-id'`), and only `muse exec` accepts it —
//! but a pane needs the interactive TUI, not a headless one-shot. There is
//! also no `SessionStart` hook or plugin event amber could tap, so the id has
//! to be DISCOVERED after launch:
//!
//! * fresh: `muse --yolo` (unattended approvals + sandbox off + workspace
//!   trusted for the run — the same posture every other agent pane runs with).
//!   Muse mints its own UUID session and records it under
//!   `${XDG_DATA_HOME:-~/.local/share}/muse/sessions/YYYY/MM/DD/<uuid>/`.
//! * resume: `muse resume <uuid> --yolo` (both orders parse — root options may
//!   appear on either side of `resume`; this order is observed live).
//!
//! Discovery reads that store. The directory name IS the session id, and the
//! head of `session.jsonl` carries `runtime.session.metadata`
//! (`workspace_root`) plus `runtime.session.route_facts` (`pid` — the CLI's
//! own pid, which for a supervised pane is a descendant of the pty child).
//! Matching on (pid, cwd) binds a pane to exactly its own conversation even
//! when several Muse panes share one cwd; a bare newest-for-cwd fallback is
//! deliberately NOT offered (it would steal a sibling pane's conversation).
//!
//! Process detection cannot be an exact name: the launcher (`command -v muse`)
//! execs a versioned `muse-bin-<version>` ELF, so the argv0 basename changes
//! on every Muse update. [`is_muse_process`] matches `muse` (the launcher,
//! briefly) and the `muse-bin` prefix instead.

use std::path::{Path, PathBuf};

/// How to start `muse`: reopen a recorded conversation, or begin a new one
/// (Muse mints the id itself — see the module docs).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MuseStart {
    Resume(String),
    Fresh,
}

/// Build muse's argument vector (excluding the program itself).
///
/// `--yolo` is muse's unattended equivalent of claude's
/// `--dangerously-skip-permissions` / grok's `bypassPermissions`: a pane runs
/// detached in the daemon's pty, so an approval prompt nobody is watching
/// would hang the session. It also trusts the workspace for the run, which is
/// what lets a fresh pane start without an interactive trust gesture.
pub fn muse_argv(start: &MuseStart) -> Vec<String> {
    match start {
        MuseStart::Resume(id) => vec![
            "resume".to_string(),
            id.clone(),
            "--yolo".to_string(),
        ],
        MuseStart::Fresh => vec!["--yolo".to_string()],
    }
}

/// Is `id` a plausible Muse session id (a UUID)?
///
/// Guards the `Resume` arm the same way the claude ladder does: resuming must
/// name an exact conversation, never fall through to `resume --last` (which
/// would reopen whatever ran last in the cwd — the hijack `--continue` is for
/// claude). A blank or malformed id starts Fresh rather than being handed to
/// `resume`, whose positional arg is required.
pub fn is_session_id(id: &str) -> bool {
    if id.len() != 36 {
        return false;
    }
    id.bytes().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => byte == b'-',
        _ => byte.is_ascii_hexdigit(),
    })
}

/// True for a process that IS the Muse CLI: the `muse` launcher or a
/// versioned `muse-bin-<version>` binary. Plain prefix matching is load
/// bearing — the version suffix changes on every Muse update, so an exact
/// process-name list would silently stop detecting Muse after an upgrade.
pub fn is_muse_process(comm: &str) -> bool {
    comm == "muse" || comm.starts_with("muse-bin")
}

/// Resolve the muse binary via the user's login shell — never the daemon's
/// own PATH (same distribution-safe path claude/grok/codex take). This finds
/// the `muse` launcher, which execs the real versioned binary itself.
pub fn resolve_muse() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        let shell = crate::platform::default_shell();
        crate::claude::resolve_bin_with(&shell.to_string_lossy(), true, "muse", &[])
    }
    #[cfg(windows)]
    {
        crate::claude::resolve_bin_windows("muse")
    }
}

/// Muse's session store: `$XDG_DATA_HOME/muse/sessions` when set, else
/// `~/.local/share/muse/sessions` (Muse's own `${XDG_DATA_HOME:-...}`
/// default). `None` when no home can be found — discovery then degrades to
/// "no recording" (the pane still runs; it just resumes Fresh).
pub fn sessions_base() -> Option<PathBuf> {
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        let p = PathBuf::from(xdg);
        if !p.as_os_str().is_empty() {
            return Some(p.join("muse").join("sessions"));
        }
    }
    crate::platform::user_home().map(|home| {
        home.join(".local")
            .join("share")
            .join("muse")
            .join("sessions")
    })
}

/// One Muse session discovered in the store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MuseSession {
    /// Directory name = the id `muse resume <id>` takes.
    pub id: String,
    /// `workspace_root` from the session's metadata record.
    pub workspace_root: PathBuf,
    /// Earliest `recorded_at` seen (microseconds) — the session's birth.
    pub created_us: u64,
    /// `pid` from the session's route_facts record, when present.
    pub pid: Option<u32>,
}

/// How many bytes of each `session.jsonl` to parse. The metadata and
/// route_facts records land within the first lines (sequences 3–4); the file
/// itself can be megabytes.
const SESSION_HEAD_BYTES: u64 = 65536;

/// Bound on discovered session directories per scan. The store accumulates
/// one directory per session ever run; parsing is head-only and stops early
/// per file, but the directory walk itself must stay bounded on a machine
/// with years of Muse history.
const SCAN_DIR_CAP: usize = 8192;

/// Discover every Muse session in the store. Best-effort: unreadable files
/// are skipped, never fatal.
pub fn scan_sessions() -> Vec<MuseSession> {
    sessions_base()
        .map(|base| scan_sessions_in(&base))
        .unwrap_or_default()
}

fn scan_sessions_in(base: &Path) -> Vec<MuseSession> {
    let mut out = Vec::new();
    // Layout: sessions/YYYY/MM/DD/<uuid>/session.jsonl. Walk the three date
    // levels explicitly rather than a recursive walk so unrelated files under
    // the data dir can never be mistaken for sessions.
    let mut day_dirs = Vec::new();
    for year in read_dir_names(base) {
        for month in read_dir_names(&base.join(&year)) {
            for day in read_dir_names(&base.join(&year).join(&month)) {
                day_dirs.push(base.join(&year).join(&month).join(&day));
            }
        }
    }
    for day in day_dirs {
        for id in read_dir_names(&day) {
            if out.len() >= SCAN_DIR_CAP {
                return out;
            }
            let log = day.join(&id).join("session.jsonl");
            if let Some(session) = parse_session_head(&id, &log) {
                out.push(session);
            }
        }
    }
    out
}

fn read_dir_names(dir: &Path) -> Vec<String> {
    let mut names = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    names.sort();
    names
}

/// Parse the head of one `session.jsonl` into a [`MuseSession`]. Returns
/// `None` when the directory name is not a session id or no workspace root
/// can be found (a partial/corrupt log).
///
/// Each line is an event-log envelope; the FIRST line may instead be a
/// `retained_frame` whose `children[].record_json` strings are the real
/// envelopes, so both shapes are inspected.
fn parse_session_head(id: &str, log: &Path) -> Option<MuseSession> {
    if !is_session_id(id) {
        return None;
    }
    let bytes = read_head(log, SESSION_HEAD_BYTES)?;
    let text = String::from_utf8_lossy(&bytes);
    let mut workspace_root: Option<PathBuf> = None;
    let mut pid: Option<u32> = None;
    let mut created_us: Option<u64> = None;
    // No early exit: the head is bounded (64 KiB) and a resumed session
    // appends a FRESHER route_facts (new pid) after the original — the last
    // pid seen is the live process, while created_us stays the minimum.
    for line in text.lines() {
        let value: serde_json::Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        inspect_record(&value, &mut workspace_root, &mut pid, &mut created_us);
        if let Some(children) = value.get("children").and_then(|c| c.as_array()) {
            for child in children {
                if let Some(nested) = child.get("record_json").and_then(|r| r.as_str()) {
                    if let Ok(record) = serde_json::from_str::<serde_json::Value>(nested) {
                        inspect_record(&record, &mut workspace_root, &mut pid, &mut created_us);
                    }
                }
            }
        }
    }
    let workspace_root = workspace_root?;
    Some(MuseSession {
        id: id.to_string(),
        workspace_root,
        created_us: created_us.unwrap_or(0),
        pid,
    })
}

fn inspect_record(
    record: &serde_json::Value,
    workspace_root: &mut Option<PathBuf>,
    pid: &mut Option<u32>,
    created_us: &mut Option<u64>,
) {
    if let Some(ts) = record.get("recorded_at").and_then(|t| t.as_u64()) {
        *created_us = Some(created_us.map_or(ts, |min| min.min(ts)));
    }
    let payload_type = record.get("payload_type").and_then(|t| t.as_str());
    match payload_type {
        Some("runtime.session.metadata") => {
            if workspace_root.is_none() {
                if let Some(root) = record
                    .pointer("/payload/record/workspace_root")
                    .and_then(|r| r.as_str())
                {
                    *workspace_root = Some(PathBuf::from(root));
                }
            }
        }
        Some("runtime.session.route_facts") => {
            // Last write wins: a `muse resume` appends route_facts for the new
            // process, and only that pid is a live descendant of the pane. A
            // record without a pid must not clobber an earlier one.
            if let Some(found) = record
                .pointer("/payload/record/pid")
                .and_then(|p| p.as_u64())
                .and_then(|p| u32::try_from(p).ok())
            {
                *pid = Some(found);
            }
        }
        _ => {}
    }
}

fn read_head(path: &Path, max_bytes: u64) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len().min(max_bytes);
    let mut buf = vec![0u8; len as usize];
    file.read_exact(&mut buf).ok()?;
    Some(buf)
}

/// Find the pane's OWN Muse conversation: a session whose recorded CLI pid is
/// one of `pids` (the Muse descendants of the pty child) and whose workspace
/// matches the pane cwd. Pid + cwd together are exact — two Muse panes in one
/// cwd still resolve to their own sessions. On (impossible-but-cheap)
/// duplicates the oldest wins deterministically.
pub fn find_session_for_pids(cwd: &Path, pids: &[u32]) -> Option<MuseSession> {
    if pids.is_empty() {
        return None;
    }
    let mut best: Option<MuseSession> = None;
    for session in scan_sessions() {
        if session.workspace_root != cwd {
            continue;
        }
        if !session.pid.is_some_and(|pid| pids.contains(&pid)) {
            continue;
        }
        let replace = match &best {
            None => true,
            Some(current) => session.created_us < current.created_us,
        };
        if replace {
            best = Some(session);
        }
    }
    best
}

/// Record a discovered Muse session the way the claude `SessionStart` hook
/// would have: same `claude/<name>.json` store (rename/kill/adopt already
/// move and delete that path), tagged with its agent kind.
pub fn record_session(
    store: &amber_core::state::StateStore,
    session_name: &str,
    session: &MuseSession,
) -> anyhow::Result<()> {
    let previous = store.read_claude(session_name)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let updated = previous
        .as_ref()
        .map_or(now, |meta| now.max(meta.updated.saturating_add(1)));
    store.write_claude(
        session_name,
        &amber_core::state::ClaudeMeta {
            session_id: session.id.clone(),
            cwd: session.workspace_root.clone(),
            updated,
            session_file: None,
            agent_kind: Some(amber_core::state::SessionKind::Muse),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argv_fresh_runs_unattended_without_an_id() {
        // A fresh pane must NOT pass --session-id: the TUI rejects it
        // (`invalid TUI options: unexpected argument '--session-id'`).
        let argv = muse_argv(&MuseStart::Fresh);
        assert_eq!(argv, vec!["--yolo".to_string()]);
    }

    #[test]
    fn argv_resume_names_the_exact_conversation() {
        let id = "01a08f86-013a-7a13-9a1f-6298f3efe1d1";
        let argv = muse_argv(&MuseStart::Resume(id.into()));
        assert_eq!(argv[0], "resume");
        assert_eq!(argv[1], id);
        assert!(argv.contains(&"--yolo".to_string()));
        // Never --last: that would reopen whatever ran last in the cwd.
        assert!(!argv.iter().any(|a| a == "--last"));
    }

    #[test]
    fn accepts_uuid_session_ids() {
        assert!(is_session_id("01a08f86-013a-7a13-9a1f-6298f3efe1d1"));
        assert!(is_session_id("11111111-2222-4333-8444-555555555555"));
        assert!(is_session_id("01A08F86-013A-7A13-9A1F-6298F3EFE1D1"));
    }

    #[test]
    fn rejects_ids_that_would_resume_the_wrong_conversation() {
        assert!(!is_session_id(""));
        assert!(!is_session_id("latest"));
        assert!(!is_session_id("--last"));
        assert!(!is_session_id("ses_fd8f8accaffeTWUvgvTimbhECs"));
        assert!(!is_session_id("9d5ed578-38af-420e-9cb5"));
        assert!(!is_session_id("not-a-uuid-at-all-0000-000000000000"));
    }

    #[test]
    fn matches_the_launcher_and_versioned_binaries() {
        assert!(is_muse_process("muse"));
        assert!(is_muse_process("muse-bin-1.1.1-R2514.1"));
        assert!(is_muse_process("muse-bin-9.9.9-R9999.9"));
        assert!(!is_muse_process("claude"));
        assert!(!is_muse_process("amuse"));
        assert!(!is_muse_process("muse-wrapper"));
        assert!(!is_muse_process(""));
    }

    fn write_log(dir: &Path, id: &str, lines: &[serde_json::Value]) {
        let session_dir = dir.join(id);
        std::fs::create_dir_all(&session_dir).unwrap();
        let body = lines
            .iter()
            .map(|v| serde_json::to_string(v).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(session_dir.join("session.jsonl"), body).unwrap();
    }

    fn metadata_record(id: &str, workspace_root: &str, recorded_at: u64) -> serde_json::Value {
        serde_json::json!({
            "schema_version": 1,
            "stream": {"kind": "session", "id": id},
            "sequence": 3,
            "recorded_at": recorded_at,
            "payload_type": "runtime.session.metadata",
            "payload": {"kind": "metadata", "record": {"workspace_root": workspace_root}},
        })
    }

    fn route_record(id: &str, pid: u32, recorded_at: u64) -> serde_json::Value {
        serde_json::json!({
            "schema_version": 1,
            "stream": {"kind": "session", "id": id},
            "sequence": 4,
            "recorded_at": recorded_at,
            "payload_type": "runtime.session.route_facts",
            "payload": {"kind": "route_facts", "record": {"pid": pid}},
        })
    }

    fn day_dir(base: &Path) -> PathBuf {
        base.join("2026").join("09").join("11")
    }

    #[test]
    fn scan_finds_a_session_by_pid_and_cwd() {
        let root = tempfile::TempDir::new().unwrap();
        let base = root.path().join("muse").join("sessions");
        let day = day_dir(&base);
        let id = "01a08f86-013a-7a13-9a1f-6298f3efe1d1";
        write_log(
            &day,
            id,
            &[
                metadata_record(id, "/work/proj", 1000),
                route_record(id, 4242, 1001),
            ],
        );
        // A sibling pane's conversation in the same cwd must not match.
        let other = "01a08f82-9702-77d3-9f13-681da81210a5";
        write_log(
            &day,
            other,
            &[
                metadata_record(other, "/work/proj", 2000),
                route_record(other, 9999, 2001),
            ],
        );
        // A non-session directory and a corrupt log are skipped, never fatal.
        std::fs::create_dir_all(day.join("not-a-session")).unwrap();
        std::fs::create_dir_all(day.join("01a08f89-d683-7e71-b77c-fbc0d12f91f0")).unwrap();
        std::fs::write(
            day.join("01a08f89-d683-7e71-b77c-fbc0d12f91f0")
                .join("session.jsonl"),
            "this is not json\n",
        )
        .unwrap();

        let found = scan_sessions_in(&base);
        assert_eq!(found.len(), 2);
        let session = found.iter().find(|s| s.id == id).unwrap();
        assert_eq!(session.workspace_root, PathBuf::from("/work/proj"));
        assert_eq!(session.pid, Some(4242));
        assert_eq!(session.created_us, 1000);
    }

    #[test]
    fn latest_route_facts_pid_wins_for_resumed_sessions() {
        // A `muse resume` appends route_facts for the NEW process under the
        // same session id; binding must use the live pid, not the original.
        let root = tempfile::TempDir::new().unwrap();
        let base = root.path().join("muse").join("sessions");
        let day = day_dir(&base);
        let id = "01a08f86-013a-7a13-9a1f-6298f3efe1d1";
        write_log(
            &day,
            id,
            &[
                metadata_record(id, "/work/proj", 1000),
                route_record(id, 4242, 1001),
                route_record(id, 5150, 5000),
            ],
        );
        let found = scan_sessions_in(&base);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].pid, Some(5150));
        assert_eq!(found[0].created_us, 1000);
    }

    #[test]
    fn parse_reads_through_a_retained_frame_wrapper() {
        let root = tempfile::TempDir::new().unwrap();
        let base = root.path().join("muse").join("sessions");
        let day = day_dir(&base);
        let id = "01a08f86-013a-7a13-9a1f-6298f3efe1d1";
        let frame = serde_json::json!({
            "retained_frame": "session_permission_transaction",
            "children": [
                {"child_index": 0, "record_json": serde_json::to_string(&metadata_record(id, "/work/proj", 500)).unwrap()},
                {"child_index": 1, "record_json": serde_json::to_string(&route_record(id, 777, 501)).unwrap()},
            ],
        });
        write_log(&day, id, &[frame]);
        let found = scan_sessions_in(&base);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].workspace_root, PathBuf::from("/work/proj"));
        assert_eq!(found[0].pid, Some(777));
        assert_eq!(found[0].created_us, 500);
    }
}
