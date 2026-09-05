#![cfg(unix)]

//! Slice 2 exit test: the claude supervisor loop (resume/continue argv
//! selection, bounded-retry crash handling) and the `amber hook` subcommand
//! that records the rotating session id (spec §6.2, §8).

use amber::supervisor::{supervise_agent, Agent, SuperviseOutcome, SuspendControl};
use amber_core::proto::{self, ControlMsg, Decoder, Frame, SessionInfo};
use amber_core::state::{ClaudeMeta, StateStore};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
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
    #[cfg(target_os = "linux")]
    PrivateSystemd(PrivateSystemdDaemon),
}

#[cfg(target_os = "linux")]
struct PrivateSystemdDaemon {
    unit: String,
    root: PathBuf,
    systemctl: OsString,
}

#[cfg(target_os = "linux")]
impl Drop for PrivateSystemdDaemon {
    fn drop(&mut self) {
        for action in ["stop", "reset-failed"] {
            let _ = Command::new(&self.systemctl)
                .args(["--user", action, &self.unit])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let _ = fs::remove_dir_all(&self.root);
    }
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
            #[cfg(target_os = "linux")]
            TestDaemon::PrivateSystemd(_daemon) => {}
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

#[cfg(target_os = "linux")]
fn assert_normal_absolute(path: &Path, label: &str) {
    assert!(path.is_absolute(), "{label} must be absolute: {}", path.display());
    assert!(
        path.components()
            .all(|component| matches!(component, Component::RootDir | Component::Normal(_))),
        "{label} must not contain relative or prefix components: {}",
        path.display(),
    );
}

#[cfg(target_os = "linux")]
const PRIVATE_TEST_ROOT_MARKER: &str = ".amber-private-test-root";

#[cfg(target_os = "linux")]
const PRIVATE_TEST_ROOT_MARKER_CONTENT: &[u8] = b"amber private integration test root\n";

#[cfg(target_os = "linux")]
fn mark_private_test_root(root: &Path) {
    fs::write(
        root.join(PRIVATE_TEST_ROOT_MARKER),
        PRIVATE_TEST_ROOT_MARKER_CONTENT,
    )
    .expect("mark private test root");
}

#[cfg(target_os = "linux")]
fn assert_private_root_socket(root: &Path, socket: &Path) {
    assert_normal_absolute(root, "private state root");
    assert_normal_absolute(socket, "private daemon socket");
    let temp_root = std::env::temp_dir()
        .canonicalize()
        .unwrap_or_else(|_| std::env::temp_dir());
    let root_canonical = root.canonicalize().expect("private state root must exist");
    assert!(
        root_canonical != temp_root && root_canonical.starts_with(&temp_root),
        "private state root must be a strict child of the OS temp directory: {}",
        root.display(),
    );
    assert_eq!(
        fs::read(root_canonical.join(PRIVATE_TEST_ROOT_MARKER)).ok().as_deref(),
        Some(PRIVATE_TEST_ROOT_MARKER_CONTENT),
        "private state root must carry the test-owned cleanup marker: {}",
        root.display(),
    );
    assert_eq!(
        socket.parent(),
        Some(root),
        "private socket must be directly under the private state root",
    );
    assert_eq!(
        socket.file_name(),
        Some(OsStr::new("amberd.sock")),
        "private socket must use the expected test-only filename",
    );
}

#[cfg(target_os = "linux")]
#[test]
fn private_root_validator_rejects_temp_directory_and_unmarked_children() {
    let temp_root = std::env::temp_dir()
        .canonicalize()
        .unwrap_or_else(|_| std::env::temp_dir());
    assert!(
        std::panic::catch_unwind(|| {
            assert_private_root_socket(&temp_root, &temp_root.join("amberd.sock"));
        })
        .is_err(),
        "the OS temp directory itself must never be cleanup-owned",
    );

    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().join("private-state");
    fs::create_dir(&root).unwrap();
    let socket = root.join("amberd.sock");
    assert!(
        std::panic::catch_unwind(|| assert_private_root_socket(&root, &socket)).is_err(),
        "an arbitrary temp child must not become cleanup-owned",
    );

    mark_private_test_root(&root);
    assert_private_root_socket(&root, &socket);
}

#[cfg(target_os = "linux")]
fn private_amber_command(root: &Path, socket: &Path, args: Vec<OsString>) -> Command {
    assert_private_root_socket(root, socket);
    assert!(
        args.windows(2).any(|pair| {
            pair[0].as_os_str() == OsStr::new("--socket") && pair[1].as_os_str() == socket
        }),
        "private CLI invocation must include an explicit --socket {}",
        socket.display(),
    );
    let mut command = Command::new(env!("CARGO_BIN_EXE_amber"));
    command
        .args(args)
        .current_dir(root)
        .env_remove("AMBER_SOCK")
        .env_remove("HOME")
        .env_remove("CODEX_HOME");
    command
}

#[cfg(target_os = "linux")]
fn create_private_session(root: &Path, socket: &Path, name: &str) {
    let output = private_amber_command(
        root,
        socket,
        vec![
            OsString::from("create"),
            OsString::from(name),
            OsString::from("--cwd"),
            root.as_os_str().to_os_string(),
            OsString::from("--kind"),
            OsString::from("claude"),
            OsString::from("--socket"),
            socket.as_os_str().to_os_string(),
        ],
    )
    .output()
    .unwrap();
    assert!(
        output.status.success(),
        "private create {name} failed: {}",
        String::from_utf8_lossy(&output.stderr),
    );
}

#[cfg(target_os = "linux")]
fn start_required_delegated_daemon(root: &Path, socket: &Path) -> RunningDaemon {
    start_required_delegated_daemon_with_programs(
        root,
        socket,
        OsStr::new("systemd-run"),
        OsStr::new("systemctl"),
    )
}

#[cfg(target_os = "linux")]
fn start_required_delegated_daemon_with_programs(
    root: &Path,
    socket: &Path,
    systemd_run: &OsStr,
    systemctl: &OsStr,
) -> RunningDaemon {
    assert_private_root_socket(root, socket);
    static NEXT_UNIT: AtomicUsize = AtomicUsize::new(0);
    let unit = format!(
        "amber-task6-cgroup-{}-{}.service",
        std::process::id(),
        NEXT_UNIT.fetch_add(1, Ordering::SeqCst),
    );
    let output = Command::new(systemd_run)
        .args([
            "--user",
            "--unit",
            &unit,
            "--property=Delegate=cpu memory",
            "--collect",
            "--quiet",
        ])
        .args(["/usr/bin/env", "-u", "HOME", "-u", "CODEX_HOME"])
        .arg(env!("CARGO_BIN_EXE_amber"))
        .args(["daemon", "--root"])
        .arg(root)
        .arg("--socket")
        .arg(socket)
        .output()
        .expect("systemd-run must be invokable for delegated cgroup proof");
    let daemon = PrivateSystemdDaemon {
        unit,
        root: root.to_path_buf(),
        systemctl: systemctl.to_os_string(),
    };
    if !output.status.success() || !wait_for_socket(socket, Duration::from_secs(5)) {
        panic!(
            "required delegated private daemon did not start: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }

    let control_group = Command::new(&daemon.systemctl)
        .args([
            "--user",
            "show",
            &daemon.unit,
            "--property=ControlGroup",
            "--value",
        ])
        .output()
        .expect("systemctl show must be invokable for delegated cgroup proof");
    assert!(
        control_group.status.success(),
        "could not inspect private unit cgroup: {}",
        String::from_utf8_lossy(&control_group.stderr),
    );
    let control_group = String::from_utf8(control_group.stdout).unwrap();
    let delegated_root =
        PathBuf::from("/sys/fs/cgroup").join(control_group.trim().trim_start_matches('/'));
    assert!(
        delegated_root.starts_with("/sys/fs/cgroup") && delegated_root.join("_daemon").is_dir(),
        "private daemon did not activate inside a delegated cgroup: {}",
        delegated_root.display(),
    );
    for (file, expected) in [
        ("cgroup.controllers", ["cpu", "memory"]),
        ("cgroup.subtree_control", ["cpu", "memory"]),
    ] {
        let body = fs::read_to_string(delegated_root.join(file)).unwrap();
        for controller in expected {
            assert!(
                body.split_whitespace().any(|token| token == controller),
                "{file} missing {controller}: {body:?}",
            );
        }
    }
    RunningDaemon {
        _handle: TestDaemon::PrivateSystemd(daemon),
        delegated_root: Some(delegated_root),
    }
}

fn send_control(socket: &Path, message: ControlMsg) {
    let mut stream = UnixStream::connect(socket).unwrap();
    stream.write_all(&proto::encode(&Frame::Control(message))).unwrap();
    stream.flush().unwrap();
}

#[cfg(target_os = "linux")]
fn record_run_states_until_fallback(socket: &Path) -> std::thread::JoinHandle<Vec<String>> {
    let listener = std::os::unix::net::UnixListener::bind(socket).unwrap();
    std::thread::spawn(move || {
        let mut states = Vec::new();
        loop {
            let (mut stream, _) = listener.accept().unwrap();
            let mut decoder = Decoder::new();
            let mut buf = [0u8; 4096];
            let (name, state, seq) = loop {
                if let Some(Frame::Control(ControlMsg::ReportRunState {
                    name,
                    state,
                    seq,
                })) = decoder.next_frame().unwrap()
                {
                    break (name, state, seq);
                }
                let read = stream.read(&mut buf).unwrap();
                assert!(read > 0, "reporter closed before sending a run-state frame");
                decoder.feed(&buf[..read]);
            };
            stream
                .write_all(&proto::encode(&Frame::Control(ControlMsg::RunStateAck {
                    name,
                    seq,
                })))
                .unwrap();
            let terminal = state == "shell-fallback";
            states.push(state);
            if terminal {
                return states;
            }
        }
    })
}

#[cfg(target_os = "linux")]
fn run_slotted_agent(root: &Path, agent_path: &Path) -> (std::process::Output, Vec<String>) {
    let store = StateStore::new(root);
    let mut config = store.load_config().unwrap();
    config.claude_path = Some(agent_path.to_path_buf());
    store.save_config(&config).unwrap();

    let fallback = root.join("fallback-shell");
    fs::write(&fallback, "#!/bin/sh\nexit 0\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&fallback, fs::Permissions::from_mode(0o755)).unwrap();

    let socket = root.join("report.sock");
    let recorder = record_run_states_until_fallback(&socket);
    let output = Command::new(env!("CARGO_BIN_EXE_amber"))
        .args(["run", "work", "--kind", "claude", "--slot", "7"])
        .current_dir(root)
        .env("AMBER_STATE_DIR", root)
        .env("AMBER_SOCK", &socket)
        .env("HOME", root)
        .env("SHELL", &fallback)
        .output()
        .unwrap();
    (output, recorder.join().unwrap())
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

#[cfg(target_os = "linux")]
fn wait_for_cgroup_populated(path: &Path, expected: bool, label: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while workload_populated(path) != Some(expected) {
        assert!(
            Instant::now() < deadline,
            "{label} cgroup did not reach populated={expected}: {}",
            path.display(),
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(target_os = "linux")]
fn wait_for_control_value(path: &Path, expected: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if fs::read_to_string(path)
            .map(|value| value.trim() == expected)
            .unwrap_or(false)
        {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "control file {} did not become {expected:?}",
            path.display(),
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(target_os = "linux")]
fn assert_cgroup_has_pids(path: &Path, expected_suffix: &str) {
    let pids: Vec<i32> = fs::read_to_string(path.join("cgroup.procs"))
        .unwrap()
        .lines()
        .filter_map(|line| line.trim().parse().ok())
        .collect();
    assert!(!pids.is_empty(), "{} had no placed pids", path.display());
    for pid in pids {
        let proc_cgroup = fs::read_to_string(format!("/proc/{pid}/cgroup")).unwrap();
        assert!(
            proc_cgroup.contains(expected_suffix),
            "pid {pid} was not in {expected_suffix}: {proc_cgroup}",
        );
    }
}

#[cfg(target_os = "linux")]
fn write_sleeping_fake_claude(root: &Path) -> PathBuf {
    let bin = root.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let claude_path = bin.join("claude");
    fs::write(
        &claude_path,
        "#!/bin/sh\necho \"$@\" >> \"$AMBER_STATE_DIR/claude_argv.log\"\nsleep 30\n",
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&claude_path, fs::Permissions::from_mode(0o755)).unwrap();
    claude_path
}

#[cfg(target_os = "linux")]
#[test]
fn delegated_daemon_inspection_failure_cleans_exact_private_unit_and_root() {
    let _exec_guard = exec_guard();
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().join("private-state");
    fs::create_dir(&root).unwrap();
    mark_private_test_root(&root);
    let socket = root.join("amberd.sock");
    let sibling = fixture.path().join("must-survive");
    fs::write(&sibling, "sentinel").unwrap();

    let fake_bin = fixture.path().join("fake-bin");
    fs::create_dir(&fake_bin).unwrap();
    let calls = fixture.path().join("systemctl.calls");
    let daemon_pid = fixture.path().join("daemon.pid");
    let systemd_run = fake_bin.join("systemd-run");
    fs::write(
        &systemd_run,
        format!(
            r#"#!/bin/sh
/usr/bin/python3 -c 'import socket,time; s=socket.socket(socket.AF_UNIX); s.bind({socket:?}); s.listen(); time.sleep(60)' </dev/null >/dev/null 2>&1 &
printf '%s\n' "$!" > {daemon_pid}
exit 0
"#,
            socket = socket.to_string_lossy(),
            daemon_pid = daemon_pid.display(),
        ),
    )
    .unwrap();
    let systemctl = fake_bin.join("systemctl");
    fs::write(
        &systemctl,
        format!(
            r#"#!/bin/sh
printf '%s\n' "$*" >> {calls}
if [ "$2" = "show" ]; then
  exit 23
fi
if [ "$2" = "stop" ] && [ -f {daemon_pid} ]; then
  kill "$(/bin/cat {daemon_pid})" 2>/dev/null || true
fi
exit 0
"#,
            calls = calls.display(),
            daemon_pid = daemon_pid.display(),
        ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    for executable in [&systemd_run, &systemctl] {
        fs::set_permissions(executable, fs::Permissions::from_mode(0o755)).unwrap();
    }

    let inspection = std::panic::catch_unwind(|| {
        start_required_delegated_daemon_with_programs(
            &root,
            &socket,
            systemd_run.as_os_str(),
            systemctl.as_os_str(),
        );
    });

    let actual_calls = fs::read_to_string(&calls).unwrap_or_default();
    let root_was_removed = !root.exists();
    let sibling_survived = sibling.exists();

    // Keep the RED phase hermetic even before the cleanup guard exists.
    if let Ok(pid) = fs::read_to_string(&daemon_pid).and_then(|pid| {
        pid.trim()
            .parse::<u32>()
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
    }) {
        let _ = Command::new("kill").arg(pid.to_string()).status();
    }
    let _ = fs::remove_dir_all(&root);

    assert!(inspection.is_err(), "the fake cgroup inspection must fail");
    let call_lines = actual_calls.lines().collect::<Vec<_>>();
    let unit = call_lines
        .first()
        .and_then(|line| line.split_whitespace().nth(2))
        .expect("systemctl show must name the generated private unit");
    assert!(
        unit.starts_with(&format!("amber-task6-cgroup-{}-", std::process::id()))
            && unit.ends_with(".service"),
        "unexpected private unit name: {unit}",
    );
    assert_eq!(
        call_lines,
        [
            format!("--user show {unit} --property=ControlGroup --value"),
            format!("--user stop {unit}"),
            format!("--user reset-failed {unit}"),
        ],
        "inspection failure must clean only the exact generated unit",
    );
    assert!(root_was_removed, "inspection failure leaked the private state root");
    assert!(sibling_survived, "cleanup escaped the exact private state root");
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
            &ClaudeMeta { session_file: None, agent_kind: None,
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

#[cfg(target_os = "linux")]
#[test]
fn slotted_inner_exec_failure_never_reports_a_running_agent() {
    let _exec_guard = exec_guard();
    let dir = tempfile::tempdir().unwrap();
    let unexecutable = dir.path().join("agent-is-a-directory");
    fs::create_dir(&unexecutable).unwrap();

    let (output, states) = run_slotted_agent(dir.path(), &unexecutable);

    assert!(
        output.status.success(),
        "fallback shell failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        states,
        ["claude-retrying", "claude-retrying", "shell-fallback"],
        "the wrapper starting is not proof that the real agent reached exec"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn successful_slotted_inner_exec_reports_a_running_agent() {
    let _exec_guard = exec_guard();
    let dir = tempfile::tempdir().unwrap();
    let agent = write_fake_claude(dir.path(), 0);

    let (output, states) = run_slotted_agent(dir.path(), &agent);

    assert!(
        output.status.success(),
        "fallback shell failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(states, ["claude", "shell-fallback"]);
}

#[cfg(target_os = "linux")]
#[test]
fn ambient_exec_status_env_cannot_hijack_a_generic_cgroup_launcher() {
    let output = Command::new(env!("CARGO_BIN_EXE_amber"))
        .args([
            "__cgroup-exec",
            "--slot",
            "7",
            "--role",
            "workload",
            "--",
            "/bin/sh",
            "-c",
            "printf ambient-safe",
        ])
        .env("AMBER_CGROUP_EXEC_STATUS_FD", "1")
        .output()
        .unwrap();

    assert!(output.status.success());
    assert_eq!(output.stdout, b"ambient-safe");
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
            &ClaudeMeta { session_file: None, agent_kind: None, session_id: "sid-frozen".to_string(), cwd: root.clone(), updated: 1 },
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
            &ClaudeMeta { session_file: None, agent_kind: None,
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

#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires user systemd with delegated cgroup controllers; run explicitly for private Linux proof"]
fn isolated_delegated_cgroup_places_workloads_and_weights_sessions() {
    let _exec_guard = exec_guard();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    mark_private_test_root(&root);
    let socket = root.join("amberd.sock");
    assert_private_root_socket(&root, &socket);

    let claude_path = write_sleeping_fake_claude(&root);
    let store = StateStore::new(&root);
    let mut config = store.load_config().unwrap();
    config.claude_path = Some(claude_path);
    store.save_config(&config).unwrap();

    let daemon = start_required_delegated_daemon(&root, &socket);
    let service_root = daemon
        .delegated_root
        .as_ref()
        .expect("required delegated daemon must expose its cgroup root")
        .clone();
    eprintln!(
        "private cgroup proof: root={} socket={} cgroup={}",
        root.display(),
        socket.display(),
        service_root.display(),
    );

    create_private_session(&root, &socket, "foreground");
    create_private_session(&root, &socket, "background");
    wait_for_session(&socket, "foreground", |info| {
        info.run_state.as_deref() == Some("claude")
    });
    wait_for_session(&socket, "background", |info| {
        info.run_state.as_deref() == Some("claude")
    });

    send_control(&socket, ControlMsg::Focus { name: "foreground".into() });
    let foreground_slot = store.read_session("foreground").unwrap().unwrap().slot;
    let background_slot = store.read_session("background").unwrap().unwrap().slot;
    let foreground = service_root.join(format!("session-{foreground_slot}"));
    let background = service_root.join(format!("session-{background_slot}"));
    eprintln!(
        "private cgroup proof: foreground-slot={foreground_slot} background-slot={background_slot}",
    );

    for (label, slot, session) in [
        ("foreground", foreground_slot, foreground.as_path()),
        ("background", background_slot, background.as_path()),
    ] {
        wait_for_cgroup_populated(&session.join("supervisor"), true, label);
        wait_for_cgroup_populated(&session.join("workload"), true, label);
        assert_cgroup_has_pids(
            &session.join("supervisor"),
            &format!("session-{slot}/supervisor"),
        );
        assert_cgroup_has_pids(
            &session.join("workload"),
            &format!("session-{slot}/workload"),
        );
    }

    wait_for_control_value(&service_root.join("_daemon/cpu.weight"), "10000");
    wait_for_control_value(&foreground.join("cpu.weight"), "1000");
    wait_for_control_value(&background.join("cpu.weight"), "100");
    eprintln!(
        "private cgroup proof: weights daemon=10000 foreground=1000 background=100",
    );

    send_control(&socket, ControlMsg::Kill { name: "foreground".into() });
    send_control(&socket, ControlMsg::Kill { name: "background".into() });
    let deadline = Instant::now() + Duration::from_secs(5);
    while !detailed_sessions(&socket).is_empty() {
        assert!(Instant::now() < deadline, "private sessions were not removed");
        std::thread::sleep(Duration::from_millis(20));
    }
    drop(daemon);
    let deadline = Instant::now() + Duration::from_secs(5);
    while service_root.exists() {
        assert!(Instant::now() < deadline, "private cgroup was not removed");
        std::thread::sleep(Duration::from_millis(20));
    }
    eprintln!("private cgroup proof: cleanup removed {}", service_root.display());
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
            &ClaudeMeta { session_file: None, agent_kind: None,
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
