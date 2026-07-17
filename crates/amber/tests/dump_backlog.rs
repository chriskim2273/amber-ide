//! `DumpBacklog` returns a one-shot copy of a session's scrollback ring in a
//! single `Backlog` reply (workspace save/load feature); an unknown session
//! replies `Error`. Style mirrors `run_state.rs` / `backlog_hol.rs`.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::time::{Duration, Instant};

use amber::daemon::{prepare_socket, Daemon};
use amber::manager::SessionManager;
use amber::watchers::Watchers;
use amber_core::proto::{self, ControlMsg, Decoder, Frame};

fn send(stream: &UnixStream, msg: ControlMsg) {
    let mut w = stream;
    w.write_all(&proto::encode(&Frame::Control(msg))).unwrap();
    w.flush().unwrap();
}

fn send_data(stream: &UnixStream, session: &str, bytes: &[u8]) {
    let mut w = stream;
    w.write_all(&proto::encode(&Frame::Data {
        session: session.to_string(),
        bytes: bytes.to_vec(),
    }))
    .unwrap();
    w.flush().unwrap();
}

fn read_control_until<F: Fn(&ControlMsg) -> bool>(stream: &mut UnixStream, pred: F) -> ControlMsg {
    stream.set_read_timeout(Some(Duration::from_secs(8))).unwrap();
    let mut dec = Decoder::new();
    let mut buf = [0u8; 65536];
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
fn dump_backlog_returns_ring_bytes_and_errors_on_unknown() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("amberd.sock");
    let manager = Arc::new(SessionManager::new(dir.path()).unwrap());
    let watchers = Arc::new(Watchers::new());
    let listener = prepare_socket(&sock).unwrap();
    let daemon = Daemon::new(Arc::clone(&manager), Arc::clone(&watchers));
    std::thread::spawn(move || {
        let _ = daemon.serve(listener);
    });

    let cwd = dir.path().to_string_lossy().into_owned();

    // Create a shell session and drive a distinctive marker through its pty.
    let conn = UnixStream::connect(&sock).unwrap();
    send(
        &conn,
        ControlMsg::Create { name: "amber-1-1-0-a".into(), cwd, kind: "shell".into() },
    );
    let mut c = conn.try_clone().unwrap();
    read_control_until(&mut c, |m| matches!(m, ControlMsg::Created { name } if name == "amber-1-1-0-a"));
    // Shell builtin only (printf) so it runs under a minimal PATH.
    send_data(&conn, "amber-1-1-0-a", b"printf 'DUMP''MARKER'\n");

    // Wait until the marker has landed in the ring (drain a throwaway attach).
    {
        let mut drain = UnixStream::connect(&sock).unwrap();
        send(&drain, ControlMsg::Attach { name: "amber-1-1-0-a".into(), raw_client: false });
        drain.set_read_timeout(Some(Duration::from_secs(8))).unwrap();
        let mut dec = Decoder::new();
        let mut buf = [0u8; 65536];
        let mut tail: Vec<u8> = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(8);
        'outer: loop {
            while let Some(frame) = dec.next_frame().unwrap() {
                if let Frame::Data { session, bytes } = frame {
                    if session == "amber-1-1-0-a" {
                        tail.extend_from_slice(&bytes);
                        if tail.windows(10).any(|w| w == b"DUMPMARKER") {
                            break 'outer;
                        }
                    }
                }
            }
            assert!(Instant::now() < deadline, "marker never landed in the ring");
            let n = drain.read(&mut buf).expect("drain read");
            assert!(n > 0);
            dec.feed(&buf[..n]);
        }
    }

    // DumpBacklog on a fresh connection: the reply Backlog carries the ring,
    // whose bytes must END WITH the marker (the ring may prepend the shell
    // prompt / command echo, but the marker is the last output).
    let req = UnixStream::connect(&sock).unwrap();
    send(&req, ControlMsg::DumpBacklog { name: "amber-1-1-0-a".into() });
    let mut r = req.try_clone().unwrap();
    let reply = read_control_until(&mut r, |m| matches!(m, ControlMsg::Backlog { .. }));
    match reply {
        ControlMsg::Backlog { name, data } => {
            assert_eq!(name, "amber-1-1-0-a");
            assert!(
                data.windows(10).any(|w| w == b"DUMPMARKER"),
                "backlog missing marker; got {:?}",
                String::from_utf8_lossy(&data)
            );
        }
        other => panic!("expected Backlog, got {other:?}"),
    }

    // Unknown session -> Error.
    let bad = UnixStream::connect(&sock).unwrap();
    send(&bad, ControlMsg::DumpBacklog { name: "amber-9-9-9-nope".into() });
    let mut b = bad.try_clone().unwrap();
    let err = read_control_until(&mut b, |m| matches!(m, ControlMsg::Error { .. }));
    match err {
        ControlMsg::Error { msg } => assert!(msg.contains("no such session"), "unexpected: {msg}"),
        other => panic!("expected Error, got {other:?}"),
    }
}
