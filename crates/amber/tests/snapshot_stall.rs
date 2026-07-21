//! A snapshot must not stop the user typing.
//!
//! Measured on a live daemon: every 10 s (the snapshot interval) input froze for
//! ~3.5 s and then every queued keystroke landed at once, while output kept
//! flowing the whole time. `snapshot_inner` held the `sessions` lock across all
//! of its work, and `write()` — the path an `Input` frame takes — needs that
//! same lock. Output was unaffected because the pty fan-out never takes it.
//!
//! The cost itself was `is_running_claude()`, which built a FULL process table
//! (including `/proc/<pid>/smaps_rollup` for every process on the machine, which
//! the check does not even use) once PER SESSION: 781 processes → 491 ms a scan,
//! ~91 % of it the unused RSS read, times one scan per shell session.

use amber::manager::SessionManager;
use amber_core::state::SessionKind;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tempfile::tempdir;

/// Generous: the point is to catch a multi-SECOND freeze, not to police jitter.
const MAX_BLOCKED: Duration = Duration::from_millis(400);

#[test]
fn snapshot_does_not_block_input() {
    let dir = tempdir().unwrap();
    let mgr = Arc::new(SessionManager::new(dir.path()).unwrap());
    // Shell sessions are the ones snapshot runs the claude detection for.
    for i in 0..4 {
        mgr.create(&format!("amber-1-1-{i}-s{i}"), "/tmp", SessionKind::Shell)
            .unwrap();
    }

    let stop = Arc::new(AtomicBool::new(false));
    let snapshotter = {
        let mgr = Arc::clone(&mgr);
        let stop = Arc::clone(&stop);
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                mgr.snapshot().unwrap();
                // Mimic the real snapshot TIMER. Without a gap the loop
                // re-acquires the lock the instant it releases it and starves
                // the writer outright (Rust mutexes are not fair) — which hangs
                // the test instead of measuring anything.
                std::thread::sleep(Duration::from_millis(100));
            }
        })
    };

    // Type into a session while snapshots run and record the worst stall.
    let mut worst = Duration::ZERO;
    let deadline = Instant::now() + Duration::from_secs(4);
    while Instant::now() < deadline {
        let t = Instant::now();
        let _ = mgr.write("amber-1-1-0-s0", b"x");
        worst = worst.max(t.elapsed());
        std::thread::sleep(Duration::from_millis(10));
    }

    stop.store(true, Ordering::Relaxed);
    snapshotter.join().unwrap();

    assert!(
        worst < MAX_BLOCKED,
        "a keystroke waited {worst:?} on the snapshot (limit {MAX_BLOCKED:?}) — \
         the sessions lock is being held across snapshot work again"
    );
}
