//! Pi supervision integration test: the agent child is spawned with an env
//! that tells Pi its session is remote (`SSH_CONNECTION`), so its clipboard
//! copy falls back to OSC 52 — the transport amber relays to any client
//! (desktop, `amber web`, the web build). This is Pi's only lever: it reads
//! SSH_CONNECTION/SSH_CLIENT/MOSH_CONNECTION in exactly one place,
//! `copyToClipboard`, and only when `remote || !copied`.

use amber::supervisor::{supervise_agent, Agent, SuperviseOutcome, SuspendControl};
use amber_core::state::{ClaudeMeta, StateStore};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[cfg(unix)]
fn write_fake_pi(dir: &Path, _session_id: &str) -> PathBuf {
    let bin = dir.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let path = bin.join("pi");
    let script = r#"#!/bin/sh
printf '%s\n' "argv=$*" >> "$AMBER_STATE_DIR/pi_argv.log"
printf '%s\n' "ssh_connection=${SSH_CONNECTION:-UNSET}" >> "$AMBER_STATE_DIR/pi_env.log"
printf '%s\n' "amber_session=$AMBER_SESSION" >> "$AMBER_STATE_DIR/pi_env.log"
exit 0
"#.to_string();
    fs::write(&path, script).unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    path
}

#[cfg(windows)]
fn write_fake_pi(dir: &Path, session_id: &str) -> PathBuf {
    // Windows path is exercised by the shim-handling tests elsewhere; this
    // supervision env assertion is Linux/macOS-only in nature (SSH_* vars).
    let _ = (dir, session_id);
    unimplemented!("pi_supervise SSH_CONNECTION assertion is unix-only")
}

#[cfg(unix)]
#[test]
fn pi_agent_child_is_told_its_session_is_remote() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let pi = write_fake_pi(root, "pi-session-abc");
    let phases = Mutex::new(Vec::<String>::new());
    let report = |phase: &str| phases.lock().unwrap().push(phase.to_string());

    let outcome = supervise_agent(
        &Agent::Pi,
        &pi,
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

    let env = fs::read_to_string(root.join("pi_env.log")).unwrap();
    // The whole point of the lever: Pi must see a truthy SSH_CONNECTION so its
    // copy falls through to OSC 52. A bogus/fake value is fine — isRemoteSession
    // only tests presence.
    assert!(
        env.contains("ssh_connection=amber-daemon"),
        "expected SSH_CONNECTION=amber-daemon for the Pi agent child, got:\n{env}"
    );
    assert!(env.contains("amber_session=work"), "got:\n{env}");
}

#[cfg(unix)]
#[test]
fn pi_does_not_inherit_remote_env_when_it_prints_a_fresh_start() {
    // A fresh Pi session (no recorded id) spawns with no `--session` arg, but
    // still carries the remote signal: the OSC 52 lever is about the *client*
    // topology (a pane may be viewed over the socket), not whether the
    // conversation is resumed.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let pi = write_fake_pi(root, "pi-session-abc");
    StateStore::new(root).write_claude(
        "work",
        &ClaudeMeta {
            session_id: "pi-session-abc".into(),
            cwd: root.into(),
            updated: 0,
        },
    )
    .unwrap();

    let outcome = supervise_agent(
        &Agent::Pi,
        &pi,
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
    let argv = fs::read_to_string(root.join("pi_argv.log")).unwrap();
    assert!(argv.contains("--session pi-session-abc"), "got:\n{argv}");
    let env = fs::read_to_string(root.join("pi_env.log")).unwrap();
    assert!(env.contains("ssh_connection=amber-daemon"), "got:\n{env}");
}
