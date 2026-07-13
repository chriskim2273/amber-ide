//! Slice 0 exit test (library level): sessions and their scrollback survive a
//! full SessionManager teardown + fresh restore, and a detached session gets a
//! real pty size (the point-4 "detached child at boot" trap).

use amber::manager::SessionManager;
use amber::pty::PtySession;
use amber_core::state::SessionKind;
use std::time::{Duration, Instant};

fn wait_contains(sess: &PtySession, needle: &[u8]) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let sb = sess.scrollback();
        if sb.windows(needle.len()).any(|w| w == needle) {
            return;
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
fn sessions_and_scrollback_survive_manager_restart() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();

    // First "daemon": create a shell session, produce output, snapshot, die.
    {
        let mgr = SessionManager::new(root).unwrap();
        let sess = mgr.create("work", "/tmp", SessionKind::Shell).unwrap();
        mgr.write("work", b"echo PERSIST_ME_42\n").unwrap();
        wait_contains(&sess, b"PERSIST_ME_42");
        mgr.snapshot().unwrap();
    } // mgr dropped == daemon death; children reaped as the ptys close.

    // Second "daemon": restore from the same state dir.
    let mgr2 = SessionManager::new(root).unwrap();
    mgr2.restore().unwrap();

    assert_eq!(mgr2.names(), vec!["work".to_string()]);
    let restored = mgr2.session("work").unwrap();
    let sb = restored.scrollback();
    assert!(
        sb.windows(13).any(|w| w == b"PERSIST_ME_42"),
        "restored scrollback missing persisted output: {:?}",
        String::from_utf8_lossy(&sb)
    );
    assert!(restored.is_alive(), "restored session should be running");
}

#[test]
fn detached_session_has_a_real_pty_size() {
    // A session with NO subscriber (detached, as at boot) must still have a
    // proper pty size — never 0x0 — so a size-sensitive child behaves.
    let dir = tempfile::tempdir().unwrap();
    let mgr = SessionManager::new(dir.path()).unwrap();
    let sess = mgr.create("t", "/tmp", SessionKind::Shell).unwrap();
    mgr.write("t", b"stty size\n").unwrap();
    wait_contains(&sess, b"24 80"); // rows cols, as configured at spawn
}
