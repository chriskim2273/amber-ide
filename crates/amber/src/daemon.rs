//! The unix-socket server: accepts connections, speaks the `amber_core::proto`
//! wire protocol, and dispatches to the [`SessionManager`].

use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::{Arc, Mutex};
use std::thread;

use amber_core::proto::{self, ControlMsg, Decoder, Frame};
use amber_core::state::SessionKind;

use crate::manager::SessionManager;
use crate::pty::PtySession;

/// Shared handle to a connection's write half — both the control-reply path
/// and a per-attach output-forwarder thread write to it, so it must be
/// mutex-guarded.
type SharedWriter = Arc<Mutex<UnixStream>>;

/// Subscriptions this connection holds: `(session name, session, sub id)`.
/// Released on `Detach` and when the connection ends, so a vanished client
/// never leaves a subscriber (and its forwarder thread) behind on an idle
/// session.
type Subscriptions = Vec<(String, Arc<PtySession>, u64)>;

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

/// Bind the daemon's unix socket at `path`, handling leftovers safely:
/// - nothing there -> bind;
/// - a live socket (another daemon answers a connect) -> error, NEVER unlink
///   a running daemon's socket out from under it;
/// - a stale socket file (connect refused: previous daemon crashed/was
///   SIGKILLed) -> remove it and bind.
pub fn prepare_socket(path: &std::path::Path) -> anyhow::Result<UnixListener> {
    if path.exists() {
        match UnixStream::connect(path) {
            Ok(_) => anyhow::bail!(
                "another daemon is already listening on {}",
                path.display()
            ),
            Err(_) => std::fs::remove_file(path)?,
        }
    }
    Ok(UnixListener::bind(path)?)
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
    let mut subscriptions: Subscriptions = Vec::new();
    let result = connection_loop(&manager, &writer, stream, &mut subscriptions);
    // However the connection ended, release every subscription it held.
    for (_, sess, id) in subscriptions {
        sess.unsubscribe(id);
    }
    result
}

fn connection_loop(
    manager: &Arc<SessionManager>,
    writer: &SharedWriter,
    mut read_half: UnixStream,
    subscriptions: &mut Subscriptions,
) -> anyhow::Result<()> {
    let mut decoder = Decoder::new();
    let mut buf = [0u8; 8192];

    loop {
        while let Some(frame) = decoder.next_frame()? {
            handle_frame(manager, writer, frame, subscriptions);
        }
        let n = read_half.read(&mut buf)?;
        if n == 0 {
            return Ok(()); // client disconnected
        }
        decoder.feed(&buf[..n]);
    }
}

fn handle_frame(
    manager: &Arc<SessionManager>,
    writer: &SharedWriter,
    frame: Frame,
    subscriptions: &mut Subscriptions,
) {
    match frame {
        Frame::Control(msg) => handle_control(manager, writer, msg, subscriptions),
        Frame::Data { session, bytes } => {
            // Input from the client: forward to the child's stdin. A stale
            // session name is not fatal to the connection.
            let _ = manager.write(&session, &bytes);
        }
    }
}

fn handle_control(
    manager: &Arc<SessionManager>,
    writer: &SharedWriter,
    msg: ControlMsg,
    subscriptions: &mut Subscriptions,
) {
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
            let (sub_id, backlog, rx) = sess.subscribe();
            if write_frame(
                writer,
                &Frame::Data { session: name.clone(), bytes: backlog },
            )
            .is_err()
            {
                sess.unsubscribe(sub_id);
                return;
            }
            subscriptions.push((name.clone(), Arc::clone(&sess), sub_id));
            let writer = Arc::clone(writer);
            // `sess` moves into the forwarder so it can report the exit code.
            thread::spawn(move || {
                while let Ok(chunk) = rx.recv() {
                    let frame = Frame::Data { session: name.clone(), bytes: chunk };
                    if write_frame(&writer, &frame).is_err() {
                        return;
                    }
                }
                // Channel closed: either the child exited (the pty reader
                // clears all subscribers) or this subscriber was pruned as a
                // laggard. If the child is gone, tell the client the pane
                // ended. The exit code is recorded by a separate waiter
                // thread, so give it a moment to land.
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
                loop {
                    if let Some(code) = sess.exit_code() {
                        let _ = write_frame(
                            &writer,
                            &Frame::Control(ControlMsg::Exit { name, code }),
                        );
                        return;
                    }
                    if std::time::Instant::now() > deadline {
                        return; // pruned while the child is still alive
                    }
                    thread::sleep(std::time::Duration::from_millis(20));
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
        ControlMsg::Detach { name } => {
            // Release this connection's subscriptions to that session; the
            // forwarder thread exits once its channel drains.
            subscriptions.retain(|(sess_name, sess, id)| {
                if *sess_name == name {
                    sess.unsubscribe(*id);
                    false
                } else {
                    true
                }
            });
        }
        ControlMsg::Rename { .. } => {
            // Deliberately unsupported (not silently ignored): a live claude
            // session's supervisor is env-bound to its name (`amber run
            // <name>` / AMBER_SESSION), so renaming would break precise
            // resume until a supervisor-rebind mechanism exists.
            let _ = write_frame(
                writer,
                &Frame::Control(ControlMsg::Error {
                    msg: "rename is not supported yet".to_string(),
                }),
            );
        }
        // Hello and daemon->client-only variants: no-op. Well-formed but
        // meaningless here; ignore rather than tear down the connection.
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepare_socket_binds_fresh_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fresh.sock");
        assert!(prepare_socket(&path).is_ok());
        assert!(path.exists());
    }

    #[test]
    fn prepare_socket_refuses_to_steal_a_live_socket() {
        // A second daemon instance must fail loudly, not silently unbind the
        // first one's socket (killing every client's connection path).
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("live.sock");
        let _live = UnixListener::bind(&path).unwrap();
        let err = prepare_socket(&path).expect_err("stole a live socket");
        assert!(err.to_string().contains("already listening"), "{err}");
        assert!(path.exists(), "live socket file must be left alone");
    }

    #[test]
    fn prepare_socket_replaces_stale_socket_file() {
        // A crashed daemon leaves a socket file behind with nobody accepting:
        // connect() cannot succeed, so prepare_socket removes it and rebinds.
        // We simulate the leftover with a plain file rather than drop()ing a
        // live listener in-process — the latter races the kernel's socket
        // teardown and can make connect() transiently succeed (false "already
        // listening"). A crashed daemon's fds are fully closed before restart,
        // so this deterministic form matches production.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("stale.sock");
        std::fs::write(&path, b"").unwrap();
        assert!(path.exists(), "precondition: stale file present");
        assert!(prepare_socket(&path).is_ok());
        assert!(path.exists(), "rebound socket present");
    }
}
