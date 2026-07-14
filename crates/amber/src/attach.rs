//! Raw-mode terminal client — the `tmux attach` replacement (spec §5, §11
//! Slice 0 step 2). Connects to the daemon socket, attaches a session, and
//! proxies stdin/stdout raw bytes over the wire protocol.
//!
//! Per spec §5: replaying raw history that contains alt-screen/cursor
//! sequences into a cold terminal can corrupt it. So this client (a) resets
//! the local terminal ([`TERM_RESET`]) before any replayed bytes land, and
//! (b) attaches with `raw_client: true`, telling the daemon to suppress
//! historical backlog for alt-screen (claude) sessions — those rely on the
//! child's next repaint (the daemon nudges it with a resize). Shell history
//! replays cleanly and is still sent in full.
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

/// Written to the local terminal once per attach, before any replayed bytes
/// (spec §5) — a minimal reset so replay lands in a known-good terminal:
/// - `ESC [!p` (DECSTR soft reset): restores sane modes (autowrap, origin,
///   cursor keys) without the screen-clearing side effects of a full RIS;
/// - `ESC [?1049l`: leave the alternate screen, in case a previous attach
///   died while a TUI held it;
/// - `ESC [?25h`: show the cursor (TUIs hide it and may not have restored it).
const TERM_RESET: &[u8] = b"\x1b[!p\x1b[?1049l\x1b[?25h";

/// Why [`run_client`] returned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientEnd {
    /// Local stdin reached EOF (user closed input).
    StdinEof,
    /// The daemon closed the socket (daemon stopped / connection lost).
    SocketClosed,
    /// The daemon reported the session's child exited with this code.
    SessionExit(i32),
    /// The user pressed the detach hotkey (prefix + `d`). The `Detach` control
    /// message was sent; the session keeps running in the daemon.
    Detached,
}

/// Default detach prefix key: `Ctrl-b` (`0x02`), matching tmux muscle memory.
pub const DEFAULT_PREFIX: u8 = 0x02;

/// Outcome of resolving the detach prefix from flags + env, kept pure (no I/O)
/// so it is unit-testable; the caller prints `warning` if present.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrefixResolution {
    /// The prefix byte to intercept, or `None` when interception is disabled.
    pub prefix: Option<u8>,
    /// A human-readable warning (e.g. an unparseable `AMBER_PREFIX`) for the
    /// caller to surface; the resolution still falls back sanely.
    pub warning: Option<String>,
}

/// Resolve the detach prefix. Precedence: `no_prefix` flag disables everything;
/// otherwise `AMBER_PREFIX` (`C-a`.. / `none` / empty), else [`DEFAULT_PREFIX`].
/// An unparseable env value falls back to the default and reports a warning.
pub fn resolve_prefix(no_prefix: bool, env: Option<&str>) -> PrefixResolution {
    if no_prefix {
        return PrefixResolution { prefix: None, warning: None };
    }
    match env {
        None => PrefixResolution { prefix: Some(DEFAULT_PREFIX), warning: None },
        Some(raw) => match parse_prefix_env(raw) {
            Ok(prefix) => PrefixResolution { prefix, warning: None },
            Err(()) => PrefixResolution {
                prefix: Some(DEFAULT_PREFIX),
                warning: Some(format!("ignoring invalid AMBER_PREFIX {raw:?}; using Ctrl-b")),
            },
        },
    }
}

/// Parse an `AMBER_PREFIX` value. `Ok(None)` = disabled (`none`/empty),
/// `Ok(Some(b))` = a control byte from `C-<letter>`, `Err(())` = unparseable.
fn parse_prefix_env(raw: &str) -> Result<Option<u8>, ()> {
    let s = raw.trim();
    if s.is_empty() || s.eq_ignore_ascii_case("none") {
        return Ok(None);
    }
    let lower = s.to_ascii_lowercase();
    if let Some(letter) = lower.strip_prefix("c-") {
        let bytes = letter.as_bytes();
        if bytes.len() == 1 && bytes[0].is_ascii_lowercase() {
            // Ctrl-a = 0x01 .. Ctrl-z = 0x1a.
            return Ok(Some(bytes[0] - b'a' + 1));
        }
    }
    Err(())
}

/// Human name for a prefix byte in the `C-<letter>` control range, for the
/// attach banner (e.g. `0x02` -> `"Ctrl-b"`). Falls back to a hex form.
fn prefix_key_name(prefix: u8) -> String {
    if (0x01..=0x1a).contains(&prefix) {
        format!("Ctrl-{}", (prefix - 1 + b'a') as char)
    } else {
        format!("0x{prefix:02x}")
    }
}

