#![cfg(unix)]

//! Delta re-attach: a client presenting a valid `(epoch, offset)` watermark
//! gets ONLY the scrollback bytes it has not seen (plus an `AttachBacklog`
//! announcement), instead of today's always-full replay that grew every pane's
//! renderer memory by up to the ring cap on every reconnect / tab switch.
//!
//! Compat rules pinned here:
//! - the `AttachBacklog` ack STRICTLY precedes its one replay `Data` frame;
//! - a stale/zero epoch falls back to `full: true` (reset semantics);
//! - a legacy Attach (no `resume` key) must NEVER receive the new variant
//!   (`amber attach` uses a strict decoder that rejects unknown variants).

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::time::Duration;

use amber::daemon::{prepare_socket, Daemon};
use amber::manager::SessionManager;
use amber::watchers::Watchers;
use amber_core::proto::{self, AttachResume, ControlMsg, Decoder, Frame};

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

fn next_frame(stream: &mut UnixStream, dec: &mut Decoder) -> Frame {
    loop {
        if let Some(f) = dec.next_frame().unwrap() {
            return f;
        }
        let mut buf = [0u8; 16384];
        stream.set_read_timeout(Some(Duration::from_secs(8))).unwrap();
        let n = stream.read(&mut buf).expect("read timeout");
        assert!(n > 0, "connection closed");
        dec.feed(&buf[..n]);
    }
}

struct Replay {
    ack_epoch: u64,
    offset_after_replay: u64,
}

/// Attach with a watermark; consume the ack + replay (+ any trailing live
/// frames during a brief quiet window), tracking the byte position exactly the
/// way the app's utilityProcess does: watermark = ack.end_offset plus every
/// replay/live byte consumed since.
fn attach_and_consume(
    stream: &mut UnixStream,
    name: &str,
    resume: Option<AttachResume>,
    needle: &[u8],
    quiet: Duration,
) -> Replay {
    let mut dec = Decoder::new();
    let opt_in = resume.is_some();
    send(
        stream,
        ControlMsg::Attach {
            name: name.to_string(),
            raw_client: false,
            preview: false,
            resume,
        },
    );
    // The announce must precede ANY Data frame for this session.
    let (ack_epoch, mut offset) = match next_frame(stream, &mut dec) {
        Frame::Control(ControlMsg::AttachBacklog { epoch, end_offset, full: _full, .. }) => {
            assert!(opt_in, "legacy attach got an AttachBacklog");
            (epoch, end_offset)
        }
        other => panic!("expected AttachBacklog first, got {other:?}"),
    };

    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    let mut saw_marker = false;
    let mut last_data = std::time::Instant::now();
    let mut buf = [0u8; 16384];
    loop {
        // Drain every complete frame already buffered BEFORE blocking on the
        // socket again.
        while let Some(frame) = dec.next_frame().unwrap() {
            if let Frame::Data { session, bytes } = frame {
                assert_eq!(session, name);
                offset += bytes.len() as u64;
                last_data = std::time::Instant::now();
                if bytes.windows(needle.len()).any(|w| w == needle) {
                    saw_marker = true;
                }
            }
        }
        if saw_marker && last_data.elapsed() >= quiet {
            break; // replay + trailing live bytes fully drained
        }
        assert!(std::time::Instant::now() < deadline, "marker {needle:?} never arrived");
        stream
            .set_read_timeout(Some(if saw_marker { quiet } else { Duration::from_secs(8) }))
            .unwrap();
        match stream.read(&mut buf) {
            Ok(0) => panic!("connection closed before the marker arrived"),
            Ok(n) => dec.feed(&buf[..n]),
            // The quiet window elapsed with nothing more incoming: done.
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
            Err(e) => panic!("read failed: {e}"),
        }
    }
    Replay { ack_epoch, offset_after_replay: offset }
}

