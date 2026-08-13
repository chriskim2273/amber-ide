//! A claude session's supervisor reports its phase via `ReportRunState`: the
//! daemon stores it (surfacing in `ListSessionsDetailed`), broadcasts the
//! change to watchers, and rejects reports for a non-claude session.
//!
//! Fake-stub style (mirrors `watch.rs`): the report is sent manually over a
//! client connection. The agent fixture keeps a real shell PTY alive and
//! rewrites only its persisted kind to Claude, so manager trust checks see the
//! same live-kind shape as a production supervisor without launching one.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::time::Duration;

use amber::daemon::{prepare_socket, Daemon};
use amber::manager::SessionManager;
use amber::watchers::Watchers;
use amber_core::proto::{self, ControlMsg, Decoder, Frame};
use amber_core::state::{SessionKind, StateStore};

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
    // Keep both PTY children alive; a direct agent create from a Rust test would
    // launch the test-harness binary as `amber run`, which exits immediately.
    manager
        .create("amber-1-1-0-c", dir.path(), SessionKind::Shell)
        .unwrap();
    manager
        .create("amber-1-1-1-s", dir.path(), SessionKind::Shell)
        .unwrap();
    let store = StateStore::new(dir.path());
    let mut agent_meta = store.read_session("amber-1-1-0-c").unwrap().unwrap();
    agent_meta.kind = SessionKind::Claude;
    store.write_session(&agent_meta).unwrap();

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
            seq: 0,
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
            seq: 0,
        },
    );
    let err = read_control_until(&mut b, |m| matches!(m, ControlMsg::Error { .. }));
    match err {
        ControlMsg::Error { msg } => assert!(msg.contains("agent"), "unexpected error: {msg}"),
        other => panic!("expected Error, got {other:?}"),
    }
}

#[test]
fn live_resume_flagged_shell_still_rejects_run_state_reports() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("amberd.sock");
    let manager = Arc::new(SessionManager::new(dir.path()).unwrap());
    manager.create("flagged-shell", dir.path(), SessionKind::Shell).unwrap();
    let store = StateStore::new(dir.path());
    let mut meta = store.read_session("flagged-shell").unwrap().unwrap();
    meta.resume_as_claude = true;
    store.write_session(&meta).unwrap();

    let listener = prepare_socket(&sock).unwrap();
    let daemon = Daemon::new(Arc::clone(&manager), Arc::new(Watchers::new()));
    std::thread::spawn(move || {
        let _ = daemon.serve(listener);
    });

    let reporter = UnixStream::connect(&sock).unwrap();
    let mut replies = reporter.try_clone().unwrap();
    send(
        &reporter,
        ControlMsg::ReportRunState {
            name: "flagged-shell".into(),
            state: "claude".into(),
            seq: 0,
        },
    );
    let error = read_control_until(&mut replies, |msg| matches!(msg, ControlMsg::Error { .. }));
    assert!(matches!(error, ControlMsg::Error { msg } if msg.contains("agent")));
    assert_eq!(manager.session_infos().unwrap()[0].kind, "shell");
}

#[test]
fn stale_reordered_report_cannot_overwrite_terminal_fallback() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("amberd.sock");
    let manager = Arc::new(SessionManager::new(dir.path()).unwrap());
    manager.create("agent", dir.path(), SessionKind::Shell).unwrap();
    let store = StateStore::new(dir.path());
    let mut meta = store.read_session("agent").unwrap().unwrap();
    meta.kind = SessionKind::Claude;
    store.write_session(&meta).unwrap();

    let listener = prepare_socket(&sock).unwrap();
    let daemon = Daemon::new(Arc::clone(&manager), Arc::new(Watchers::new()));
    std::thread::spawn(move || {
        let _ = daemon.serve(listener);
    });

    let reporter = UnixStream::connect(&sock).unwrap();
    let mut replies = reporter.try_clone().unwrap();
    send(
        &reporter,
        ControlMsg::ReportRunState {
            name: "agent".into(),
            state: "shell-fallback".into(),
            seq: 2,
        },
    );
    assert_eq!(
        read_control_until(&mut replies, |m| matches!(m, ControlMsg::RunStateAck { seq: 2, .. })),
        ControlMsg::RunStateAck { name: "agent".into(), seq: 2 }
    );

    // Delayed delivery from an earlier connection arrives after the terminal
    // report. It is acknowledged (so a retry loop can stop) but not applied.
    send(
        &reporter,
        ControlMsg::ReportRunState {
            name: "agent".into(),
            state: "claude".into(),
            seq: 1,
        },
    );
    read_control_until(&mut replies, |m| matches!(m, ControlMsg::RunStateAck { seq: 1, .. }));
    assert_eq!(manager.session_infos().unwrap()[0].run_state.as_deref(), Some("shell-fallback"));
}
