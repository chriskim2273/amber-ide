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
    let (reader_started, reader_ready) = mpsc::channel();
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
        wait_for_shutdown.recv().unwrap();
        writer.shutdown().unwrap();
    });

    let mut first = transport::connect(&endpoint).unwrap();
    first
        .write_all(&proto::encode(&Frame::Control(ControlMsg::SessionList {
            names: vec![],
        })))
        .unwrap();
    let (released, result) = mpsc::channel();
    let stalled = transport::connect(&endpoint).unwrap();
    let (mut stalled_reader, _stalled_writer) = stalled.into_split().unwrap();
    thread::spawn(move || {
        reader_started.send(()).unwrap();
        let mut byte = [0_u8; 1];
        released.send(stalled_reader.read(&mut byte)).unwrap();
    });
    reader_ready.recv().unwrap();
    thread::sleep(Duration::from_millis(20));
    assert!(result.try_recv().is_err(), "reader must still be blocked");
    permit_shutdown.send(()).unwrap();
    server.join().unwrap();
    assert!(matches!(
        result.recv_timeout(Duration::from_secs(2)),
        Ok(Ok(0) | Err(_))
    ));
}
