//! One owned pty + child process, with a reader thread that fans output into a
//! capped scrollback [`Ring`] and to any live subscribers.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;

use amber_core::ring::Ring;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

/// Bounded per-subscriber output queue depth (in chunks). Memory per
/// subscriber stays flat at `depth * read-chunk` (spec §9, e.g. `cat` of a
/// huge file).
const SUBSCRIBER_QUEUE_DEPTH: usize = 256;

/// Retry cadence while at least one subscriber's queue is full.
const STALL_POLL: std::time::Duration = std::time::Duration::from_millis(2);

/// Rounds of [`STALL_POLL`] a full subscriber is tolerated for WHILE other
/// subscribers are making progress (~300 ms). Spec §9 isolation: when every
/// subscriber is saturated the reader blocks (true backpressure — the child
/// throttles, memory stays flat); but a lone laggard holding back healthy
/// subscribers is disconnected after this bound instead of freezing the
/// session. A disconnected laggard's byte stream simply ends — bytes are
/// never skipped for a live subscriber.
const STALL_ROUND_LIMIT: u32 = 150;

/// Live subscribers: `(id, bounded sender)`. The id lets the reader prune a
/// specific dead subscriber after a snapshot-then-send.
type Subscribers = Vec<(u64, SyncSender<Vec<u8>>)>;

/// A live session: owns the pty master, the child's writer, the scrollback
/// ring, and the subscriber list. Reader and waiter run on dedicated threads
/// (portable-pty's reader is a blocking `std::io::Read`).
pub struct PtySession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    ring: Arc<Mutex<Ring>>,
    subs: Arc<Mutex<Subscribers>>,
    /// Set by the reader thread (under the `subs` lock) once the pty hits
    /// EOF. After that nobody will ever clear a newly-registered sender, so
    /// `subscribe` must hand out an already-closed channel instead.
    reader_done: Arc<std::sync::atomic::AtomicBool>,
    next_sub_id: AtomicU64,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    exit: Arc<Mutex<Option<i32>>>,
    /// The child's OS process id, captured at spawn (for reading its live cwd
    /// via /proc/<pid>/cwd so `cd` inside a shell survives restart).
    pid: Option<u32>,
}

/// Fan one chunk out to every subscriber, returning the ids to prune.
///
/// Every live subscriber receives every chunk in order (no skips, no
/// corruption). A subscriber whose queue stays full is handled per spec §9:
/// - all subscribers saturated -> retry forever (backpressure: the reader
///   stops draining the pty, the child blocks, memory stays flat);
/// - some subscribers progressing -> the full one is a laggard; after
///   [`STALL_ROUND_LIMIT`] rounds it is disconnected so it cannot freeze the
///   healthy ones.
fn deliver_chunk(chunk: &[u8], senders: Subscribers) -> Vec<u64> {
    use std::sync::mpsc::TrySendError;

    let mut dead: Vec<u64> = Vec::new();
    let mut pending: Vec<(u64, SyncSender<Vec<u8>>, Vec<u8>)> = senders
        .into_iter()
        .map(|(id, tx)| (id, tx, chunk.to_vec()))
        .collect();
    let mut delivered_any = false;
    let mut stall_rounds = 0u32;

    loop {
        pending = pending
            .into_iter()
            .filter_map(|(id, tx, payload)| match tx.try_send(payload) {
                Ok(()) => {
                    delivered_any = true;
                    None
                }
                Err(TrySendError::Full(payload)) => Some((id, tx, payload)),
                Err(TrySendError::Disconnected(_)) => {
                    dead.push(id);
                    None
                }
            })
            .collect();
        if pending.is_empty() {
            break;
        }
        if delivered_any {
            stall_rounds += 1;
            if stall_rounds >= STALL_ROUND_LIMIT {
                dead.extend(pending.iter().map(|(id, _, _)| *id));
                break;
            }
        }
        thread::sleep(STALL_POLL);
    }
    dead
}

