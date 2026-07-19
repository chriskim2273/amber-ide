//! Slice 2 exit test: the claude supervisor loop (resume/continue argv
//! selection, bounded-retry crash handling) and the `amber hook` subcommand
//! that records the rotating session id (spec §6.2, §8).

use amber::supervisor::{supervise_claude, SuperviseOutcome, SuspendControl};
use amber_core::state::{ClaudeMeta, StateStore};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Serializes the tests in this file, which would otherwise flake with
/// `ETXTBSY` ("Text file busy") when the supervisor execs its fake `claude`.
///
/// Every test here writes an executable script and then execs it, while the
/// others concurrently `Command::spawn` (fork+exec). `fork` copies the parent's
/// whole fd table, so a fork that lands between another thread's
/// `fs::write(script)` open and close leaves the forked child holding a WRITE fd
/// to that script's inode. `O_CLOEXEC` only closes it at the child's `execve`,
/// so for that window the kernel sees the script as open-for-writing and refuses
/// to exec it. It is the inherited fd, not a shared path, that collides —
/// per-test tempdirs cannot help, and neither can an atomic write+rename (the
/// inherited fd follows the inode through the rename).
///
/// Pre-existing flake, reproducible on an untouched tree: 4/10 runs of this file
/// alone failed before the guard, 0/15 after.
// ponytail: whole-test mutex (these tests run serially, ~4s). The alternative —
// retrying an ETXTBSY exec inside the supervisor — would inject extra phases
// into the exact sequences these tests assert.
fn exec_guard() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    // Poison-tolerant: one failing test must not cascade into the others.
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Poll `phases` until `pred` holds or `timeout` elapses; panic on timeout.
fn wait_until(
    phases: &Arc<Mutex<Vec<String>>>,
    pred: impl Fn(&[String]) -> bool,
    timeout: Duration,
) {
    let deadline = Instant::now() + timeout;
    loop {
        if pred(&phases.lock().unwrap()) {
            return;
        }
        if Instant::now() >= deadline {
            panic!("timed out; phases so far: {:?}", phases.lock().unwrap());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

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
    let _exec_guard = exec_guard();
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
        supervise_claude(&claude_path, root, "work", cwd, &settings, 3, report, &SuspendControl::new()).unwrap();
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
        supervise_claude(&claude_path, root, "work", cwd, &settings, 3, report, &SuspendControl::new()).unwrap();
    assert!(matches!(outcome, SuperviseOutcome::CleanExit));

    let lines = log_lines(root);
    assert_eq!(lines.len(), 2);
    assert!(lines[1].contains("--resume"));
    assert!(lines[1].contains("sid-9"));
}

#[test]
fn crash_exhausts_to_outcome() {
    let _exec_guard = exec_guard();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let claude_path = write_fake_claude(root, 1);
    let cwd = root;
    let settings = root.join("settings.json");

    let phases = Mutex::new(Vec::<String>::new());
    let report = |s: &str| phases.lock().unwrap().push(s.to_string());
    let outcome =
        supervise_claude(&claude_path, root, "work", cwd, &settings, 3, report, &SuspendControl::new()).unwrap();
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
fn suspend_then_resume_parks_and_relaunches_claude() {
    let _exec_guard = exec_guard();
    // Slice 3: SIGUSR1 (suspend flag) mid-run must KILL the running claude,
    // report "suspended", idle, and — on the resume flag — relaunch it. The kill
    // must NOT count as a crash. Uses a fake claude that runs ~1s so suspend
    // fires while it is still alive.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let bin = root.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let claude_path = bin.join("claude");
    fs::write(
        &claude_path,
        "#!/bin/sh\necho \"$@\" >> \"$AMBER_STATE_DIR/claude_argv.log\"\nsleep 1\nexit 0\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&claude_path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let settings = root.join("settings.json");
    let ctl = SuspendControl::new();
    let phases = Arc::new(Mutex::new(Vec::<String>::new()));

    let (root2, cp2, set2, ctl2, ph2) = (
        root.clone(),
        claude_path.clone(),
        settings.clone(),
        ctl.clone(),
        Arc::clone(&phases),
    );
    let handle = std::thread::spawn(move || {
        let report = |s: &str| ph2.lock().unwrap().push(s.to_string());
        supervise_claude(&cp2, &root2, "work", &root2, &set2, 3, report, &ctl2).unwrap()
    });

    // Run #1 is up.
    wait_until(&phases, |p| p.first().is_some_and(|s| s == "claude"), Duration::from_secs(3));
    // Park it (the wait loop polls the flag every 150 ms).
    ctl.suspend.store(true, Ordering::SeqCst);
    wait_until(&phases, |p| p.iter().any(|s| s == "suspended"), Duration::from_secs(3));
    // Resume → relaunch; run #2 sleeps 1s then exits 0 → CleanExit ends the loop.
    ctl.resume.store(true, Ordering::SeqCst);
    let outcome = handle.join().unwrap();

    assert!(matches!(outcome, SuperviseOutcome::CleanExit));
    assert_eq!(
        *phases.lock().unwrap(),
        vec!["claude".to_string(), "suspended".to_string(), "claude".to_string()],
        "expected start → suspended → relaunch, with the kill NOT counted as a crash"
    );
}

#[test]
fn hook_subcommand_records_id() {
    let _exec_guard = exec_guard();
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
