//! Registry of client connections that opted in (via `WatchSessions`) to
//! pushed `SessionsChanged` events.
//!
//! # Design: broadcast must never block the caller
//!
//! `broadcast()` is called from connection read threads (Create/Kill) and
//! from the periodic snapshot timer. A synchronous write to a wedged watcher
//! socket (peer not draining, kernel buffer full) from those threads would
//! re-introduce the head-of-line failure class fixed 2026-07-15: control
//! handling stalls behind one slow client and periodic persistence silently
//! halts. So delivery is asynchronous, mirroring the pty.rs subscriber
//! philosophy (bounded queue + laggard eviction):
//!
//! - Each registered watcher gets a **dedicated forwarder thread** fed by a
//!   **bounded** queue of pre-encoded frames. `broadcast()` only `try_send`s
//!   into those queues — it never blocks, and one wedged watcher cannot delay
//!   delivery to healthy watchers (their forwarders are independent).
//! - A watcher whose queue is full at broadcast time has failed to drain
//!   [`WATCHER_QUEUE_DEPTH`] low-rate control events — it is wedged. It is
//!   **evicted**: its entry is dropped, closing the queue; the forwarder
//!   severs the connection when it notices. Losing a wedged watcher's
//!   subscription is acceptable; blocking the daemon is not.
//! - The forwarder writes with a bounded [`WRITE_TIMEOUT`] (`SO_SNDTIMEO`).
//!   On timeout/error it **shuts the socket down** and exits. Shutdown
//!   matters twice over: (1) the watcher's write half is an
//!   `Arc<Mutex<UnixStream>>` SHARED with that connection's control-reply
//!   writes (daemon.rs), so the forwarder may hold that mutex only for a
//!   bounded time — after the timeout the socket is dead and every later
//!   write on it fails fast instead of blocking; (2) a timed-out write
//!   may have written a PARTIAL frame — the stream is no longer
//!   frame-aligned, so it must not carry any further reply. The client sees
//!   a dropped connection and reconnects (the app already auto-reconnects).
//! - Lock order: a forwarder never holds the writer mutex and the registry
//!   mutex at once; `broadcast()` takes only the registry mutex and does no
//!   socket I/O under it.
//!
//! Worst case for an unrelated thread contending on a wedged watcher's
//! shared writer mutex while the WATCHER forwarder holds it: one
//! `WRITE_TIMEOUT` wait, after which the socket errors immediately. The pty
//! Output forwarders and control replies write through the same shared writer
//! and are bounded too, at the (looser) `daemon::CLIENT_WRITE_TIMEOUT` set on
//! the connection — looser because those writes carry multi-MiB backlog
//! replays. So every hold of the shared writer is bounded, and no watcher can
//! block the broadcast caller.

use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, Weak};
use std::thread;
use std::time::Duration;

use amber_core::proto::{self, ControlMsg, Frame};

/// Bounded per-watcher event queue depth. SessionsChanged events are
/// low-rate; a watcher this far behind is wedged, not merely slow.
const WATCHER_QUEUE_DEPTH: usize = 32;

/// Upper bound on one forwarder write (`SO_SNDTIMEO`). Also the worst-case
/// time a forwarder can hold the shared writer mutex, and thus the worst-case
/// delay it can impose on that connection's own control replies.
const WRITE_TIMEOUT: Duration = Duration::from_secs(1);

struct Entry {
    id: u64,
    writer_key: usize,
    session_events: bool,
    pressure_version: u16,
    tx: SyncSender<QueuedFrame>,
}

enum QueuedFrame {
    Frame(Arc<Vec<u8>>),
    Initial(Receiver<Arc<Vec<u8>>>),
}

pub struct Watchers {
    entries: Arc<Mutex<Vec<Entry>>>,
    next_id: AtomicU64,
}

impl Default for Watchers {
    fn default() -> Self {
        Watchers {
            entries: Arc::new(Mutex::new(Vec::new())),
            next_id: AtomicU64::new(0),
        }
    }
}

impl Watchers {
    pub fn new() -> Self {
        Watchers::default()
    }

