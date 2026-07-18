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

/// Written to the local terminal on detach/exit (the mirror of [`TERM_RESET`]).
/// The attach client is a raw pipe, so any mode the streamed session output set
/// (mouse tracking, bracketed paste, the alt screen, a hidden cursor) reached
/// the user's REAL terminal directly and stays set after we stop streaming.
/// Without this, detaching leaves:
/// - mouse tracking on → the shell spams encoded reports (`ESC[<…M`) on every
///   pointer move/click — the "character spam" bug;
/// - the alt screen held → a TUI session (claude) leaves a frozen buffer on
///   screen instead of returning the user to their shell — "rendering off".
///
/// Mirrors tmux/screen detach restore. Order: disable mouse (all encodings) +
/// bracketed paste, DECSTR soft reset (autowrap/origin/cursor-keys/margins),
/// leave the alt screen, show the cursor.
const TERM_RESTORE: &[u8] =
    b"\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?2004l\x1b[!p\x1b[?1049l\x1b[?25h";

/// Why [`run_client`] returned.
#[derive(Debug, Clone, PartialEq, Eq)]
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
    /// The daemon rejected the attach with an `Error` frame (e.g. `amber attach
    /// <typo>` — "no such session"). Carries the daemon's message; the caller
    /// prints it and exits nonzero. Without this, a bad attach silently emitted
    /// the terminal reset and left a dead, unresponsive terminal.
    Rejected(String),
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

