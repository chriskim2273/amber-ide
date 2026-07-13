//! Slice 1 exit test: a raw client round-trips Create -> Attach -> input ->
//! output over the real unix socket, using amber_core::proto directly (no CLI).

use amber::daemon::Daemon;
use amber::manager::SessionManager;
use amber::watchers::Watchers;
use amber_core::proto::{self, ControlMsg, Decoder, Frame};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

/// Spin up a Daemon on a temp socket + temp state root, serving on a
/// background thread. Returns the socket path (temp dirs kept alive via the
/// returned guards).
fn start_daemon() -> (PathBuf, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("state");
    std::fs::create_dir_all(&root).unwrap();
    let socket_path = dir.path().join("amberd.sock");

    let manager = Arc::new(SessionManager::new(&root).unwrap());
    let listener = std::os::unix::net::UnixListener::bind(&socket_path).unwrap();
    let daemon = Daemon::new(manager, std::sync::Arc::new(Watchers::new()));
    thread::spawn(move || {
        let _ = daemon.serve(listener);
    });

    (socket_path, dir)
}

fn connect_with_retry(path: &Path) -> UnixStream {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match UnixStream::connect(path) {
            Ok(s) => return s,
            Err(_) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            Err(e) => panic!("could not connect to daemon socket: {e}"),
        }
    }
}

fn send(stream: &mut UnixStream, frame: &Frame) {
    stream.write_all(&proto::encode(frame)).unwrap();
}

/// Pull frames from `stream` (via `decoder`) until `pred` matches one, or
/// panic after `timeout`.
fn read_frame_until<F: Fn(&Frame) -> bool>(
    stream: &mut UnixStream,
    decoder: &mut Decoder,
    pred: F,
    timeout: Duration,
) -> Frame {
    stream.set_read_timeout(Some(Duration::from_millis(100))).unwrap();
    let deadline = Instant::now() + timeout;
    let mut buf = [0u8; 8192];
    loop {
        while let Some(frame) = decoder.next_frame().unwrap() {
            if pred(&frame) {
                return frame;
            }
        }
        if Instant::now() > deadline {
            panic!("timed out waiting for expected frame");
        }
        match stream.read(&mut buf) {
            Ok(0) => panic!("daemon closed the connection unexpectedly"),
            Ok(n) => decoder.feed(&buf[..n]),
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(e) => panic!("read error: {e}"),
        }
    }
}

