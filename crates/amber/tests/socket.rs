//! Slice 1 exit test: a raw client round-trips Create -> Attach -> input ->
//! output over the real unix socket, using amber_core::proto directly (no CLI).

use amber::daemon::Daemon;
use amber::manager::SessionManager;
use amber::watchers::Watchers;
use amber_core::proto::{self, ControlMsg, Decoder, Frame};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::Command;
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

/// Like [`start_daemon`], but also hands back the manager so tests can seed
/// scrollback rings and flip persisted metadata directly.
fn start_daemon_with_manager() -> (PathBuf, Arc<SessionManager>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("state");
    std::fs::create_dir_all(&root).unwrap();
    let socket_path = dir.path().join("amberd.sock");

    let manager = Arc::new(SessionManager::new(&root).unwrap());
    let listener = std::os::unix::net::UnixListener::bind(&socket_path).unwrap();
    let daemon = Daemon::new(Arc::clone(&manager), Arc::new(Watchers::new()));
    thread::spawn(move || {
        let _ = daemon.serve(listener);
    });

    (socket_path, manager, dir)
}

/// Rewrite a session's persisted kind to `claude`. Tests cannot spawn a real
/// claude-kind session (its pty would run `current_exe() run <name>` — i.e.
/// this test binary), so they spawn a shell and flip the metadata the daemon
/// consults on Attach.
fn flip_kind_to_claude(state_root: &Path, name: &str) {
    let store = amber_core::state::StateStore::new(state_root);
    let mut meta = store.read_session(name).unwrap().unwrap();
    meta.kind = amber_core::state::SessionKind::Claude;
    store.write_session(&meta).unwrap();
}