impl PtySession {
    /// Spawn `cmd` in a fresh pty of `rows`x`cols`, retaining at most `cap`
    /// bytes of scrollback.
    pub fn spawn(cmd: CommandBuilder, rows: u16, cols: u16, cap: usize) -> anyhow::Result<Self> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let mut child = pair.slave.spawn_command(cmd)?;
        // Drop the local slave so the reader sees EOF once the child exits.
        drop(pair.slave);

        let killer = child.clone_killer();
        let pid = child.process_id();
        // If pty plumbing fails after the spawn, don't leak the child.
        let mut reader = match pair.master.try_clone_reader() {
            Ok(r) => r,
            Err(e) => {
                let _ = child.kill();
                return Err(e);
            }
        };
        let writer = match pair.master.take_writer() {
            Ok(w) => w,
            Err(e) => {
                let _ = child.kill();
                return Err(e);
            }
        };

        let ring = Arc::new(Mutex::new(Ring::new(cap)));
        let subs: Arc<Mutex<Subscribers>> = Arc::new(Mutex::new(Vec::new()));
        let reader_done = Arc::new(std::sync::atomic::AtomicBool::new(false));

        // Reader thread: append to ring, fan out to live subscribers. Senders
        // are snapshotted (subs lock released) BEFORE the blocking send, so a
        // backpressured send never wedges subscribe(); dead subscribers
        // (receiver dropped) are pruned afterward.
        {
            let ring = Arc::clone(&ring);
            let subs = Arc::clone(&subs);
            let reader_done = Arc::clone(&reader_done);
            thread::spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let chunk = &buf[..n];
                            // Push to the ring and snapshot the subscriber
                            // list while STILL holding the ring lock —
                            // subscribe() takes ring-then-subs in the same
                            // order, so a subscriber can never slip in
                            // between the push and the snapshot (which would
                            // hand it this chunk both in its backlog and via
                            // its channel).
                            let senders: Subscribers = {
                                let mut ring_guard = ring.lock().unwrap();
                                ring_guard.push(chunk);
                                subs.lock().unwrap().clone()
                            };
                            let dead = deliver_chunk(chunk, senders);
                            if !dead.is_empty() {
                                subs.lock().unwrap().retain(|(id, _)| !dead.contains(id));
                            }
                        }
                        Err(_) => break,
                    }
                }
                // Pty EOF/read error: the child is gone. Drop every
                // subscriber's sender so their channels close — attached
                // clients must observe the pane ending, not silence. The
                // done-flag is set under the same lock `subscribe` takes, so
                // a late subscriber can never register a sender that nobody
                // will clear.
                let mut subs = subs.lock().unwrap();
                reader_done.store(true, Ordering::SeqCst);
                subs.clear();
            });
        }

        // Waiter thread: record the exit code once the child dies.
        let exit = Arc::new(Mutex::new(None));
        {
            let exit = Arc::clone(&exit);
            thread::spawn(move || {
                if let Ok(status) = child.wait() {
                    *exit.lock().unwrap() = Some(status.exit_code() as i32);
                }
            });
        }

        Ok(PtySession {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            ring,
            subs,
            reader_done,
            next_sub_id: AtomicU64::new(0),
            killer: Mutex::new(killer),
            exit,
            pid,
        })
    }

    /// The child's OS process id (None if the platform didn't report one).
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// The child process's current working directory, read live from
    /// `/proc/<pid>/cwd`. For a shell this tracks the user's `cd`s, so it can be
    /// snapshotted and restored. None if unavailable (no pid, not Linux, the
    /// process is gone, or the link can't be read).
    pub fn live_cwd(&self) -> Option<std::path::PathBuf> {
        let pid = self.pid?;
        std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
    }

    /// Write bytes to the child's stdin.
    pub fn write(&self, data: &[u8]) -> anyhow::Result<()> {
        let mut w = self.writer.lock().unwrap();
        w.write_all(data)?;
        w.flush()?;
        Ok(())
    }

    /// Resize the pty (delivers SIGWINCH to the child).
    pub fn resize(&self, rows: u16, cols: u16) -> anyhow::Result<()> {
        self.master.lock().unwrap().resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    /// Current scrollback contents (oldest byte first).
    pub fn scrollback(&self) -> Vec<u8> {
        self.ring.lock().unwrap().snapshot()
    }

    /// Seed the ring with persisted history (used on restore, before live output).
    pub fn preload(&self, bytes: &[u8]) {
        self.ring.lock().unwrap().push(bytes);
    }

    /// Atomically capture the current scrollback and start receiving live
    /// output — no bytes lost or duplicated across the handoff. Returns the
    /// subscriber id (for [`unsubscribe`](Self::unsubscribe)), the backlog,
    /// and the live receiver.
    pub fn subscribe(&self) -> (u64, Vec<u8>, Receiver<Vec<u8>>) {
        let ring = self.ring.lock().unwrap();
        let backlog = ring.snapshot();
        let (tx, rx) = sync_channel(SUBSCRIBER_QUEUE_DEPTH);
        let id = self.next_sub_id.fetch_add(1, Ordering::Relaxed);
        {
            let mut subs = self.subs.lock().unwrap();
            // If the pty already hit EOF the reader will never clear this
            // sender; drop it now so the subscriber sees a closed channel
            // (backlog still delivered above).
            if !self.reader_done.load(Ordering::SeqCst) {
                subs.push((id, tx));
            }
        }
        drop(ring);
        (id, backlog, rx)
    }

    /// Drop a subscriber's sender so its channel closes and it stops
    /// receiving output. Used when a client detaches or its connection dies;
    /// without this an idle session (no output to flush the dead sender out)
    /// would keep the subscription and its forwarder thread alive forever.
    pub fn unsubscribe(&self, id: u64) {
        self.subs.lock().unwrap().retain(|(sid, _)| *sid != id);
    }

    /// Number of live subscribers (dead/laggard ones are pruned by the
    /// reader thread).
    pub fn subscriber_count(&self) -> usize {
        self.subs.lock().unwrap().len()
    }

    /// Exit code if the child has exited, else `None`.
    pub fn exit_code(&self) -> Option<i32> {
        *self.exit.lock().unwrap()
    }

    pub fn is_alive(&self) -> bool {
        self.exit_code().is_none()
    }

    /// Terminate the child.
    pub fn kill(&self) -> anyhow::Result<()> {
        self.killer.lock().unwrap().kill()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use portable_pty::CommandBuilder;
    use std::time::{Duration, Instant};

    fn wait_for(sess: &PtySession, needle: &[u8]) -> Vec<u8> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let sb = sess.scrollback();
            if sb.windows(needle.len()).any(|w| w == needle) {
                return sb;
            }
            if Instant::now() > deadline {
                panic!(
                    "timed out waiting for {:?}; got {:?}",
                    String::from_utf8_lossy(needle),
                    String::from_utf8_lossy(&sb)
                );
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn captures_child_output_into_ring() {
        let mut cmd = CommandBuilder::new("sh");
        cmd.arg("-c");
        cmd.arg("printf amber-hello");
        let sess = PtySession::spawn(cmd, 24, 80, 4096).unwrap();
        wait_for(&sess, b"amber-hello");
    }

    #[test]
    fn write_reaches_child_and_echoes_back() {
        let cmd = CommandBuilder::new("cat");
        let sess = PtySession::spawn(cmd, 24, 80, 4096).unwrap();
        sess.write(b"ping-pong\n").unwrap();
        wait_for(&sess, b"ping-pong");
    }

    #[test]
    fn subscriber_receives_live_output_with_backlog() {
        let mut cmd = CommandBuilder::new("sh");
        cmd.arg("-c");
        cmd.arg("printf first-; sleep 0.2; printf second-live");
        let sess = PtySession::spawn(cmd, 24, 80, 4096).unwrap();
        // give "first-" time to land in the ring
        wait_for(&sess, b"first-");
        let (_id, backlog, rx) = sess.subscribe();
        assert!(
            backlog.windows(6).any(|w| w == b"first-"),
            "backlog should contain already-produced bytes"
        );
        // now collect live bytes until the post-subscribe output arrives
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut acc = Vec::new();
        while Instant::now() < deadline {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(200)) {
                acc.extend_from_slice(&chunk);
                if acc.windows(11).any(|w| w == b"second-live") {
                    return;
                }
            }
        }
        panic!("no live bytes; got {:?}", String::from_utf8_lossy(&acc));
    }

    #[test]
    fn preload_seeds_ring_for_restore() {
        // A restored session should show its persisted scrollback immediately.
        let cmd = CommandBuilder::new("cat");
        let sess = PtySession::spawn(cmd, 24, 80, 4096).unwrap();
        sess.preload(b"RESTORED-HISTORY\n");
        assert!(sess
            .scrollback()
            .windows(16)
            .any(|w| w == b"RESTORED-HISTORY"));
    }

    #[test]
    fn slow_subscriber_backpressures_producer() {
        // A subscriber that never drains must throttle the child: the reader
        // blocks on the full bounded queue, the pty fills, and the producer
        // can't finish. With an UNBOUNDED queue the reader would drain forever
        // (memory ballooning) and the producer would reach the sentinel.
        let dir = tempfile::tempdir().unwrap();
        let sentinel = dir.path().join("done");
        let mut cmd = CommandBuilder::new("sh");
        cmd.arg("-c");
        cmd.arg(format!(
            "yes PADDING_LINE_TO_FILL_THE_PIPE | head -n 400000; : > '{}'",
            sentinel.display()
        ));
        let sess = PtySession::spawn(cmd, 24, 80, 4096).unwrap();
        // Subscribe but NEVER read from rx — hold it so the channel fills.
        let (_id, _backlog, _rx) = sess.subscribe();
        std::thread::sleep(Duration::from_millis(700));
        assert!(
            !sentinel.exists(),
            "producer finished despite a stalled subscriber — no backpressure"
        );
    }

    #[test]
    fn stalled_subscriber_does_not_freeze_healthy_subscriber() {
        // Spec §9 isolation: one fully-stalled subscriber must not
        // backpressure the whole session when another subscriber is healthy.
        // The laggard is disconnected after a bounded grace; the healthy one
        // keeps receiving and the producer completes.
        let dir = tempfile::tempdir().unwrap();
        let sentinel = dir.path().join("done");
        let mut cmd = CommandBuilder::new("sh");
        cmd.arg("-c");
        cmd.arg(format!(
            "yes PADDING_LINE_TO_FILL_THE_PIPE | head -n 400000; : > '{}'",
            sentinel.display()
        ));
        let sess = Arc::new(PtySession::spawn(cmd, 24, 80, 4096).unwrap());

        // Stalled: subscribed but NEVER drained (receiver kept alive).
        let (_id1, _b1, rx_stalled) = sess.subscribe();
        // Healthy: drained continuously on its own thread.
        let (_id2, _b2, rx_healthy) = sess.subscribe();
        let drained = Arc::new(AtomicU64::new(0));
        {
            let drained = Arc::clone(&drained);
            std::thread::spawn(move || {
                while let Ok(chunk) = rx_healthy.recv_timeout(Duration::from_secs(5)) {
                    drained.fetch_add(chunk.len() as u64, Ordering::Relaxed);
                }
            });
        }

        let deadline = Instant::now() + Duration::from_secs(20);
        while !sentinel.exists() {
            assert!(
                Instant::now() < deadline,
                "producer never finished: the stalled subscriber froze the session \
                 (healthy subscriber drained {} bytes)",
                drained.load(Ordering::Relaxed)
            );
            std::thread::sleep(Duration::from_millis(50));
        }

        // The laggard must have been disconnected; the healthy one survives.
        let deadline = Instant::now() + Duration::from_secs(5);
        while sess.subscriber_count() > 1 {
            assert!(Instant::now() < deadline, "stalled subscriber was never pruned");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(drained.load(Ordering::Relaxed) > 0, "healthy subscriber got nothing");
        drop(rx_stalled);
    }

    #[test]
    fn dead_subscriber_does_not_wedge_reader() {
        // Dropping a subscriber's receiver must not stall the reader: output
        // keeps flowing to the ring after the dead one is pruned.
        let cmd = CommandBuilder::new("cat");
        let sess = PtySession::spawn(cmd, 24, 80, 4096).unwrap();
        let (_id, _backlog, rx) = sess.subscribe();
        drop(rx); // subscriber goes away
        sess.write(b"AFTER_DROP\n").unwrap();
        wait_for(&sess, b"AFTER_DROP");
    }

    #[test]
    fn subscribe_backlog_and_live_never_duplicate_or_lose_bytes() {
        // Invariant: for any subscriber, backlog + live bytes must be an
        // exact suffix of the session's final stream — a subscriber added
        // between the ring push and the fan-out must not receive the same
        // chunk twice (once in backlog, once live) or miss it entirely.
        let mut cmd = CommandBuilder::new("sh");
        cmd.arg("-c");
        cmd.arg("seq 1 20000");
        let sess = Arc::new(PtySession::spawn(cmd, 24, 80, 8 * 1024 * 1024).unwrap());

        let mut handles = Vec::new();
        for i in 0..16 {
            let sess = Arc::clone(&sess);
            handles.push(std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(3 * i as u64));
                let (_id, backlog, rx) = sess.subscribe();
                let mut acc = backlog;
                // Drain until the channel closes (child exit closes it). A wide
                // idle bound — NOT a mid-stream gap timeout — so a scheduling
                // stall can't end the drain early and yield a middle segment
                // (which would fail the suffix invariant under load).
                while let Ok(chunk) = rx.recv_timeout(Duration::from_secs(10)) {
                    acc.extend_from_slice(&chunk);
                }
                acc
            }));
        }

        // Wait for the child to finish and output to settle.
        let deadline = Instant::now() + Duration::from_secs(10);
        while sess.is_alive() {
            assert!(Instant::now() < deadline, "producer never finished");
            std::thread::sleep(Duration::from_millis(20));
        }

        let streams: Vec<Vec<u8>> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        let full = sess.scrollback();
        for (i, s) in streams.iter().enumerate() {
            assert!(
                full.ends_with(s),
                "subscriber {i}: backlog+live is not a suffix of the final stream \
                 (duplicated or lost bytes at the subscribe boundary); \
                 got {} bytes vs full {} bytes",
                s.len(),
                full.len()
            );
        }
    }

    #[test]
    fn subscriber_channel_closes_when_child_exits() {
        // When the child exits, subscribers must see their channel close
        // (sender dropped) instead of blocking forever on a silent session —
        // this is what lets the daemon tell attached clients the pane ended.
        let mut cmd = CommandBuilder::new("sh");
        cmd.arg("-c");
        cmd.arg("printf bye");
        let sess = PtySession::spawn(cmd, 24, 80, 4096).unwrap();
        let (_id, _backlog, rx) = sess.subscribe();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(_) => {}                                      // live bytes
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return, // closed: pass
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    assert!(
                        Instant::now() < deadline,
                        "channel never closed after child exit"
                    );
                }
            }
        }
    }

    #[test]
    fn subscribe_after_child_exit_yields_closed_channel() {
        // Attaching to a session whose child already died must yield an
        // immediately-closed channel (backlog still readable), not a sender
        // that nothing will ever clear — the reader thread has already
        // exited, so nobody else can close it.
        let mut cmd = CommandBuilder::new("sh");
        cmd.arg("-c");
        cmd.arg("printf gone");
        let sess = PtySession::spawn(cmd, 24, 80, 4096).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while sess.is_alive() {
            assert!(Instant::now() < deadline, "child never exited");
            std::thread::sleep(Duration::from_millis(10));
        }
        wait_for(&sess, b"gone"); // reader has drained the output
        let (_id, backlog, rx) = sess.subscribe();
        assert!(backlog.windows(4).any(|w| w == b"gone"));
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(_) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => assert!(
                    Instant::now() < deadline,
                    "channel from a post-exit subscribe never closed"
                ),
            }
        }
    }

    #[test]
    fn exit_code_observed_after_child_exits() {
        let mut cmd = CommandBuilder::new("sh");
        cmd.arg("-c");
        cmd.arg("exit 3");
        let sess = PtySession::spawn(cmd, 24, 80, 4096).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(code) = sess.exit_code() {
                assert_eq!(code, 3);
                assert!(!sess.is_alive());
                return;
            }
            if Instant::now() > deadline {
                panic!("child never reported exit");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
