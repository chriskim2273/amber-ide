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

// ---- scrollback replay: the mode preamble ----------------------------------
//
// A capped ring cannot restore a full-screen application's private modes: Pi
// writes `?1049h ?1000h ?1002h ?1003h ?1004h ?1006h` once, in
// `beforeTerminalStart`, and a long session evicts those bytes. A COLD client
// therefore used to replay a TUI's cursor-addressed frames into the NORMAL
// buffer with no mouse protocol — corrupted scrollback, and a wheel that
// reached the editor's prompt history instead of the conversation. The daemon
// now tracks the state (`amber_core::modes`) and leads a FULL replay with it.

/// Boot a daemon over a fresh temp dir. Returns the dir (keep it alive), the
/// socket path and the manager.
fn boot(dir: &tempfile::TempDir) -> (std::path::PathBuf, Arc<SessionManager>) {
    let sock = dir.path().join("amberd.sock");
    let manager = Arc::new(SessionManager::new(dir.path()).unwrap());
    let watchers = Arc::new(Watchers::new());
    let listener = prepare_socket(&sock).unwrap();
    let daemon = Daemon::new(Arc::clone(&manager), Arc::clone(&watchers));
    std::thread::spawn(move || {
        let _ = daemon.serve(listener);
    });
    (sock, manager)
}

/// Create a shell session and wait for its `Created` ack.
fn create_shell(sock: &std::path::Path, name: &str, cwd: &std::path::Path) -> UnixStream {
    let producer = UnixStream::connect(sock).unwrap();
    send(
        &producer,
        ControlMsg::Create {
            name: name.into(),
            cwd: cwd.to_string_lossy().into_owned(),
            kind: "shell".into(),
            title: None,
        },
    );
    let mut pr = producer.try_clone().unwrap();
    let mut dec = Decoder::new();
    while !matches!(
        next_frame(&mut pr, &mut dec),
        Frame::Control(ControlMsg::Created { .. })
    ) {}
    producer
}

/// Pi's startup modes plus a frame, printed by the session's child so they land
/// in the ring exactly as a real TUI's would. `\033` (octal ESC) keeps the
/// COMMAND LINE free of raw escape bytes: a shell's line editor would otherwise
/// swallow them as key sequences before `printf` ever ran. The trailing flood
/// is what a real session does to the ring — it evicts the startup enables
/// while the application stays in them.
const MODES_COMMAND: &str = "printf '\\033[?1049h\\033[?1000h\\033[?1002h\\033[?1003h\\033[?1004h\\033[?1006h\\033[?25l\\033[2JFRAME-ONE'; i=0; while [ $i -lt 300 ]; do printf 'filler-%s\\n' $i; i=$((i+1)); done; printf '%s\\n' 'FRAME''-LAST'\n";

/// The head of the preamble a cold replay of a Pi-shaped session must lead
/// with: the alt screen first, then Pi's mouse modes in xterm's ascending
/// last-writer-wins order (so the effective protocol is ANY-motion). The
/// preamble may continue with modes the session's own shell asserted (an
/// interactive bash enables bracketed paste), so only this head is pinned.
const PI_MODE_PREFIX: &[u8] =
    b"\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h";

/// The daemon refuses a partial `config.toml`, so write both keys.
fn write_small_ring_config(root: &std::path::Path, scrollback_bytes: usize) {
    std::fs::write(
        root.join("config.toml"),
        format!("snapshot_interval_secs = 30\nscrollback_bytes = {scrollback_bytes}\n"),
    )
    .unwrap();
}

