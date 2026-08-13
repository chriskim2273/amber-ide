use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const ID: &str = "91b9f942-914d-4ea0-8c29-cef2c8b3b984";

fn executable(path: &Path, body: &str) {
    fs::write(path, body).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

fn fixtures(dir: &Path) -> (PathBuf, PathBuf, PathBuf) {
    let shell = dir.join("login-shell");
    let claude = dir.join("claude");
    let args = dir.join("args.bin");
    executable(&shell, "#!/bin/sh\nprintf '%s\\n' \"$FAKE_CLAUDE\"\n");
    executable(
        &claude,
        r##"#!/bin/sh
printf '%s\0' "$@" > "$FAKE_ARGS"
case "${FAKE_MODE:-ok}" in
  ok)        printf '%s' '{"result":"# Handoff\n\nContinue task."}' ;;
  malformed) printf '%s' '{' ;;
  fail)      printf '%s' 'do-not-forward-this-secret' >&2; exit 7 ;;
esac
"##,
    );
    (shell, claude, args)
}

fn run(shell: &Path, claude: &Path, args: &Path, mode: &str, id: &str) -> Output {
    Command::new(env!("CARGO_BIN_EXE_amber"))
        .args(["handoff", id])
        .env("SHELL", shell)
        .env("FAKE_CLAUDE", claude)
        .env("FAKE_ARGS", args)
        .env("FAKE_MODE", mode)
        .output()
        .unwrap()
}

#[test]
fn handoff_prints_only_the_result_and_passes_safe_exact_argv() {
    let dir = tempfile::tempdir().unwrap();
    let (shell, claude, args) = fixtures(dir.path());
    let out = run(&shell, &claude, &args, "ok", ID);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(out.stdout, b"# Handoff\n\nContinue task.\n");

    let raw = fs::read(args).unwrap();
    let actual: Vec<&str> = raw
        .strip_suffix(&[0])
        .unwrap()
        .split(|byte| *byte == 0)
        .map(|arg| std::str::from_utf8(arg).unwrap())
        .collect();
    assert_eq!(actual, amber::claude::handoff_argv(ID).unwrap());
}

#[test]
fn handoff_rejects_bad_ids_before_launching_claude() {
    let dir = tempfile::tempdir().unwrap();
    let (shell, claude, args) = fixtures(dir.path());
    let out = run(&shell, &claude, &args, "ok", "../escape");
    assert!(!out.status.success());
    assert!(!args.exists(), "Claude must not run for an invalid id");
    assert!(String::from_utf8_lossy(&out.stderr).contains("valid Claude session UUID"));
}

#[test]
fn handoff_hides_malformed_and_failed_claude_output() {
    let dir = tempfile::tempdir().unwrap();
    let (shell, claude, args) = fixtures(dir.path());
    for mode in ["malformed", "fail"] {
        let out = run(&shell, &claude, &args, mode, ID);
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(!out.status.success(), "{mode} unexpectedly succeeded");
        assert!(out.stdout.is_empty());
        assert!(!stderr.contains("do-not-forward-this-secret"));
    }
}
