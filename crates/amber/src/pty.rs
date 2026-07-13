//! One owned pty + child process, with a reader thread that fans output into a
//! capped scrollback [`Ring`] and to any live subscribers.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;

use amber_core::ring::Ring;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

/// Bounded per-subscriber output queue depth (in chunks). When a subscriber
/// falls this far behind, the reader thread blocks on it — backpressuring the
/// pty and thus the child — so memory stays flat (spec §9, e.g. `cat` of a
/// huge file). Caveat: a fully-stalled subscriber backpressures the whole
/// session; per-subscriber isolation (drop only the laggard) is a refinement.
const SUBSCRIBER_QUEUE_DEPTH: usize = 256;

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
    next_sub_id: AtomicU64,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    exit: Arc<Mutex<Option<i32>>>,
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
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;

        let ring = Arc::new(Mutex::new(Ring::new(cap)));
        let subs: Arc<Mutex<Subscribers>> = Arc::new(Mutex::new(Vec::new()));

        // Reader thread: append to ring, fan out to live subscribers. Senders
        // are snapshotted (subs lock released) BEFORE the blocking send, so a
        // backpressured send never wedges subscribe(); dead subscribers
        // (receiver dropped) are pruned afterward.
        {
            let ring = Arc::clone(&ring);
            let subs = Arc::clone(&subs);
            thread::spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let chunk = &buf[..n];
                            ring.lock().unwrap().push(chunk);
                            let senders: Subscribers =
                                subs.lock().unwrap().clone();
                            let mut dead = Vec::new();
                            for (id, tx) in &senders {
                                // Blocking send == backpressure when the bounded
                                // queue is full.
                                if tx.send(chunk.to_vec()).is_err() {
                                    dead.push(*id);
                                }
                            }
                            if !dead.is_empty() {
                                subs.lock().unwrap().retain(|(id, _)| !dead.contains(id));
                            }
                        }
                        Err(_) => break,
                    }
                }
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
            next_sub_id: AtomicU64::new(0),
            killer: Mutex::new(killer),
            exit,
        })
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
    /// output — no bytes lost or duplicated across the handoff.
    pub fn subscribe(&self) -> (Vec<u8>, Receiver<Vec<u8>>) {
        let ring = self.ring.lock().unwrap();
        let backlog = ring.snapshot();
        let (tx, rx) = sync_channel(SUBSCRIBER_QUEUE_DEPTH);
        let id = self.next_sub_id.fetch_add(1, Ordering::Relaxed);
        self.subs.lock().unwrap().push((id, tx));
        drop(ring);
        (backlog, rx)
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
        let (backlog, rx) = sess.subscribe();
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
        let (_backlog, _rx) = sess.subscribe();
        std::thread::sleep(Duration::from_millis(700));
        assert!(
            !sentinel.exists(),
            "producer finished despite a stalled subscriber — no backpressure"
        );
    }

    #[test]
    fn dead_subscriber_does_not_wedge_reader() {
        // Dropping a subscriber's receiver must not stall the reader: output
        // keeps flowing to the ring after the dead one is pruned.
        let cmd = CommandBuilder::new("cat");
        let sess = PtySession::spawn(cmd, 24, 80, 4096).unwrap();
        let (_backlog, rx) = sess.subscribe();
        drop(rx); // subscriber goes away
        sess.write(b"AFTER_DROP\n").unwrap();
        wait_for(&sess, b"AFTER_DROP");
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
