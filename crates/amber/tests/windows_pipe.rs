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
        writer.shutdown().unwrap();
    });

    let mut first = transport::connect(&endpoint).unwrap();
    first
        .write_all(&proto::encode(&Frame::Control(ControlMsg::SessionList {
            names: vec![],
        })))
        .unwrap();
    let mut stalled = transport::connect(&endpoint).unwrap();
    server.join().unwrap();

    let (released, result) = mpsc::channel();
    thread::spawn(move || {
        let mut byte = [0_u8; 1];
        released.send(stalled.read(&mut byte)).unwrap();
    });
    assert!(matches!(
        result.recv_timeout(Duration::from_secs(2)),
        Ok(Ok(0) | Err(_))
    ));
}
