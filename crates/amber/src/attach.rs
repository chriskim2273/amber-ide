//! Raw-mode terminal client — the `tmux attach` replacement (spec §5, §11
//! Slice 0 step 2). Connects to the daemon socket, attaches a session, and
//! proxies stdin/stdout raw bytes over the wire protocol.
//!
//! Per spec §5: this client does NOT replay alt-screen history specially —
//! received bytes are written straight to stdout; a TUI child is expected to
//! repaint on its own.
//!
//! Single-threaded event loop over `poll(2)` (stdin + socket), so:
//! - the daemon closing the socket tears the client down immediately (no
//!   thread left parked in a blocking `stdin.read()`);
//! - SIGWINCH is observed via a `signal-hook` flag checked every wakeup and
//!   forwarded as a `Resize`;
//! - a daemon `Exit` frame (the pane's child ended) exits the client.

use std::io::{self, IsTerminal, Read, Write};
use std::os::fd::AsFd;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use amber_core::proto::{self, ControlMsg, Decoder, Frame};
use nix::errno::Errno;
use nix::poll::{poll, PollFd, PollFlags, PollTimeout};
use nix::sys::termios::{self, SetArg, Termios};

/// Poll timeout: the cadence at which the SIGWINCH flag is rechecked even if
/// no fd is ready (a signal may interrupt poll on this thread, but flag-only
/// delivery on another thread must still be noticed).
const POLL_TICK_MS: u16 = 100;

/// Why [`run_client`] returned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientEnd {
    /// Local stdin reached EOF (user closed input).
    StdinEof,
    /// The daemon closed the socket (daemon stopped / connection lost).
    SocketClosed,
    /// The daemon reported the session's child exited with this code.
    SessionExit(i32),
}

/// Restores the original terminal settings when dropped, even on error or
/// panic unwind, so a crashing client never leaves the user's shell in raw
/// mode.
struct RawModeGuard {
    original: Termios,
}

impl RawModeGuard {
    fn enable() -> anyhow::Result<Self> {
        let stdin = io::stdin();
        let original = termios::tcgetattr(&stdin)?;
        let mut raw = original.clone();
        termios::cfmakeraw(&mut raw);
        termios::tcsetattr(&stdin, SetArg::TCSANOW, &raw)?;
        Ok(RawModeGuard { original })
    }
}

impl Drop for RawModeGuard {
    fn drop(&mut self) {
        let stdin = io::stdin();
        let _ = termios::tcsetattr(&stdin, SetArg::TCSANOW, &self.original);
    }
}

/// Current terminal size, falling back to 80x24 if it cannot be determined
/// (e.g. stdout is not a tty).
fn current_size() -> (u16, u16) {
    match terminal_size::terminal_size() {
        Some((terminal_size::Width(w), terminal_size::Height(h))) => (w, h),
        None => (80, 24),
    }
}

fn send_control(stream: &UnixStream, msg: ControlMsg) -> anyhow::Result<()> {
    let mut w = stream;
    w.write_all(&proto::encode(&Frame::Control(msg)))?;
    w.flush()?;
    Ok(())
}

/// Connect to `socket`, attach session `name`, and proxy the terminal until
/// stdin hits EOF, the socket closes, or the daemon reports the session's
/// child exited.
pub fn attach(socket: &Path, name: &str) -> anyhow::Result<()> {
    let stream = UnixStream::connect(socket)?;

    let winch = Arc::new(AtomicBool::new(false));
    signal_hook::flag::register(signal_hook::consts::SIGWINCH, Arc::clone(&winch))?;

    // Enter raw mode only when stdin really is a terminal (and restore it
    // via RAII regardless of how this function returns).
    let raw_guard = if io::stdin().is_terminal() {
        Some(RawModeGuard::enable()?)
    } else {
        None
    };

    let end = run_client(&stream, name, io::stdin(), io::stdout(), &winch);

    drop(raw_guard); // leave raw mode before printing any trailer
    match end? {
        ClientEnd::StdinEof => {}
        ClientEnd::SocketClosed => eprintln!("[amber] daemon closed the connection"),
        ClientEnd::SessionExit(code) => {
            eprintln!("[amber] session {name} ended (exit code {code})");
        }
    }
    Ok(())
}