/// Accumulate Data-frame bytes from `stream` until `pred(acc)` matches, or
/// panic after `timeout`. Returns everything accumulated.
fn read_data_until<F: Fn(&[u8]) -> bool>(
    stream: &mut UnixStream,
    decoder: &mut Decoder,
    pred: F,
    timeout: Duration,
) -> Vec<u8> {
    stream.set_read_timeout(Some(Duration::from_millis(100))).unwrap();
    let deadline = Instant::now() + timeout;
    let mut acc = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        while let Some(frame) = decoder.next_frame().unwrap() {
            if let Frame::Data { bytes, .. } = frame {
                acc.extend_from_slice(&bytes);
            }
        }
        if pred(&acc) {
            return acc;
        }
        if Instant::now() > deadline {
            panic!(
                "timed out waiting for expected data; got {:?}",
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
    send(&mut stream, &Frame::Control(ControlMsg::Attach { name: "idle".into(), raw_client: false }));

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
fn reattach_replaces_subscription_not_stacks_it() {
    // A re-Attach on the SAME connection (reconnect resubscribe / pane remount)
    // must REPLACE the prior subscription, not add a second — else every pty
    // byte is delivered twice and reads as duplicated input.
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

    manager
        .create("idle", "/tmp", amber_core::state::SessionKind::Shell)
        .unwrap();
    let sess = manager.session("idle").unwrap();

    let mut stream = connect_with_retry(&socket_path);
    send(&mut stream, &Frame::Control(ControlMsg::Attach { name: "idle".into(), raw_client: false }));

    let deadline = Instant::now() + Duration::from_secs(5);
    while sess.subscriber_count() != 1 {
        assert!(Instant::now() < deadline, "first attach never subscribed");
        thread::sleep(Duration::from_millis(20));
    }

    // Re-Attach on the same connection; the count must never stack to 2.
    send(&mut stream, &Frame::Control(ControlMsg::Attach { name: "idle".into(), raw_client: false }));
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        assert!(
            sess.subscriber_count() <= 1,
            "re-attach stacked a duplicate subscriber ({})",
            sess.subscriber_count()
        );
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(sess.subscriber_count(), 1, "exactly one subscription after re-attach");
    drop(stream);
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

    send(&mut stream, &Frame::Control(ControlMsg::Attach { name: "s".into(), raw_client: false }));
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

    send(&mut stream, &Frame::Control(ControlMsg::Attach { name: "mortal".into(), raw_client: false }));
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
fn kill_via_cli_removes_the_session() {
    // `amber kill <name>` over the real socket must remove the session. The
    // daemon sends no reply to Kill, so the client verifies removal with a
    // follow-up ListSessions on the same (in-order) connection.
    let (socket_path, _dir) = start_daemon();
    let mut stream = connect_with_retry(&socket_path);
    let mut decoder = Decoder::new();

    send(
        &mut stream,
        &Frame::Control(ControlMsg::Create {
            name: "victim".into(),
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

    let out = Command::new(env!("CARGO_BIN_EXE_amber"))
        .args(["kill", "victim", "--socket"])
        .arg(&socket_path)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "amber kill failed; stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    // Independently confirm the session is gone.
    let mut probe = connect_with_retry(&socket_path);
    let mut pdec = Decoder::new();
    send(&mut probe, &Frame::Control(ControlMsg::ListSessions));
    let frame = read_frame_until(
        &mut probe,
        &mut pdec,
        |f| matches!(f, Frame::Control(ControlMsg::SessionList { .. })),
        Duration::from_secs(5),
    );
    match frame {
        Frame::Control(ControlMsg::SessionList { names }) => {
            assert!(!names.contains(&"victim".to_string()), "victim survived kill: {names:?}");
        }
        _ => unreachable!(),
    }
}

#[test]
fn rename_via_cli_surfaces_daemon_error() {
    // Rename is unsupported daemon-side; the CLI must surface that error to
    // stderr and exit nonzero (the verb exists so the UX matches the spec).
    let (socket_path, _dir) = start_daemon();
    let out = Command::new(env!("CARGO_BIN_EXE_amber"))
        .args(["rename", "a", "b", "--socket"])
        .arg(&socket_path)
        .output()
        .unwrap();
    assert!(!out.status.success(), "amber rename unexpectedly succeeded");
    let stderr = String::from_utf8_lossy(&out.stderr);
    // The daemon's exact message — proves we surfaced the server error, not a
    // clap "unrecognized subcommand" (which also contains the word "rename").
    assert!(stderr.contains("not supported"), "rename error not surfaced: {stderr}");
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

// --- spec §5 reconnect semantics: backlog replay depends on client + kind ---

#[test]
fn raw_attach_to_claude_session_skips_backlog() {
    // A plain-terminal client (`amber attach`, raw_client: true) attaching to
    // an alt-screen (claude) session must NOT receive historical backlog —
    // replaying alt-screen bytes into a cold terminal corrupts it (spec §5).
    // The child repaints via the daemon's resize nudge instead.
    let (socket_path, manager, dir) = start_daemon_with_manager();
    manager
        .create("c", "/tmp", amber_core::state::SessionKind::Shell)
        .unwrap();
    flip_kind_to_claude(&dir.path().join("state"), "c");
    let sess = manager.session("c").unwrap();
    sess.preload(b"OLD_ALT_SCREEN_BYTES");

    let mut stream = connect_with_retry(&socket_path);
    let mut decoder = Decoder::new();
    send(&mut stream, &Frame::Control(ControlMsg::Attach { name: "c".into(), raw_client: true }));
    // Same connection, so the daemon handles Attach before this input.
    send(&mut stream, &Frame::Data { session: "c".into(), bytes: b"echo LIVE_MARKER\n".to_vec() });

    // Wait for live output to prove the attach is fully serviced; only then
    // is "no backlog arrived" meaningful (backlog would have been sent first).
    let acc = read_data_until(
        &mut stream,
        &mut decoder,
        |acc| acc.windows(11).any(|w| w == b"LIVE_MARKER"),
        Duration::from_secs(10),
    );
    assert!(
        !acc.windows(20).any(|w| w == b"OLD_ALT_SCREEN_BYTES"),
        "raw client got historical alt-screen backlog: {:?}",
        String::from_utf8_lossy(&acc)
    );
}

#[test]
fn raw_attach_to_shell_session_replays_backlog() {
    // Shell history replays cleanly into a plain terminal (spec §5): a raw
    // client attaching to a shell session still gets the full backlog.
    let (socket_path, manager, _dir) = start_daemon_with_manager();
    manager
        .create("sh", "/tmp", amber_core::state::SessionKind::Shell)
        .unwrap();
    manager.session("sh").unwrap().preload(b"SHELL_HISTORY_OK");

    let mut stream = connect_with_retry(&socket_path);
    let mut decoder = Decoder::new();
    send(&mut stream, &Frame::Control(ControlMsg::Attach { name: "sh".into(), raw_client: true }));
    read_data_until(
        &mut stream,
        &mut decoder,
        |acc| acc.windows(16).any(|w| w == b"SHELL_HISTORY_OK"),
        Duration::from_secs(10),
    );
}

#[test]
fn default_attach_to_claude_session_replays_backlog() {
    // Backward compatibility: a client that does not set raw_client (the
    // Electron app — xterm.js is a full emulator, raw replay is clean) keeps
    // getting the full backlog even for claude sessions.
    let (socket_path, manager, dir) = start_daemon_with_manager();
    manager
        .create("c2", "/tmp", amber_core::state::SessionKind::Shell)
        .unwrap();
    flip_kind_to_claude(&dir.path().join("state"), "c2");
    manager.session("c2").unwrap().preload(b"XTERM_BACKLOG_OK");

    let mut stream = connect_with_retry(&socket_path);
    let mut decoder = Decoder::new();
    send(&mut stream, &Frame::Control(ControlMsg::Attach { name: "c2".into(), raw_client: false }));
    read_data_until(
        &mut stream,
        &mut decoder,
        |acc| acc.windows(16).any(|w| w == b"XTERM_BACKLOG_OK"),
        Duration::from_secs(10),
    );
}

#[test]
fn stale_session_write_and_resize_do_not_kill_the_connection() {
    // Input/Resize aimed at a session that no longer exists is logged on the
    // daemon side but must NOT tear down the client's connection — the same
    // socket keeps serving control traffic afterward.
    let (socket_path, _dir) = start_daemon();
    let mut stream = connect_with_retry(&socket_path);
    let mut decoder = Decoder::new();

    send(&mut stream, &Frame::Data { session: "ghost".into(), bytes: b"boo".to_vec() });
    send(&mut stream, &Frame::Control(ControlMsg::Resize { name: "ghost".into(), cols: 80, rows: 24 }));
    send(&mut stream, &Frame::Control(ControlMsg::ListSessions));

    let reply = read_frame_until(
        &mut stream,
        &mut decoder,
        |f| matches!(f, Frame::Control(ControlMsg::SessionList { .. })),
        Duration::from_secs(5),
    );
    assert_eq!(
        reply,
        Frame::Control(ControlMsg::SessionList { names: vec![] }),
        "connection died after a stale-session write/resize"
    );
}

#[test]
fn unknown_control_frame_is_skipped_not_fatal() {
    // Forward-compat: a newer client sends a control message this daemon can't
    // decode (simulated here by a raw control frame with an unknown JSON
    // variant). The daemon must log-and-skip it and keep serving the
    // multiplexed connection — a subsequent ListSessions still answers.
    let (socket_path, _dir) = start_daemon();
    let mut stream = connect_with_retry(&socket_path);
    let mut decoder = Decoder::new();

    // Hand-encode a control frame (tag 0) whose body is a valid-JSON but
    // unknown-to-this-build ControlMsg variant. Framing stays length-prefixed.
    const TAG_CONTROL: u8 = 0;
    let json = br#"{"FutureMsg":{"x":1}}"#;
    let mut body = vec![TAG_CONTROL];
    body.extend_from_slice(json);
    let mut raw = (body.len() as u32).to_be_bytes().to_vec();
    raw.extend_from_slice(&body);
    stream.write_all(&raw).unwrap();

    // A normal request after the unknown one must still be served.
    send(&mut stream, &Frame::Control(ControlMsg::ListSessions));
    let reply = read_frame_until(
        &mut stream,
        &mut decoder,
        |f| matches!(f, Frame::Control(ControlMsg::SessionList { .. })),
        Duration::from_secs(5),
    );
    assert_eq!(
        reply,
        Frame::Control(ControlMsg::SessionList { names: vec![] }),
        "connection died after an undecodable control frame"
    );
}
