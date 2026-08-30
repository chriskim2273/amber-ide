use amber::supervisor::{supervise_agent, Agent, SuperviseOutcome, SuspendControl};
use amber_core::state::{ClaudeMeta, StateStore};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[cfg(unix)]
fn write_fake_codex(dir: &Path, session_id: &str) -> PathBuf {
    let bin = dir.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let path = bin.join("codex");
    let payload = serde_json::json!({
        "session_id": session_id,
        "cwd": dir,
        "hook_event_name": "SessionStart"
    })
    .to_string();
    let amber = env!("CARGO_BIN_EXE_amber");
    let script = format!(
        r#"#!/bin/sh
printf '%s\n' "$*" >> "$AMBER_STATE_DIR/codex_argv.log"
if [ ! -e "$AMBER_STATE_DIR/codex_crashed_once" ]; then
    : > "$AMBER_STATE_DIR/codex_crashed_once"
    printf '%s' '{payload}' | "{amber}" hook
    exit 1
fi
exit 0
"#
    );
    fs::write(&path, script).unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    path
}

#[cfg(windows)]
fn write_fake_codex(dir: &Path, session_id: &str) -> PathBuf {
    let bin = dir.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let source_path = bin.join("fake_codex.rs");
    let executable_path = bin.join("codex.exe");
    let payload = serde_json::json!({
        "session_id": session_id,
        "cwd": dir,
        "hook_event_name": "SessionStart"
    })
    .to_string();
    let source = r#"
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

const AMBER: &str = __AMBER__;
const PAYLOAD: &str = __PAYLOAD__;

fn main() {
    let root = PathBuf::from(std::env::var_os("AMBER_STATE_DIR").unwrap());
    let mut log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("codex_argv.log"))
        .unwrap();
    let args = std::env::args_os()
        .skip(1)
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(" ");
    writeln!(log, "{}", args).unwrap();

    let crash_marker = root.join("codex_crashed_once");
    if !crash_marker.exists() {
        File::create(crash_marker).unwrap();
        let mut hook = Command::new(AMBER)
            .arg("hook")
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        hook.stdin.as_mut().unwrap().write_all(PAYLOAD.as_bytes()).unwrap();
        assert!(hook.wait().unwrap().success());
        std::process::exit(1);
    }
}
"#
    .replace("__AMBER__", &format!("{:?}", env!("CARGO_BIN_EXE_amber")))
    .replace("__PAYLOAD__", &format!("{payload:?}"));
    fs::write(&source_path, source).unwrap();
    let rustc = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
    let output = std::process::Command::new(rustc)
        .args(["--edition=2021"])
        .arg(&source_path)
        .arg("-o")
        .arg(&executable_path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "fake Codex compile failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    executable_path
}

#[test]
fn crash_resumes_the_id_recorded_by_codex_session_start() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let codex = write_fake_codex(root, "codex-named-session");
    let phases = Mutex::new(Vec::<String>::new());
    let report = |phase: &str| phases.lock().unwrap().push(phase.to_string());

    let outcome = supervise_agent(
        &Agent::Codex,
        &codex,
        root,
        "work",
        root,
        3,
        report,
        &SuspendControl::new(),
        None,
    )
    .unwrap();

    assert!(matches!(outcome, SuperviseOutcome::CleanExit));
    assert_eq!(
        *phases.lock().unwrap(),
        vec!["claude", "claude-retrying", "claude"]
    );

    let lines: Vec<String> = fs::read_to_string(root.join("codex_argv.log"))
        .unwrap()
        .lines()
        .map(str::to_string)
        .collect();
    assert_eq!(
        lines,
        vec![
            "--dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust",
            "resume --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust -- codex-named-session",
        ]
    );
    assert!(!lines.iter().any(|line| line.contains("--last")));

    let recorded = StateStore::new(root).read_claude("work").unwrap().unwrap();
    assert_eq!(recorded.session_id, "codex-named-session");
    assert_eq!(recorded.cwd, root);
}

#[test]
fn active_pre_recorded_session_is_resumed_again_after_crash() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let codex = write_fake_codex(root, "--last");
    StateStore::new(root)
        .write_claude(
            "work",
            &ClaudeMeta {
                session_id: "--last".into(),
                cwd: root.into(),
                updated: 0,
            },
        )
        .unwrap();

    let outcome = supervise_agent(
        &Agent::Codex,
        &codex,
        root,
        "work",
        root,
        3,
        |_| {},
        &SuspendControl::new(),
        None,
    )
    .unwrap();

    assert_eq!(outcome, SuperviseOutcome::CleanExit);
    let lines: Vec<_> = fs::read_to_string(root.join("codex_argv.log"))
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect();
    assert_eq!(
        lines,
        [
            "resume --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust -- --last",
            "resume --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust -- --last",
        ]
    );
}