/// The session at 1-based `index` in the by-name sort — the exact ordering
/// `amber ls` prints, so `amber attach <n>` selects the n-th listed session.
/// No alive filter (matches `ls`, which lists every session). `None` for index
/// 0 or out of range.
pub fn pick_by_index(sessions: &[proto::SessionInfo], index: usize) -> Option<&proto::SessionInfo> {
    let i = index.checked_sub(1)?;
    let mut refs: Vec<&proto::SessionInfo> = sessions.iter().collect();
    refs.sort_by(|a, b| a.name.cmp(&b.name));
    refs.get(i).copied()
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

// ---- session indicator: title + best-effort bottom bar -----------------

/// Terminal decoration for an interactive attach. Both fields are inert off a
/// tty; the headless tests use [`StatusUi::none`].
#[derive(Debug, Clone)]
pub struct StatusUi {
    /// Set the terminal title (`amber: <name>`) via OSC 2 (push/pop).
    pub title: bool,
    /// Reserve the last row for the tmux-style status bar.
    pub bar: bool,
    /// Detach-key label shown in the bar (e.g. `Ctrl-b`); `None` omits the hint.
    pub hint: Option<String>,
}

impl StatusUi {
    /// No decoration — raw passthrough, used off a tty and in tests.
    pub fn none() -> Self {
        StatusUi { title: false, bar: false, hint: None }
    }
}

/// OSC 2 set-title, preceded by XTPUSHTITLE so [`TITLE_POP`] can restore it.
fn title_set(name: &str) -> String {
    format!("\x1b[22;2t\x1b]2;amber: {name}\x07")
}
/// XTPOPTITLE — restore the title saved by [`title_set`] (ignored if unsupported).
const TITLE_POP: &str = "\x1b[23;2t";

/// DECSTBM: confine scrolling to rows `1..=bottom`, keeping the bar row clear.
fn set_scroll_region(bottom: u16) -> String {
    format!("\x1b[1;{bottom}r")
}
/// DECSTBM reset to the full screen.
const SCROLL_RESET: &str = "\x1b[r";

/// Draw `line` on physical row `row`, preserving the child's cursor (DECSC/DECRC).
fn draw_bar(row: u16, line: &str) -> String {
    format!("\x1b7\x1b[{row};1H\x1b[7m{line}\x1b[0m\x1b8")
}
/// Erase physical row `row` (used on cleanup), preserving the cursor.
fn clear_row(row: u16) -> String {
    format!("\x1b7\x1b[{row};1H\x1b[2K\x1b8")
}

/// The visible status-bar text: `amber: <name>` plus an optional detach hint,
/// truncated to `cols` and padded with spaces to exactly `cols` columns (no
/// escape sequences — the caller wraps it in positioning + SGR). Assumes
/// single-width ASCII, which the fixed content is.
fn render_status_line(name: &str, cols: u16, hint: Option<&str>) -> String {
    let cols = cols as usize;
    let mut s = format!("amber: {name}");
    if let Some(h) = hint {
        s.push_str(&format!(" · {h} d detach"));
    }
    let width = s.chars().count();
    if width > cols {
        s = s.chars().take(cols).collect();
    } else {
        s.push_str(&" ".repeat(cols - width));
    }
    s
}

/// Tracks whether the child is on the alternate screen, by parsing DEC
/// private-mode set/reset (`ESC [ ? … h|l`) in the *output* stream. Modes
/// 47 / 1047 / 1049 toggle the alt screen. This is a bounded state machine
/// (split-safe across `feed` calls), NOT a general terminal emulator — it only
/// gates whether the bar may draw, so it never paints over a full-screen TUI.
#[derive(Debug)]
struct AltScreenTracker {
    alt: bool,
    state: AltState,
}

#[derive(Debug, PartialEq, Eq)]
enum AltState {
    Normal,
    Esc,           // saw ESC
    Csi,           // saw ESC [
    Priv(String),  // saw ESC [ ? … , collecting parameter bytes
}

impl AltScreenTracker {
    fn new() -> Self {
        AltScreenTracker { alt: false, state: AltState::Normal }
    }

    fn is_alt(&self) -> bool {
        self.alt
    }

    /// Feed output bytes; returns the alt-screen state after consuming them.
    fn feed(&mut self, bytes: &[u8]) -> bool {
        for &b in bytes {
            self.state = match std::mem::replace(&mut self.state, AltState::Normal) {
                AltState::Normal if b == 0x1b => AltState::Esc,
                AltState::Normal => AltState::Normal,
                AltState::Esc if b == b'[' => AltState::Csi,
                AltState::Esc if b == 0x1b => AltState::Esc,
                AltState::Esc => AltState::Normal,
                AltState::Csi if b == b'?' => AltState::Priv(String::new()),
                AltState::Csi if b == 0x1b => AltState::Esc,
                AltState::Csi => AltState::Normal,
                AltState::Priv(mut params) => {
                    if b == b'h' || b == b'l' {
                        if params.split(';').any(|p| matches!(p, "47" | "1047" | "1049")) {
                            self.alt = b == b'h';
                        }
                        AltState::Normal
                    } else if b.is_ascii_digit() || b == b';' {
                        params.push(b as char);
                        AltState::Priv(params)
                    } else if b == 0x1b {
                        AltState::Esc
                    } else {
                        AltState::Normal
                    }
                }
            };
        }
        self.alt
    }
}

/// Whether attaching from inside an amber pane should be refused. `Some(msg)`
/// means refuse (and print `msg`); `None` means proceed. Nesting is refused
/// when `AMBER_SESSION` is set unless `force` (—force / `AMBER_ALLOW_NEST`).
pub fn nest_refusal(amber_session: Option<&str>, force: bool) -> Option<String> {
    match amber_session {
        Some(s) if !force => Some(format!(
            "already inside amber session '{s}'; refusing to nest \
             (use --force or AMBER_ALLOW_NEST=1 to override)"
        )),
        _ => None,
    }
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
pub fn attach(socket: &Path, name: &str, prefix: Option<u8>, want_bar: bool) -> anyhow::Result<()> {
    let stream = UnixStream::connect(socket).map_err(|e| {
        anyhow::anyhow!(
            "cannot reach the amber daemon at {} ({e}) — is it running?",
            socket.display()
        )
    })?;

    let winch = Arc::new(AtomicBool::new(false));
    signal_hook::flag::register(signal_hook::consts::SIGWINCH, Arc::clone(&winch))?;

    let is_tty = io::stdin().is_terminal();

    // Decoration is meaningful only on a real terminal. Off a tty (pipes,
    // tests) everything stays raw. The title is always on; the bar is on only
    // when the caller allows it (`want_bar` folds in --no-status and the
    // shell-only gate — the bar is never drawn over a full-screen TUI session
    // such as claude, whose alt-screen state the raw client can't observe).
    let ui = if is_tty {
        StatusUi { title: true, bar: want_bar, hint: prefix.map(prefix_key_name) }
    } else {
        StatusUi::none()
    };

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

    let end = run_client(&stream, name, io::stdin(), io::stdout(), &winch, prefix, &ui);

    // Unwind title/bar on EVERY exit — Ok or Err — before leaving raw mode, so
    // a mid-loop error never strands a scroll region on the user's shell.
    teardown_decoration(&ui);

    drop(raw_guard); // leave raw mode before printing any trailer
    match end? {
        ClientEnd::StdinEof => {}
        ClientEnd::Detached => eprintln!("[amber] detached from {name}"),
        ClientEnd::SocketClosed => eprintln!("[amber] daemon closed the connection"),
        ClientEnd::SessionExit(code) => {
            eprintln!("[amber] session {name} ended (exit code {code})");
        }
        // Daemon refused the attach (no such session, etc.). Report + exit
        // nonzero so a typo'd `amber attach` doesn't look like success. The
        // terminal is already restored (teardown + raw_guard drop ran above).
        ClientEnd::Rejected(msg) => {
            eprintln!("[amber] {msg}");
            std::process::exit(1);
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
    ui: &StatusUi,
) -> anyhow::Result<ClientEnd> {
    send_control(stream, ControlMsg::Attach { name: name.to_string(), raw_client: true })?;

    // Whether the bar can be shown at a given height: it needs the physical
    // last row plus at least one row for the child.
    let bar_at = |rows: u16| ui.bar && rows >= 2;
    let child_rows = |rows: u16| if bar_at(rows) { rows - 1 } else { rows };
    let bar_line = |cols: u16| render_status_line(name, cols, ui.hint.as_deref());

    let (mut cols, mut rows) = current_size();
    send_control(
        stream,
        ControlMsg::Resize { name: name.to_string(), cols, rows: child_rows(rows) },
    )?;

    // Prefix armed across reads: a prefix byte can be the last byte of one
    // chunk and its command byte the first of the next.
    let mut prefix_armed = false;
    // Alt-screen state, so the bar never paints over a full-screen TUI.
    let mut alt = AltScreenTracker::new();

    // Reset the local terminal before any replayed backlog can land (spec
    // §5) — see TERM_RESET for the exact sequences and why each is needed.
    stdout.write_all(TERM_RESET)?;
    if ui.title {
        stdout.write_all(title_set(name).as_bytes())?;
    }
    if bar_at(rows) {
        stdout.write_all(set_scroll_region(rows - 1).as_bytes())?;
        stdout.write_all(draw_bar(rows, &bar_line(cols)).as_bytes())?;
    }
    stdout.flush()?;

    let mut decoder = Decoder::new();
    let mut sock_buf = [0u8; 8192];
    let mut stdin_buf = [0u8; 4096];

    let end = 'ev: loop {
        if winch.swap(false, Ordering::Relaxed) {
            let (c, r) = current_size();
            cols = c;
            rows = r;
            send_control(
                stream,
                ControlMsg::Resize { name: name.to_string(), cols, rows: child_rows(rows) },
            )?;
            if bar_at(rows) && !alt.is_alt() {
                stdout.write_all(set_scroll_region(rows - 1).as_bytes())?;
                stdout.write_all(draw_bar(rows, &bar_line(cols)).as_bytes())?;
                stdout.flush()?;
            }
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
                break 'ev ClientEnd::SocketClosed;
            }
            decoder.feed(&sock_buf[..n]);
            let was_alt = alt.is_alt();
            let mut exit_code: Option<i32> = None;
            let mut rejected: Option<String> = None;
            while let Some(frame) = decoder.next_frame()? {
                match frame {
                    Frame::Data { bytes, .. } => {
                        alt.feed(&bytes);
                        stdout.write_all(&bytes)?;
                    }
                    Frame::Control(ControlMsg::Exit { name: ended, code }) if ended == name => {
                        exit_code = Some(code);
                        break;
                    }
                    // The daemon refused the attach (e.g. no such session).
                    // Surface it instead of dropping it — otherwise the reset is
                    // emitted and the terminal sits dead with no feedback.
                    Frame::Control(ControlMsg::Error { msg }) => {
                        rejected = Some(msg);
                        break;
                    }
                    _ => {}
                }
            }
            // Redraw the bar ONLY when the child has just left the alt screen
            // (a complete, parsed `?1049l` transition), re-asserting the scroll
            // region the TUI cleared. We deliberately do NOT redraw after every
            // batch: the daemon batches raw pty bytes with no escape-sequence
            // awareness, so a redraw mid-stream could inject between two halves
            // of one of the child's own sequences (best-effort — a child that
            // resets the scroll region in the primary screen may push the bar
            // off until the next redraw trigger).
            if bar_at(rows) && was_alt && !alt.is_alt() {
                stdout.write_all(set_scroll_region(rows - 1).as_bytes())?;
                stdout.write_all(draw_bar(rows, &bar_line(cols)).as_bytes())?;
            }
            stdout.flush()?;
            if let Some(msg) = rejected {
                break 'ev ClientEnd::Rejected(msg);
            }
            if let Some(code) = exit_code {
                break 'ev ClientEnd::SessionExit(code);
            }
        }

        if stdin_ready {
            let n = stdin.read(&mut stdin_buf)?;
            if n == 0 {
                break 'ev ClientEnd::StdinEof;
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
                break 'ev ClientEnd::Detached;
            }
        }
    };

    // Terminal decoration is unwound by the caller (`attach`) on ALL exit
    // paths — including the `?` errors above — so a mid-loop failure can't
    // strand a scroll region on the user's shell.
    Ok(end)
}

/// Build the teardown byte sequence: undo the attach decoration (leave the
/// scroll region, clear the reserved row, pop the title) AND restore sane
/// terminal modes ([`TERM_RESTORE`] — mouse/paste/alt-screen/cursor), which the
/// streamed session output may have left set on the LOCAL terminal. Pure so it
/// is unit-testable; empty for a non-tty (`StatusUi::none()`), where there is no
/// terminal to restore. The restore always runs on a tty — not just when the
/// bar/title were drawn — because the mode leak is independent of decoration
/// (e.g. a claude session runs with the bar OFF but still leaves the alt screen
/// and mouse tracking on).
fn restore_bytes(ui: &StatusUi, rows: u16) -> Vec<u8> {
    let mut b = Vec::new();
    if !(ui.title || ui.bar) {
        return b; // non-tty: nothing was decorated and nothing to restore
    }
    if ui.bar && rows >= 2 {
        b.extend_from_slice(SCROLL_RESET.as_bytes());
        b.extend_from_slice(clear_row(rows).as_bytes());
    }
    if ui.title {
        b.extend_from_slice(TITLE_POP.as_bytes());
    }
    b.extend_from_slice(TERM_RESTORE);
    b
}

/// Undo attach decoration + restore sane terminal modes on EVERY exit path
/// (detach, socket close, session exit, stdin EOF). Best-effort (ignores write
/// errors); written through a fresh stdout handle so it runs regardless of how
/// `run_client` returned.
fn teardown_decoration(ui: &StatusUi) {
    let (_, rows) = current_size();
    let bytes = restore_bytes(ui, rows);
    if bytes.is_empty() {
        return;
    }
    let mut out = io::stdout();
    let _ = out.write_all(&bytes);
    let _ = out.flush();
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
        start_client_full(prefix, StatusUi::none())
    }

    fn start_client_full(prefix: Option<u8>, ui: StatusUi) -> Harness {
        let (client_sock, server) = UnixStream::pair().unwrap();
        let (stdin_feeder, stdin_read) = UnixStream::pair().unwrap();
        let winch = Arc::new(AtomicBool::new(false));
        let (tx, done) = mpsc::channel();
        {
            let winch = Arc::clone(&winch);
            std::thread::spawn(move || {
                let mut out = Vec::new();
                let end = run_client(&client_sock, "s", stdin_read, &mut out, &winch, prefix, &ui);
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
    fn client_surfaces_error_frame_as_rejected() {
        // The daemon rejects an attach to a nonexistent session with an Error
        // frame. The client must surface it (and exit nonzero) rather than
        // silently emit the terminal reset and sit on a dead terminal.
        let mut h = start_client();
        h.expect_attach_and_initial_resize();
        let err = Frame::Control(ControlMsg::Error { msg: "no such session: s".into() });
        h.server.write_all(&proto::encode(&err)).unwrap();
        let (end, _) = h.done.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(end.unwrap(), ClientEnd::Rejected("no such session: s".into()));
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
            run_state: None,
            claude_id: None,
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
    fn restore_bytes_resets_terminal_modes_on_teardown() {
        let has = |hay: &[u8], needle: &[u8]| hay.windows(needle.len()).any(|w| w == needle);

        // Non-tty (piped/tests): nothing to restore.
        assert!(restore_bytes(&StatusUi::none(), 24).is_empty());

        // claude-style attach (title on, bar off): no scroll-region reset, but
        // the mode restore (mouse-off + leave alt screen) MUST run — this is the
        // exact detach-glitch case.
        let claude = StatusUi { title: true, bar: false, hint: None };
        let out = restore_bytes(&claude, 24);
        assert!(!has(&out, SCROLL_RESET.as_bytes()), "no bar => no scroll reset");
        assert!(has(&out, TITLE_POP.as_bytes()));
        assert!(has(&out, b"\x1b[?1000l"), "must disable mouse tracking");
        assert!(has(&out, b"\x1b[?1006l"), "must disable SGR mouse encoding");
        assert!(has(&out, b"\x1b[?2004l"), "must disable bracketed paste");
        assert!(has(&out, b"\x1b[?1049l"), "must leave the alt screen");
        assert!(has(&out, b"\x1b[?25h"), "must show the cursor");

        // Shell attach with the bar: scroll region + reserved row cleared too.
        let bar = StatusUi { title: true, bar: true, hint: None };
        let out = restore_bytes(&bar, 24);
        assert!(has(&out, SCROLL_RESET.as_bytes()));
        assert!(has(&out, b"\x1b[?1000l"));
        assert!(has(&out, b"\x1b[?1049l"));
    }

    #[test]
    fn pick_by_index_matches_ls_order() {
        // Given out-of-order input, indexing follows the by-name sort (== `ls`).
        let s = [info("amber-c", true, 1), info("amber-a", false, 9), info("amber-b", true, 5)];
        assert_eq!(pick_by_index(&s, 1).unwrap().name, "amber-a"); // sorted: a,b,c
        assert_eq!(pick_by_index(&s, 2).unwrap().name, "amber-b");
        assert_eq!(pick_by_index(&s, 3).unwrap().name, "amber-c"); // dead sessions still indexed
        // 0 is invalid (1-based); past-the-end is None.
        assert!(pick_by_index(&s, 0).is_none());
        assert!(pick_by_index(&s, 4).is_none());
        assert!(pick_by_index(&[], 1).is_none());
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

    // ---- session indicator: pure helpers --------------------------------

    #[test]
    fn render_status_line_pads_and_truncates() {
        // Padded to exactly `cols`.
        let line = render_status_line("work", 30, Some("Ctrl-b"));
        assert_eq!(line.chars().count(), 30);
        assert!(line.starts_with("amber: work · Ctrl-b d detach"));
        // No hint -> just the name, still padded.
        let plain = render_status_line("work", 20, None);
        assert_eq!(plain.chars().count(), 20);
        assert!(plain.starts_with("amber: work"));
        // Overflow is truncated to `cols` (never wider).
        let narrow = render_status_line("a-very-long-session-name", 10, Some("Ctrl-b"));
        assert_eq!(narrow.chars().count(), 10);
        assert_eq!(narrow, "amber: a-v");
    }

    #[test]
    fn alt_screen_tracker_toggles_on_relevant_modes() {
        let mut t = AltScreenTracker::new();
        assert!(!t.is_alt());
        assert!(t.feed(b"\x1b[?1049h")); // enter alt
        assert!(t.is_alt());
        assert!(!t.feed(b"\x1b[?1049l")); // leave alt
        assert!(!t.is_alt());
        // Combined params (mode 1049 alongside another) still toggles.
        assert!(t.feed(b"\x1b[?1;1049h"));
        // Legacy 47 / 1047 recognized too.
        assert!(!t.feed(b"\x1b[?1047l"));
        // An unrelated private mode (cursor visibility 25) does NOT toggle.
        t.feed(b"\x1b[?25h");
        assert!(!t.is_alt());
    }

    #[test]
    fn alt_screen_tracker_handles_split_sequences() {
        let mut t = AltScreenTracker::new();
        // The enter-alt sequence arrives in three separate feeds.
        t.feed(b"\x1b[?10");
        t.feed(b"49");
        assert!(t.feed(b"h"));
        assert!(t.is_alt());
    }

    #[test]
    fn nest_refusal_gates_on_env_and_force() {
        assert!(nest_refusal(None, false).is_none());
        assert!(nest_refusal(Some("work"), false).is_some());
        // --force / AMBER_ALLOW_NEST overrides.
        assert!(nest_refusal(Some("work"), true).is_none());
    }

    // ---- session indicator: through the client event loop ---------------

    #[test]
    fn bar_reserves_a_row_in_the_initial_resize() {
        // With the bar enabled the child must be sized one row short so the
        // physical last row is free for the bar. current_size() falls back to
        // 80x24 off a tty, so the reserved Resize carries rows = 23.
        let ui = StatusUi { title: true, bar: true, hint: Some("Ctrl-b".into()) };
        let mut h = start_client_full(Some(DEFAULT_PREFIX), ui);
        let resize = h.server_read_until(|f| matches!(f, Frame::Control(ControlMsg::Resize { .. })));
        match resize {
            Frame::Control(ControlMsg::Resize { rows, .. }) => assert_eq!(rows, 23),
            other => panic!("expected Resize, got {other:?}"),
        }
        drop(h.server);
        let _ = h.done.recv_timeout(Duration::from_secs(5)).unwrap();
    }

    #[test]
    fn no_bar_uses_full_height_and_emits_no_scroll_region() {
        // Without the bar the child gets the full height (rows = 24), and
        // run_client emits no scroll-region control at all (the bar is what
        // sets it; teardown lives in `attach`, not the loop).
        let mut h = start_client_full(Some(DEFAULT_PREFIX), StatusUi::none());
        let resize = h.server_read_until(|f| matches!(f, Frame::Control(ControlMsg::Resize { .. })));
        match resize {
            Frame::Control(ControlMsg::Resize { rows, .. }) => assert_eq!(rows, 24),
            other => panic!("expected Resize, got {other:?}"),
        }
        let exit = Frame::Control(ControlMsg::Exit { name: "s".into(), code: 0 });
        h.server.write_all(&proto::encode(&exit)).unwrap();
        let (end, out) = h.done.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(end.unwrap(), ClientEnd::SessionExit(0));
        assert!(
            !out.windows(SCROLL_RESET.len()).any(|w| w == SCROLL_RESET.as_bytes()),
            "no-bar attach must not emit a scroll-region reset"
        );
    }
}
