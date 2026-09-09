//! A second `amber daemon` racing an existing one must lose the socket BEFORE
//! it restores anything.
//!
//! The daemon used to call `manager.restore()` before it bound its socket, so a
//! duplicate process spawned during that window ran a FULL restore first —
//! spawning a second pty, `amber run` supervisor and agent child for every
//! persisted session — and only then discovered the socket was taken and
//! exited. Two supervisors then shared one session's recording file, which is
//! how a Pi pane loses its recording and comes back as a bare shell.
//!
//! Binding first makes the loser exit immediately, touching no session state.

use amber::manager::SessionManager;
use amber_core::state::{SessionKind, StateStore};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn wait_for_socket(socket: &Path, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if std::os::unix::net::UnixStream::connect(socket).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

fn restore_events(store: &StateStore) -> usize {
    store
        .list_recovery_events(500)
        .unwrap()
        .iter()
        .filter(|event| event.event == "daemon.restore")
        .count()
}

#[cfg(unix)]
#[test]
fn a_losing_duplicate_daemon_never_restores_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("state");
    std::fs::create_dir_all(&root).unwrap();
    // A short path: a unix socket address is capped near 108 bytes.
    let sockdir = tempfile::tempdir_in("/tmp").unwrap();
    let socket = sockdir.path().join("d.sock");

    // Persist one session so a restore has real work to do.
    {
        let mgr = SessionManager::new(&root).unwrap();
        mgr.create("work", "/tmp", SessionKind::Shell).unwrap();
        mgr.snapshot().unwrap();
    }

    let mut winner = Command::new(env!("CARGO_BIN_EXE_amber"))
        .args(["daemon", "--root"])
        .arg(&root)
        .arg("--socket")
        .arg(&socket)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env_remove("HOME")
        .spawn()
        .unwrap();
    assert!(wait_for_socket(&socket, Duration::from_secs(10)), "daemon did not bind");

    let store = StateStore::new(&root);
    let before = restore_events(&store);

    // The duplicate must refuse the live socket and exit without restoring.
    let loser = Command::new(env!("CARGO_BIN_EXE_amber"))
        .args(["daemon", "--root"])
        .arg(&root)
        .arg("--socket")
        .arg(&socket)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .env_remove("HOME")
        .output()
        .unwrap();

    assert!(!loser.status.success(), "the duplicate daemon must fail, not serve");
    let stderr = String::from_utf8_lossy(&loser.stderr);
    assert!(
        stderr.contains("already listening"),
        "the duplicate must lose on the socket guard, got: {stderr}"
    );

    let after = restore_events(&store);
    assert_eq!(
        after, before,
        "a duplicate daemon restored sessions before losing the socket \
         (recovery journal gained {} daemon.restore event(s))",
        after - before
    );

    let _ = winner.kill();
    let _ = winner.wait();
}
