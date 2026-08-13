//! A watcher connection sees session create/kill deltas; a non-watcher does not.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::time::Duration;

use amber::daemon::{prepare_socket, Daemon};
use amber::manager::SessionManager;
use amber::watchers::Watchers;
use amber_core::proto::{self, ControlMsg, Decoder, Frame};

fn send(stream: &UnixStream, msg: ControlMsg) {
    let mut w = stream;
    w.write_all(&proto::encode(&Frame::Control(msg))).unwrap();
    w.flush().unwrap();
}

fn send_raw_control(stream: &UnixStream, json: &str) {
    let mut body = vec![0];
    body.extend_from_slice(json.as_bytes());
    let mut wire = Vec::with_capacity(4 + body.len());
    wire.extend_from_slice(&(body.len() as u32).to_be_bytes());
    wire.extend_from_slice(&body);
    let mut w = stream;
    w.write_all(&wire).unwrap();
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
fn watcher_sees_create_and_kill_deltas() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("amberd.sock");
    let manager = Arc::new(SessionManager::new(dir.path()).unwrap());
    let watchers = Arc::new(Watchers::new());
    let listener = prepare_socket(&sock).unwrap();
    let daemon = Daemon::new(Arc::clone(&manager), Arc::clone(&watchers));
    std::thread::spawn(move || {
        let _ = daemon.serve(listener);
    });

    let watcher = UnixStream::connect(&sock).unwrap();
    let bystander = UnixStream::connect(&sock).unwrap();

    let mut w = watcher.try_clone().unwrap();
    send(&watcher, ControlMsg::WatchSessions);
    // WatchSessions replies with the (empty) full set first.
    read_control_until(&mut w, |m| matches!(m, ControlMsg::Sessions { .. }));

    // Create a shell session over the bystander connection.
    send(
        &bystander,
        ControlMsg::Create {
            name: "amber-1-1-0-a".into(),
            cwd: dir.path().to_string_lossy().into_owned(),
            kind: "shell".into(),
        },
    );

    let delta = read_control_until(&mut w, |m| matches!(m, ControlMsg::SessionsChanged { .. }));
    match delta {
        ControlMsg::SessionsChanged { added, removed } => {
            assert_eq!(added.len(), 1);
            assert_eq!(added[0].name, "amber-1-1-0-a");
            assert_eq!(added[0].kind, "shell");
            assert!(removed.is_empty());
        }
        other => panic!("expected SessionsChanged, got {other:?}"),
    }

    // Kill it; watcher sees a removal delta.
    send(&bystander, ControlMsg::Kill { name: "amber-1-1-0-a".into() });
    let delta = read_control_until(&mut w, |m| {
        matches!(m, ControlMsg::SessionsChanged { removed, .. } if !removed.is_empty())
    });
    match delta {
        ControlMsg::SessionsChanged { removed, .. } => {
            assert_eq!(removed, vec!["amber-1-1-0-a".to_string()]);
        }
        other => panic!("expected removal, got {other:?}"),
    }
}

#[test]
fn watcher_snapshot_arrives_before_later_deltas() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("amberd.sock");
    let manager = Arc::new(SessionManager::new(dir.path()).unwrap());
    let watchers = Arc::new(Watchers::new());
    let listener = prepare_socket(&sock).unwrap();
    let daemon = Daemon::new(Arc::clone(&manager), Arc::clone(&watchers));
    std::thread::spawn(move || {
        let _ = daemon.serve(listener);
    });

    let watcher = UnixStream::connect(&sock).unwrap();
    let mut reader = watcher.try_clone().unwrap();
    send(&watcher, ControlMsg::WatchSessions);
    send(
        &UnixStream::connect(&sock).unwrap(),
        ControlMsg::Create {
            name: "amber-1-1-0-after-watch".into(),
            cwd: dir.path().to_string_lossy().into_owned(),
            kind: "shell".into(),
        },
    );

    let mut decoder = Decoder::new();
    reader.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut buf = [0u8; 8192];
    let first = loop {
        if let Some(frame) = decoder.next_frame().unwrap() {
            break frame;
        }
        let n = reader.read(&mut buf).expect("timed out waiting for initial snapshot");
        assert!(n > 0, "watcher closed before its initial snapshot");
        decoder.feed(&buf[..n]);
    };
    assert!(matches!(first, Frame::Control(ControlMsg::Sessions { .. })));
    let delta = loop {
        if let Some(Frame::Control(msg)) = decoder.next_frame().unwrap() {
            break msg;
        }
        let n = reader.read(&mut buf).expect("timed out waiting for create delta");
        assert!(n > 0, "watcher closed before create delta");
        decoder.feed(&buf[..n]);
    };
    assert!(matches!(
        delta,
        ControlMsg::SessionsChanged { added, .. }
            if added.iter().any(|info| info.name == "amber-1-1-0-after-watch")
    ));
}

#[test]
fn memory_pressure_reaches_only_versioned_opt_in_watchers() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("amberd.sock");
    let manager = Arc::new(SessionManager::new(dir.path()).unwrap());
    let watchers = Arc::new(Watchers::new());
    let listener = prepare_socket(&sock).unwrap();
    let daemon = Daemon::new(Arc::clone(&manager), Arc::clone(&watchers));
    std::thread::spawn(move || {
        let _ = daemon.serve(listener);
    });

    // This connection models an older strict client: it knows WatchSessions
    // but has never advertised support for the newer pressure control.
    let old = UnixStream::connect(&sock).unwrap();
    let mut old_read = old.try_clone().unwrap();
    send(&old, ControlMsg::WatchSessions);
    read_control_until(&mut old_read, |m| matches!(m, ControlMsg::Sessions { .. }));

    // Send the new capability in raw serde shape so this test is RED before
    // the protocol enum learns the variant.
    let current = UnixStream::connect(&sock).unwrap();
    let mut current_read = current.try_clone().unwrap();
    send(&current, ControlMsg::WatchSessions);
    read_control_until(&mut current_read, |m| matches!(m, ControlMsg::Sessions { .. }));
    send_raw_control(&current, r#"{"WatchMemoryPressure":{"version":1}}"#);
    // A reply to the following request proves the daemon processed the
    // capability first (one ordered unix stream) before pressure is emitted.
    send(&current, ControlMsg::ListSessionsDetailed);
    read_control_until(&mut current_read, |m| matches!(m, ControlMsg::Sessions { .. }));

    let pressure = ControlMsg::MemoryPressure {
        level: "critical".into(),
        current_kb: 9_000,
        budget_kb: 8_000,
        blocked: false,
    };
    watchers.broadcast_pressure(&pressure);
    assert_eq!(
        read_control_until(&mut current_read, |m| matches!(m, ControlMsg::MemoryPressure { .. })),
        pressure
    );

    // If pressure leaked to the old connection, it is the next frame and this
    // exact assertion fails. Otherwise the old client remains connected and
    // receives its ordinary Sessions response.
    send(&old, ControlMsg::ListSessionsDetailed);
    old_read.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let mut decoder = Decoder::new();
    let mut buf = [0u8; 8192];
    let first = loop {
        if let Some(frame) = decoder.next_frame().unwrap() {
            break frame;
        }
        let n = old_read.read(&mut buf).expect("old watcher disconnected");
        assert!(n > 0, "old watcher disconnected");
        decoder.feed(&buf[..n]);
    };
    assert!(matches!(first, Frame::Control(ControlMsg::Sessions { .. })), "unexpected old-client frame: {first:?}");
}
