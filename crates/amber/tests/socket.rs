//! Slice 1 exit test: a raw client round-trips Create -> Attach -> input ->
//! output over the real unix socket, using amber_core::proto directly (no CLI).

use amber::daemon::Daemon;
use amber::manager::SessionManager;
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
    let daemon = Daemon::new(manager);
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