#[test]
fn reattach_with_a_current_watermark_replays_only_the_delta() {
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
    let name = "amber-1-1-0-a";

    let producer = UnixStream::connect(&sock).unwrap();
    send(
        &producer,
        ControlMsg::Create { name: name.into(), cwd: cwd.clone(), kind: "shell".into(), title: None },
    );
    let mut pr = producer.try_clone().unwrap();
    // Wait for Created (skip any earlier frames).
    let mut d = Decoder::new();
    while !matches!(
        next_frame(&mut pr, &mut d),
        Frame::Control(ControlMsg::Created { .. })
    ) {}
    // Markers split so the pty echo of the command line never contains them.
    send_data(
        &producer,
        name,
        b"printf '%s\\n' 'MARK''ER-A'\n",
    );

    let mut client = UnixStream::connect(&sock).unwrap();

    // 1) First attach WITH a zero epoch: never servable -> full replay, and
    //    the ack hands back the ring's real identity + end position.
    let first = attach_and_consume(
        &mut client,
        name,
        Some(AttachResume { epoch: 0, offset: 0 }),
        b"MARKER-A",
        Duration::from_millis(400),
    );
    assert_ne!(first.ack_epoch, 0, "daemon must mint a nonzero epoch");

    // Detach so the next output has no subscriber (pure ring traffic).
    send(&client, ControlMsg::Detach { name: name.into() });

    // 2) Produce more output while nobody is attached...
    send_data(&producer, name, b"printf '%s\\n' 'MARK''ER-B'\n");

    // 3) Re-attach with the tracked watermark: DELTA only. It must contain B,
    //    must NOT contain A (that would be the duplicate-history bug), and
    //    must be far smaller than a full replay of everything so far.
    let _second = attach_and_consume(
        &mut client,
        name,
        Some(AttachResume { epoch: first.ack_epoch, offset: first.offset_after_replay }),
        b"MARKER-B",
        Duration::from_millis(400),
    );

    // 4) Live continuity: further output flows as ordinary Data frames.
    send_data(&producer, name, b"printf '%s\\n' 'MARK''ER-C'\n");
    let mut dec = Decoder::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    let mut live_c = false;
    while !live_c && std::time::Instant::now() < deadline {
        if let Frame::Data { session, bytes } = next_frame(&mut client, &mut dec) {
            live_c = session == name && bytes.windows(8).any(|w| w == b"MARKER-C");
        }
    }
    assert!(live_c, "live output stopped flowing after a delta attach");
}

#[test]
fn reattach_with_a_stale_watermark_falls_back_to_full_with_reset_semantics() {
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
    let name = "amber-1-1-0-a";
    let producer = UnixStream::connect(&sock).unwrap();
    send(&producer, ControlMsg::Create { name: name.into(), cwd, kind: "shell".into(), title: None });
    let mut pr = producer.try_clone().unwrap();
    let mut d = Decoder::new();
    while !matches!(
        next_frame(&mut pr, &mut d),
        Frame::Control(ControlMsg::Created { .. })
    ) {}
    send_data(&producer, name, b"printf '%s\\n' 'MARK''ER-A'\n");

    let mut client = UnixStream::connect(&sock).unwrap();
    let mut dec = Decoder::new();
    send(
        &client,
        ControlMsg::Attach {
            name: name.into(),
            raw_client: false,
            preview: false,
            resume: Some(AttachResume { epoch: 424_242, offset: 9_000 }),
        },
    );
    // An unknown epoch cannot be served as a delta: full:true tells the
    // client to RESET its terminal before applying the replay.
    match next_frame(&mut client, &mut dec) {
        Frame::Control(ControlMsg::AttachBacklog { full, end_offset, .. }) => {
            assert!(full, "stale watermark must degrade to a full replay");
            assert_eq!(end_offset, manager.session(name).unwrap().scrollback_written());
        }
        other => panic!("expected full-replay AttachBacklog, got {other:?}"),
    }
}

#[test]
fn a_legacy_attach_is_never_shown_the_attach_backlog_variant() {
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
    let name = "amber-1-1-0-a";
    let producer = UnixStream::connect(&sock).unwrap();
    send(&producer, ControlMsg::Create { name: name.into(), cwd, kind: "shell".into(), title: None });
    let mut pr = producer.try_clone().unwrap();
    let mut d = Decoder::new();
    while !matches!(
        next_frame(&mut pr, &mut d),
        Frame::Control(ControlMsg::Created { .. })
    ) {}
    send_data(&producer, name, b"printf '%s\\n' 'MARK''ER-A'\n");

    // Legacy attach: `resume` absent (the key itself is the opt-in).
    let mut client = UnixStream::connect(&sock).unwrap();
    let mut dec = Decoder::new();
    send(
        &client,
        ControlMsg::Attach { name: name.into(), raw_client: false, preview: false, resume: None },
    );
    // Strict-decoder clients (`amber attach`) would hard-error on an unknown
    // control variant, so NO AttachBacklog may ever arrive — consume Data
    // frames until the marker proves the replay+live path delivered, failing
    // if the new variant shows up anywhere.
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    let mut buf = [0u8; 16384];
    loop {
        while let Some(frame) = dec.next_frame().unwrap() {
            match frame {
                Frame::Data { session, bytes } => {
                    assert_eq!(session, name);
                    if bytes.windows(8).any(|w| w == b"MARKER-A") {
                        return; // legacy full-backlog delivery confirmed
                    }
                }
                Frame::Control(ControlMsg::AttachBacklog { .. }) => {
                    panic!("legacy attach was shown the AttachBacklog variant")
                }
                _ => {}
            }
        }
        assert!(std::time::Instant::now() < deadline, "marker never arrived");
        client.set_read_timeout(Some(Duration::from_secs(8))).unwrap();
        let n = client.read(&mut buf).expect("read failed");
        assert!(n > 0, "connection closed");
        dec.feed(&buf[..n]);
    }
}