    /// Register a connection's shared write half as a watcher, spawning its
    /// dedicated forwarder thread. Holds only a `Weak` to the writer, so a
    /// vanished connection is pruned automatically.
    pub fn register(&self, writer: &Arc<Mutex<UnixStream>>) {
        self.register_capability(writer, true, None);
    }

    /// Opt a connection in to versioned memory-pressure controls without
    /// changing what legacy `WatchSessions` means.
    pub fn register_pressure(&self, writer: &Arc<Mutex<UnixStream>>, version: u16) {
        self.register_capability(writer, false, Some(version));
    }

    /// Register a session watcher before building its full snapshot. Its
    /// forwarder waits for that snapshot, so every delta queued meanwhile is
    /// delivered after it without holding the registry lock across manager or
    /// disk work.
    pub fn register_sessions(
        &self,
        writer: &Arc<Mutex<UnixStream>>,
        snapshot: impl FnOnce() -> Vec<amber_core::proto::SessionInfo>,
    ) {
        let writer_key = Arc::as_ptr(writer) as usize;
        let (snapshot_tx, snapshot_rx) = sync_channel(1);
        let forwarder = {
            let mut entries = self.entries.lock().unwrap();
            if let Some(index) = entries.iter().position(|entry| entry.writer_key == writer_key) {
                if entries[index].tx.try_send(QueuedFrame::Initial(snapshot_rx)).is_err() {
                    entries.remove(index);
                    return;
                }
                entries[index].session_events = true;
                None
            } else {
                let id = self.next_id.fetch_add(1, Ordering::Relaxed);
                let (tx, rx) = sync_channel(WATCHER_QUEUE_DEPTH);
                tx.send(QueuedFrame::Initial(snapshot_rx)).unwrap();
                entries.push(Entry {
                    id,
                    writer_key,
                    session_events: true,
                    pressure_version: 0,
                    tx,
                });
                Some((id, rx, Arc::downgrade(writer), Arc::clone(&self.entries)))
            }
        };
        if let Some((id, rx, weak, entries)) = forwarder {
            thread::spawn(move || forward(id, rx, weak, entries));
        }
        let initial = Arc::new(proto::encode(&Frame::Control(ControlMsg::Sessions {
            sessions: snapshot(),
        })));
        let _ = snapshot_tx.send(initial);
    }