/// The client event loop, separated from tty/signal setup so it can be
/// driven in tests with socket pairs and pipes instead of a real terminal.
pub fn run_client(
    stream: &UnixStream,
    name: &str,
    mut stdin: impl AsFd + Read,
    mut stdout: impl Write,
    winch: &AtomicBool,
) -> anyhow::Result<ClientEnd> {
    send_control(stream, ControlMsg::Attach { name: name.to_string() })?;
    let (cols, rows) = current_size();
    send_control(stream, ControlMsg::Resize { name: name.to_string(), cols, rows })?;

    let mut decoder = Decoder::new();
    let mut sock_buf = [0u8; 8192];
    let mut stdin_buf = [0u8; 4096];

    loop {
        if winch.swap(false, Ordering::Relaxed) {
            let (cols, rows) = current_size();
            send_control(stream, ControlMsg::Resize { name: name.to_string(), cols, rows })?;
        }

        let (stdin_ready, sock_ready) = {
            let mut fds = [
                PollFd::new(stdin.as_fd(), PollFlags::POLLIN),
                PollFd::new(stream.as_fd(), PollFlags::POLLIN),
            ];
            match poll(&mut fds, PollTimeout::from(POLL_TICK_MS)) {
                Ok(0) => continue, // tick: recheck the winch flag
                Ok(_) => {}
                Err(Errno::EINTR) => continue, // signal: recheck the winch flag
                Err(e) => return Err(e.into()),
            }
            let ready = |fd: &PollFd| {
                fd.revents()
                    .map(|r| {
                        r.intersects(PollFlags::POLLIN | PollFlags::POLLHUP | PollFlags::POLLERR)
                    })
                    .unwrap_or(false)
            };
            (ready(&fds[0]), ready(&fds[1]))
        };

        if sock_ready {
            let n = { stream }.read(&mut sock_buf)?;
            if n == 0 {
                return Ok(ClientEnd::SocketClosed);
            }
            decoder.feed(&sock_buf[..n]);
            while let Some(frame) = decoder.next_frame()? {
                match frame {
                    Frame::Data { bytes, .. } => {
                        stdout.write_all(&bytes)?;
                        stdout.flush()?;
                    }
                    Frame::Control(ControlMsg::Exit { name: ended, code }) if ended == name => {
                        return Ok(ClientEnd::SessionExit(code));
                    }
                    _ => {}
                }
            }
        }

        if stdin_ready {
            let n = stdin.read(&mut stdin_buf)?;
            if n == 0 {
                return Ok(ClientEnd::StdinEof);
            }
            let frame = Frame::Data {
                session: name.to_string(),
                bytes: stdin_buf[..n].to_vec(),
            };
            let mut w = stream;
            w.write_all(&proto::encode(&frame))?;
            w.flush()?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    /// Drive `run_client` on a background thread against a socketpair; the
    /// far end plays daemon. `stdin` is the read half of another socketpair
    /// (kept open by the returned write half).
    struct Harness {
        server: UnixStream,
        decoder: Decoder,
        stdin_feeder: UnixStream,
        winch: Arc<AtomicBool>,
        done: mpsc::Receiver<(anyhow::Result<ClientEnd>, Vec<u8>)>,
    }

    fn start_client() -> Harness {
        let (client_sock, server) = UnixStream::pair().unwrap();
        let (stdin_feeder, stdin_read) = UnixStream::pair().unwrap();
        let winch = Arc::new(AtomicBool::new(false));
        let (tx, done) = mpsc::channel();
        {
            let winch = Arc::clone(&winch);
            std::thread::spawn(move || {
                let mut out = Vec::new();
                let end = run_client(&client_sock, "s", stdin_read, &mut out, &winch);
                let _ = tx.send((end, out));
            });
        }
        Harness { server, decoder: Decoder::new(), stdin_feeder, winch, done }
    }

    impl Harness {
        /// Read frames from the server side until `pred` matches (5s cap).
        /// One shared decoder: frames buffered past a match are not lost.
        fn server_read_until<F: Fn(&Frame) -> bool>(&mut self, pred: F) -> Frame {
            self.server
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut buf = [0u8; 8192];
            loop {
                while let Some(frame) = self.decoder.next_frame().unwrap() {
                    if pred(&frame) {
                        return frame;
                    }
                }
                let n = self.server.read(&mut buf).expect("server read timed out");
                assert!(n > 0, "client closed its socket unexpectedly");
                self.decoder.feed(&buf[..n]);
            }
        }

        fn expect_attach_and_initial_resize(&mut self) {
            self.server_read_until(|f| matches!(f, Frame::Control(ControlMsg::Attach { .. })));
            self.server_read_until(|f| matches!(f, Frame::Control(ControlMsg::Resize { .. })));
        }
    }

    #[test]
    fn client_exits_when_daemon_closes_socket() {
        // The old two-thread client stayed parked in stdin.read() when the
        // socket closed; the poll loop must return promptly instead.
        let mut h = start_client();
        h.expect_attach_and_initial_resize();
        drop(h.server); // daemon goes away; stdin stays open and silent
        let (end, _) = h
            .done
            .recv_timeout(Duration::from_secs(5))
            .expect("client did not exit after socket close");
        assert_eq!(end.unwrap(), ClientEnd::SocketClosed);
        drop(h.stdin_feeder);
    }

    #[test]
    fn client_sends_resize_when_winch_flag_set() {
        let mut h = start_client();
        h.expect_attach_and_initial_resize();
        h.winch.store(true, Ordering::Relaxed);
        // A second Resize must arrive without any other traffic.
        h.server_read_until(|f| {
            matches!(f, Frame::Control(ControlMsg::Resize { .. }))
        });
        drop(h.server);
        let _ = h.done.recv_timeout(Duration::from_secs(5)).unwrap();
    }

    #[test]
    fn client_exits_on_session_exit_frame() {
        let mut h = start_client();
        h.expect_attach_and_initial_resize();
        let exit = Frame::Control(ControlMsg::Exit { name: "s".into(), code: 7 });
        h.server.write_all(&proto::encode(&exit)).unwrap();
        let (end, _) = h.done.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(end.unwrap(), ClientEnd::SessionExit(7));
    }

    #[test]
    fn client_exits_on_stdin_eof_and_forwards_input() {
        let mut h = start_client();
        h.expect_attach_and_initial_resize();

        h.stdin_feeder.write_all(b"typed").unwrap();
        let frame = h.server_read_until(|f| matches!(f, Frame::Data { .. }));
        assert_eq!(
            frame,
            Frame::Data { session: "s".into(), bytes: b"typed".to_vec() }
        );

        drop(h.stdin_feeder); // stdin EOF
        let (end, _) = h.done.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(end.unwrap(), ClientEnd::StdinEof);
    }

    #[test]
    fn client_writes_session_output_to_stdout() {
        let mut h = start_client();
        h.expect_attach_and_initial_resize();
        let data = Frame::Data { session: "s".into(), bytes: b"OUTPUT".to_vec() };
        h.server.write_all(&proto::encode(&data)).unwrap();
        let exit = Frame::Control(ControlMsg::Exit { name: "s".into(), code: 0 });
        h.server.write_all(&proto::encode(&exit)).unwrap();
        let (end, out) = h.done.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(end.unwrap(), ClientEnd::SessionExit(0));
        assert_eq!(out, b"OUTPUT");
    }
}