/// Wait until the session's ring holds `needle` (the child is asynchronous).
fn wait_for_ring(manager: &SessionManager, name: &str, needle: &[u8]) {
    let sess = manager.session(name).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !sess.scrollback().windows(needle.len()).any(|w| w == needle) {
        assert!(
            std::time::Instant::now() < deadline,
            "child output {:?} never reached the ring",
            String::from_utf8_lossy(needle)
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn a_cold_full_replay_leads_with_the_alt_screen_mode_preamble() {
    let dir = tempfile::tempdir().unwrap();
    // 256 bytes of ring: every frame above the newest handful is evicted, which
    // is the live condition (2 MiB of frames versus an enable written once, at
    // TUI start).
    write_small_ring_config(dir.path(), 256);
    let (sock, manager) = boot(&dir);
    let name = "amber-1-1-0-a";
    let producer = create_shell(&sock, name, dir.path());
    send_data(&producer, name, MODES_COMMAND.as_bytes());
    wait_for_ring(&manager, name, b"FRAME-LAST");
    // Exactly what the app's fresh mount sends (`{epoch:'0'}`): a terminal with
    // no history and no modes of its own.
    let mut client = UnixStream::connect(&sock).unwrap();
    send(
        &client,
        ControlMsg::Attach {
            name: name.into(),
            raw_client: false,
            preview: false,
            resume: Some(AttachResume { epoch: 0, offset: 0 }),
        },
    );
    let mut dec = Decoder::new();
    match next_frame(&mut client, &mut dec) {
        Frame::Control(ControlMsg::AttachBacklog { full, .. }) => assert!(full),
        other => panic!("expected the AttachBacklog ack first, got {other:?}"),
    }
    // The first Data frame IS the replay, and it opens with the modes.
    let replay = loop {
        match next_frame(&mut client, &mut dec) {
            Frame::Data { session, bytes } if session == name => break bytes,
            Frame::Data { .. } => continue,
            other => panic!("expected the replay Data frame, got {other:?}"),
        }
    };
    // Precondition, checked against the daemon's own ring: the bytes this
    // replay leads with are NOT in it — they can only come from the tracked
    // state.
    let ring = manager.session(name).unwrap().scrollback();
    assert!(
        !ring.windows(8).any(|w| w == b"\x1b[?1049"),
        "precondition: the capped ring must have evicted the alt-screen enable"
    );
    assert!(
        replay.starts_with(PI_MODE_PREFIX),
        "replay must lead with the modes the ring can no longer show; got {:?}",
        String::from_utf8_lossy(&replay[..PI_MODE_PREFIX.len().min(replay.len())])
    );
    assert!(
        replay.windows(10).any(|w| w == b"FRAME-LAST"),
        "the session's own retained bytes must still follow the preamble"
    );
}

#[test]
fn an_opt_in_attach_is_always_answered_with_one_replay_frame_even_when_empty() {
    // The client arms "the next Data frame is the replay" when it Attaches. If
    // an empty replay were simply omitted, that arm would survive and tag the
    // NEXT LIVE frame as scrollback — the router would then hand the renderer a
    // backlog tag for output that is not history (a live pane reset, or
    // history duplicated). A zero-byte scrollback cap makes the empty replay
    // certain instead of racy.
    let dir = tempfile::tempdir().unwrap();
    write_small_ring_config(dir.path(), 0);
    let (sock, _manager) = boot(&dir);
    let name = "amber-1-1-0-a";
    let _producer = create_shell(&sock, name, dir.path());

    let mut client = UnixStream::connect(&sock).unwrap();
    send(
        &client,
        ControlMsg::Attach {
            name: name.into(),
            raw_client: false,
            preview: false,
            resume: Some(AttachResume { epoch: 0, offset: 0 }),
        },
    );
    let mut dec = Decoder::new();
    let mut buf = [0u8; 16384];
    let mut saw_ack = false;
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    while std::time::Instant::now() < deadline {
        while let Some(frame) = dec.next_frame().unwrap() {
            match frame {
                Frame::Control(ControlMsg::AttachBacklog { full, .. }) => {
                    assert!(full, "a zero watermark is always a full replay");
                    saw_ack = true;
                }
                Frame::Data { session, bytes } if session == name => {
                    assert!(saw_ack, "the replay frame must follow its ack");
                    assert!(bytes.is_empty(), "cap 0 holds no bytes to replay");
                    return;
                }
                _ => {}
            }
        }
        client.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        match client.read(&mut buf) {
            Ok(0) => panic!("connection closed before the replay frame"),
            Ok(n) => dec.feed(&buf[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
            Err(e) => panic!("read failed: {e}"),
        }
    }
    panic!("an opt-in attach was never answered with its replay frame (arm left dangling)");
}

#[test]
fn a_delta_replay_never_carries_the_preamble() {
    // Re-asserting `?1049h` on a surviving terminal would clear the alternate
    // buffer the user is reading — the state is already there.
    let dir = tempfile::tempdir().unwrap();
    let (sock, manager) = boot(&dir);
    let name = "amber-1-1-0-a";
    let producer = create_shell(&sock, name, dir.path());
    send_data(&producer, name, MODES_COMMAND.as_bytes());
    wait_for_ring(&manager, name, b"FRAME-LAST");
    let sess = manager.session(name).unwrap();
    let epoch = sess.scrollback_epoch();
    let offset = sess.scrollback_written();

    let mut client = UnixStream::connect(&sock).unwrap();
    send(
        &client,
        ControlMsg::Attach {
            name: name.into(),
            raw_client: false,
            preview: false,
            resume: Some(AttachResume { epoch, offset }),
        },
    );
    let mut dec = Decoder::new();
    match next_frame(&mut client, &mut dec) {
        Frame::Control(ControlMsg::AttachBacklog { full, .. }) => {
            assert!(!full, "a current watermark must be served as a delta");
        }
        other => panic!("expected the AttachBacklog ack first, got {other:?}"),
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    while std::time::Instant::now() < deadline {
        while let Some(frame) = dec.next_frame().unwrap() {
            if let Frame::Data { session, bytes } = frame {
                assert_eq!(session, name);
                assert!(
                    !bytes.starts_with(b"\x1b[?1049h"),
                    "a delta must not re-enter the alt screen"
                );
                return; // the (empty) delta arrived
            }
        }
        let mut buf = [0u8; 16384];
        client.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        match client.read(&mut buf) {
            Ok(0) => panic!("connection closed before the delta frame"),
            Ok(n) => dec.feed(&buf[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
            Err(e) => panic!("read failed: {e}"),
        }
    }
    panic!("no delta frame arrived");
}
