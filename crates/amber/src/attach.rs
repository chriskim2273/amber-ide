//! Raw-mode terminal client — the `tmux attach` replacement (spec §5, §11
//! Slice 0 step 2). Connects to the daemon socket, attaches a session, and
//! proxies stdin/stdout raw bytes over the wire protocol.
//!
//! Per spec §5: this client does NOT replay alt-screen history specially —
//! received bytes are written straight to stdout; a TUI child is expected to
//! repaint on its own.

use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;

use amber_core::proto::{self, ControlMsg, Decoder, Frame};
use nix::sys::termios::{self, SetArg, Termios};

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

fn send_control(writer: &Arc<Mutex<UnixStream>>, msg: ControlMsg) -> anyhow::Result<()> {
    let bytes = proto::encode(&Frame::Control(msg));
    let mut w = writer.lock().unwrap();
    w.write_all(&bytes)?;
    w.flush()?;
    Ok(())
}

/// Connect to `socket`, attach session `name`, and proxy the terminal until
/// stdin hits EOF or the socket closes.
///
/// NOTE (limitation): SIGWINCH is not handled — the terminal size is sent
/// once at attach time. A live-resized window will not be reported to the
/// child until the client is reattached. Left simple per the task's escape
/// hatch; revisit with signal-hook's flag-based SIGWINCH handling if needed.
pub fn attach(socket: &Path, name: &str) -> anyhow::Result<()> {
    let stream = UnixStream::connect(socket)?;
    let writer: Arc<Mutex<UnixStream>> = Arc::new(Mutex::new(stream.try_clone()?));

    send_control(&writer, ControlMsg::Attach { name: name.to_string() })?;

    // Enter raw mode only after the Attach request is sent, and restore it
    // via RAII regardless of how this function returns.
    let _raw_guard = RawModeGuard::enable()?;

    let (cols, rows) = current_size();
    send_control(
        &writer,
        ControlMsg::Resize { name: name.to_string(), cols, rows },
    )?;

    // Reader thread: socket -> stdout.
    let mut read_half = stream.try_clone()?;
    let reader = thread::spawn(move || -> anyhow::Result<()> {
        let mut decoder = Decoder::new();
        let mut buf = [0u8; 8192];
        let mut stdout = io::stdout();
        loop {
            while let Some(frame) = decoder.next_frame()? {
                if let Frame::Data { bytes, .. } = frame {
                    stdout.write_all(&bytes)?;
                    stdout.flush()?;
                }
            }
            let n = read_half.read(&mut buf)?;
            if n == 0 {
                return Ok(());
            }
            decoder.feed(&buf[..n]);
        }
    });

    // Main thread: stdin -> socket.
    let mut stdin = io::stdin();
    let mut buf = [0u8; 4096];
    loop {
        let n = stdin.read(&mut buf)?;
        if n == 0 {
            break; // stdin EOF
        }
        let frame = Frame::Data { session: name.to_string(), bytes: buf[..n].to_vec() };
        let bytes = proto::encode(&frame);
        let mut w = writer.lock().unwrap();
        if w.write_all(&bytes).and_then(|_| w.flush()).is_err() {
            break; // socket closed
        }
    }

    let _ = reader.join();
    Ok(())
}
