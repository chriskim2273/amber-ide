#![cfg(unix)]
//! A claude session's supervisor reports its phase via `ReportRunState`: the
//! daemon stores it (surfacing in `ListSessionsDetailed`), broadcasts the
//! change to watchers, and rejects reports for a non-claude session.
//!
//! Fake-stub style (mirrors `watch.rs`): the report is sent manually over a
//! client connection — the real supervisor child is bogus in-test — and no reap
//! thread runs, so a session with a dead stub child stays in the table (session
//! lookups key off table presence, not liveness).

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::time::Duration;

use amber::daemon::{prepare_socket, Daemon};
use amber::manager::SessionManager;
use amber::watchers::Watchers;
use amber_core::proto::{self, ControlMsg, Decoder, Frame};
use amber_core::state::SessionKind;

fn send(stream: &UnixStream, msg: ControlMsg) {
    let mut w = stream;
    w.write_all(&proto::encode(&Frame::Control(msg))).unwrap();
    w.flush().unwrap();
}

fn read_control_until<F: Fn(&ControlMsg) -> bool>(stream: &mut UnixStream, pred: F) -> ControlMsg {
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut dec = Decoder::new();
    let mut buf = [0u8; 8192];
    loop {
        while let Some(Frame::Control(msg)) = dec.next_frame().unwrap() {
            if pred(&msg) {
                return msg;
            }
        }
        let n = stream.read(&mut buf).expect("timed out waiting for control frame");
        assert!(n > 0, "connection closed unexpectedly");
        dec.feed(&buf[..n]);
    }
}

#[test]
fn report_run_state_stores_broadcasts_and_validates() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("amberd.sock");
    let manager = Arc::new(SessionManager::new(dir.path()).unwrap());
    // Create the sessions directly on the manager (a claude one and a shell
    // one) so the test doesn't depend on the bogus spawned supervisor child.
    manager
        .create("amber-1-1-0-c", dir.path(), SessionKind::Claude)
        .unwrap();
    manager
        .create("amber-1-1-1-s", dir.path(), SessionKind::Shell)
        .unwrap();

    let watchers = Arc::new(Watchers::new());
    let listener = prepare_socket(&sock).unwrap();
    let daemon = Daemon::new(Arc::clone(&manager), Arc::clone(&watchers));
    std::thread::spawn(move || {
        let _ = daemon.serve(listener);
    });

    // A watcher connection to observe the broadcast.
    let watcher = UnixStream::connect(&sock).unwrap();
    let mut w = watcher.try_clone().unwrap();
    send(&watcher, ControlMsg::WatchSessions);
    read_control_until(&mut w, |m| matches!(m, ControlMsg::Sessions { .. }));

    // The supervisor reports "claude-retrying" over its own connection.
    let reporter = UnixStream::connect(&sock).unwrap();
    send(
        &reporter,
        ControlMsg::ReportRunState {
            name: "amber-1-1-0-c".into(),
            state: "claude-retrying".into(),
        },
    );

    // The watcher receives the upserted SessionInfo carrying the run_state.
    let delta = read_control_until(&mut w, |m| {
        matches!(m, ControlMsg::SessionsChanged { added, .. }
            if added.iter().any(|i| i.name == "amber-1-1-0-c"))
    });
    match delta {
        ControlMsg::SessionsChanged { added, .. } => {
            let info = added.iter().find(|i| i.name == "amber-1-1-0-c").unwrap();
            assert_eq!(info.run_state.as_deref(), Some("claude-retrying"));
        }
        other => panic!("expected SessionsChanged, got {other:?}"),
    }

    // ListSessionsDetailed reflects the stored state.
    let query = UnixStream::connect(&sock).unwrap();
    let mut q = query.try_clone().unwrap();
    send(&query, ControlMsg::ListSessionsDetailed);
    let sessions = read_control_until(&mut q, |m| matches!(m, ControlMsg::Sessions { .. }));
    match sessions {
        ControlMsg::Sessions { sessions } => {
            let info = sessions.iter().find(|i| i.name == "amber-1-1-0-c").unwrap();
            assert_eq!(info.run_state.as_deref(), Some("claude-retrying"));
            // The shell session has no run_state.
            let shell = sessions.iter().find(|i| i.name == "amber-1-1-1-s").unwrap();
            assert_eq!(shell.run_state, None);
        }
        other => panic!("expected Sessions, got {other:?}"),
    }

    // Reporting run_state for a shell session is rejected with an Error reply
    // (the real supervisor ignores replies; the test reads it to assert).
    let bad = UnixStream::connect(&sock).unwrap();
    let mut b = bad.try_clone().unwrap();
    send(
        &bad,
        ControlMsg::ReportRunState {
            name: "amber-1-1-1-s".into(),
            state: "claude".into(),
        },
    );
    let err = read_control_until(&mut b, |m| matches!(m, ControlMsg::Error { .. }));
    match err {
        ControlMsg::Error { msg } => assert!(msg.contains("claude"), "unexpected error: {msg}"),
        other => panic!("expected Error, got {other:?}"),
    }
}
