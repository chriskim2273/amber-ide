//! `GetUsage` answers from the daemon's cache, never from a live fetch.

use std::io::Write;
use std::sync::Arc;
use std::time::Duration;

use amber::daemon::{prepare_socket, Daemon};
use amber::manager::SessionManager;
use amber::transport::{self, LocalReader, LocalWriter};
use amber::usage::UsageCache;
use amber::watchers::Watchers;
use amber_core::proto::{self, ControlMsg, Decoder, Frame, ProviderUsage};

fn send(stream: &mut LocalWriter, msg: ControlMsg) {
    stream.write_all(&proto::encode(&Frame::Control(msg))).unwrap();
    stream.flush().unwrap();
}

fn read_usage(stream: &mut LocalReader) -> Vec<ProviderUsage> {
    let mut dec = Decoder::new();
    let mut buf = [0u8; 8192];
    loop {
        while let Some(frame) = dec.next_frame().unwrap() {
            if let Frame::Control(ControlMsg::Usage { providers }) = frame {
                return providers;
            }
        }
        let n = stream
            .read_with_timeout(&mut buf, Duration::from_secs(5))
            .expect("timed out waiting for a Usage reply");
        assert!(n > 0, "connection closed unexpectedly");
        dec.feed(&buf[..n]);
    }
}

#[test]
fn get_usage_replies_with_the_cached_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("amberd.sock");
    let manager = Arc::new(SessionManager::new(dir.path()).unwrap());
    let watchers = Arc::new(Watchers::new());
    let cache = UsageCache::new();
    cache.store(vec![ProviderUsage {
        provider: "codex".into(),
        plan: Some("pro".into()),
        gauges: vec![],
        updated: 42,
        state: "ok".into(),
        detail: None,
    }]);
    let listener = prepare_socket(&sock).unwrap();
    let daemon = Daemon::new(Arc::clone(&manager), Arc::clone(&watchers))
        .with_usage(Arc::clone(&cache));
    std::thread::spawn(move || {
        let _ = daemon.serve(listener);
    });

    let client = transport::connect(&sock).unwrap();
    let (mut r, mut w) = client.into_split().unwrap();
    send(&mut w, ControlMsg::GetUsage);

    let providers = read_usage(&mut r);
    assert_eq!(providers.len(), 1);
    assert_eq!(providers[0].provider, "codex");
    assert_eq!(providers[0].updated, 42);
    assert_eq!(providers[0].plan.as_deref(), Some("pro"));
    assert_eq!(providers[0].state, "error", "old sample is not live");
    let began = std::time::Instant::now();
    send(&mut w, ControlMsg::RefreshUsage);
    assert_eq!(read_usage(&mut r)[0].updated, 42);
    assert!(began.elapsed() < Duration::from_secs(1), "refresh must not fetch on read thread");
}

#[test]
fn get_usage_without_a_poller_is_an_empty_list_not_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("amberd.sock");
    let manager = Arc::new(SessionManager::new(dir.path()).unwrap());
    let watchers = Arc::new(Watchers::new());
    let listener = prepare_socket(&sock).unwrap();
    let daemon = Daemon::new(manager, watchers);
    std::thread::spawn(move || {
        let _ = daemon.serve(listener);
    });

    let client = transport::connect(&sock).unwrap();
    let (mut r, mut w) = client.into_split().unwrap();
    send(&mut w, ControlMsg::GetUsage);
    // An empty list, never a fabricated zero and never an Error the app would
    // surface in its red banner.
    assert!(read_usage(&mut r).is_empty());
}
