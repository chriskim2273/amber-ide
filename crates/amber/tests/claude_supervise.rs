//! Slice 2 exit test: the claude supervisor loop (resume/continue argv
//! selection, bounded-retry crash handling) and the `amber hook` subcommand
//! that records the rotating session id (spec §6.2, §8).

use amber::supervisor::{supervise_agent, Agent, SuperviseOutcome, SuspendControl};
use amber_core::proto::{self, ControlMsg, Decoder, Frame, SessionInfo};
use amber_core::state::{ClaudeMeta, StateStore};
use std::fs;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
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

// `supervise_agent`'s reporter is invoked at each supervision transition; a
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

enum TestDaemon {
    Direct(Child),
    #[cfg(target_os = "linux")]
    Systemd(String),
}

impl Drop for TestDaemon {
    fn drop(&mut self) {
        match self {
            TestDaemon::Direct(child) => {
                let _ = child.kill();
                let _ = child.wait();
            }
            #[cfg(target_os = "linux")]
            TestDaemon::Systemd(unit) => {
                let _ = Command::new("systemctl")
                    .args(["--user", "stop", unit])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
        }
    }
}

struct RunningDaemon {
    _handle: TestDaemon,
    delegated_root: Option<PathBuf>,
}

fn wait_for_socket(socket: &Path, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if UnixStream::connect(socket).is_ok() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(target_os = "linux")]
fn try_start_delegated_daemon(root: &Path, socket: &Path) -> Option<RunningDaemon> {
    let unit = format!("amber-task4-cgroup-{}.service", std::process::id());
    let output = Command::new("systemd-run")
        .args(["--user", "--unit", &unit, "--property=Delegate=yes", "--collect", "--quiet"])
        .args(["/usr/bin/env", "-u", "HOME", "-u", "CODEX_HOME"])
        .arg(env!("CARGO_BIN_EXE_amber"))
        .args(["daemon", "--root"])
        .arg(root)
        .arg("--socket")
        .arg(socket)
        .output()
        .ok()?;
    if !output.status.success() || !wait_for_socket(socket, Duration::from_secs(5)) {
        let _ = Command::new("systemctl")
            .args(["--user", "stop", &unit])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        return None;
    }
    let control_group = Command::new("systemctl")
        .args(["--user", "show", &unit, "--property=ControlGroup", "--value"])
        .output()
        .ok()
        .filter(|result| result.status.success())
        .and_then(|result| String::from_utf8(result.stdout).ok())
        .map(|path| PathBuf::from("/sys/fs/cgroup").join(path.trim().trim_start_matches('/')))
        .filter(|path| path.join("_daemon").is_dir());
    Some(RunningDaemon {
        _handle: TestDaemon::Systemd(unit),
        delegated_root: control_group,
    })
}

fn start_test_daemon(root: &Path, socket: &Path) -> RunningDaemon {
    #[cfg(target_os = "linux")]
    if let Some(daemon) = try_start_delegated_daemon(root, socket) {
        return daemon;
    }

    let child = Command::new(env!("CARGO_BIN_EXE_amber"))
        .args(["daemon", "--root"])
        .arg(root)
        .arg("--socket")
        .arg(socket)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env_remove("HOME")
        .env_remove("CODEX_HOME")
        .spawn()
        .unwrap();
    assert!(wait_for_socket(socket, Duration::from_secs(5)), "test daemon did not start");
    RunningDaemon { _handle: TestDaemon::Direct(child), delegated_root: None }
}

fn send_control(socket: &Path, message: ControlMsg) {
    let mut stream = UnixStream::connect(socket).unwrap();
    stream.write_all(&proto::encode(&Frame::Control(message))).unwrap();
    stream.flush().unwrap();
}

fn detailed_sessions(socket: &Path) -> Vec<SessionInfo> {
    let mut stream = UnixStream::connect(socket).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    stream
        .write_all(&proto::encode(&Frame::Control(ControlMsg::ListSessionsDetailed)))
        .unwrap();
    let mut decoder = Decoder::new();
    let mut buf = [0u8; 8192];
    loop {
        while let Some(frame) = decoder.next_frame().unwrap() {
            if let Frame::Control(ControlMsg::Sessions { sessions }) = frame {
                return sessions;
            }
        }
        let read = stream.read(&mut buf).unwrap();
        assert_ne!(read, 0, "daemon closed before detailed session reply");
        decoder.feed(&buf[..read]);
    }
}

fn wait_for_session(
    socket: &Path,
    name: &str,
    predicate: impl Fn(&SessionInfo) -> bool,
) -> SessionInfo {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(info) = detailed_sessions(socket)
            .into_iter()
            .find(|info| info.name == name && predicate(info))
        {
            return info;
        }
        assert!(Instant::now() < deadline, "session {name} never reached expected state");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(target_os = "linux")]
fn workload_populated(path: &Path) -> Option<bool> {
    fs::read_to_string(path.join("cgroup.events"))
        .ok()?
        .lines()
        .find_map(|line| {
            let mut fields = line.split_whitespace();
            (fields.next() == Some("populated")).then(|| fields.next() == Some("1"))
        })
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
        supervise_agent(&Agent::Claude { settings: settings.clone() }, &claude_path, root, "work", cwd, 3, report, &SuspendControl::new(), None).unwrap();
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
        supervise_agent(&Agent::Claude { settings: settings.clone() }, &claude_path, root, "work", cwd, 3, report, &SuspendControl::new(), None).unwrap();
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
        supervise_agent(&Agent::Claude { settings: settings.clone() }, &claude_path, root, "work", cwd, 3, report, &SuspendControl::new(), None).unwrap();
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
    // The conversation the pane is in, as the SessionStart hook records it: the
    // relaunch after a suspend must resume THIS id, not start a fresh chat.
    StateStore::new(&root)
        .write_claude(
            "work",
            &ClaudeMeta { session_id: "sid-frozen".to_string(), cwd: root.clone(), updated: 1 },
        )
        .unwrap();
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
        supervise_agent(&Agent::Claude { settings: set2.clone() }, &cp2, &root2, "work", &root2, 3, report, &ctl2, None).unwrap()
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
    let lines = log_lines(&root);
    assert_eq!(lines.len(), 2);
    assert!(
        lines[1].contains("--resume") && lines[1].contains("sid-frozen"),
        "unfreeze must resume the recorded conversation, got: {}",
        lines[1]
    );
}

#[test]
fn duplicate_suspend_while_parked_does_not_repark_after_resume() {
    let _exec_guard = exec_guard();
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
    StateStore::new(&root)
        .write_claude(
            "work",
            &ClaudeMeta {
                session_id: "sid-double-suspend".to_string(),
                cwd: root.clone(),
                updated: 1,
            },
        )
        .unwrap();
    let settings = root.join("settings.json");
    let ctl = SuspendControl::new();
    let phases = Arc::new(Mutex::new(Vec::<String>::new()));
    let handle = {
        let root = root.clone();
        let claude_path = claude_path.clone();
        let settings = settings.clone();
        let ctl = ctl.clone();
        let phases = Arc::clone(&phases);
        std::thread::spawn(move || {
            supervise_agent(
                &Agent::Claude { settings },
                &claude_path,
                &root,
                "work",
                &root,
                3,
                |state| phases.lock().unwrap().push(state.to_string()),
                &ctl,
                None,
            )
            .unwrap()
        })
    };

    wait_until(&phases, |states| states == ["claude"], Duration::from_secs(3));
    ctl.suspend.store(true, Ordering::SeqCst);
    wait_until(
        &phases,
        |states| states.iter().any(|state| state == "suspended"),
        Duration::from_secs(3),
    );
    // A second SIGUSR1 can arrive after cleanup consumed the first request but
    // before Resume. It belongs to the already-parked transition, not the next
    // agent launch.
    ctl.suspend.store(true, Ordering::SeqCst);
    ctl.resume.store(true, Ordering::SeqCst);
    wait_until(
        &phases,
        |states| states.iter().filter(|state| state.as_str() == "claude").count() >= 2,
        Duration::from_secs(3),
    );
    std::thread::sleep(Duration::from_millis(500));
    let reparks = phases.lock().unwrap().iter().filter(|state| *state == "suspended").count();
    if reparks > 1 {
        ctl.resume.store(true, Ordering::SeqCst);
    }
    let outcome = handle.join().unwrap();

    assert!(matches!(outcome, SuperviseOutcome::CleanExit));
    assert_eq!(reparks, 1, "a duplicate suspend request leaked into the resumed launch");
    assert_eq!(log_lines(&root).len(), 2);
}

#[test]
fn suspend_reclaims_a_stubborn_descendant_before_reporting_suspended() {
    let _exec_guard = exec_guard();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let socket = root.join("amberd.sock");
    let bin = root.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let claude_path = bin.join("claude");
    fs::write(
        &claude_path,
        r#"#!/bin/sh
echo "$@" >> "$AMBER_STATE_DIR/claude_argv.log"
count=$(wc -l < "$AMBER_STATE_DIR/claude_argv.log")
if [ "$count" -eq 1 ]; then
  python3 -c 'import os,signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); open(os.environ["AMBER_STATE_DIR"]+"/stubborn.pid","w").write(str(os.getpid())); payload=bytearray(1024*1024); time.sleep(60)' &
  wait
else
  sleep 2
fi
"#,
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&claude_path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    StateStore::new(&root)
        .write_claude(
            "work",
            &ClaudeMeta {
                session_id: "conv-42".to_string(),
                cwd: root.clone(),
                updated: 1,
            },
        )
        .unwrap();
    let store = StateStore::new(&root);
    let mut config = store.load_config().unwrap();
    config.claude_path = Some(claude_path);
    store.save_config(&config).unwrap();
    let daemon = start_test_daemon(&root, &socket);
    let create = Command::new(env!("CARGO_BIN_EXE_amber"))
        .args(["create", "work", "--cwd"])
        .arg(&root)
        .args(["--kind", "claude", "--socket"])
        .arg(&socket)
        .output()
        .unwrap();
    assert!(
        create.status.success(),
        "create failed: {}",
        String::from_utf8_lossy(&create.stderr)
    );
    wait_for_session(&socket, "work", |info| info.run_state.as_deref() == Some("claude"));
    eprintln!(
        "amber task4 test: {}",
        if daemon.delegated_root.is_some() {
            "exercising delegated workload cgroup"
        } else {
            "delegated cgroup unavailable; exercising process-tree fallback"
        }
    );

    let pid_path = root.join("stubborn.pid");
    let deadline = Instant::now() + Duration::from_secs(5);
    let stubborn_pid: i32 = loop {
        if let Ok(text) = fs::read_to_string(&pid_path) {
            if let Ok(pid) = text.trim().parse() {
                break pid;
            }
        }
        assert!(
            Instant::now() < deadline,
            "stubborn descendant never published its pid"
        );
        std::thread::sleep(Duration::from_millis(20));
    };

    #[cfg(target_os = "linux")]
    let delegated_workload = daemon.delegated_root.as_ref().map(|root| {
        let slot = store.read_session("work").unwrap().unwrap().slot;
        let workload = root.join(format!("session-{slot}/workload"));
        assert!(workload.is_dir(), "delegated workload leaf was not created");
        let deadline = Instant::now() + Duration::from_secs(5);
        while workload_populated(&workload) != Some(true) {
            assert!(Instant::now() < deadline, "agent never entered delegated workload");
            std::thread::sleep(Duration::from_millis(20));
        }
        workload
    });

    send_control(&socket, ControlMsg::Suspend { name: "work".into() });
    let suspended =
        wait_for_session(&socket, "work", |info| info.run_state.as_deref() == Some("suspended"));
    assert!(suspended.alive, "the supervisor exited instead of parking");

    #[cfg(target_os = "linux")]
    if let Some(workload) = &delegated_workload {
        let deadline = Instant::now() + Duration::from_secs(5);
        while workload_populated(workload) != Some(false) {
            assert!(Instant::now() < deadline, "delegated workload stayed recursively populated");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    let deadline = Instant::now() + Duration::from_secs(5);
    let reclaimed = loop {
        let alive = unsafe { libc::kill(stubborn_pid, 0) } == 0;
        if !alive || Instant::now() >= deadline {
            break !alive;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    if !reclaimed {
        unsafe { libc::kill(stubborn_pid, libc::SIGKILL) };
    }
    assert!(reclaimed, "suspend reported success while a descendant survived");

    send_control(&socket, ControlMsg::Resume { name: "work".into() });
    wait_for_session(&socket, "work", |info| info.run_state.as_deref() == Some("claude"));
    let deadline = Instant::now() + Duration::from_secs(5);
    while log_lines(&root).len() < 2 {
        assert!(Instant::now() < deadline, "agent did not relaunch after resume");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(log_lines(&root)[1].contains("--resume conv-42"));

    send_control(&socket, ControlMsg::Kill { name: "work".into() });
    let deadline = Instant::now() + Duration::from_secs(5);
    while detailed_sessions(&socket).iter().any(|info| info.name == "work") {
        assert!(Instant::now() < deadline, "test session was not removed");
        std::thread::sleep(Duration::from_millis(20));
    }
    drop(daemon);
}

#[test]
fn shell_fallback_ignores_late_supervisor_signals() {
    let _exec_guard = exec_guard();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let claude_path = write_fake_claude(root, 0);
    let fallback = root.join("fallback-shell");
    fs::write(
        &fallback,
        "#!/bin/sh\n: > \"$AMBER_STATE_DIR/fallback-ready\"\nwhile :; do sleep 1; done\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&fallback, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let store = StateStore::new(root);
    let mut config = store.load_config().unwrap();
    config.claude_path = Some(claude_path);
    store.save_config(&config).unwrap();

    // `amber run` now flushes ordered run-state reports before exec'ing the
    // shell. This focused signal test has no real daemon/session manager, so a
    // tiny protocol-faithful peer acknowledges the expected running + terminal
    // reports instead of accidentally testing an absent socket.
    let report_socket = root.join("report.sock");
    let listener = std::os::unix::net::UnixListener::bind(&report_socket).unwrap();
    let ack_server = std::thread::spawn(move || {
        for _ in 0..2 {
            let (mut stream, _) = listener.accept().unwrap();
            let mut decoder = Decoder::new();
            let mut buf = [0u8; 4096];
            let (name, seq) = loop {
                if let Some(Frame::Control(ControlMsg::ReportRunState { name, seq, .. })) =
                    decoder.next_frame().unwrap()
                {
                    break (name, seq);
                }
                let n = stream.read(&mut buf).unwrap();
                assert!(n > 0, "reporter closed before sending a run-state frame");
                decoder.feed(&buf[..n]);
            };
            stream
                .write_all(&proto::encode(&Frame::Control(ControlMsg::RunStateAck {
                    name,
                    seq,
                })))
                .unwrap();
        }
    });

    let mut child = Command::new(env!("CARGO_BIN_EXE_amber"))
        .args(["run", "work", "--kind", "claude"])
        .env("AMBER_STATE_DIR", root)
        .env("AMBER_SOCK", &report_socket)
        .env("SHELL", &fallback)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let ready = root.join("fallback-ready");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !ready.exists() {
        assert!(Instant::now() < deadline, "supervisor never entered shell fallback");
        std::thread::sleep(Duration::from_millis(20));
    }
    ack_server.join().unwrap();

    for signal in [libc::SIGUSR1, libc::SIGUSR2] {
        assert_eq!(unsafe { libc::kill(child.id() as i32, signal) }, 0);
        std::thread::sleep(Duration::from_millis(100));
        assert!(child.try_wait().unwrap().is_none(), "fallback died from signal {signal}");
    }
    child.kill().unwrap();
    child.wait().unwrap();
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