    fn register_capability(
        &self,
        writer: &Arc<Mutex<UnixStream>>,
        session_events: bool,
        pressure_version: Option<u16>,
    ) {
        let writer_key = Arc::as_ptr(writer) as usize;
        let mut entries = self.entries.lock().unwrap();
        if let Some(entry) = entries.iter_mut().find(|entry| entry.writer_key == writer_key) {
            entry.session_events |= session_events;
            if let Some(version) = pressure_version {
                entry.pressure_version = entry.pressure_version.max(version);
            }
            return;
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = sync_channel(WATCHER_QUEUE_DEPTH);
        entries.push(Entry {
            id,
            writer_key,
            session_events,
            pressure_version: pressure_version.unwrap_or(0),
            tx: tx.clone(),
        });
        drop(entries);
        let weak = Arc::downgrade(writer);
        let entries = Arc::clone(&self.entries);
        thread::spawn(move || forward(id, rx, weak, entries));
    }

    /// Encode `msg` once and queue it to every registered watcher. Never
    /// blocks: only `try_send`s into bounded queues (no socket I/O). A
    /// watcher whose queue is full or whose forwarder is gone is evicted.
    pub fn broadcast(&self, msg: &ControlMsg) {
        self.broadcast_where(msg, |entry| entry.session_events);
    }

    /// Queue a pressure control only for clients that explicitly advertised a
    /// compatible pressure-watch version. Legacy session watchers receive no
    /// unknown variant and therefore stay connected.
    pub fn broadcast_pressure(&self, msg: &ControlMsg) {
        debug_assert!(matches!(msg, ControlMsg::MemoryPressure { .. }));
        self.broadcast_where(msg, |entry| entry.pressure_version >= 1);
    }

    fn broadcast_where(&self, msg: &ControlMsg, include: impl Fn(&Entry) -> bool) {
        let frame = Arc::new(proto::encode(&Frame::Control(msg.clone())));
        self.entries.lock().unwrap().retain(|e| {
            if !include(e) {
                return true;
            }
            match e.tx.try_send(QueuedFrame::Frame(Arc::clone(&frame))) {
                Ok(()) => true,
                // Full: WATCHER_QUEUE_DEPTH undelivered low-rate events is
                // the bounded grace — the watcher is wedged. Dropping the
                // entry closes the queue; its forwarder severs the socket.
                Err(TrySendError::Full(_)) => false,
                // Forwarder exited (connection gone or already severed).
                Err(TrySendError::Disconnected(_)) => false,
            }
        });
    }

    /// Number of watchers still in the registry (vanished/wedged ones are
    /// pruned). Daemon-state observable for tests and diagnostics.
    pub fn watcher_count(&self) -> usize {
        self.entries.lock().unwrap().len()
    }
}

/// Per-watcher forwarder: drain the bounded queue, writing each frame to the
/// shared write half under a bounded write timeout. Exits (self-removing from
/// the registry) when the connection vanishes, a write fails/times out, or
/// the watcher is evicted (queue dropped by `broadcast`).
fn forward(
    id: u64,
    rx: Receiver<QueuedFrame>,
    weak: Weak<Mutex<UnixStream>>,
    entries: Arc<Mutex<Vec<Entry>>>,
) {
    let queue_closed = loop {
        let frame = match rx.recv() {
            Ok(frame) => frame,
            Err(_) => break true,
        };
        let frame = match frame {
            QueuedFrame::Frame(frame) => frame,
            QueuedFrame::Initial(initial) => match initial.recv() {
                Ok(frame) => frame,
                Err(_) => break true,
            },
        };
        if write_frame(&weak, &frame).is_err() {
            break false;
        }
    };
    // An evicted queue drops its last sender. Its forwarder may first drain
    // already-queued frames, but must then close the still-live connection:
    // the client missed the frame that triggered eviction and needs a full
    // resync on reconnect.
    if queue_closed {
        shutdown_writer(&weak);
    }
    // Remove by the entry's never-reused id on every exit path, including a
    // vanished writer. This happens before `weak` is dropped, so its Arc
    // allocation cannot be reused while a raw-address registry key survives.
    // (Writer guard is released above — registry and writer locks never nest.)
    entries.lock().unwrap().retain(|e| e.id != id);
}

fn shutdown_writer(weak: &Weak<Mutex<UnixStream>>) {
    let Some(writer) = weak.upgrade() else {
        return;
    };
    let s = writer.lock().unwrap();
    let _ = s.shutdown(Shutdown::Both);
}

fn write_frame(weak: &Weak<Mutex<UnixStream>>, frame: &[u8]) -> std::io::Result<()> {
    // Connection dropped its writer: nothing to write to, just exit.
    let Some(writer) = weak.upgrade() else {
        return Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "writer dropped"));
    };
    let mut s = writer.lock().unwrap();
    // Bounded hold of the shared mutex: the write can take at most
    // WRITE_TIMEOUT. The tighter timeout is scoped to this write and the
    // socket's PREVIOUS value restored afterwards — restored, not cleared,
    // because the connection carries a `daemon::CLIENT_WRITE_TIMEOUT` and
    // clearing it here would leave every later control-reply/Output write
    // on this socket unbounded again. Saving the actual value also keeps
    // this module independent of daemon.rs (unit-test pairs have none).
    let prev = s.write_timeout().ok().flatten();
    let res = s
        .set_write_timeout(Some(WRITE_TIMEOUT))
        .and_then(|()| crate::daemon::write_bounded(&mut s, frame, WRITE_TIMEOUT));
    let _ = s.set_write_timeout(prev);
    if res.is_err() {
        // Wedged (timeout) or dead. A timed-out write may have left a partial
        // frame on the stream, so it can no longer carry a reply safely.
        let _ = s.shutdown(Shutdown::Both);
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use amber_core::proto::{Decoder, SessionInfo};
    use std::io::{Read, Write};
    use std::time::Duration;

    fn read_one(stream: &mut UnixStream) -> Option<Frame> {
        let mut dec = Decoder::new();
        read_next(stream, &mut dec)
    }

    fn read_next(stream: &mut UnixStream, dec: &mut Decoder) -> Option<Frame> {
        stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut buf = [0u8; 4096];
        loop {
            if let Some(f) = dec.next_frame().unwrap() {
                return Some(f);
            }
            match stream.read(&mut buf) {
                Ok(0) => return None,
                Ok(n) => dec.feed(&buf[..n]),
                Err(_) => return None,
            }
        }
    }

    #[test]
    fn initial_snapshot_precedes_delta_queued_while_it_is_built() {
        // Hold the snapshot builder after registration. A concurrent delta
        // must queue behind the initial full set, not overtake it on the
        // forwarder and make the client overwrite a newer state as stale.
        let watchers = Arc::new(Watchers::new());
        let (mut client, server) = UnixStream::pair().unwrap();
        let writer = Arc::new(Mutex::new(server));
        let (snapshot_started_tx, snapshot_started_rx) = std::sync::mpsc::channel();
        let (finish_snapshot_tx, finish_snapshot_rx) = std::sync::mpsc::channel();
        let registering = {
            let watchers = Arc::clone(&watchers);
            let writer = Arc::clone(&writer);
            thread::spawn(move || {
                watchers.register_sessions(&writer, || {
                    snapshot_started_tx.send(()).unwrap();
                    finish_snapshot_rx.recv().unwrap();
                    vec![SessionInfo {
                        name: "before".into(),
                        cwd: "/tmp".into(),
                        kind: "shell".into(),
                        alive: true,
                        updated: 0,
                        run_state: None,
                        claude_id: None,
                        cols: 80,
                        rows: 24,
                        slot: 0,
                    }]
                });
            })
        };

        snapshot_started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let delta = ControlMsg::SessionsChanged {
            added: vec![],
            removed: vec!["before".into()],
        };
        watchers.broadcast(&delta);
        finish_snapshot_tx.send(()).unwrap();
        registering.join().unwrap();

        let mut decoder = Decoder::new();
        assert!(matches!(
            read_next(&mut client, &mut decoder),
            Some(Frame::Control(ControlMsg::Sessions { sessions }))
                if sessions.iter().any(|info| info.name == "before")
        ));
        assert_eq!(read_next(&mut client, &mut decoder), Some(Frame::Control(delta)));
    }

    #[test]
    fn pressure_watcher_snapshot_precedes_delta_queued_while_it_is_built() {
        let watchers = Arc::new(Watchers::new());
        let (mut client, server) = UnixStream::pair().unwrap();
        let writer = Arc::new(Mutex::new(server));
        watchers.register_pressure(&writer, 1);
        let (snapshot_started_tx, snapshot_started_rx) = std::sync::mpsc::channel();
        let (finish_snapshot_tx, finish_snapshot_rx) = std::sync::mpsc::channel();
        let registering = {
            let watchers = Arc::clone(&watchers);
            let writer = Arc::clone(&writer);
            thread::spawn(move || {
                watchers.register_sessions(&writer, || {
                    snapshot_started_tx.send(()).unwrap();
                    finish_snapshot_rx.recv().unwrap();
                    vec![]
                });
            })
        };
        snapshot_started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let delta = ControlMsg::SessionsChanged { added: vec![], removed: vec!["after".into()] };
        watchers.broadcast(&delta);
        finish_snapshot_tx.send(()).unwrap();
        registering.join().unwrap();

        let mut decoder = Decoder::new();
        assert!(matches!(
            read_next(&mut client, &mut decoder),
            Some(Frame::Control(ControlMsg::Sessions { sessions })) if sessions.is_empty()
        ));
        assert_eq!(read_next(&mut client, &mut decoder), Some(Frame::Control(delta)));
    }

    #[test]
    fn repeat_session_watch_snapshot_precedes_later_delta() {
        let watchers = Arc::new(Watchers::new());
        let (mut client, server) = UnixStream::pair().unwrap();
        let writer = Arc::new(Mutex::new(server));
        watchers.register(&writer);
        let (snapshot_started_tx, snapshot_started_rx) = std::sync::mpsc::channel();
        let (finish_snapshot_tx, finish_snapshot_rx) = std::sync::mpsc::channel();
        let registering = {
            let watchers = Arc::clone(&watchers);
            let writer = Arc::clone(&writer);
            thread::spawn(move || {
                watchers.register_sessions(&writer, || {
                    snapshot_started_tx.send(()).unwrap();
                    finish_snapshot_rx.recv().unwrap();
                    vec![]
                });
            })
        };
        snapshot_started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let delta = ControlMsg::SessionsChanged { added: vec![], removed: vec!["after".into()] };
        watchers.broadcast(&delta);
        finish_snapshot_tx.send(()).unwrap();
        registering.join().unwrap();

        let mut decoder = Decoder::new();
        assert!(matches!(
            read_next(&mut client, &mut decoder),
            Some(Frame::Control(ControlMsg::Sessions { sessions })) if sessions.is_empty()
        ));
        assert_eq!(read_next(&mut client, &mut decoder), Some(Frame::Control(delta)));
    }

    #[test]
    fn broadcast_reaches_live_watchers_and_prunes_dropped_ones() {
        let watchers = Watchers::new();
        let (mut client_a, server_a) = UnixStream::pair().unwrap();
        let (mut client_b, server_b) = UnixStream::pair().unwrap();
        let wa = Arc::new(Mutex::new(server_a));
        let wb = Arc::new(Mutex::new(server_b));
        watchers.register(&wa);
        watchers.register(&wb);

        let msg = ControlMsg::SessionsChanged { added: vec![], removed: vec!["x".into()] };
        watchers.broadcast(&msg);
        assert_eq!(read_one(&mut client_a), Some(Frame::Control(msg.clone())));
        assert_eq!(read_one(&mut client_b), Some(Frame::Control(msg.clone())));

        // Drop watcher B's server writer: the Weak can no longer upgrade, so
        // its forwarder exits and a subsequent broadcast prunes it.
        drop(wb);
        let msg2 = ControlMsg::SessionsChanged { added: vec![], removed: vec!["y".into()] };
        watchers.broadcast(&msg2);
        assert_eq!(read_one(&mut client_a), Some(Frame::Control(msg2)));
        let msg3 = ControlMsg::SessionsChanged { added: vec![], removed: vec!["z".into()] };
        wait_until(Duration::from_secs(5), || {
            watchers.broadcast(&msg3);
            watchers.watcher_count() == 1
        })
        .expect("dropped watcher pruned");
    }

    /// Fill `stream`'s send buffer to saturation (peer not reading), so the
    /// next blocking write on it wedges. Restores blocking mode afterward.
    fn saturate(stream: &UnixStream) {
        stream.set_nonblocking(true).unwrap();
        let junk = [0u8; 8192];
        let mut w = stream;
        loop {
            match w.write(&junk) {
                Ok(_) => continue,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(e) => panic!("saturating write failed: {e}"),
            }
        }
        stream.set_nonblocking(false).unwrap();
    }

    /// Poll `cond` until it holds or `bound` elapses. Bounded-timeout helper —
    /// generously above expected latency, never load-bearing for correctness.
    fn wait_until(bound: Duration, cond: impl Fn() -> bool) -> Result<(), ()> {
        let deadline = std::time::Instant::now() + bound;
        while !cond() {
            if std::time::Instant::now() > deadline {
                return Err(());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Ok(())
    }

    fn assert_eof(stream: &mut UnixStream) {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut buf = [0u8; 4096];
        loop {
            match stream.read(&mut buf) {
                Ok(0) => return,
                Ok(_) => {}
                Err(error) => panic!("watcher stayed connected after eviction: {error}"),
            }
        }
    }

    #[test]
    fn queue_full_behind_initial_snapshot_evicts_and_closes_the_client() {
        // A full queue while the initial barrier is held drops a delta. The
        // client must be disconnected, not left subscribed without that delta.
        let watchers = Arc::new(Watchers::new());
        let (mut client, server) = UnixStream::pair().unwrap();
        let writer = Arc::new(Mutex::new(server));
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        let registering = {
            let watchers = Arc::clone(&watchers);
            let writer = Arc::clone(&writer);
            thread::spawn(move || {
                watchers.register_sessions(&writer, || {
                    started_tx.send(()).unwrap();
                    finish_rx.recv().unwrap();
                    vec![]
                });
            })
        };

        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        for index in 0..=WATCHER_QUEUE_DEPTH {
            watchers.broadcast(&ControlMsg::SessionsChanged {
                added: vec![],
                removed: vec![index.to_string()],
            });
        }
        assert_eq!(watchers.watcher_count(), 0, "full queue must evict watcher");

        finish_tx.send(()).unwrap();
        registering.join().unwrap();
        assert_eof(&mut client);
        assert_eq!(watchers.watcher_count(), 0);
        drop(writer);
    }

    #[test]
    fn repeat_initial_snapshot_with_full_queue_evicts_and_closes_the_client() {
        // Repeating WatchSessions is an Initial queue write too. If it cannot
        // fit behind the held snapshot, the client must reconnect for a full
        // resync rather than remain connected with no watcher entry.
        let watchers = Arc::new(Watchers::new());
        let (mut client, server) = UnixStream::pair().unwrap();
        let writer = Arc::new(Mutex::new(server));
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        let registering = {
            let watchers = Arc::clone(&watchers);
            let writer = Arc::clone(&writer);
            thread::spawn(move || {
                watchers.register_sessions(&writer, || {
                    started_tx.send(()).unwrap();
                    finish_rx.recv().unwrap();
                    vec![]
                });
            })
        };

        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        for index in 0..WATCHER_QUEUE_DEPTH {
            watchers.broadcast(&ControlMsg::SessionsChanged {
                added: vec![],
                removed: vec![index.to_string()],
            });
        }
        watchers.register_sessions(&writer, || panic!("full repeat must not build a snapshot"));
        assert_eq!(
            watchers.watcher_count(),
            0,
            "full repeat must evict watcher"
        );

        finish_tx.send(()).unwrap();
        registering.join().unwrap();
        assert_eof(&mut client);
        assert_eq!(watchers.watcher_count(), 0);
        drop(writer);
    }

    #[test]
    fn wedged_watcher_does_not_block_broadcast_or_starve_healthy_watcher() {
        // One watcher whose peer never reads (socket buffer saturated) must
        // not block broadcast() — the caller is a connection read thread or
        // the snapshot timer — and must not delay delivery to a healthy
        // watcher. Registered FIRST so a blocking implementation wedges
        // before ever reaching the healthy one.
        let watchers = Arc::new(Watchers::new());
        let (_wedged_peer, wedged_server) = UnixStream::pair().unwrap();
        let (mut healthy_peer, healthy_server) = UnixStream::pair().unwrap();
        saturate(&wedged_server);
        let wedged = Arc::new(Mutex::new(wedged_server));
        let healthy = Arc::new(Mutex::new(healthy_server));
        watchers.register(&wedged);
        watchers.register(&healthy);

        let msg = ControlMsg::SessionsChanged { added: vec![], removed: vec!["x".into()] };
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        {
            let watchers = Arc::clone(&watchers);
            let msg = msg.clone();
            std::thread::spawn(move || {
                watchers.broadcast(&msg);
                let _ = done_tx.send(());
            });
        }
        // Bounded well above any legitimate latency: broadcast must return
        // promptly, not after (or never after) the wedged socket drains.
        done_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("broadcast blocked on a wedged watcher");
        assert_eq!(
            read_one(&mut healthy_peer),
            Some(Frame::Control(msg)),
            "healthy watcher starved by the wedged one"
        );
    }

    #[test]
    fn persistently_wedged_watcher_is_evicted_from_registry() {
        // A watcher that stays wedged past the bounded grace must be dropped
        // from the registry (laggard eviction, mirroring pty.rs) — losing a
        // wedged watcher's subscription is acceptable; a permanently blocked
        // daemon thread is not. Assert daemon-side state (registry count).
        let watchers = Arc::new(Watchers::new());
        let (_wedged_peer, wedged_server) = UnixStream::pair().unwrap();
        let (mut healthy_peer, healthy_server) = UnixStream::pair().unwrap();
        saturate(&wedged_server);
        let wedged = Arc::new(Mutex::new(wedged_server));
        let healthy = Arc::new(Mutex::new(healthy_server));
        watchers.register_pressure(&wedged, 1);
        watchers.register_pressure(&healthy, 1);
        assert_eq!(watchers.watcher_count(), 2);

        // Repeated pressure refreshes ride this same bounded queue. The healthy
        // watcher receives every one while the non-reader fills its grace and
        // is evicted; pressure uses the same bounded per-connection queue once
        // the connection explicitly opts in.
        for current_kb in 0..=(WATCHER_QUEUE_DEPTH as u64) {
            let msg = ControlMsg::MemoryPressure {
                level: "critical".into(),
                current_kb,
                budget_kb: 100,
                blocked: false,
            };
            watchers.broadcast_pressure(&msg);
            assert_eq!(read_one(&mut healthy_peer), Some(Frame::Control(msg)));
        }
        // The wedged one is evicted after a bounded grace (generous bound,
        // far above the eviction deadline, so CI load can't flake it).
        wait_until(Duration::from_secs(15), || watchers.watcher_count() == 1)
            .expect("persistently wedged watcher was never evicted");
    }

    #[test]
    fn wedged_watchers_shared_writer_mutex_is_released_within_bounded_time() {
        // The wedged watcher's write half is SHARED with its connection's
        // control-reply writes. A wedged forwarder may delay an unrelated
        // thread on that mutex only briefly (<= one WRITE_TIMEOUT), never
        // block it forever.
        let watchers = Arc::new(Watchers::new());
        let (_peer, server) = UnixStream::pair().unwrap();
        saturate(&server);
        let wedged = Arc::new(Mutex::new(server));
        watchers.register(&wedged);
        watchers.broadcast(&ControlMsg::SessionsChanged { added: vec![], removed: vec![] });

        // Simulate the connection read thread replying through the shared
        // mutex while the forwarder is wedged mid-write.
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        {
            let wedged = Arc::clone(&wedged);
            std::thread::spawn(move || {
                let s = wedged.lock().unwrap();
                drop(s);
                let _ = done_tx.send(());
            });
        }
        done_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("shared writer mutex held beyond the bounded write timeout");
    }

    #[test]
    fn vanished_watcher_is_removed_before_reconnect_merges_capabilities() {
        let watchers = Watchers::new();
        let (_old_peer, old_server) = UnixStream::pair().unwrap();
        let old = Arc::new(Mutex::new(old_server));
        watchers.register(&old);
        drop(old);

        // Wake the forwarder so it observes the vanished writer. Its stale
        // entry must be gone before a reconnect can be mistaken for it after
        // allocator address reuse.
        watchers.broadcast(&ControlMsg::SessionsChanged {
            added: vec![],
            removed: vec![],
        });
        wait_until(Duration::from_secs(5), || watchers.watcher_count() == 0)
            .expect("vanished watcher left a stale registry entry");

        let (mut peer, server) = UnixStream::pair().unwrap();
        let reconnect = Arc::new(Mutex::new(server));
        watchers.register(&reconnect);
        watchers.register_pressure(&reconnect, 1);
        assert_eq!(
            watchers.watcher_count(),
            1,
            "one live writer gets one merged entry"
        );

        let sessions = ControlMsg::SessionsChanged {
            added: vec![],
            removed: vec!["reconnected".into()],
        };
        watchers.broadcast(&sessions);
        assert_eq!(read_one(&mut peer), Some(Frame::Control(sessions)));

        let pressure = ControlMsg::MemoryPressure {
            level: "warning".into(),
            current_kb: 80,
            budget_kb: 100,
            blocked: false,
        };
        watchers.broadcast_pressure(&pressure);
        assert_eq!(read_one(&mut peer), Some(Frame::Control(pressure)));
    }
}
