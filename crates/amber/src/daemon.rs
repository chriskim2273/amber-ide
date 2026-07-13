//! The unix-socket server: accepts connections, speaks the `amber_core::proto`
//! wire protocol, and dispatches to the [`SessionManager`].

use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::{Arc, Mutex};
use std::thread;

use amber_core::proto::{self, ControlMsg, Decoder, Frame};
use amber_core::state::SessionKind;

use crate::manager::SessionManager;

/// Shared handle to a connection's write half — both the control-reply path
/// and a per-attach output-forwarder thread write to it, so it must be
/// mutex-guarded.
type SharedWriter = Arc<Mutex<UnixStream>>;

/// Owns the session table and serves the unix socket. Each accepted
/// connection is handled on its own thread; a single connection erroring out
/// never stops the accept loop.
pub struct Daemon {
    manager: Arc<SessionManager>,
}

impl Daemon {
    pub fn new(manager: Arc<SessionManager>) -> Self {
        Daemon { manager }
    }

    /// Accept loop. Runs until the listener itself errors (e.g. the socket
    /// file is removed out from under it); per-connection errors are logged
    /// and otherwise ignored.
    pub fn serve(&self, listener: UnixListener) -> anyhow::Result<()> {
        for conn in listener.incoming() {
            match conn {
                Ok(stream) => {
                    let manager = Arc::clone(&self.manager);
                    thread::spawn(move || {
                        if let Err(e) = handle_connection(manager, stream) {
                            eprintln!("amber daemon: connection error: {e}");
                        }
                    });
                }
                Err(e) => {
                    eprintln!("amber daemon: accept error: {e}");
                }
            }
        }
        Ok(())
    }
}

fn write_frame(writer: &SharedWriter, frame: &Frame) -> anyhow::Result<()> {
    let bytes = proto::encode(frame);
    let mut w = writer.lock().unwrap();
    w.write_all(&bytes)?;
    w.flush()?;
    Ok(())
}

fn parse_kind(kind: &str) -> anyhow::Result<SessionKind> {
    match kind {
        "shell" => Ok(SessionKind::Shell),
        "claude" => Ok(SessionKind::Claude),
        other => anyhow::bail!("unknown session kind: {other}"),
    }
}

/// Per-connection loop: decode frames from the read half, dispatch each one,
/// and reply/forward via the shared write half.
fn handle_connection(manager: Arc<SessionManager>, stream: UnixStream) -> anyhow::Result<()> {
    let writer: SharedWriter = Arc::new(Mutex::new(stream.try_clone()?));
    let mut read_half = stream;
    let mut decoder = Decoder::new();
    let mut buf = [0u8; 8192];

    loop {
        while let Some(frame) = decoder.next_frame()? {
            handle_frame(&manager, &writer, frame);
        }
        let n = read_half.read(&mut buf)?;
        if n == 0 {
            return Ok(()); // client disconnected
        }
        decoder.feed(&buf[..n]);
    }
}

fn handle_frame(manager: &Arc<SessionManager>, writer: &SharedWriter, frame: Frame) {
    match frame {
        Frame::Control(msg) => handle_control(manager, writer, msg),
        Frame::Data { session, bytes } => {
            // Input from the client: forward to the child's stdin. A stale
            // session name is not fatal to the connection.
            let _ = manager.write(&session, &bytes);
        }
    }
}

fn handle_control(manager: &Arc<SessionManager>, writer: &SharedWriter, msg: ControlMsg) {
    match msg {
        ControlMsg::Create { name, cwd, kind } => {
            let result = parse_kind(&kind).and_then(|k| manager.create(&name, cwd, k));
            let reply = match result {
                Ok(_) => ControlMsg::Created { name },
                Err(e) => ControlMsg::Error { msg: e.to_string() },
            };
            let _ = write_frame(writer, &Frame::Control(reply));
        }
        ControlMsg::ListSessions => {
            let names = manager.names();
            let _ = write_frame(writer, &Frame::Control(ControlMsg::SessionList { names }));
        }
        ControlMsg::Attach { name } => {
            let Some(sess) = manager.session(&name) else {
                let _ = write_frame(
                    writer,
                    &Frame::Control(ControlMsg::Error {
                        msg: format!("no such session: {name}"),
                    }),
                );
                return;
            };
            let (backlog, rx) = sess.subscribe();
            if write_frame(
                writer,
                &Frame::Data { session: name.clone(), bytes: backlog },
            )
            .is_err()
            {
                return;
            }
            let writer = Arc::clone(writer);
            thread::spawn(move || {
                while let Ok(chunk) = rx.recv() {
                    let frame = Frame::Data { session: name.clone(), bytes: chunk };
                    if write_frame(&writer, &frame).is_err() {
                        break;
                    }
                }
            });
        }
        ControlMsg::Snapshot => {
            let reply = match manager.snapshot() {
                Ok(()) => ControlMsg::SnapshotOk,
                Err(e) => ControlMsg::Error { msg: e.to_string() },
            };
            let _ = write_frame(writer, &Frame::Control(reply));
        }
        ControlMsg::Resize { name, cols, rows } => {
            let _ = manager.resize(&name, rows, cols);
        }
        ControlMsg::Kill { name } => {
            let _ = manager.remove(&name);
        }
        // Detach/Rename/Hello and daemon->client-only variants: no-op for
        // Slice 1. Unknown to us but well-formed; ignore rather than tear
        // down the connection.
        _ => {}
    }
}
