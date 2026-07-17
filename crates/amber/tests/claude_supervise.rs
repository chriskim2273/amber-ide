//! Slice 2 exit test: the claude supervisor loop (resume/continue argv
//! selection, bounded-retry crash handling) and the `amber hook` subcommand
//! that records the rotating session id (spec §6.2, §8).

use amber::supervisor::{supervise_claude, SuperviseOutcome};
use amber_core::state::{ClaudeMeta, StateStore};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Mutex;

// `supervise_claude`'s reporter is invoked at each supervision transition; a
// `Mutex<Vec<String>>` records the exact phase sequence for assertions. The
// closure borrows the vec immutably, so it can be read back after the call.

/// Write a fake `claude` shell script into `dir/bin` (kept out of the state
/// root's own `claude/` metadata subdirectory) that appends its received
/// argv to `$AMBER_STATE_DIR/claude_argv.log` (one line per invocation) and
/// exits with `code`.
fn write_fake_claude(dir: &Path, code: i32) -> std::path::PathBuf {
    let bin_dir = dir.join("bin");
    fs::create_dir_all(&bin_dir).unwrap();
    let path = bin_dir.join("claude");
    let script = format!(
        "#!/bin/sh\necho \"$@\" >> \"$AMBER_STATE_DIR/claude_argv.log\"\nexit {code}\n"
    );
    fs::write(&path, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    path
}

fn log_lines(root: &Path) -> Vec<String> {
    match fs::read_to_string(root.join("claude_argv.log")) {
        Ok(s) => s.lines().map(|l| l.to_string()).collect(),
        Err(_) => Vec::new(),
    }
}

#[test]
fn resume_after_first_run() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let claude_path = write_fake_claude(root, 0);
    let cwd = root;
    let settings = root.join("settings.json");

    // First run: no claude/<name>.json yet -> Fresh (a brand-new conversation).
    // NOT --continue: that would print "No conversation to continue" and fail.
    let phases = Mutex::new(Vec::<String>::new());
    let report = |s: &str| phases.lock().unwrap().push(s.to_string());
    let outcome =
        supervise_claude(&claude_path, root, "work", cwd, &settings, 3, report).unwrap();
    assert!(matches!(outcome, SuperviseOutcome::CleanExit));
    // A clean first run reports exactly one "claude" (start), no retry.
    assert_eq!(phases.lock().unwrap().clone(), vec!["claude".to_string()]);

    let lines = log_lines(root);
    assert_eq!(lines.len(), 1);
    assert!(!lines[0].contains("--continue"), "fresh session must not --continue");
    assert!(!lines[0].contains("--resume"));

    // Simulate the SessionStart hook recording a rotated session id.
    let store = StateStore::new(root);
    store
        .write_claude(
            "work",
            &ClaudeMeta {
                session_id: "sid-9".to_string(),
                cwd: cwd.to_path_buf(),
                updated: 1,
            },
        )
        .unwrap();

    // Second run: claude/<name>.json now present -> --resume sid-9.
    let report = |_s: &str| {};
    let outcome =
        supervise_claude(&claude_path, root, "work", cwd, &settings, 3, report).unwrap();
    assert!(matches!(outcome, SuperviseOutcome::CleanExit));

    let lines = log_lines(root);
    assert_eq!(lines.len(), 2);
    assert!(lines[1].contains("--resume"));
    assert!(lines[1].contains("sid-9"));
}

#[test]
fn crash_exhausts_to_outcome() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let claude_path = write_fake_claude(root, 1);
    let cwd = root;
    let settings = root.join("settings.json");

    let phases = Mutex::new(Vec::<String>::new());
    let report = |s: &str| phases.lock().unwrap().push(s.to_string());
    let outcome =
        supervise_claude(&claude_path, root, "work", cwd, &settings, 3, report).unwrap();
    assert!(matches!(outcome, SuperviseOutcome::Exhausted));

    let lines = log_lines(root);
    assert_eq!(lines.len(), 3);

    // Three crashing runs with a max of 3: claude, (retry) claude-retrying,
    // claude, (retry) claude-retrying, claude — then the budget is exhausted
    // (no trailing retry). "shell-fallback" is reported by run_session, not
    // supervise_claude, so it does not appear here.
    assert_eq!(
        phases.lock().unwrap().clone(),
        vec![
            "claude".to_string(),
            "claude-retrying".to_string(),
            "claude".to_string(),
            "claude-retrying".to_string(),
            "claude".to_string(),
        ]
    );
}

#[test]
fn hook_subcommand_records_id() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();

    let mut child = Command::new(env!("CARGO_BIN_EXE_amber"))
        .arg("hook")
        .env("AMBER_SESSION", "w")
        .env("AMBER_STATE_DIR", root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(br#"{"session_id":"H1","cwd":"/tmp"}"#)
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());

    let store = StateStore::new(root);
    let meta = store.read_claude("w").unwrap().unwrap();
    assert_eq!(meta.session_id, "H1");
}
