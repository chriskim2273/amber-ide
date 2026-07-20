//! Regression: a client that STOPS READING must be dropped, not allowed to
//! wedge the daemon.
//!
//! Production symptom (hit twice): the daemon froze while idle — every session
//! unresponsive — until it was manually restarted. Mechanism: `write_frame`
//! did an untimed `write_all`, so a per-attach Output forwarder writing to a
//! client whose socket buffer was full blocked FOREVER. It held that
//! connection's shared writer mutex (head-of-line-blocking that connection's
//! own control replies), and — worse — never drained its subscriber queue, so
//! a session whose only subscriber was the wedged client stayed permanently
//! backpressured: the pty reader stops draining, the child blocks on write,
//! the session is dead in the water with no self-heal.
//!
//! With a bounded `SO_SNDTIMEO` the forwarder's write fails, the connection is
//! severed, its subscriptions are released, and the pty resumes.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::time::{Duration, Instant};

use amber::daemon::{prepare_socket, Daemon, CLIENT_WRITE_TIMEOUT};
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

/// Shrink the receive buffer so the daemon's writes to this client block
/// quickly and deterministically (an AF_UNIX sender blocks once the peer's
/// buffer is full), regardless of the host's socket-buffer autotuning.
fn shrink_rcvbuf(stream: &UnixStream) {
    use std::os::fd::AsRawFd;
    let sz: libc::c_int = 4096;
    let rc = unsafe {
        libc::setsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_RCVBUF,
            &sz as *const _ as *const libc::c_void,
            std::mem::size_of::<libc::c_int>() as libc::socklen_t,
        )
    };
    assert_eq!(rc, 0, "setsockopt SO_RCVBUF failed");
}

/// Drain until the marker appears in this session's data, proving output
/// produced AFTER the wedge is flowing again. Keeps only a short tail.
fn drain_until_marker(stream: &mut UnixStream, session: &str, needle: &[u8], bound: Duration) {
    stream.set_read_timeout(Some(bound)).unwrap();
    let deadline = Instant::now() + bound;
    let mut dec = Decoder::new();
    let mut buf = [0u8; 65536];
    let mut tail: Vec<u8> = Vec::new();
    let mut total = 0usize;
    loop {
        while let Some(frame) = dec.next_frame().unwrap() {
            if let Frame::Data { session: s, bytes } = frame {
                if s == session {
                    total += bytes.len();
                    tail.extend_from_slice(&bytes);
                    if tail.windows(needle.len()).any(|w| w == needle) {
                        return;
                    }
                    if tail.len() > 8192 {
                        let cut = tail.len() - 4096;
                        tail.drain(0..cut);
                    }
                }
            }
        }
        assert!(Instant::now() < deadline, "marker never arrived (total_data={total})");
        let n = stream
            .read(&mut buf)
            .unwrap_or_else(|e| panic!("drain timeout: total_data={total} err={e}"));
        assert!(n > 0, "connection closed (total_data={total})");
        dec.feed(&buf[..n]);
    }
}

#[test]
fn non_reading_client_is_dropped_and_never_freezes_the_daemon() {
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

    // Producer connection: owns session A and feeds its shell input. It never
    // attaches, so it is NOT a subscriber — the victim below is A's only one.
    let producer = UnixStream::connect(&sock).unwrap();
    send(
        &producer,
        ControlMsg::Create { name: "amber-1-1-0-a".into(), cwd: cwd.clone(), kind: "shell".into() },
    );
    let mut pr = producer.try_clone().unwrap();
    read_control_until(&mut pr, |m| matches!(m, ControlMsg::Created { name } if name == "amber-1-1-0-a"));

    // Victim: attaches, then never reads a byte (a stuck renderer).
    let victim = UnixStream::connect(&sock).unwrap();
    shrink_rcvbuf(&victim);
    send(&victim, ControlMsg::Attach { name: "amber-1-1-0-a".into(), raw_client: false });
    // Let the subscription register before output starts, so the victim really
    // is the subscriber being backpressured (not a late attacher).
    std::thread::sleep(Duration::from_millis(300));

    // ~2.5 MB of shell-builtin output — far beyond the socket buffers and the
    // 2 MiB ring — followed by a marker. The marker can only appear on the
    // wire if the pty resumed after the wedged subscriber was dropped.
    // 'RE''SUMED' is split in the source so the pty's echo of the command line
    // does not itself contain the needle.
    send_data(
        &producer,
        "amber-1-1-0-a",
        b"i=0; while [ $i -lt 40000 ]; do printf 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\n'; i=$((i+1)); done; printf '%s\\n' 'RE''SUMED'\n",
    );

    // (a) The daemon is still serving everyone else. This is the reported
    // symptom ("frozen daemon, CLI included") asserted end to end.
    let mut healthy = UnixStream::connect(&sock).unwrap();
    send(&healthy, ControlMsg::ListSessions);
    read_control_until(&mut healthy, |m| matches!(m, ControlMsg::SessionList { .. }));
    send(
        &healthy,
        ControlMsg::Create { name: "amber-2-2-0-b".into(), cwd, kind: "shell".into() },
    );
    read_control_until(&mut healthy, |m| matches!(m, ControlMsg::Created { name } if name == "amber-2-2-0-b"));

    // (b) The victim is dropped. Do NOT read it before the write timeout could
    // have fired — reading would drain its buffer and un-wedge it. After the
    // daemon's shutdown(Both) the buffered bytes drain and the read hits EOF.
    std::thread::sleep(CLIENT_WRITE_TIMEOUT + Duration::from_secs(4));
    let mut victim = victim;
    victim.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let mut buf = [0u8; 65536];
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        match victim.read(&mut buf) {
            Ok(0) => break, // dropped by the daemon
            Ok(_) => {}
            Err(e) => panic!("wedged client was never dropped: {e}"),
        }
        assert!(Instant::now() < deadline, "wedged client was never dropped (still streaming)");
    }

    // (c) Dropping it released its subscription, so the session's pty — which
    // was backpressured with a single saturated subscriber — resumes.
    let mut fresh = UnixStream::connect(&sock).unwrap();
    send(&fresh, ControlMsg::Attach { name: "amber-1-1-0-a".into(), raw_client: false });
    drain_until_marker(&mut fresh, "amber-1-1-0-a", b"RESUMED", Duration::from_secs(30));
}
