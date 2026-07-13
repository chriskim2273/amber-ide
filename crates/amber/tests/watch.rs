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
