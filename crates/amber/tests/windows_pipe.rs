//! Transport boundary parity tests.  The Windows-only cases are compiled and
//! executed by Windows CI; keeping the Unix case here gives the boundary a
//! fast, real-stream red/green loop on development hosts.

#[cfg(unix)]
use std::io::{Read, Write};

#[cfg(unix)]
use amber::transport;
#[cfg(unix)]
use amber_core::proto::{self, ControlMsg, Decoder, Frame};

#[cfg(unix)]
#[test]
fn local_stream_round_trips_a_protocol_frame() {
    let (mut client, mut server) = transport::test_pair().unwrap();
    let frame = Frame::Control(ControlMsg::SessionList { names: vec![] });

    client.write_all(&proto::encode(&frame)).unwrap();

    let mut bytes = [0_u8; 1024];
    let read = server.read(&mut bytes).unwrap();
    let mut decoder = Decoder::new();
    decoder.feed(&bytes[..read]);
    assert_eq!(decoder.next_frame().unwrap(), Some(frame));
}

#[cfg(unix)]
#[test]
fn local_writer_shutdown_releases_an_already_blocked_peer() {
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    let (client, server) = transport::test_pair().unwrap();
    let (mut reader, _server_writer) = server.into_split().unwrap();
    let (_client_reader, mut client_writer) = client.into_split().unwrap();
    let (started_tx, started_rx) = mpsc::channel();
    let (released_tx, released_rx) = mpsc::channel();

    thread::spawn(move || {
        started_tx.send(()).unwrap();
        let mut byte = [0_u8; 1];
        released_tx.send(reader.read(&mut byte)).unwrap();
    });
    started_rx.recv().unwrap();
    thread::sleep(Duration::from_millis(20));
    assert!(
        released_rx.try_recv().is_err(),
        "reader must still be blocked"
    );

    client_writer.shutdown().unwrap();
    assert!(matches!(
        released_rx.recv_timeout(Duration::from_secs(1)),
        Ok(Ok(0) | Err(_))
    ));
}

/// Windows CI proves that the boundary supports two independently connected
/// clients and that a server-side writer shutdown releases a stalled peer.
#[cfg(windows)]
#[test]
fn named_pipe_accepts_two_clients_and_releases_a_stalled_peer() {
    use std::io::{Read, Write};
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use amber::transport;
    use amber_core::proto::{self, ControlMsg, Decoder, Frame};

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let endpoint = PathBuf::from(format!("amber-windows-pipe-{stamp}"));
    let listener = transport::bind(&endpoint).unwrap();
    let (write_queued, queued) = mpsc::channel();
    let (reader_pending, reader_started) = mpsc::channel();
    let (permit_shutdown, wait_for_shutdown) = mpsc::channel();
    let server = thread::spawn(move || {
        let mut first = listener.accept().unwrap();
        let mut bytes = [0_u8; 1024];
        let count = first.read(&mut bytes).unwrap();
        let mut decoder = Decoder::new();
        decoder.feed(&bytes[..count]);
        assert!(matches!(
            decoder.next_frame().unwrap(),
            Some(Frame::Control(_))
        ));

        let second = listener.accept().unwrap();
        let (_reader, mut writer) = second.into_split().unwrap();
        writer.write_all(b"queued-before-forced-close").unwrap();
        write_queued.send(()).unwrap();
        reader_started.recv().unwrap();
        wait_for_shutdown.recv().unwrap();
        writer.shutdown().unwrap();
    });

    let mut first = transport::connect(&endpoint).unwrap();
    first
        .write_all(&proto::encode(&Frame::Control(ControlMsg::SessionList {
            names: vec![],
        })))
        .unwrap();
    let stalled = transport::connect(&endpoint).unwrap();
    queued.recv().unwrap();

    let (released, result) = mpsc::channel();
    thread::spawn(move || {
        let mut stalled = stalled;
        let mut bytes = [0_u8; 64];
        let queued = stalled.read(&mut bytes).unwrap();
        assert_eq!(&bytes[..queued], b"queued-before-forced-close");
        // The first read consumed the earlier output. This signal precedes the
        // second read, which must remain blocked until server shutdown.
        reader_pending.send(()).unwrap();
        released.send(stalled.read(&mut bytes)).unwrap();
    });
    reader_pending.recv().unwrap();
    thread::sleep(Duration::from_millis(20));
    assert!(
        result.try_recv().is_err(),
        "reader must be pending after it consumed queued output"
    );
    permit_shutdown.send(()).unwrap();
    server.join().unwrap();
    assert!(
        matches!(
            result.recv_timeout(Duration::from_secs(2)),
            Ok(Ok(0) | Err(_))
        ),
        "forced server close did not release the stalled peer"
    );
}

/// A client can connect and close before the server calls `accept`. Windows
/// reports `ERROR_NO_DATA` for that stale pending instance; accept must
/// disconnect/replenish and still accept the next client.
#[cfg(windows)]
#[test]
fn named_pipe_recovers_from_client_close_before_accept() {
    use std::path::PathBuf;
    use std::thread;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use amber::transport;

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let endpoint = PathBuf::from(format!("amber-windows-stale-pipe-{stamp}"));
    let listener = transport::bind(&endpoint).unwrap();
    let stale = transport::connect(&endpoint).unwrap();
    let (_reader, mut writer) = stale.into_split().unwrap();
    writer.shutdown().unwrap(); // Client role closes only its own raw handle.

    let server = thread::spawn(move || listener.accept());
    thread::sleep(Duration::from_millis(20));
    let fresh = transport::connect(&endpoint).unwrap();
    let accepted = server.join().unwrap();
    assert!(
        accepted.is_ok(),
        "accept must replenish after ERROR_NO_DATA"
    );
    drop(fresh);
}
