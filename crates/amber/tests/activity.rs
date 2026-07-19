#![cfg(unix)]
//! A session that produces output broadcasts a rate-limited `Activity` to
//! watchers: at most one per session per 500 ms, correctly attributed — driven
//! output lands on the busy session's name and never on an undriven one (the
//! per-session attribution property; a spawned shell always emits a startup
//! prompt, so a literal zero-output session isn't reachable via the manager).
//!
//! Fake-stub style (mirrors `run_state.rs`): sessions are created directly on
//! the manager and driven with `manager.write`; a watcher connection observes
//! the broadcasts over the socket. Assertions are on received counts with
//! timing slack, never tight wall-clock. A spawned shell prints a prompt some
//! variable time after spawn (bash init), so the test drains activity until
//! quiet before driving its own output — never assumes prompt timing.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::time::{Duration, Instant};

use amber::daemon::{prepare_socket, Daemon};
use amber::manager::SessionManager;
use amber::watchers::Watchers;
use amber_core::proto::{self, ControlMsg, Decoder, Frame};
use amber_core::state::SessionKind;

fn send(stream: &UnixStream, msg: ControlMsg) {
    let mut w = stream;
    w.write_all(&proto::encode(&Frame::Control(msg))).unwrap();
    w.flush().unwrap();
}

/// Read control frames off `stream` for `window`, returning the names of every
/// `Activity` seen (other control frames are ignored).
fn collect_activity(stream: &mut UnixStream, window: Duration) -> Vec<String> {
    stream.set_read_timeout(Some(Duration::from_millis(50))).unwrap();
    let deadline = Instant::now() + window;
    let mut dec = Decoder::new();
    let mut buf = [0u8; 8192];
    let mut names = Vec::new();
    while Instant::now() < deadline {
        while let Some(Frame::Control(msg)) = dec.next_frame().unwrap() {
            if let ControlMsg::Activity { name } = msg {
                names.push(name);
            }
        }
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => dec.feed(&buf[..n]),
            Err(_) => {} // read timeout: keep polling until the window ends
        }
    }
    names
}

/// Drain frames until no `Activity` arrives for a full `quiet` gap. Guarantees
/// (for `quiet` > 500 ms) that startup output has settled AND the per-session
/// rate-limit window has elapsed, so the next driven write fires cleanly.
fn drain_until_quiet(stream: &mut UnixStream, quiet: Duration) {
    loop {
        if collect_activity(stream, quiet).is_empty() {
            return;
        }
    }
}

#[test]
fn output_broadcasts_rate_limited_activity_and_silence_stays_silent() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("amberd.sock");
    let watchers = Arc::new(Watchers::new());
    let manager = Arc::new(
        SessionManager::new(dir.path())
            .unwrap()
            .with_watchers(Arc::clone(&watchers)),
    );
    // Two shells; we drive output only into "busy" and never into "silent".
    manager.create("busy", dir.path(), SessionKind::Shell).unwrap();
    manager.create("silent", dir.path(), SessionKind::Shell).unwrap();

    let listener = prepare_socket(&sock).unwrap();
    let daemon = Daemon::new(Arc::clone(&manager), Arc::clone(&watchers));
    std::thread::spawn(move || {
        let _ = daemon.serve(listener);
    });

    // Watch, and consume the initial Sessions snapshot.
    let watcher = UnixStream::connect(&sock).unwrap();
    let mut w = watcher.try_clone().unwrap();
    send(&watcher, ControlMsg::WatchSessions);
    {
        w.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut dec = Decoder::new();
        let mut buf = [0u8; 8192];
        'snap: loop {
            while let Some(Frame::Control(msg)) = dec.next_frame().unwrap() {
                if matches!(msg, ControlMsg::Sessions { .. }) {
                    break 'snap;
                }
            }
            let n = w.read(&mut buf).unwrap();
            assert!(n > 0, "watcher closed before the snapshot");
            dec.feed(&buf[..n]);
        }
    }

    // Wait out the shells' startup prompts (which fire their own activity) and
    // the rate-limit window that follows, so the first write we drive is the
    // first OBSERVED activity for "busy".
    drain_until_quiet(&mut w, Duration::from_millis(700));

    // A single write -> at least one Activity for "busy", none for "silent".
    manager.write("busy", b"printf hi\n").unwrap();
    let first = collect_activity(&mut w, Duration::from_millis(400));
    assert!(
        first.iter().any(|n| n == "busy"),
        "expected an Activity for the busy session, got {first:?}"
    );
    assert!(
        !first.iter().any(|n| n == "silent"),
        "activity must be attributed per session: no Activity for the undriven \
         session in the same window, got {first:?}"
    );

    // Clear the window opened by that write before the burst, so the burst's
    // first event isn't suppressed (would flake the lower bound).
    drain_until_quiet(&mut w, Duration::from_millis(700));

    // A burst of writes well within one 500 ms window must be rate-limited:
    // ~20 writes would be ~20 frames unbatched, but Activity is capped to one
    // per window (allow a small slack for a window boundary landing mid-burst).
    for _ in 0..20 {
        manager.write("busy", b"printf x\n").unwrap();
        std::thread::sleep(Duration::from_millis(10)); // ~200 ms total < 500 ms
    }
    let burst = collect_activity(&mut w, Duration::from_millis(300));
    let busy_count = burst.iter().filter(|n| *n == "busy").count();
    assert!(
        (1..=2).contains(&busy_count),
        "burst of 20 writes yielded {busy_count} Activity events — expected 1 \
         (rate-limited to one per 500 ms), 2 tolerated for a window boundary; \
         all: {burst:?}"
    );
}
