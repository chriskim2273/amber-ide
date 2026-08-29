#![cfg(windows)]

use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use amber::attach::{
    run_windows_client_for_test, windows_console_restore_order_for_test,
    windows_console_size_from_info, ClientEnd, ConsoleBufferInfo, DEFAULT_PREFIX,
};
use amber::transport;
use amber_core::proto::{ControlMsg, Decoder, Frame};

#[test]
fn windows_console_size_reads_visible_window() {
    let info = ConsoleBufferInfo {
        width: 132,
        height: 43,
    };
    assert_eq!(windows_console_size_from_info(info), (132, 43));
}

#[test]
fn windows_console_restore_raii_restores_output_before_input() {
    // This uses the same helper as ConsoleModeGuard::drop, so it checks the
    // production RAII order without mutating this test process's console.
    assert_eq!(
        windows_console_restore_order_for_test(0x0011, 0x0022),
        vec![0x0022, 0x0011]
    );
}

fn endpoint(label: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    PathBuf::from(format!("amber-windows-attach-{label}-{stamp}"))
}

fn read_frames_until(
    stream: &mut transport::LocalStream,
    done: impl Fn(&Frame) -> bool,
) -> Vec<Frame> {
    let mut decoder = Decoder::new();
    let mut frames = Vec::new();
    let mut bytes = [0_u8; 4096];
    loop {
        let count = stream
            .read_with_timeout(&mut bytes, Duration::from_secs(3))
            .unwrap();
        assert_ne!(count, 0, "client closed before the expected attach frames");
        decoder.feed(&bytes[..count]);
        while let Some(frame) = decoder.next_frame().unwrap() {
            let is_done = done(&frame);
            frames.push(frame);
            if is_done {
                return frames;
            }
        }
    }
}

#[test]
fn windows_attach_loop_uses_a_real_named_pipe_for_focus_attach_resize_input_and_detach() {
    let endpoint = endpoint("protocol");
    let listener = transport::bind(&endpoint).unwrap();
    let (server_frames, client_frames) = mpsc::channel();
    let server = thread::spawn(move || {
        let mut stream = listener.accept().unwrap();
        let frames = read_frames_until(&mut stream, |frame| {
            matches!(frame, Frame::Control(ControlMsg::Detach { .. }))
        });
        server_frames.send(frames).unwrap();
        // Dropping the accepted endpoint exercises the close cleanup path too.
    });

    let (input_sender, input) = mpsc::channel();
    input_sender
        .send(b"echo from windows attach\r\n".to_vec())
        .unwrap();
    input_sender.send(vec![DEFAULT_PREFIX, b'd']).unwrap();
    let end = run_windows_client_for_test(
        &endpoint,
        "amber-windows-attach",
        Some(DEFAULT_PREFIX),
        input,
        Vec::new(),
        (132, 43),
    )
    .unwrap();
    assert_eq!(end, ClientEnd::Detached);

    let frames = client_frames.recv_timeout(Duration::from_secs(3)).unwrap();
    server.join().unwrap();
    assert_eq!(
        frames,
        vec![
            Frame::Control(ControlMsg::Focus {
                name: "amber-windows-attach".into(),
            }),
            Frame::Control(ControlMsg::Attach {
                name: "amber-windows-attach".into(),
                raw_client: true,
                preview: false,
                resume: None,
            }),
            Frame::Control(ControlMsg::Resize {
                name: "amber-windows-attach".into(),
                cols: 132,
                rows: 43,
            }),
            Frame::Data {
                session: "amber-windows-attach".into(),
                bytes: b"echo from windows attach\r\n".to_vec(),
            },
            Frame::Control(ControlMsg::Detach {
                name: "amber-windows-attach".into(),
            }),
        ]
    );
}

#[test]
fn windows_attach_loop_returns_when_the_real_named_pipe_peer_closes() {
    let endpoint = endpoint("close");
    let listener = transport::bind(&endpoint).unwrap();
    let server = thread::spawn(move || {
        let mut stream = listener.accept().unwrap();
        let frames = read_frames_until(&mut stream, |frame| {
            matches!(frame, Frame::Control(ControlMsg::Resize { .. }))
        });
        assert_eq!(
            frames.len(),
            3,
            "Focus, Attach, and initial Resize are required"
        );
        // Close while the production socket reader is blocked on this pipe.
    });

    let (_keep_input_open, input) = mpsc::channel();
    let end = run_windows_client_for_test(
        &endpoint,
        "amber-windows-close",
        Some(DEFAULT_PREFIX),
        input,
        Vec::new(),
        (80, 24),
    )
    .unwrap();
    server.join().unwrap();
    assert_eq!(end, ClientEnd::SocketClosed);
}