#[test]
fn disconnecting_client_releases_its_subscription() {
    // A client that attaches and then drops its connection must not leave a
    // subscriber (and its blocked forwarder) behind on an idle session.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("state");
    std::fs::create_dir_all(&root).unwrap();
    let socket_path = dir.path().join("amberd.sock");

    let manager = Arc::new(SessionManager::new(&root).unwrap());
    let listener = std::os::unix::net::UnixListener::bind(&socket_path).unwrap();
    let daemon = Daemon::new(Arc::clone(&manager), std::sync::Arc::new(Watchers::new()));
    thread::spawn(move || {
        let _ = daemon.serve(listener);
    });

    // `cat` idles forever: no output, so nothing ever prunes a dead sender.
    manager
        .create("idle", "/tmp", amber_core::state::SessionKind::Shell)
        .unwrap();
    let sess = manager.session("idle").unwrap();

    let mut stream = connect_with_retry(&socket_path);
    send(&mut stream, &Frame::Control(ControlMsg::Attach { name: "idle".into() }));

    let deadline = Instant::now() + Duration::from_secs(5);
    while sess.subscriber_count() != 1 {
        assert!(Instant::now() < deadline, "attach never registered a subscriber");
        thread::sleep(Duration::from_millis(20));
    }

    drop(stream); // client goes away with NO further session output

    let deadline = Instant::now() + Duration::from_secs(5);
    while sess.subscriber_count() != 0 {
        assert!(
            Instant::now() < deadline,
            "subscription leaked after client disconnect"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn socket_roundtrip_create_attach_write_read() {
    let (socket_path, _dir) = start_daemon();
    let mut stream = connect_with_retry(&socket_path);
    let mut decoder = Decoder::new();

    send(
        &mut stream,
        &Frame::Control(ControlMsg::Create {
            name: "s".into(),
            cwd: "/tmp".into(),
            kind: "shell".into(),
        }),
    );
    read_frame_until(
        &mut stream,
        &mut decoder,
        |f| matches!(f, Frame::Control(ControlMsg::Created { name }) if name == "s"),
        Duration::from_secs(5),
    );

    send(&mut stream, &Frame::Control(ControlMsg::Attach { name: "s".into() }));
    send(
        &mut stream,
        &Frame::Data {
            session: "s".into(),
            bytes: b"echo SOCKET_RT_OK\n".to_vec(),
        },
    );

    stream.set_read_timeout(Some(Duration::from_millis(100))).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut acc = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        while let Some(frame) = decoder.next_frame().unwrap() {
            if let Frame::Data { bytes, .. } = frame {
                acc.extend_from_slice(&bytes);
            }
        }
        if acc.windows(12).any(|w| w == b"SOCKET_RT_OK") {
            return;
        }
        if Instant::now() > deadline {
            panic!(
                "timed out waiting for SOCKET_RT_OK; got {:?}",
                String::from_utf8_lossy(&acc)
            );
        }
        match stream.read(&mut buf) {
            Ok(0) => panic!("daemon closed the connection unexpectedly"),
            Ok(n) => decoder.feed(&buf[..n]),
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(e) => panic!("read error: {e}"),
        }
    }
}

#[test]
fn snapshot_control_flushes_scrollback_and_acks() {
    let (socket_path, dir) = start_daemon();
    let mut stream = connect_with_retry(&socket_path);
    let mut decoder = Decoder::new();

    send(
        &mut stream,
        &Frame::Control(ControlMsg::Create {
            name: "snap".into(),
            cwd: "/tmp".into(),
            kind: "shell".into(),
        }),
    );
    read_frame_until(
        &mut stream,
        &mut decoder,
        |f| matches!(f, Frame::Control(ControlMsg::Created { .. })),
        Duration::from_secs(5),
    );

    send(&mut stream, &Frame::Control(ControlMsg::Snapshot));
    read_frame_until(
        &mut stream,
        &mut decoder,
        |f| matches!(f, Frame::Control(ControlMsg::SnapshotOk)),
        Duration::from_secs(5),
    );

    // The ack must mean the flush actually happened.
    let scrollback = dir.path().join("state/scrollback/snap.bin");
    assert!(scrollback.exists(), "snapshot did not write {scrollback:?}");
}

#[test]
fn attached_client_receives_exit_when_child_dies() {
    let (socket_path, _dir) = start_daemon();
    let mut stream = connect_with_retry(&socket_path);
    let mut decoder = Decoder::new();

    send(
        &mut stream,
        &Frame::Control(ControlMsg::Create {
            name: "mortal".into(),
            cwd: "/tmp".into(),
            kind: "shell".into(),
        }),
    );
    read_frame_until(
        &mut stream,
        &mut decoder,
        |f| matches!(f, Frame::Control(ControlMsg::Created { .. })),
        Duration::from_secs(5),
    );

    send(&mut stream, &Frame::Control(ControlMsg::Attach { name: "mortal".into() }));
    send(
        &mut stream,
        &Frame::Data { session: "mortal".into(), bytes: b"exit\n".to_vec() },
    );

    read_frame_until(
        &mut stream,
        &mut decoder,
        |f| matches!(f, Frame::Control(ControlMsg::Exit { name, .. }) if name == "mortal"),
        Duration::from_secs(10),
    );
}

#[test]
fn rename_gets_an_explicit_unsupported_error() {
    // Rename is deliberately unimplemented (a live claude session's
    // supervisor is bound to its name); the daemon must say so instead of
    // silently ignoring the request.
    let (socket_path, _dir) = start_daemon();
    let mut stream = connect_with_retry(&socket_path);
    let mut decoder = Decoder::new();

    send(
        &mut stream,
        &Frame::Control(ControlMsg::Rename { from: "a".into(), to: "b".into() }),
    );
    let frame = read_frame_until(
        &mut stream,
        &mut decoder,
        |f| matches!(f, Frame::Control(ControlMsg::Error { .. })),
        Duration::from_secs(5),
    );
    match frame {
        Frame::Control(ControlMsg::Error { msg }) => {
            assert!(msg.contains("rename"), "unexpected error: {msg}");
        }
        _ => unreachable!(),
    }
}

#[test]
fn malformed_frame_kills_only_that_connection_not_the_daemon() {
    let (socket_path, _dir) = start_daemon();

    // Connection A sends garbage: an unknown tag inside a valid length
    // prefix. Its connection is torn down...
    let mut bad = connect_with_retry(&socket_path);
    bad.write_all(&[0, 0, 0, 1, 99]).unwrap(); // len=1, tag=99
    bad.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut buf = [0u8; 64];
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match bad.read(&mut buf) {
            Ok(0) => break, // daemon dropped the bad connection
            Ok(_) => {}
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                assert!(Instant::now() < deadline, "bad connection never dropped");
            }
            Err(_) => break,
        }
    }

    // ...but the daemon keeps serving fresh connections.
    let mut good = connect_with_retry(&socket_path);
    let mut decoder = Decoder::new();
    send(&mut good, &Frame::Control(ControlMsg::ListSessions));
    read_frame_until(
        &mut good,
        &mut decoder,
        |f| matches!(f, Frame::Control(ControlMsg::SessionList { .. })),
        Duration::from_secs(5),
    );
}

#[test]
fn list_sessions_returns_all_created_names() {
    let (socket_path, _dir) = start_daemon();
    let mut stream = connect_with_retry(&socket_path);
    let mut decoder = Decoder::new();

    for name in ["a", "b"] {
        send(
            &mut stream,
            &Frame::Control(ControlMsg::Create {
                name: name.into(),
                cwd: "/tmp".into(),
                kind: "shell".into(),
            }),
        );
        read_frame_until(
            &mut stream,
            &mut decoder,
            |f| matches!(f, Frame::Control(ControlMsg::Created { .. })),
            Duration::from_secs(5),
        );
    }

    send(&mut stream, &Frame::Control(ControlMsg::ListSessions));
    let frame = read_frame_until(
        &mut stream,
        &mut decoder,
        |f| matches!(f, Frame::Control(ControlMsg::SessionList { .. })),
        Duration::from_secs(5),
    );
    match frame {
        Frame::Control(ControlMsg::SessionList { mut names }) => {
            names.sort();
            assert_eq!(names, vec!["a".to_string(), "b".to_string()]);
        }
        _ => unreachable!(),
    }
}