/// The most-recently-updated live session — the target for `amber attach` with
/// no name. Dead sessions are ignored; ties break on the greater name so the
/// choice is deterministic. `None` when no live session exists.
pub fn pick_newest(sessions: &[proto::SessionInfo]) -> Option<&proto::SessionInfo> {
    sessions
        .iter()
        .filter(|s| s.alive)
        .max_by(|a, b| a.updated.cmp(&b.updated).then_with(|| a.name.cmp(&b.name)))
}

/// One stdin chunk scanned for prefix commands (see [`scan_prefix`]).
#[derive(Debug, Default, PartialEq, Eq)]
struct ScanResult {
    /// Bytes to forward to the child as input, in order.
    forward: Vec<u8>,
    /// Whether the prefix is armed after this chunk (prefix was its last byte).
    armed: bool,
    /// Set when a detach command (prefix + `d`) was seen; forwarding stops.
    detach: bool,
}

/// Scan one stdin `chunk` for detach-prefix commands. `armed` is whether the
/// previous chunk ended right after an unconsumed prefix (state crosses reads).
/// Bindings: prefix + `d` = detach; prefix + prefix = one literal prefix byte;
/// prefix + any other byte = drop both (tmux "unbound key"). Every other byte
/// is forwarded verbatim — no normal keystroke is ever silently lost.
fn scan_prefix(chunk: &[u8], prefix: u8, armed: bool) -> ScanResult {
    let mut out = ScanResult { forward: Vec::with_capacity(chunk.len()), armed, detach: false };
    for &b in chunk {
        if out.armed {
            out.armed = false;
            if b == b'd' {
                out.detach = true;
                return out; // leaving; bytes after `d` in this chunk are moot
            } else if b == prefix {
                out.forward.push(prefix); // prefix prefix -> literal prefix
            }
            // else: unbound key -> drop both the prefix and this byte
        } else if b == prefix {
            out.armed = true;
        } else {
            out.forward.push(b);
        }
    }
    out
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
pub fn attach(socket: &Path, name: &str, prefix: Option<u8>) -> anyhow::Result<()> {
    let stream = UnixStream::connect(socket)?;

    let winch = Arc::new(AtomicBool::new(false));
    signal_hook::flag::register(signal_hook::consts::SIGWINCH, Arc::clone(&winch))?;

    let is_tty = io::stdin().is_terminal();

    // Announce the detach key on a real terminal, before entering raw mode so
    // the line renders normally. To stderr, so it never mixes with the
    // terminal reset + replayed backlog on stdout. Suppressed when piped.
    if is_tty {
        match prefix {
            Some(p) => {
                eprintln!("[amber] attached to {name} — {} d to detach", prefix_key_name(p));
            }
            None => eprintln!("[amber] attached to {name} — close the terminal to detach"),
        }
    }

    // Enter raw mode only when stdin really is a terminal (and restore it
    // via RAII regardless of how this function returns).
    let raw_guard = if is_tty { Some(RawModeGuard::enable()?) } else { None };

    let end = run_client(&stream, name, io::stdin(), io::stdout(), &winch, prefix);

    drop(raw_guard); // leave raw mode before printing any trailer
    match end? {
        ClientEnd::StdinEof => {}
        ClientEnd::Detached => eprintln!("[amber] detached from {name}"),
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
    prefix: Option<u8>,
) -> anyhow::Result<ClientEnd> {
    send_control(stream, ControlMsg::Attach { name: name.to_string(), raw_client: true })?;
    let (cols, rows) = current_size();
    send_control(stream, ControlMsg::Resize { name: name.to_string(), cols, rows })?;

    // Prefix armed across reads: a prefix byte can be the last byte of one
    // chunk and its command byte the first of the next.
    let mut prefix_armed = false;

    // Reset the local terminal before any replayed backlog can land (spec
    // §5) — see TERM_RESET for the exact sequences and why each is needed.
    stdout.write_all(TERM_RESET)?;
    stdout.flush()?;

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
            let chunk = &stdin_buf[..n];

            // Bytes to forward to the child. With no prefix, the raw chunk;
            // otherwise whatever the scanner leaves after stripping commands.
            let (to_send, detach) = match prefix {
                None => (chunk.to_vec(), false),
                Some(p) => {
                    let res = scan_prefix(chunk, p, prefix_armed);
                    prefix_armed = res.armed;
                    (res.forward, res.detach)
                }
            };

            if !to_send.is_empty() {
                let frame = Frame::Data { session: name.to_string(), bytes: to_send };
                let mut w = stream;
                w.write_all(&proto::encode(&frame))?;
                w.flush()?;
            }

            if detach {
                send_control(stream, ControlMsg::Detach { name: name.to_string() })?;
                return Ok(ClientEnd::Detached);
            }
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

    /// Start the client with the default `Ctrl-b` detach prefix active.
    fn start_client() -> Harness {
        start_client_with(Some(DEFAULT_PREFIX))
    }

    fn start_client_with(prefix: Option<u8>) -> Harness {
        let (client_sock, server) = UnixStream::pair().unwrap();
        let (stdin_feeder, stdin_read) = UnixStream::pair().unwrap();
        let winch = Arc::new(AtomicBool::new(false));
        let (tx, done) = mpsc::channel();
        {
            let winch = Arc::clone(&winch);
            std::thread::spawn(move || {
                let mut out = Vec::new();
                let end = run_client(&client_sock, "s", stdin_read, &mut out, &winch, prefix);
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
                // Generous vs POLL_TICK_MS (100ms): a Resize normally lands in
                // ~100ms, but under heavy CPU contention the client thread can
                // be starved for seconds. 20s tolerates that without hiding a
                // genuine "Resize never sent" break (which still fails).
                .set_read_timeout(Some(Duration::from_secs(20)))
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
        assert_eq!(out, [TERM_RESET, b"OUTPUT"].concat());
    }

    #[test]
    fn client_attaches_as_raw_client() {
        // `amber attach` is the plain-terminal client: it must identify
        // itself so the daemon can suppress alt-screen backlog replay
        // (spec §5). The Electron app attaches without the flag.
        let mut h = start_client();
        let frame =
            h.server_read_until(|f| matches!(f, Frame::Control(ControlMsg::Attach { .. })));
        assert_eq!(
            frame,
            Frame::Control(ControlMsg::Attach { name: "s".into(), raw_client: true })
        );
        drop(h.server);
        let _ = h.done.recv_timeout(Duration::from_secs(5)).unwrap();
    }

    #[test]
    fn client_emits_terminal_reset_before_replayed_backlog() {
        // The reset preamble must land before ANY replayed bytes (spec §5):
        // the local terminal may still be in a mode a previous attach left it
        // in (alt screen, hidden cursor).
        let mut h = start_client();
        h.expect_attach_and_initial_resize();
        let data = Frame::Data { session: "s".into(), bytes: b"BACKLOG".to_vec() };
        h.server.write_all(&proto::encode(&data)).unwrap();
        let exit = Frame::Control(ControlMsg::Exit { name: "s".into(), code: 0 });
        h.server.write_all(&proto::encode(&exit)).unwrap();
        let (_, out) = h.done.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(
            out.starts_with(TERM_RESET),
            "terminal reset must precede replayed bytes, got {out:?}"
        );
        assert!(out.ends_with(b"BACKLOG"), "replayed bytes lost, got {out:?}");
    }

    // ---- detach prefix: pure helpers ------------------------------------

    #[test]
    fn resolve_prefix_precedence() {
        // --no-prefix wins over everything.
        assert_eq!(resolve_prefix(true, Some("C-a")).prefix, None);
        // env remaps to the matching control byte.
        assert_eq!(resolve_prefix(false, Some("C-a")).prefix, Some(0x01));
        assert_eq!(resolve_prefix(false, Some("c-b")).prefix, Some(0x02));
        // none / empty disable interception.
        assert_eq!(resolve_prefix(false, Some("none")).prefix, None);
        assert_eq!(resolve_prefix(false, Some("")).prefix, None);
        // unset -> default Ctrl-b, no warning.
        let d = resolve_prefix(false, None);
        assert_eq!(d.prefix, Some(DEFAULT_PREFIX));
        assert!(d.warning.is_none());
        // garbage -> default Ctrl-b, with a warning for the caller to print.
        let bad = resolve_prefix(false, Some("banana"));
        assert_eq!(bad.prefix, Some(DEFAULT_PREFIX));
        assert!(bad.warning.is_some());
    }

    #[test]
    fn prefix_key_name_is_human_readable() {
        assert_eq!(prefix_key_name(0x02), "Ctrl-b");
        assert_eq!(prefix_key_name(0x01), "Ctrl-a");
        assert_eq!(prefix_key_name(0x7f), "0x7f");
    }

    fn info(name: &str, alive: bool, updated: u64) -> proto::SessionInfo {
        proto::SessionInfo {
            name: name.into(),
            cwd: "/tmp".into(),
            kind: "shell".into(),
            alive,
            updated,
        }
    }

    #[test]
    fn pick_newest_selects_most_recent_live() {
        assert!(pick_newest(&[]).is_none());
        // dead sessions are ignored even if newer.
        let only_dead = [info("a", false, 99)];
        assert!(pick_newest(&only_dead).is_none());
        // greatest `updated` among live wins.
        let mixed = [info("a", true, 10), info("b", true, 30), info("c", false, 40)];
        assert_eq!(pick_newest(&mixed).unwrap().name, "b");
        // tie on `updated` breaks toward the greater name, deterministically.
        let tie = [info("a", true, 5), info("z", true, 5)];
        assert_eq!(pick_newest(&tie).unwrap().name, "z");
    }

    #[test]
    fn scan_prefix_bindings() {
        let p = DEFAULT_PREFIX; // 0x02
        // plain bytes pass through, prefix disarmed.
        let r = scan_prefix(b"abc", p, false);
        assert_eq!(r, ScanResult { forward: b"abc".to_vec(), armed: false, detach: false });
        // prefix + d = detach, forwarding the bytes seen before it.
        let r = scan_prefix(b"ab\x02d", p, false);
        assert!(r.detach);
        assert_eq!(r.forward, b"ab".to_vec());
        // prefix + prefix = one literal prefix byte.
        let r = scan_prefix(b"\x02\x02", p, false);
        assert_eq!(r, ScanResult { forward: vec![p], armed: false, detach: false });
        // prefix + unbound key = drop both.
        let r = scan_prefix(b"\x02x", p, false);
        assert_eq!(r, ScanResult { forward: vec![], armed: false, detach: false });
        // trailing prefix leaves the scanner armed for the next chunk.
        let r = scan_prefix(b"x\x02", p, false);
        assert_eq!(r, ScanResult { forward: b"x".to_vec(), armed: true, detach: false });
        // an armed scanner completes the command from the next chunk.
        let r = scan_prefix(b"d", p, true);
        assert!(r.detach);
        assert!(r.forward.is_empty());
    }

    // ---- detach prefix: through the client event loop -------------------

    #[test]
    fn client_detaches_on_prefix_d() {
        let mut h = start_client();
        h.expect_attach_and_initial_resize();
        h.stdin_feeder.write_all(&[DEFAULT_PREFIX, b'd']).unwrap();
        // The daemon side must observe a Detach control frame...
        let frame = h.server_read_until(|f| matches!(f, Frame::Control(ControlMsg::Detach { .. })));
        assert_eq!(frame, Frame::Control(ControlMsg::Detach { name: "s".into() }));
        // ...and the client exits with Detached.
        let (end, _) = h.done.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(end.unwrap(), ClientEnd::Detached);
    }

    #[test]
    fn client_detaches_when_prefix_split_across_reads() {
        // The prefix byte and the `d` arrive in separate stdin reads; the
        // armed flag must survive between loop iterations.
        let mut h = start_client();
        h.expect_attach_and_initial_resize();
        h.stdin_feeder.write_all(&[DEFAULT_PREFIX]).unwrap();
        // Give the client a beat to consume the lone prefix and arm.
        h.server.set_read_timeout(Some(Duration::from_millis(300))).unwrap();
        let mut scratch = [0u8; 64];
        let _ = h.server.read(&mut scratch); // drain nothing / timeout, just yield
        h.stdin_feeder.write_all(b"d").unwrap();
        let frame = h.server_read_until(|f| matches!(f, Frame::Control(ControlMsg::Detach { .. })));
        assert_eq!(frame, Frame::Control(ControlMsg::Detach { name: "s".into() }));
        let (end, _) = h.done.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(end.unwrap(), ClientEnd::Detached);
    }

    #[test]
    fn client_sends_literal_prefix_on_double_prefix() {
        let mut h = start_client();
        h.expect_attach_and_initial_resize();
        h.stdin_feeder.write_all(&[DEFAULT_PREFIX, DEFAULT_PREFIX]).unwrap();
        let frame = h.server_read_until(|f| matches!(f, Frame::Data { .. }));
        assert_eq!(
            frame,
            Frame::Data { session: "s".into(), bytes: vec![DEFAULT_PREFIX] }
        );
        drop(h.stdin_feeder);
        let (end, _) = h.done.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(end.unwrap(), ClientEnd::StdinEof);
    }

    #[test]
    fn client_forwards_raw_prefix_when_interception_disabled() {
        // With prefix None, a raw prefix byte is ordinary input (no detach).
        let mut h = start_client_with(None);
        h.expect_attach_and_initial_resize();
        h.stdin_feeder.write_all(&[DEFAULT_PREFIX, b'd']).unwrap();
        let frame = h.server_read_until(|f| matches!(f, Frame::Data { .. }));
        assert_eq!(
            frame,
            Frame::Data { session: "s".into(), bytes: vec![DEFAULT_PREFIX, b'd'] }
        );
        drop(h.stdin_feeder);
        let (end, _) = h.done.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(end.unwrap(), ClientEnd::StdinEof);
    }
}
