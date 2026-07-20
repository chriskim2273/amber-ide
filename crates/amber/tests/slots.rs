//! Stable session slots (spec `2026-07-19-stable-session-slots-design.md`):
//! the number `amber ls` prints and `amber attach <n>` resolves belongs to the
//! session, not to its position in the list. It survives a daemon restart and
//! another session's death.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::time::Duration;

use amber::daemon::{prepare_socket, Daemon};
use amber::manager::SessionManager;
use amber::watchers::Watchers;
use amber_core::proto::{self, ControlMsg, Decoder, Frame};
use amber_core::state::SessionKind;

fn slots(mgr: &SessionManager) -> Vec<(String, u32)> {
    mgr.session_infos().unwrap().into_iter().map(|i| (i.name, i.slot)).collect()
}

#[test]
fn slots_survive_a_daemon_restart_against_the_same_state_dir() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();

    {
        let mgr = SessionManager::new(root).unwrap();
        for n in ["a", "b", "c"] {
            mgr.create(n, "/tmp", SessionKind::Shell).unwrap();
        }
        // Kill the middle one: the survivors must not renumber.
        mgr.remove("b").unwrap();
        assert_eq!(slots(&mgr), vec![("a".into(), 1), ("c".into(), 3)]);
        mgr.snapshot().unwrap();
    } // manager dropped == daemon death

    let mgr2 = SessionManager::new(root).unwrap();
    mgr2.restore().unwrap();
    assert_eq!(
        slots(&mgr2),
        vec![("a".into(), 1), ("c".into(), 3)],
        "slots must be restored from the store, not re-derived from position"
    );

    // A create after the restart still takes the lowest free number.
    mgr2.create("d", "/tmp", SessionKind::Shell).unwrap();
    assert_eq!(
        slots(&mgr2),
        vec![("a".into(), 1), ("c".into(), 3), ("d".into(), 2)]
    );
}

#[test]
fn attach_by_slot_resolves_the_right_session_over_the_socket() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("amberd.sock");
    let manager = Arc::new(SessionManager::new(dir.path()).unwrap());
    let watchers = Arc::new(Watchers::new());
    let listener = prepare_socket(&sock).unwrap();
    let daemon = Daemon::new(Arc::clone(&manager), Arc::clone(&watchers));
    std::thread::spawn(move || {
        let _ = daemon.serve(listener);
    });

    for n in ["amber-1-1-0-a", "amber-1-1-1-b", "amber-1-1-2-c"] {
        manager.create(n, "/tmp", SessionKind::Shell).unwrap();
    }
    manager.remove("amber-1-1-1-b").unwrap();

    let mut stream = UnixStream::connect(&sock).unwrap();
    stream
        .write_all(&proto::encode(&Frame::Control(ControlMsg::ListSessionsDetailed)))
        .unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();

    let mut dec = Decoder::new();
    let mut buf = [0u8; 8192];
    let sessions = loop {
        if let Some(Frame::Control(ControlMsg::Sessions { sessions })) = dec.next_frame().unwrap() {
            break sessions;
        }
        let n = stream.read(&mut buf).expect("timed out waiting for Sessions");
        assert!(n > 0, "daemon closed the connection");
        dec.feed(&buf[..n]);
    };

    // The killed session's slot 2 is gone; 1 and 3 still name the same panes.
    assert_eq!(amber::attach::pick_by_slot(&sessions, 1).unwrap().name, "amber-1-1-0-a");
    assert_eq!(amber::attach::pick_by_slot(&sessions, 3).unwrap().name, "amber-1-1-2-c");
    assert!(amber::attach::pick_by_slot(&sessions, 2).is_none());
    // Slot 0 is "unassigned" on the wire and must never resolve.
    assert!(amber::attach::pick_by_slot(&sessions, 0).is_none());
}
