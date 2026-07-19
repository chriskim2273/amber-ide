#![cfg(unix)]
//! Regression: a slow client replaying a large scrollback backlog must NOT
//! head-of-line-block the control frames multiplexed on the SAME connection.
//!
//! The daemon streams control (Create/Kill/…) and pane data over one socket.
//! If the backlog is written on the connection's read thread, a client that is
//! slow to drain a multi-MB backlog freezes that thread, and every control
//! command queued behind the Attach is never processed — the app can't create,
//! close, split, or open panes ("nothing works"). This test fills a session's
//! ring, has a NON-draining client Attach it and immediately Create a second
//! session, and asserts a watcher still sees the new session promptly.

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

/// Drain a data stream for `session` until `needle` is seen (confirms the
/// producer's output has fully landed in the ring), or time out. Keeps only a
/// short tail so scanning stays cheap under a multi-hundred-KB stream.
fn drain_until_marker(stream: &mut UnixStream, session: &str, needle: &[u8]) {
    stream.set_read_timeout(Some(Duration::from_secs(8))).unwrap();
    let mut dec = Decoder::new();
    let mut buf = [0u8; 65536];
    let mut tail: Vec<u8> = Vec::new();
    let mut total = 0usize;
    let mut ctrls: Vec<String> = Vec::new();
    loop {
        while let Some(frame) = dec.next_frame().unwrap() {
            match frame {
                Frame::Data { session: s, bytes } if s == session => {
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
                Frame::Control(m) => ctrls.push(format!("{m:?}")),
                _ => {}
            }
        }
        let n = stream
            .read(&mut buf)
            .unwrap_or_else(|e| panic!("drain timeout: total_data={total} ctrls={ctrls:?} err={e}"));
        assert!(n > 0, "producer connection closed (total_data={total} ctrls={ctrls:?})");
        dec.feed(&buf[..n]);
    }
}

#[test]
fn large_backlog_does_not_block_control_on_shared_connection() {
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

    // Producer connection: create session A and make its shell emit ~1.5 MB so
    // the ring holds a backlog far larger than the socket send/recv buffers.
    let producer = UnixStream::connect(&sock).unwrap();
    send(
        &producer,
        ControlMsg::Create { name: "amber-1-1-0-a".into(), cwd: cwd.clone(), kind: "shell".into() },
    );
    // Synchronize: the session must exist before anyone attaches it.
    let mut pr = producer.try_clone().unwrap();
    read_control_until(&mut pr, |m| matches!(m, ControlMsg::Created { name } if name == "amber-1-1-0-a"));
    // Shell-builtin loop only (printf / [ / arithmetic) — no external commands,
    // so it works even if the spawned shell has a minimal PATH. Emit ~2.5 MB so
    // the ring fills to its 2 MiB cap: a backlog that far exceeds the kernel
    // socket send+recv buffers, so a non-draining client's backlog write blocks.
    // The completion marker is SPLIT in the command source ('RING''FULL') so the
    // pty's echo of the command line does not itself contain the needle — only
    // the shell's real output does. Otherwise the drain would match the echo and
    // return before the loop ran.
    send_data(
        &producer,
        "amber-1-1-0-a",
        b"i=0; while [ $i -lt 40000 ]; do printf 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\n'; i=$((i+1)); done; printf '%s\\n' 'RING''FULL'\n",
    );

    // Confirm the output has landed by draining a throwaway attach until the
    // marker, then dropping that connection (the ring retains the bytes).
    {
        let mut drain = UnixStream::connect(&sock).unwrap();
        send(&drain, ControlMsg::Attach { name: "amber-1-1-0-a".into(), raw_client: false });
        drain_until_marker(&mut drain, "amber-1-1-0-a", b"RINGFULL");
    }

    // Victim connection: Attach the big-backlog session, then IMMEDIATELY Create
    // a second session — and NEVER read this socket (a stuck/slow renderer). If
    // the backlog is written on the read thread, the Create never gets processed.
    let victim = UnixStream::connect(&sock).unwrap();
    // Shrink the receive buffer so the daemon's backlog write blocks quickly and
    // deterministically (AF_UNIX senders block once the peer's buffer is full),
    // regardless of the host's socket-buffer autotuning.
    {
        use std::os::fd::AsRawFd;
        let sz: libc::c_int = 4096;
        let rc = unsafe {
            libc::setsockopt(
                victim.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_RCVBUF,
                &sz as *const _ as *const libc::c_void,
                std::mem::size_of::<libc::c_int>() as libc::socklen_t,
            )
        };
        assert_eq!(rc, 0, "setsockopt SO_RCVBUF failed");
    }
    send(&victim, ControlMsg::Attach { name: "amber-1-1-0-a".into(), raw_client: false });
    send(
        &victim,
        ControlMsg::Create { name: "amber-2-2-0-b".into(), cwd, kind: "shell".into() },
    );

    // The invariant under test is that the daemon PROCESSED the control frame
    // despite an undrained backlog on the same connection — so assert on daemon
    // state directly, not on any reply/broadcast. (A reply would have to be
    // written back to this deliberately-stuck socket, which says nothing about
    // whether the read thread got to the frame.)
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        if manager.names().iter().any(|n| n == "amber-2-2-0-b") {
            return; // control processed while the backlog is still pending
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!(
        "Create was never processed: a pending backlog on the same connection \
         head-of-line-blocked the control frame (sessions: {:?})",
        manager.names()
    );
}
