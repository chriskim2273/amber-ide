//! `amber web` — a mobile web UI for live amber sessions, served over
//! HTTP/WebSocket on `127.0.0.1` only.
//!
//! Spec: `docs/superpowers/specs/2026-07-19-amber-web-mobile-design.md`.
//!
//! This is a daemon **client**, not a second daemon (CLAUDE.md core rule #1):
//! it holds ONE unix-socket connection and multiplexes every browser tab over
//! it exactly like the Electron client (`Attach` per session, `Data` frames
//! tagged by name).
//!
//! # Browser ⇄ server protocol
//!
//! One WebSocket per browser tab. **Control is JSON text frames; terminal
//! bytes are BINARY frames, raw, no wrapper and no base64.**
//!
//! browser → server:
//! - `{"t":"open","name":"<session>"}` — attach that session on this
//!   connection. One open session per connection; `open` while another is
//!   open switches (`Detach` old, `Attach` new).
//! - `{"t":"close","name":"<session>"}` — detach it.
//! - `{"t":"resize","name":"..","cols":n,"rows":n}` — resize that session's
//!   pty (2026-08-01 decision reversing the earlier "never resize" rule; see
//!   Invariants below). Ignored (no-op, no error) for a session that isn't
//!   currently live, or for cols/rows outside [`map_browser_msg`]'s bounds.
//! - a BINARY frame — raw input bytes for this connection's currently-open
//!   session. With no open session it is ignored.
//!
//! server → browser:
//! - a BINARY frame — raw pty output of this connection's open session.
//! - `{"t":"sessions","sessions":[{"name","kind","cwd","run_state","alive",
//!   "cols","rows"}]}` — sent once on connect and on every change (including
//!   an empty list when the daemon is unreachable). `cols`/`rows` are the
//!   pty's LIVE winsize: the hand-written phone client (`assets/app.js`)
//!   renders at that geometry and never sends a resize of its own (spec §4 of
//!   the mobile design) — the newer React-renderer web build reads this the
//!   same way the Electron client does (session-list display), not to drive
//!   its own pane geometry.
//! - `{"t":"exit","name":"..","code":n}`
//! - `{"t":"error","msg":".."}`
//!
//! Unknown `t`, malformed JSON, or a binary frame with no open session are
//! **ignored** — never an error that closes the socket.
//!
//! # Invariants
//!
//! - **The browser may resize a pty (2026-08-01 decision, reversing the
//!   earlier "never resize" rule)** — the real React renderer's web build no
//!   longer pins its xterm grid to the pty and shrinks its font to fit;
//!   instead it resizes the pty to fit ITS pane, exactly like the Electron
//!   desktop client. Accepted cost: a pty's winsize is shared with the
//!   desktop app, so a browser-driven resize reflows the desktop's live
//!   panes while the user is away from it — the desktop re-fits its own
//!   panes on return and a running TUI repaints on the SIGWINCH, so this is
//!   judged self-healing. [`map_browser_msg`] is the ONLY path from a browser
//!   message to a daemon control message; its `Resize` arm is the one place
//!   that constructs `ControlMsg::Resize`, and only after checking the
//!   session is live and `cols`/`rows` are within [`RESIZE_MIN_COLS`]..=
//!   [`RESIZE_MAX_COLS`] / [`RESIZE_MIN_ROWS`]..=[`RESIZE_MAX_ROWS`] — a
//!   crushed/backgrounded browser window must not be able to shrink a pty to
//!   something degenerate that corrupts the desktop's layout when it returns.
//! - **The browser can create/kill/move/suspend/resume/resize panes,
//!   validated at the boundary** (pane-parity pass, widened by the resize
//!   reversal above): `Create`/`Kill`/`Rename`/`Suspend`/`Resume`/`Resize` are
//!   reachable, but only ever CONSTRUCTED from validated parts — never passed
//!   through. `Snapshot` and `ReportRunState` remain unreachable from
//!   [`map_browser_msg`] by construction (no `BrowserMsg` variant parses to
//!   them).
//! - A large `Attach` backlog is delivered on the per-client writer thread,
//!   never on the shared daemon-read thread (the backlog head-of-line lesson
//!   in CLAUDE.md).

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use amber_core::proto::{self, ControlMsg, Decoded, Decoder, Frame, SessionInfo};
use crate::transport::{self, LocalReader, LocalWriter};

use crate::layout_cas;
use crate::mosaic;

// ---- constant-time comparison ------------------------------------------

/// Compare two secrets without an early-exit data dependency on their
/// contents. Length is compared first (it is not secret: both the token and
/// the cookie session id are fixed-length).
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    std::hint::black_box(diff) == 0
}

/// Unpadded base64url of `bytes` (RFC 4648 §5) — the only encoding needed:
/// tokens and cookie session ids are generated here and compared as strings.
pub fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        let idx = [(n >> 18) & 63, (n >> 12) & 63, (n >> 6) & 63, n & 63];
        for &j in idx.iter().take(chunk.len() + 1) {
            out.push(ALPHABET[j as usize] as char);
        }
    }
    out
}

// ---- HTTP request parsing ----------------------------------------------

/// A parsed HTTP/1.1 request. Header names are lowercased.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

/// Largest accepted request head + body. The browser only ever POSTs a token,
/// so anything larger is hostile/garbage.
pub const MAX_REQUEST_LEN: usize = 32 * 1024;

/// Parse one complete request from `buf`. `Ok(None)` means "need more bytes".
pub fn parse_request(buf: &[u8]) -> anyhow::Result<Option<Request>> {
    if buf.len() > MAX_REQUEST_LEN {
        anyhow::bail!("request exceeds {MAX_REQUEST_LEN} bytes");
    }
    let Some(head_end) = buf.windows(4).position(|w| w == b"\r\n\r\n") else {
        return Ok(None);
    };
    let head = std::str::from_utf8(&buf[..head_end])?;
    let mut lines = head.split("\r\n");
    let start = lines.next().unwrap_or_default();
    let mut parts = start.split(' ');
    let (Some(method), Some(path), Some(version)) = (parts.next(), parts.next(), parts.next())
    else {
        anyhow::bail!("malformed request line: {start:?}");
    };
    if !version.starts_with("HTTP/") {
        anyhow::bail!("malformed request line: {start:?}");
    }
    let mut headers = Vec::new();
    for line in lines {
        let Some((k, v)) = line.split_once(':') else {
            anyhow::bail!("malformed header line: {line:?}");
        };
        headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
    }
    let body_start = head_end + 4;
    let len: usize = headers
        .iter()
        .find(|(k, _)| k == "content-length")
        .map(|(_, v)| v.parse())
        .transpose()?
        .unwrap_or(0);
    if buf.len() < body_start + len {
        return Ok(None);
    }
    Ok(Some(Request {
        method: method.to_string(),
        path: path.to_string(),
        headers,
        body: buf[body_start..body_start + len].to_vec(),
    }))
}

/// Value of cookie `name` in a `Cookie:` header value, if present.
pub fn cookie_value<'a>(header: &'a str, name: &str) -> Option<&'a str> {
    header.split(';').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k.trim() == name).then_some(v.trim())
    })
}

/// Same-origin check for the WebSocket upgrade (spec §3.5). The tailnet
/// hostname is unknowable here, so the rule is: an `Origin`, if present, must
/// name a host the request was addressed to. A request with no `Origin` is not
/// a browser page (curl, the tests) and is allowed.
///
/// BOTH `Host` and `X-Forwarded-Host` count: `tailscale serve` terminates TLS
/// and proxies to 127.0.0.1, so the real tailnet name may arrive only in
/// `X-Forwarded-Host` (the same header family we already trust for
/// `X-Forwarded-Proto`). Matching just `Host` would 403 every real phone.
/// Erring toward accepting the legitimate tailnet host is the right tradeoff:
/// the cookie is `HttpOnly; SameSite=Strict`, which already blocks a foreign
/// origin from attaching it — this check is defence in depth.
pub fn origin_ok(origin: Option<&str>, host: Option<&str>, fwd_host: Option<&str>) -> bool {
    let Some(origin) = origin else { return true };
    // Strip the scheme; what remains is `host[:port]`.
    let authority = origin.split_once("://").map(|(_, rest)| rest).unwrap_or(origin);
    [host, fwd_host]
        .into_iter()
        .flatten()
        .any(|h| authority.eq_ignore_ascii_case(h))
}

// ---- browser message → daemon control ----------------------------------

/// The complete set of browser-originated control messages (spec §5, widened
/// by the pane-parity pass).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrowserMsg {
    Open { name: String },
    Close { name: String },
    Focus { name: String },
    Create { name: String, cwd: String, kind: String },
    Kill { name: String },
    Move { from: String, to: String },
    Suspend { name: String },
    Resume { name: String },
    /// One-shot scrollback dump request (spec §3 "Backlog" row). Reply rides
    /// its own `backlogReply` marker + a binary frame — see [`Hub::on_frame`].
    DumpBacklog { name: String },
    /// The browser resizing its own pty (2026-08-01 decision). `cols`/`rows`
    /// are untrusted wire input — [`map_browser_msg`] is what bounds-checks
    /// them before they can become a [`ControlMsg::Resize`].
    Resize { name: String, cols: u16, rows: u16 },
    /// The browser is done looking at its open session (un-zoom, tab hidden,
    /// page unload). Maps to NO daemon control message of its own — it only
    /// tells the [`Hub`] to hand a borrowed pty grid back (spec §2.3).
    Release,
}

/// Parse a browser control (JSON text) frame. `None` for malformed JSON, an
/// unknown `t`, or a missing/!string field — the caller ignores it.
pub fn parse_browser_msg(text: &str) -> Option<BrowserMsg> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let f = |k: &str| v.get(k)?.as_str().map(str::to_string);
    match v.get("t")?.as_str()? {
        "open" => Some(BrowserMsg::Open { name: f("name")? }),
        "close" => Some(BrowserMsg::Close { name: f("name")? }),
        "focus" => Some(BrowserMsg::Focus { name: f("name")? }),
        "create" => Some(BrowserMsg::Create { name: f("name")?, cwd: f("cwd")?, kind: f("kind")? }),
        "kill" => Some(BrowserMsg::Kill { name: f("name")? }),
        "move" => Some(BrowserMsg::Move { from: f("from")?, to: f("to")? }),
        "suspend" => Some(BrowserMsg::Suspend { name: f("name")? }),
        "resume" => Some(BrowserMsg::Resume { name: f("name")? }),
        "dumpBacklog" => Some(BrowserMsg::DumpBacklog { name: f("name")? }),
        "release" => Some(BrowserMsg::Release),
        "resize" => Some(BrowserMsg::Resize {
            name: f("name")?,
            cols: v.get("cols")?.as_u64().and_then(|n| u16::try_from(n).ok())?,
            rows: v.get("rows")?.as_u64().and_then(|n| u16::try_from(n).ok())?,
        }),
        // Anything else — including a hand-crafted `snapshot`/`reportrunstate`
        // — has no representation here, so it can never reach the daemon.
        _ => None,
    }
}

/// Bounds on a browser-requested pty resize (2026-08-01 decision), enforced in
/// [`map_browser_msg`]. Floor: a browser window crushed to nothing (minimized,
/// a backgrounded/`display:none` tab, a mid-layout transient) must not be able
/// to shrink the pty to something degenerate — 10 cols / 4 rows is comfortably
/// below any real split (the layout's own minimum ratio, 0.05, still leaves
/// far more than this on a normal viewport) but well above a 1x1 that would
/// SIGWINCH every full-screen program into repainting garbage. Ceiling: 1000
/// cols / 300 rows is far beyond any real display, so it only rejects a
/// broken/hostile client rather than a legitimate huge monitor.
const RESIZE_MIN_COLS: u16 = 10;
const RESIZE_MAX_COLS: u16 = 1000;
const RESIZE_MIN_ROWS: u16 = 4;
const RESIZE_MAX_ROWS: u16 = 300;

/// Valid `Create` kinds. A pty runs a shell or `amber run <name> [--kind …]`
/// and nothing else — `Create` carries no argv, so this is the entire surface.
const CREATE_KINDS: [&str; 7] = ["shell", "claude", "grok", "codex", "opencode", "hermes", "pi"];

/// The ONLY mapping from a browser message to daemon control messages
/// (spec §5, widened by the pane-parity pass). `open` is this connection's
/// currently-open session; `sessions` is the daemon's current session set.
///
/// Every arm CONSTRUCTS its `ControlMsg` from validated parts; nothing from
/// the browser is passed through unchecked. By construction there is no path
/// from any browser input to `Snapshot` or `ReportRunState`; `Resize` IS
/// reachable (2026-08-01 decision) but only for a live session and only
/// within [`RESIZE_MIN_COLS`]..=[`RESIZE_MAX_COLS`] /
/// [`RESIZE_MIN_ROWS`]..=[`RESIZE_MAX_ROWS`].
pub fn map_browser_msg(
    msg: &BrowserMsg,
    open: Option<&str>,
    sessions: &[SessionInfo],
) -> Vec<ControlMsg> {
    let live = |n: &str| sessions.iter().any(|s| s.name == n);
    let is_agent = |n: &str| {
        sessions.iter().any(|s| {
            s.name == n
                && (s.kind == "claude"
                    || s.kind == "grok"
                    || s.kind == "codex"
                    || s.kind == "opencode"
                    || s.kind == "hermes"
                    || s.kind == "pi")
        })
    };
    // Exhaustive match: adding a browser message forces a decision here, so a
    // forbidden control can never become reachable by accident.
    match msg {
        BrowserMsg::Open { name } => {
            if !live(name) {
                return Vec::new();
            }
            let mut out = Vec::new();
            if let Some(prev) = open {
                if prev != name {
                    out.push(ControlMsg::Detach { name: prev.to_string() });
                }
            }
            out.push(ControlMsg::Attach { name: name.clone(), raw_client: false, preview: false, resume: None });
            out
        }
        BrowserMsg::Close { name } => {
            if !live(name) {
                return Vec::new();
            }
            vec![ControlMsg::Detach { name: name.clone() }]
        }
        BrowserMsg::Focus { name } => {
            if !live(name) {
                return Vec::new();
            }
            vec![ControlMsg::Focus { name: name.clone() }]
        }
        BrowserMsg::Create { name, cwd, kind } => {
            // Grammar first: a name outside it belongs to no workspace, and
            // `s<n>` would shadow the bare-`amber` CLI namespace.
            if mosaic::parse_pane_name(name).is_none()
                || live(name)
                || !CREATE_KINDS.contains(&kind.as_str())
                || !Path::new(cwd).is_dir()
            {
                return Vec::new();
            }
            vec![ControlMsg::Create { name: name.clone(), cwd: cwd.clone(), kind: kind.clone() }]
        }
        BrowserMsg::Kill { name } => {
            if !live(name) {
                return Vec::new();
            }
            vec![ControlMsg::Kill { name: name.clone() }]
        }
        BrowserMsg::Move { from, to } => {
            if !live(from) || mosaic::parse_pane_name(to).is_none() || live(to) {
                return Vec::new();
            }
            vec![ControlMsg::Rename { from: from.clone(), to: to.clone() }]
        }
        BrowserMsg::Suspend { name } => {
            if !is_agent(name) {
                return Vec::new();
            }
            vec![ControlMsg::Suspend { name: name.clone() }]
        }
        BrowserMsg::Resume { name } => {
            if !is_agent(name) {
                return Vec::new();
            }
            vec![ControlMsg::Resume { name: name.clone() }]
        }
        BrowserMsg::DumpBacklog { name } => {
            if !live(name) {
                return Vec::new();
            }
            vec![ControlMsg::DumpBacklog { name: name.clone() }]
        }
        // Release carries no authority of its own: the Hub turns it into a
        // restore `Resize` built by this same function, so a browser can never
        // name a geometry through it.
        BrowserMsg::Release => Vec::new(),
        BrowserMsg::Resize { name, cols, rows } => {
            if !live(name)
                || !(RESIZE_MIN_COLS..=RESIZE_MAX_COLS).contains(cols)
                || !(RESIZE_MIN_ROWS..=RESIZE_MAX_ROWS).contains(rows)
            {
                return Vec::new();
            }
            vec![ControlMsg::Resize { name: name.clone(), cols: *cols, rows: *rows }]
        }
    }
}

// ---- embedded front-end (spec §7) --------------------------------------

const INDEX_HTML: &[u8] = include_bytes!("../assets/index.html");
const APP_JS: &[u8] = include_bytes!("../assets/app.js");
const STYLE_CSS: &[u8] = include_bytes!("../assets/style.css");
const XTERM_JS: &[u8] = include_bytes!("../assets/xterm.js");
const XTERM_CSS: &[u8] = include_bytes!("../assets/xterm.css");

const CT_HTML: &str = "text/html; charset=utf-8";
const CT_JS: &str = "text/javascript; charset=utf-8";
const CT_CSS: &str = "text/css; charset=utf-8";
const CT_JSON: &str = "application/json";
const CT_MANIFEST: &str = "application/manifest+json";
const CT_PNG: &str = "image/png";

/// The static asset for a path, if any. These are **public**: the QR/URL
/// carries the token in the fragment, which the browser never sends, so only
/// JS on the served page can read it and POST it to `/api/auth`. The assets
/// are embedded, inert and hold no secrets; the security boundary is the data
/// surface (`/api/sessions`, `/ws`), which requires the cookie.
fn asset(path: &str) -> Option<(&'static [u8], &'static str)> {
    match path {
        "/" | "/index.html" => Some((INDEX_HTML, CT_HTML)),
        "/app.js" => Some((APP_JS, CT_JS)),
        "/style.css" => Some((STYLE_CSS, CT_CSS)),
        "/xterm.js" => Some((XTERM_JS, CT_JS)),
        "/xterm.css" => Some((XTERM_CSS, CT_CSS)),
        _ => None,
    }
}

// ---- token + cookie session auth (spec §3) -----------------------------

/// Token file name inside the state dir, mode 0600.
pub const TOKEN_FILE: &str = "web-token";
/// Cookie carrying the browser's post-exchange session id.
pub const COOKIE_NAME: &str = "amber_web";
/// Failed `/api/auth` attempts per IP before the endpoint stops answering.
pub const AUTH_MAX_FAILS: u32 = 8;
const AUTH_WINDOW: Duration = Duration::from_secs(60);
const AUTH_FAIL_DELAY: Duration = Duration::from_millis(300);

/// 32 bytes from the platform CSPRNG, encoded for URLs and cookies.
fn random_token() -> std::io::Result<String> {
    let mut buf = [0u8; 32];
    crate::platform::random_bytes(&mut buf)?;
    Ok(base64url(&buf))
}

/// Load the web token from `<root>/web-token`, creating it (mode 0600) if it
/// is missing/empty or `regenerate` is set (`amber web --new-token`).
pub fn load_or_create_token(root: &Path, regenerate: bool) -> anyhow::Result<String> {
    let path = root.join(TOKEN_FILE);
    if !regenerate {
        if let Ok(existing) = std::fs::read_to_string(&path) {
            let existing = existing.trim().to_string();
            if !existing.is_empty() {
                if !crate::platform::is_user_private(&path)? {
                    anyhow::bail!(
                        "refusing to use {}: it is not private to the current user",
                        path.display()
                    );
                }
                return Ok(existing);
            }
        }
    }
    std::fs::create_dir_all(root)?;
    let token = random_token()?;
    crate::platform::write_user_private(&path, token.as_bytes())?;
    Ok(token)
}

/// Read the token WITHOUT creating one.
///
/// `load_or_create_token` mints a credential as a side effect, which is wrong
/// for a read-only query: `amber ctl web status` must be able to report "no
/// token yet" rather than manufacture one.
pub fn load_token(root: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(root.join(TOKEN_FILE)).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
}

struct Auth {
    token: String,
    /// Live cookie session ids (in memory only — restarting `amber web`
    /// invalidates every browser session, which is the desired blast radius).
    sessions: Mutex<Vec<String>>,
    fails: Mutex<HashMap<std::net::IpAddr, (u32, Instant)>>,
}

impl Auth {
    fn new(token: String) -> Self {
        Auth { token, sessions: Mutex::new(Vec::new()), fails: Mutex::new(HashMap::new()) }
    }

    /// Whether this peer has burned through its failure budget (spec §3.6).
    fn throttled(&self, ip: std::net::IpAddr) -> bool {
        let mut fails = self.fails.lock().unwrap();
        match fails.get(&ip) {
            Some(&(n, at)) if n >= AUTH_MAX_FAILS => {
                if at.elapsed() < AUTH_WINDOW {
                    true
                } else {
                    fails.remove(&ip);
                    false
                }
            }
            _ => false,
        }
    }

    /// Exchange a presented token for a cookie session id. Constant-time
    /// comparison; a failure costs a fixed delay and a counter tick.
    fn authenticate(&self, ip: std::net::IpAddr, body: &[u8]) -> Option<String> {
        let presented = std::str::from_utf8(body).unwrap_or_default().trim();
        if ct_eq(presented.as_bytes(), self.token.as_bytes()) {
            let Ok(id) = random_token() else { return None };
            self.sessions.lock().unwrap().push(id.clone());
            self.fails.lock().unwrap().remove(&ip);
            return Some(id);
        }
        {
            let mut fails = self.fails.lock().unwrap();
            let entry = fails.entry(ip).or_insert((0, Instant::now()));
            if entry.1.elapsed() >= AUTH_WINDOW {
                *entry = (0, Instant::now());
            }
            entry.0 += 1;
        }
        thread::sleep(AUTH_FAIL_DELAY);
        None
    }

    /// Constant-time cookie check, required by every data route and the
    /// WebSocket upgrade.
    fn valid_cookie(&self, req: &Request) -> bool {
        let Some(value) = req.header("cookie").and_then(|h| cookie_value(h, COOKIE_NAME)) else {
            return false;
        };
        self.sessions
            .lock()
            .unwrap()
            .iter()
            .fold(false, |ok, s| ct_eq(s.as_bytes(), value.as_bytes()) | ok)
    }
}

// ---- the daemon-connection hub -----------------------------------------

/// Per-browser-client outbound queue depth. Terminal output is batched (~16 ms)
/// by the daemon, so a client this far behind is wedged, not merely slow — it
/// is evicted (socket closed) and the phone reconnects. Mirrors the
/// `watchers.rs` bounded-queue + laggard-eviction discipline.
const CLIENT_QUEUE_DEPTH: usize = 512;
const DAEMON_WRITE_TIMEOUT: Duration = Duration::from_secs(1);
const WS_WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const RECONNECT_MIN: Duration = Duration::from_millis(250);
const RECONNECT_MAX: Duration = Duration::from_secs(5);
/// Cadence of the pty-geometry refresh (see the call site in [`serve`]).
const GEOMETRY_POLL: Duration = Duration::from_secs(1);

/// One queued frame for a browser client. `Arc` so a broadcast clones a
/// pointer, not the payload.
#[derive(Clone, Debug)]
enum Out {
    Text(Arc<String>),
    Binary(Arc<Vec<u8>>),
}

struct Client {
    id: u64,
    /// The one session this WebSocket has open, if any.
    open: Option<String>,
    tx: SyncSender<Out>,
}

struct HubInner {
    /// Write half of the single daemon connection; `None` while unreachable.
    daemon: Option<LocalWriter>,
    sessions: Vec<SessionInfo>,
    file: mosaic::LayoutFile,
    layout: String,
    layout_dirty: bool,
    clients: Vec<Client>,
    /// Session names whose next `Frame::Data` is an `Attach` backlog replay
    /// (2026-08-01 webapp-pivot §4.1 fix). Populated by
    /// [`Hub::write_daemon_tracking`], the ONE place an `Attach` is ever sent
    /// — whether from a browser `Open` or from `run_daemon_link`'s own
    /// reconnect re-attach — so both paths get the same tag instead of only
    /// the browser-initiated one.
    pending_backlog: HashSet<String>,
    /// Client ids awaiting a `DumpBacklog` reply, keyed by session name (a
    /// `Frame::Backlog` carries no client id, so this is the only way to
    /// route the one-shot reply back to whoever asked).
    dump_pending: HashMap<String, Vec<u64>>,
    /// Pty grids a browser client has taken over, keyed by session name
    /// (spec §2.2). A phone reflows an agent pane to a readable width while it
    /// is looking at it, and the desktop's grid is handed back when it stops.
    borrows: HashMap<String, Borrow>,
}

/// One borrowed pty grid.
#[derive(Debug, Clone, Copy)]
struct Borrow {
    /// The browser client holding it. Only this client's release restores.
    client: u64,
    /// The grid to restore: captured when the client OPENED the session, before
    /// it could resize anything (see [`Hub::note_open`] for why not on resize).
    prior: (u16, u16),
    /// The last grid this client applied. A restore is suppressed unless the
    /// session still matches it — if the desktop re-fit in the meantime, the
    /// desktop is the newer writer and we leave it alone.
    set: Option<(u16, u16)>,
}

/// The single daemon connection, multiplexed across every browser client.
pub struct Hub {
    socket: PathBuf,
    root: PathBuf,
    inner: Mutex<HubInner>,
    next_id: AtomicU64,
    /// When this server came up — the only thing `/api/status` reports that is
    /// not derivable from `HubInner`.
    started: Instant,
}

fn session_json(s: &SessionInfo) -> serde_json::Value {
    serde_json::json!({
        "name": s.name,
        "kind": s.kind,
        "cwd": s.cwd,
        "run_state": s.run_state,
        "alive": s.alive,
        // The pty's real winsize. The phone renders AT this geometry and never
        // resizes (spec §4) — a guess would corrupt an alt-screen claude TUI.
        "cols": s.cols,
        "rows": s.rows,
        "slot": s.slot,
    })
}

impl Hub {
    fn new(socket: PathBuf, root: PathBuf) -> Arc<Self> {
        Arc::new(Hub {
            socket,
            root,
            inner: Mutex::new(HubInner {
                daemon: None,
                sessions: Vec::new(),
                file: mosaic::LayoutFile::default(),
                layout: String::new(),
                layout_dirty: false,
                clients: Vec::new(),
                pending_backlog: HashSet::new(),
                dump_pending: HashMap::new(),
                borrows: HashMap::new(),
            }),
            next_id: AtomicU64::new(0),
            started: Instant::now(),
        })
    }

    /// JSON body for `GET /api/status`: the operator-facing snapshot behind
    /// `amber ctl web status`.
    ///
    /// Deliberately holds NO secret. The token is a full-authority credential
    /// and this payload is polled every few seconds by the desktop dialog,
    /// piped through IPC, logged and pasted — everything a credential must not
    /// travel in. The tokenised URL comes from `amber ctl web url`, on demand.
    fn status_json(&self, port: u16) -> String {
        let inner = self.inner.lock().unwrap();
        let clients: Vec<serde_json::Value> = inner
            .clients
            .iter()
            .map(|c| {
                serde_json::json!({
                    "id": c.id,
                    "open": c.open,
                    // Phase B (spec §2.2) fills this with the borrowed grid.
                    "borrow": serde_json::Value::Null,
                })
            })
            .collect();
        serde_json::json!({
            "port": port,
            "uptime_secs": self.started.elapsed().as_secs(),
            "sessions": inner.sessions.len(),
            "clients": clients,
        })
        .to_string()
    }

    /// JSON body for `GET /api/sessions`: `{"sessions":[…],"layout":{…}}`.
    fn sessions_json(&self) -> String {
        let inner = self.inner.lock().unwrap();
        Self::payload(&inner.sessions, &inner.layout)
    }

    fn payload(sessions: &[SessionInfo], layout: &str) -> String {
        let list: Vec<_> = sessions.iter().map(session_json).collect();
        let layout: serde_json::Value =
            serde_json::from_str(layout).unwrap_or(serde_json::Value::Null);
        serde_json::to_string(&serde_json::json!({ "sessions": list, "layout": layout }))
            .unwrap_or_else(|_| r#"{"sessions":[],"layout":null}"#.into())
    }

    fn sessions_msg(sessions: &[SessionInfo], layout: &str) -> Out {
        let list: Vec<_> = sessions.iter().map(session_json).collect();
        let layout: serde_json::Value =
            serde_json::from_str(layout).unwrap_or(serde_json::Value::Null);
        Out::Text(Arc::new(
            serde_json::json!({ "t": "sessions", "sessions": list, "layout": layout }).to_string(),
        ))
    }

    fn render_layout(file: &mosaic::LayoutFile, sessions: &[SessionInfo]) -> String {
        serde_json::to_string(&mosaic::render(file, sessions)).unwrap_or_else(|_| "null".into())
    }

    fn error_msg(msg: &str) -> Out {
        Out::Text(Arc::new(serde_json::json!({ "t": "error", "msg": msg }).to_string()))
    }

    /// Register a browser client. The returned receiver feeds that client's
    /// dedicated writer thread — the ONLY place a WebSocket is written, so a
    /// multi-MiB `Attach` backlog can never stall the daemon read thread.
    fn add_client(&self) -> (u64, Receiver<Out>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = sync_channel(CLIENT_QUEUE_DEPTH);
        let mut inner = self.inner.lock().unwrap();
        let _ = tx.try_send(Self::sessions_msg(&inner.sessions, &inner.layout));
        if inner.daemon.is_none() {
            let _ = tx.try_send(Self::error_msg("daemon unreachable"));
        }
        inner.clients.push(Client { id, open: None, tx });
        (id, rx)
    }

    fn remove_client(&self, id: u64) {
        let mut inner = self.inner.lock().unwrap();
        let Some(pos) = inner.clients.iter().position(|c| c.id == id) else { return };
        // A phone that walks out of Wi-Fi range never sends `release`, so the
        // socket dying IS the release. This is the whole reason the borrow map
        // lives server-side rather than in the shim (spec §2.2).
        Self::release_all(&mut inner, id);
        let open = inner.clients.remove(pos).open;
        Self::detach_if_unwanted(&mut inner, open);
    }

    /// Detach `name` from the daemon unless another browser client still has
    /// it open (one daemon connection is shared by every tab).
    fn detach_if_unwanted(inner: &mut HubInner, name: Option<String>) {
        let Some(name) = name else { return };
        if inner.clients.iter().any(|c| c.open.as_deref() == Some(name.as_str())) {
            return;
        }
        Self::write_daemon(inner, &Frame::Control(ControlMsg::Detach { name }));
    }

    /// Write one frame to the daemon. Unix retains `SO_SNDTIMEO`; every
    /// platform also gets the same wall-clock bound. A failure drops the link
    /// so the supervisor reconnects.
    fn write_daemon(inner: &mut HubInner, frame: &Frame) {
        let bytes = proto::encode(frame);
        let ok = match inner.daemon.as_mut() {
            Some(s) => crate::daemon::write_bounded(s, &bytes, DAEMON_WRITE_TIMEOUT)
                .and_then(|()| s.flush())
                .is_ok(),
            None => false,
        };
        if !ok {
            if let Some(mut writer) = inner.daemon.take() {
                // The read half shares this local connection. Dropping only
                // the writer leaves a Windows named-pipe reader polling the
                // still-open handle forever, so force-close both directions
                // and let `run_daemon_link` enter its reconnect state.
                let _ = writer.shutdown();
            }
        }
    }

    /// [`write_daemon`], plus: if `frame` is an `Attach`, remember that this
    /// session's next `Frame::Data` is the backlog replay (2026-08-01
    /// webapp-pivot §4.1). The daemon always sends the backlog as the first
    /// `Data` frame after an `Attach` (`daemon.rs`'s subscribe-then-forward
    /// ordering), so whichever code sends the `Attach` is the one place that
    /// can know this for certain — never a "next message after X" guess. This
    /// is the ONLY place `Attach` is written (both a browser `Open` and
    /// `run_daemon_link`'s own reconnect re-attach route through it), so both
    /// get tagged, not just the browser-initiated one. Mirrors the Electron
    /// client's `router.ts::sendAttach`/`awaitingBacklog`.
    fn write_daemon_tracking(inner: &mut HubInner, frame: &Frame) {
        if let Frame::Control(ControlMsg::Attach { name, .. }) = frame {
            inner.pending_backlog.insert(name.clone());
        }
        Self::write_daemon(inner, frame);
    }

    /// Queue `msg` to every client matching `want`, evicting any whose queue
    /// is full or whose writer thread is gone. Never blocks.
    fn queue(inner: &mut HubInner, want: impl Fn(&Client) -> bool, msg: Out) {
        let mut evicted: Vec<Option<String>> = Vec::new();
        inner.clients.retain(|c| {
            if !want(c) {
                return true;
            }
            match c.tx.try_send(msg.clone()) {
                Ok(()) => true,
                Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                    evicted.push(c.open.clone());
                    false
                }
            }
        });
        for open in evicted {
            Self::detach_if_unwanted(inner, open);
        }
    }

    /// Record the grid a session had BEFORE a browser client could touch it.
    ///
    /// Called from the `Open` handler, and deliberately NOT from `Resize`
    /// (spec §2.2.1). `HubInner::sessions` refreshes on the 1 s daemon poll
    /// while the browser's own resize debounce is 300 ms, so two resizes fit
    /// inside one poll window: capturing on the second one would record the
    /// PHONE's grid as `prior`, and the restore would silently leave the
    /// desktop at ~46 columns — exactly the failure borrowing exists to
    /// prevent, and one that would present as a test that passes or fails on
    /// timing. A client's `open` is set before any resize can arrive on its
    /// socket, so capturing here removes the race by construction.
    fn note_open(inner: &mut HubInner, id: u64, name: &str) {
        if inner.borrows.contains_key(name) {
            return;
        }
        let Some(info) = inner.sessions.iter().find(|s| s.name == name) else { return };
        if info.cols == 0 || info.rows == 0 {
            return;
        }
        inner
            .borrows
            .insert(name.to_string(), Borrow { client: id, prior: (info.cols, info.rows), set: None });
    }

    /// Note the grid a browser client just applied, so a later restore can tell
    /// "still ours" from "the desktop re-fit since".
    fn note_resize(inner: &mut HubInner, id: u64, name: &str, cols: u16, rows: u16) {
        if let Some(b) = inner.borrows.get_mut(name) {
            if b.client == id {
                b.set = Some((cols, rows));
            }
        }
    }

    /// Hand a borrowed grid back.
    ///
    /// Restores ONLY when the session's current grid still equals what this
    /// client set: if the desktop resized in the meantime it is the newer
    /// writer and keeps its geometry. A borrow that never resized anything is
    /// simply dropped. Last writer wins; a restore never clobbers.
    fn release_borrow(inner: &mut HubInner, id: u64, name: &str) {
        let Some(b) = inner.borrows.get(name).copied() else { return };
        if b.client != id {
            return;
        }
        inner.borrows.remove(name);
        let Some(set) = b.set else { return };
        let Some(info) = inner.sessions.iter().find(|s| s.name == name) else { return };
        if (info.cols, info.rows) != set {
            return;
        }
        if (info.cols, info.rows) == b.prior {
            return;
        }
        let restore = ControlMsg::Resize { name: name.to_string(), cols: b.prior.0, rows: b.prior.1 };
        Self::write_daemon(inner, &Frame::Control(restore));
    }

    /// Release every borrow held by a client (socket closed, or it switched
    /// which session it has open).
    fn release_all(inner: &mut HubInner, id: u64) {
        let names: Vec<String> = inner
            .borrows
            .iter()
            .filter(|(_, b)| b.client == id)
            .map(|(n, _)| n.clone())
            .collect();
        for n in names {
            Self::release_borrow(inner, id, &n);
        }
    }

    /// A browser control (JSON text) frame. The ONLY path from browser input
    /// to daemon control messages, via [`map_browser_msg`].
    fn handle_browser(&self, id: u64, text: &str) {
        // Unknown `t` / malformed JSON: ignored, never an error that closes.
        let Some(msg) = parse_browser_msg(text) else { return };
        let mut inner = self.inner.lock().unwrap();
        let Some(pos) = inner.clients.iter().position(|c| c.id == id) else { return };
        let previous = inner.clients[pos].open.clone();
        let controls = map_browser_msg(&msg, previous.as_deref(), &inner.sessions);
        if controls.is_empty() {
            // `Release` legitimately maps to no control message — it acts on
            // Hub state only (handled below), so it is not "no such session".
            if !matches!(msg, BrowserMsg::Release) {
                let err = Self::error_msg("no such session");
                Self::queue(&mut inner, |c| c.id == id, err);
                return;
            }
        }
        // Borrow bookkeeping (spec §2.2) BEFORE the open field moves: a client
        // changing which session it looks at releases what it held.
        match &msg {
            BrowserMsg::Open { name } => {
                if previous.as_deref() != Some(name.as_str()) {
                    Self::release_all(&mut inner, id);
                }
                Self::note_open(&mut inner, id, name);
            }
            BrowserMsg::Close { name } => Self::release_borrow(&mut inner, id, name),
            BrowserMsg::Release => Self::release_all(&mut inner, id),
            BrowserMsg::Resize { name, cols, rows } => {
                Self::note_resize(&mut inner, id, name, *cols, *rows)
            }
            _ => {}
        }
        inner.clients[pos].open = match &msg {
            BrowserMsg::Open { name } => Some(name.clone()),
            BrowserMsg::Close { .. } => None,
            BrowserMsg::Focus { .. }
            | BrowserMsg::Create { .. }
            | BrowserMsg::Kill { .. }
            | BrowserMsg::Move { .. }
            | BrowserMsg::Suspend { .. }
            | BrowserMsg::Resume { .. }
            | BrowserMsg::DumpBacklog { .. }
            | BrowserMsg::Release
            | BrowserMsg::Resize { .. } => previous,
        };
        for control in controls {
            if let ControlMsg::Detach { name } = &control {
                // Another tab still wants this session's output.
                if inner.clients.iter().any(|c| c.open.as_deref() == Some(name.as_str())) {
                    continue;
                }
            }
            // Correlate this client to the ONE-SHOT Backlog reply the daemon
            // will send for a DumpBacklog — `on_frame`'s `Frame::Backlog` arm
            // has no other way to know who asked (unlike pty `Data`, which
            // routes by whichever client has the session `open`).
            if let ControlMsg::DumpBacklog { name } = &control {
                inner.dump_pending.entry(name.clone()).or_default().push(id);
            }
            Self::write_daemon_tracking(&mut inner, &Frame::Control(control));
        }
    }

    /// A browser BINARY frame: raw input for that client's open session.
    /// Ignored when nothing is open.
    fn input(&self, id: u64, bytes: Vec<u8>) {
        let mut inner = self.inner.lock().unwrap();
        let Some(session) = inner
            .clients
            .iter()
            .find(|c| c.id == id)
            .and_then(|c| c.open.clone())
        else {
            return;
        };
        Self::write_daemon(&mut inner, &Frame::Data { session, bytes });
    }

    /// One frame from the daemon. Runs on the SHARED read thread, so it only
    /// ever `try_send`s into bounded per-client queues — never a socket write.
    fn on_frame(&self, frame: Frame) {
        let mut inner = self.inner.lock().unwrap();
        match frame {
            Frame::Data { session, bytes } => {
                // §4.1 fix: this session's next Data frame after an Attach we
                // ourselves sent (browser `Open` OR our own daemon-reconnect
                // re-attach — see `write_daemon_tracking`) is the backlog
                // replay. Tag it with a marker text frame first so the
                // browser-side shim can reset() before it, exactly like the
                // Electron client's `router.ts` already does for its own
                // connection.
                if inner.pending_backlog.remove(&session) {
                    let marker = Out::Text(Arc::new(
                        serde_json::json!({ "t": "backlog", "name": session.clone() })
                            .to_string(),
                    ));
                    Self::queue(
                        &mut inner,
                        |c| c.open.as_deref() == Some(session.as_str()),
                        marker,
                    );
                }
                let msg = Out::Binary(Arc::new(bytes));
                Self::queue(&mut inner, |c| c.open.as_deref() == Some(session.as_str()), msg);
            }
            Frame::Backlog { session, bytes } => {
                // Reply to a browser `DumpBacklog` (spec §3 "Backlog" row) —
                // routed back to whichever client id(s) asked, not by `open`
                // (a `DumpBacklog` needs no Attach and this connection may
                // have nothing open at all).
                let Some(ids) = inner.dump_pending.remove(&session) else { return };
                let marker = Out::Text(Arc::new(
                    serde_json::json!({ "t": "backlogReply", "name": session }).to_string(),
                ));
                let payload = Out::Binary(Arc::new(bytes));
                for id in ids {
                    Self::queue(&mut inner, |c| c.id == id, marker.clone());
                    Self::queue(&mut inner, |c| c.id == id, payload.clone());
                }
            }
            Frame::Control(ControlMsg::Sessions { sessions }) => {
                // Unchanged is the common case for the geometry poll — don't
                // churn every browser with an identical push, UNLESS the
                // sidecar changed underneath us (layout_dirty), since the
                // mosaic depends on the session set even when it's identical.
                if inner.sessions == sessions && !inner.layout_dirty {
                    return;
                }
                inner.layout_dirty = false;
                inner.sessions = sessions;
                inner.layout = Self::render_layout(&inner.file, &inner.sessions);
                let msg = Self::sessions_msg(&inner.sessions, &inner.layout);
                Self::queue(&mut inner, |_| true, msg);
            }
            Frame::Control(ControlMsg::SessionsChanged { added, removed }) => {
                inner.sessions.retain(|s| {
                    !removed.contains(&s.name) && !added.iter().any(|a| a.name == s.name)
                });
                inner.sessions.extend(added);
                inner.layout = Self::render_layout(&inner.file, &inner.sessions);
                let msg = Self::sessions_msg(&inner.sessions, &inner.layout);
                Self::queue(&mut inner, |_| true, msg);
            }
            Frame::Control(ControlMsg::Exit { name, code }) => {
                let msg = Out::Text(Arc::new(
                    serde_json::json!({ "t": "exit", "name": name, "code": code }).to_string(),
                ));
                Self::queue(&mut inner, |c| c.open.as_deref() == Some(name.as_str()), msg);
            }
            Frame::Control(ControlMsg::Error { msg }) => {
                let out = Self::error_msg(&msg);
                Self::queue(&mut inner, |_| true, out);
            }
            // Broadcast like Sessions/Error. The web-app shim (spec 2026-08-01
            // §3 "the same event stream the Electron client emits") only lets
            // its ONE control connection forward these into `onDaemonEvent` —
            // every per-pane connection ignores them — so this reaching every
            // client here does not fan out into duplicate app-level events.
            // The hand-written mobile UI (`app.js`) ignores unknown `t`s.
            Frame::Control(ControlMsg::Activity { name }) => {
                let out = Out::Text(Arc::new(serde_json::json!({ "t": "activity", "name": name }).to_string()));
                Self::queue(&mut inner, |_| true, out);
            }
            Frame::Control(ControlMsg::MemoryStat { name, rss_kb, growing }) => {
                let out = Out::Text(Arc::new(
                    serde_json::json!({ "t": "memory", "name": name, "rss_kb": rss_kb, "growing": growing })
                        .to_string(),
                ));
                Self::queue(&mut inner, |_| true, out);
            }
            Frame::Control(ControlMsg::MemoryPressure {
                level,
                current_kb,
                budget_kb,
                blocked,
            }) => {
                let out = Out::Text(Arc::new(
                    serde_json::json!({
                        "t": "memoryPressure",
                        "level": level,
                        "current_kb": current_kb,
                        "budget_kb": budget_kb,
                        "blocked": blocked,
                    })
                    .to_string(),
                ));
                Self::queue(&mut inner, |_| true, out);
            }
            Frame::Control(ControlMsg::ResourcePressure {
                level,
                causes,
                blocked,
            }) => {
                let out = Out::Text(Arc::new(
                    serde_json::json!({
                        "t": "resourcePressure",
                        "level": level,
                        "causes": causes,
                        "blocked": blocked,
                    })
                    .to_string(),
                ));
                Self::queue(&mut inner, |_| true, out);
            }
            // Acks (Created/Killed/SessionList/…): nothing the UI needs.
            _ => {}
        }
    }

    fn read_loop(&self, mut stream: LocalReader) {
        let mut decoder = Decoder::new();
        let mut buf = [0u8; 65536];
        loop {
            let n = match stream.read(&mut buf) {
                Ok(0) | Err(_) => return,
                Ok(n) => n,
            };
            decoder.feed(&buf[..n]);
            loop {
                match decoder.next_decoded() {
                    Ok(Some(Decoded::Frame(frame))) => self.on_frame(frame),
                    Ok(Some(Decoded::UndecodableControl(error))) => {
                        eprintln!("amber web: skipping unknown daemon control: {error}");
                    }
                    Ok(None) => break,
                    Err(e) => {
                        eprintln!("amber web: daemon frame decode failed: {e}");
                        return;
                    }
                }
            }
        }
    }
}

/// Keep the single daemon connection up, with the app's reconnect discipline
/// (spec §6): while it is down the UI is served a "daemon unreachable" state,
/// and on reconnect every session a browser still has open is re-attached.
fn run_daemon_link(hub: Arc<Hub>) {
    let mut backoff = RECONNECT_MIN;
    loop {
        match transport::connect(&hub.socket) {
            Ok(stream) => {
                backoff = RECONNECT_MIN;
                let Ok((read_half, writer)) = stream.into_split() else { continue };
                let _ = writer.set_write_timeout(Some(DAEMON_WRITE_TIMEOUT));
                {
                    let mut inner = hub.inner.lock().unwrap();
                    inner.daemon = Some(writer);
                    Hub::write_daemon(&mut inner, &Frame::Control(ControlMsg::WatchSessions));
                    Hub::write_daemon(
                        &mut inner,
                        &Frame::Control(ControlMsg::WatchMemoryPressure { version: 2 }),
                    );
                    let mut reattach: Vec<String> =
                        inner.clients.iter().filter_map(|c| c.open.clone()).collect();
                    reattach.sort();
                    reattach.dedup();
                    for name in reattach {
                        // §4.1 fix: this reconnect's re-attach is exactly the
                        // path that used to arrive untagged (`amber web`
                        // reconnecting to the DAEMON, independent of any
                        // browser event) — route it through the same tracked
                        // write a browser `Open` uses so its backlog reply
                        // gets tagged too.
                        Hub::write_daemon_tracking(
                            &mut inner,
                            &Frame::Control(ControlMsg::Attach { name, raw_client: false, preview: false, resume: None }),
                        );
                    }
                }
                hub.read_loop(read_half);
                let mut inner = hub.inner.lock().unwrap();
                inner.daemon = None;
                inner.sessions.clear();
                inner.layout.clear();
                // Bounded hygiene: an Attach/DumpBacklog that never got its
                // reply because the daemon died mid-flight would otherwise
                // leak its entry forever. Reattaching on the next reconnect
                // (above) re-inserts pending_backlog fresh; a dropped
                // DumpBacklog is not retried, so its client-side caller times
                // out on its own (same as any other daemon-unreachable gap).
                inner.pending_backlog.clear();
                inner.dump_pending.clear();
                // An empty session list with a stale non-empty layout would be
                // incoherent (every leaf it names is now unreachable); "" here
                // renders as `"layout":null`, matching the empty session list.
                let sessions = Hub::sessions_msg(&[], "");
                Hub::queue(&mut inner, |_| true, sessions);
                let err = Hub::error_msg("daemon unreachable");
                Hub::queue(&mut inner, |_| true, err);
            }
            Err(_) => {
                let mut inner = hub.inner.lock().unwrap();
                let err = Hub::error_msg("daemon unreachable");
                Hub::queue(&mut inner, |_| true, err);
            }
        }
        thread::sleep(backoff);
        backoff = (backoff * 2).min(RECONNECT_MAX);
    }
}

// ---- HTTP / WebSocket server -------------------------------------------

/// Bind the web port. **127.0.0.1 only** (spec §3.1) — no flag exposes
/// another interface; reaching it from a phone goes through `tailscale serve`.
pub fn bind(port: u16) -> std::io::Result<TcpListener> {
    TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port)))
}

/// Serve until the listener errors. `daemon_socket` is the amber daemon's unix
/// socket; `root` is the state root the app's `ui-layout.json` sidecar lives
/// in (read-only, polled — never written here); `token` is the shared secret
/// from `<state>/web-token`.
pub fn serve(
    listener: TcpListener,
    daemon_socket: PathBuf,
    root: PathBuf,
    token: String,
) -> anyhow::Result<()> {
    let hub = Hub::new(daemon_socket, root);
    {
        let hub = Arc::clone(&hub);
        thread::spawn(move || run_daemon_link(hub));
    }
    // Geometry poll. `SessionInfo.cols/rows` is the pty's live winsize, and the
    // phone must render at it (spec §4 — it may never resize). A `Resize` from
    // the desktop app broadcasts NO SessionsChanged, so the cache would go
    // stale and the phone would paint an alt-screen TUI onto the wrong grid.
    // A 1 s `ListSessionsDetailed` (one tiny control frame) refreshes it; the
    // reply only reaches browsers when the set actually changed. The same tick
    // also re-reads the `ui-layout.json` sidecar — file IO happens ONLY here,
    // never on the shared daemon read thread (`on_frame`), which just re-renders
    // the cached `LayoutFile` when the session set changes.
    // ponytail: polling here, not a new daemon broadcast — a divider drag emits
    // resizes far faster than the bounded watcher queue should carry.
    {
        let hub = Arc::clone(&hub);
        thread::spawn(move || loop {
            thread::sleep(GEOMETRY_POLL);
            let file = mosaic::load(&hub.root);
            let mut inner = hub.inner.lock().unwrap();
            let rendered = Hub::render_layout(&file, &inner.sessions);
            if rendered != inner.layout {
                inner.layout = rendered;
                inner.layout_dirty = true;
            }
            inner.file = file;
            if inner.daemon.is_some() {
                Hub::write_daemon(&mut inner, &Frame::Control(ControlMsg::ListSessionsDetailed));
            }
        });
    }
    let auth = Arc::new(Auth::new(token));
    // The honest port is the one actually bound — the tests bind port 0, and a
    // caller-supplied argument would report a lie.
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    for conn in listener.incoming() {
        let Ok(stream) = conn else { continue };
        let hub = Arc::clone(&hub);
        let auth = Arc::clone(&auth);
        thread::spawn(move || {
            if let Err(e) = handle_conn(stream, &hub, &auth, port) {
                eprintln!("amber web: connection error: {e}");
            }
        });
    }
    Ok(())
}

/// Write a complete response and let the connection close (no keep-alive:
/// every browser request here is one-shot, and the WebSocket is the long-lived
/// path).
fn respond(
    stream: &mut TcpStream,
    status: &str,
    ctype: &str,
    extra: &[String],
    body: &[u8],
) -> std::io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\
         Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n",
        body.len()
    );
    if !ctype.is_empty() {
        head.push_str(&format!("Content-Type: {ctype}\r\n"));
    }
    for e in extra {
        head.push_str(e);
        head.push_str("\r\n");
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

fn handle_conn(
    mut stream: TcpStream,
    hub: &Arc<Hub>,
    auth: &Arc<Auth>,
    port: u16,
) -> anyhow::Result<()> {
    let peer = stream.peer_addr()?.ip();
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    let req = loop {
        if let Some(req) = parse_request(&buf)? {
            break req;
        }
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
    };

    match (req.method.as_str(), req.path.as_str()) {
        ("POST", "/api/auth") => {
            if auth.throttled(peer) {
                return Ok(respond(&mut stream, "429 Too Many Requests", "", &[], b"")?);
            }
            match auth.authenticate(peer, &req.body) {
                Some(id) => {
                    // `Secure` only when the hop really was https — that is
                    // exactly when `tailscale serve` terminated TLS for us.
                    let secure = req.header("x-forwarded-proto") == Some("https");
                    let cookie = format!(
                        "Set-Cookie: {COOKIE_NAME}={id}; HttpOnly; SameSite=Strict; Path=/{}",
                        if secure { "; Secure" } else { "" }
                    );
                    respond(&mut stream, "204 No Content", "", &[cookie], b"")?;
                }
                None => respond(&mut stream, "401 Unauthorized", "", &[], b"")?,
            }
            Ok(())
        }
        ("GET", "/api/sessions") => {
            if !auth.valid_cookie(&req) {
                return Ok(respond(&mut stream, "401 Unauthorized", "", &[], b"")?);
            }
            let body = hub.sessions_json();
            Ok(respond(&mut stream, "200 OK", CT_JSON, &[], body.as_bytes())?)
        }
        // Operator status for `amber ctl web status` (spec §9.3). Same cookie
        // boundary as `/api/sessions`; carries no secret of its own.
        ("GET", "/api/status") => {
            if !auth.valid_cookie(&req) {
                return Ok(respond(&mut stream, "401 Unauthorized", "", &[], b"")?);
            }
            let body = hub.status_json(port);
            Ok(respond(&mut stream, "200 OK", CT_JSON, &[], body.as_bytes())?)
        }
        // Bootstrap for the real-renderer web build (spec 2026-08-01 §3 "Env"
        // row): `homeDir` must be a value, not a probe — a browser has no
        // notion of a server-side home directory. `softwareGl` is NOT served
        // here; the shim probes WebGL support itself (a browser-local fact
        // the server cannot know), unlike Electron's main process which reads
        // its OWN compat marker.
        ("GET", "/api/bootstrap") => {
            if !auth.valid_cookie(&req) {
                return Ok(respond(&mut stream, "401 Unauthorized", "", &[], b"")?);
            }
            // A boot-managed `amber web` can start with a minimal env (the
            // 2026-07-29 display-env lesson — this repo has been bitten by
            // exactly this class of gap before). An empty `home` would become
            // `cwd: ""` client-side, silently failing `map_browser_msg`'s
            // `Path::new(cwd).is_dir()` gate on every `+ Pane` with no visible
            // error — never serve it empty.
            let home = std::env::var("HOME").ok().filter(|h| !h.is_empty()).unwrap_or_else(|| "/".into());
            let body = serde_json::json!({ "home": home }).to_string();
            Ok(respond(&mut stream, "200 OK", CT_JSON, &[], body.as_bytes())?)
        }
        // Layout CAS (spec 2026-08-01 §6): the browser and the desktop app
        // are both writers of `ui-layout.json` now, so reads/writes go
        // through `layout_cas`, which re-checks the version under the same
        // call that renames the file into place — never a plain overwrite.
        ("GET", "/api/layout") => {
            if !auth.valid_cookie(&req) {
                return Ok(respond(&mut stream, "401 Unauthorized", "", &[], b"")?);
            }
            let loaded = layout_cas::load(&hub.root);
            let body = serde_json::json!({ "text": loaded.text, "version": loaded.version }).to_string();
            Ok(respond(&mut stream, "200 OK", CT_JSON, &[], body.as_bytes())?)
        }
        ("POST", "/api/layout") => {
            if !auth.valid_cookie(&req) {
                return Ok(respond(&mut stream, "401 Unauthorized", "", &[], b"")?);
            }
            let Ok(body) = serde_json::from_slice::<serde_json::Value>(&req.body) else {
                return Ok(respond(&mut stream, "400 Bad Request", "", &[], b"")?);
            };
            let Some(text) = body.get("text").and_then(|v| v.as_str()) else {
                return Ok(respond(&mut stream, "400 Bad Request", "", &[], b"")?);
            };
            let version = body.get("version").and_then(|v| v.as_str());
            match layout_cas::save(&hub.root, text, version) {
                layout_cas::SaveResult::Ok { version } => {
                    let out = serde_json::json!({ "ok": true, "version": version }).to_string();
                    Ok(respond(&mut stream, "200 OK", CT_JSON, &[], out.as_bytes())?)
                }
                layout_cas::SaveResult::Conflict { text, version } => {
                    let out =
                        serde_json::json!({ "conflict": true, "text": text, "version": version }).to_string();
                    Ok(respond(&mut stream, "409 Conflict", CT_JSON, &[], out.as_bytes())?)
                }
                layout_cas::SaveResult::Error(e) => {
                    let out = serde_json::json!({ "error": e }).to_string();
                    Ok(respond(&mut stream, "500 Internal Server Error", CT_JSON, &[], out.as_bytes())?)
                }
            }
        }
        ("GET", "/ws") => {
            if !auth.valid_cookie(&req) {
                return Ok(respond(&mut stream, "401 Unauthorized", "", &[], b"")?);
            }
            // Defence in depth (spec §3.5): a malicious page on the phone must
            // not be able to drive this socket with the ambient cookie.
            if !origin_ok(
                req.header("origin"),
                req.header("host"),
                req.header("x-forwarded-host"),
            ) {
                return Ok(respond(&mut stream, "403 Forbidden", "", &[], b"")?);
            }
            let Some(key) = req.header("sec-websocket-key") else {
                return Ok(respond(&mut stream, "400 Bad Request", "", &[], b"")?);
            };
            let accept = tungstenite::handshake::derive_accept_key(key.as_bytes());
            stream.write_all(
                format!(
                    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\
                     Connection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
                )
                .as_bytes(),
            )?;
            stream.flush()?;
            ws_session(stream, hub)
        }
        // SPIKE ONLY (2026-08-01 webapp-pivot spike, proving-order item 1 in
        // the spec): serves the built bundle off disk, read per-request, from
        // `<state-root>/web/` (installed) or `app/out/web/` (dev). This is NOT
        // the real bundle-serving design (spec §2.3) — that's `build.rs`
        // generating a static `include_bytes!` table so the binary stays
        // self-contained/offline; that's proving-order item 4. Same-origin as
        // everything else in this file on purpose: a cross-origin page would
        // fail both the WS `Origin` check and the `SameSite=Strict` cookie.
        ("GET", "/app") | ("GET", "/app/") => match web_asset(&hub.root, "index.html") {
            Some((body, ctype)) => Ok(respond(&mut stream, "200 OK", ctype, &[], &body)?),
            None => Ok(respond(
                &mut stream,
                "404 Not Found",
                "",
                &[],
                b"web bundle not built - run `npm run build:web` in app/",
            )?),
        },
        ("GET", p) if p.starts_with("/assets/") => match web_asset(&hub.root, p) {
            Some((body, ctype)) => Ok(respond(&mut stream, "200 OK", ctype, &[], &body)?),
            None => Ok(respond(&mut stream, "404 Not Found", "", &[], b"")?),
        },
        // PWA install surface (spec §7). Public like the rest of the bundle —
        // the manifest and icon hold no secrets, and the security boundary is
        // still `/api/*` + `/ws`. Without these "Add to Home Screen" gives a
        // browser-chrome window instead of a standalone app, and the URL bar
        // eats ~15% of a phone screen.
        ("GET", "/manifest.webmanifest") => match web_asset(&hub.root, "manifest.webmanifest") {
            Some((body, _)) => Ok(respond(&mut stream, "200 OK", CT_MANIFEST, &[], &body)?),
            None => Ok(respond(&mut stream, "404 Not Found", "", &[], b"")?),
        },
        ("GET", "/icon.png") => match web_asset(&hub.root, "icon.png") {
            Some((body, _)) => Ok(respond(&mut stream, "200 OK", CT_PNG, &[], &body)?),
            None => Ok(respond(&mut stream, "404 Not Found", "", &[], b"")?),
        },
        ("GET", path) => match asset(path) {
            Some((body, ctype)) => Ok(respond(&mut stream, "200 OK", ctype, &[], body)?),
            None => Ok(respond(&mut stream, "404 Not Found", "", &[], b"")?),
        },
        _ => Ok(respond(&mut stream, "405 Method Not Allowed", "", &[], b"")?),
    }
}

/// Serve one file of the built web bundle. `rel` is a request path
/// (`/assets/x.js` or `index.html`), so a leading `/` is stripped and any `..`
/// component is refused.
///
/// Two locations, in order:
///   1. `<state-root>/web/` — the INSTALLED bundle. This is the one that works
///      under systemd, where the service's CWD is `/` and a relative path
///      resolves to nothing.
///   2. `app/out/web/` relative to CWD — the dev path, so `npm run build:web`
///      plus `cargo run` still works from a checkout.
///
/// Still interim with respect to spec §2.3, which wants `build.rs` to generate
/// a static `include_bytes!` table so the binary stays self-contained and
/// offline. That is proving-order item 4. Until then a packaged binary must
/// have the bundle installed alongside it.
fn web_asset(root: &Path, rel: &str) -> Option<(Vec<u8>, &'static str)> {
    if rel.contains("..") {
        return None;
    }
    let rel = rel.trim_start_matches('/');
    let path = {
        let installed = root.join("web").join(rel);
        if installed.is_file() { installed } else { Path::new("app/out/web").join(rel) }
    };
    let ctype = if rel.ends_with(".js") {
        CT_JS
    } else if rel.ends_with(".css") {
        CT_CSS
    } else {
        CT_HTML
    };
    std::fs::read(&path).ok().map(|b| (b, ctype))
}

/// Pump one browser WebSocket. Reads happen here; ALL writes happen on a
/// dedicated writer thread fed by the hub's bounded queue, so a slow phone can
/// never stall the daemon read thread (the backlog head-of-line lesson).
fn ws_session(stream: TcpStream, hub: &Arc<Hub>) -> anyhow::Result<()> {
    use tungstenite::protocol::{Message, Role, WebSocket};

    stream.set_read_timeout(None)?;
    let write_stream = stream.try_clone()?;
    write_stream.set_write_timeout(Some(WS_WRITE_TIMEOUT))?;
    let shutdown = stream.try_clone()?;
    let (id, rx) = hub.add_client();

    let writer = thread::spawn(move || {
        let mut ws = WebSocket::from_raw_socket(write_stream, Role::Server, None);
        while let Ok(out) = rx.recv() {
            let msg = match out {
                Out::Text(t) => Message::text(t.as_str()),
                Out::Binary(b) => Message::binary(b.as_slice().to_vec()),
            };
            if ws.send(msg).is_err() {
                break;
            }
        }
        let _ = ws.close(None);
        let _ = ws.flush();
        // Unblocks the reader below, whatever ended this connection.
        let _ = shutdown.shutdown(Shutdown::Both);
    });

    // ponytail: this reader instance and the writer thread's instance share
    // one fd. Safe because the browser WebSocket API cannot send Ping, so the
    // reader never has an auto-Pong to write; if that ever changes, route the
    // pong through the hub queue instead.
    let mut reader = WebSocket::from_raw_socket(stream, Role::Server, None);
    loop {
        match reader.read() {
            Ok(Message::Text(t)) => hub.handle_browser(id, &t),
            Ok(Message::Binary(b)) => hub.input(id, b.to_vec()),
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(_) => {}
        }
    }
    hub.remove_client(id); // drops the queue -> the writer exits and closes
    let _ = writer.join();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ct_eq_matches_semantics_of_equality() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"ab"));
        assert!(ct_eq(b"", b""));
    }

    #[test]
    fn base64url_is_unpadded_rfc4648() {
        assert_eq!(base64url(b""), "");
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(b"foob"), "Zm9vYg");
        assert_eq!(base64url(b"foobar"), "Zm9vYmFy");
        // url-safe alphabet: no '+' or '/'
        assert_eq!(base64url(&[0xfb, 0xff, 0xfe]), "-__-");
    }

    #[test]
    fn parse_request_needs_full_head_and_body() {
        assert_eq!(parse_request(b"GET / HT").unwrap(), None);
        assert_eq!(parse_request(b"GET / HTTP/1.1\r\nHost: x\r\n").unwrap(), None);
        let req = parse_request(b"GET /app.js HTTP/1.1\r\nHost: x\r\nCookie: a=b\r\n\r\n")
            .unwrap()
            .unwrap();
        assert_eq!(req.method, "GET");
        assert_eq!(req.path, "/app.js");
        assert_eq!(req.header("host"), Some("x"));
        assert_eq!(req.header("cookie"), Some("a=b"));
        assert!(req.body.is_empty());
        // Header names are matched case-insensitively (browsers vary).
        let req = parse_request(b"GET / HTTP/1.1\r\nHOST: y\r\n\r\n").unwrap().unwrap();
        assert_eq!(req.header("host"), Some("y"));
    }

    #[test]
    fn parse_request_waits_for_content_length_body() {
        let head = b"POST /api/auth HTTP/1.1\r\nContent-Length: 5\r\n\r\nab";
        assert_eq!(parse_request(head).unwrap(), None);
        let full = b"POST /api/auth HTTP/1.1\r\nContent-Length: 5\r\n\r\nabcde";
        let req = parse_request(full).unwrap().unwrap();
        assert_eq!(req.method, "POST");
        assert_eq!(req.body, b"abcde");
    }

    #[test]
    fn parse_request_rejects_oversize_and_malformed() {
        let big = vec![b'x'; MAX_REQUEST_LEN + 1];
        assert!(parse_request(&big).is_err());
        assert!(parse_request(b"GARBAGE\r\n\r\n").is_err());
    }

    #[test]
    fn cookie_value_extracts_the_named_cookie() {
        assert_eq!(cookie_value("amber_web=abc", "amber_web"), Some("abc"));
        assert_eq!(cookie_value("x=1; amber_web=abc; y=2", "amber_web"), Some("abc"));
        assert_eq!(cookie_value("x=1;amber_web=abc", "amber_web"), Some("abc"));
        assert_eq!(cookie_value("x=1", "amber_web"), None);
        // A cookie whose name merely ends with ours must not match.
        assert_eq!(cookie_value("not_amber_web=abc", "amber_web"), None);
        assert_eq!(cookie_value("", "amber_web"), None);
    }

    #[test]
    fn origin_ok_requires_same_host() {
        assert!(origin_ok(Some("https://box.tailnet.ts.net"), Some("box.tailnet.ts.net"), None));
        assert!(origin_ok(Some("http://127.0.0.1:7717"), Some("127.0.0.1:7717"), None));
        // Cross-origin page on the phone driving the socket via the cookie.
        assert!(!origin_ok(Some("https://evil.example"), Some("box.tailnet.ts.net"), None));
        // No Origin at all: not a browser page (curl / tests) — allowed.
        assert!(origin_ok(None, Some("127.0.0.1:7717"), None));
        // An Origin with no host at all to compare against is refused.
        assert!(!origin_ok(Some("https://evil.example"), None, None));

        // Behind `tailscale serve`: Host is rewritten to the backend and the
        // real tailnet name arrives in X-Forwarded-Host. Matching Host alone
        // would 403 every real phone — the headline use case.
        assert!(origin_ok(Some("https://box.ts.net"), Some("127.0.0.1:7717"), Some("box.ts.net")));
        assert!(!origin_ok(
            Some("https://evil.example"),
            Some("127.0.0.1:7717"),
            Some("box.ts.net")
        ));
    }

    /// Build a `SessionInfo` for the tests below with only the fields the
    /// mapping logic reads set meaningfully.
    fn s(name: &str, kind: &str) -> SessionInfo {
        SessionInfo {
            name: name.into(),
            cwd: "/tmp".into(),
            kind: kind.into(),
            alive: true,
            updated: 0,
            run_state: None,
            claude_id: None,
            cols: 80,
            rows: 24,
            slot: 1,
        }
    }

    // ---- grid borrowing (spec §2.2) -----------------------------------

    /// A hub whose session list the test controls, with no daemon attached
    /// (writes are dropped — these tests assert on Hub STATE, which is what a
    /// restore decision is actually made from).
    fn borrow_hub(sessions: Vec<SessionInfo>) -> std::sync::Arc<Hub> {
        let dir = tempfile::tempdir().unwrap();
        let hub = Hub::new(dir.path().join("d.sock"), dir.path().to_path_buf());
        hub.inner.lock().unwrap().sessions = sessions;
        std::mem::forget(dir);
        hub
    }

    fn grid(hub: &Hub, name: &str) -> Option<(u16, u16)> {
        let inner = hub.inner.lock().unwrap();
        inner.sessions.iter().find(|s| s.name == name).map(|s| (s.cols, s.rows))
    }

    /// Pretend the daemon applied a resize (the geometry poll would refresh
    /// `sessions` in the real thing).
    fn set_grid(hub: &Hub, name: &str, cols: u16, rows: u16) {
        let mut inner = hub.inner.lock().unwrap();
        if let Some(s) = inner.sessions.iter_mut().find(|s| s.name == name) {
            s.cols = cols;
            s.rows = rows;
        }
    }

    #[test]
    fn prior_is_captured_on_open_never_on_resize() {
        // THE regression test for spec §2.2.1. `sessions` refreshes on a 1 s
        // poll while the browser's resize debounce is 300 ms, so two resizes
        // fit inside one poll window. If `prior` were captured on the first
        // RESIZE instead of on `Open`, the second resize inside the same
        // window would record the PHONE's own grid, and the restore would
        // silently leave the desktop at phone width.
        let hub = borrow_hub(vec![s("amber-1-1-0-a", "claude")]);
        let (id, _rx) = hub.add_client();
        // Desktop grid at the moment this client opens the session.
        hub.handle_browser(id, r#"{"t":"open","name":"amber-1-1-0-a"}"#);

        // Now the cached session list catches up to a PHONE-sized grid before
        // this client's first resize is seen. That happens for real: the pane
        // mounts and its FitAddon resize is debounced 300 ms while the poll
        // refreshes every 1 s, and a reconnecting client meets a pty that is
        // already phone-sized. If `prior` were captured on the first RESIZE,
        // it would record 46x40 here — the phone's own grid — and the restore
        // would be a silent no-op that leaves the desktop at phone width.
        set_grid(&hub, "amber-1-1-0-a", 46, 40);
        hub.handle_browser(id, r#"{"t":"resize","name":"amber-1-1-0-a","cols":48,"rows":41}"#);

        let b = hub.inner.lock().unwrap().borrows["amber-1-1-0-a"];
        assert_eq!(b.prior, (80, 24), "prior must be the grid at OPEN, not whatever the poll last saw");
        assert_eq!(b.set, Some((48, 41)));
    }

    #[test]
    fn release_restores_the_prior_grid() {
        let hub = borrow_hub(vec![s("amber-1-1-0-a", "claude")]);
        let (id, _rx) = hub.add_client();
        hub.handle_browser(id, r#"{"t":"open","name":"amber-1-1-0-a"}"#);
        hub.handle_browser(id, r#"{"t":"resize","name":"amber-1-1-0-a","cols":46,"rows":40}"#);
        set_grid(&hub, "amber-1-1-0-a", 46, 40);

        hub.handle_browser(id, r#"{"t":"release"}"#);
        assert!(hub.inner.lock().unwrap().borrows.is_empty(), "borrow must be dropped");
        // With no daemon attached the restore frame is dropped, so assert the
        // decision state rather than the wire: the borrow is gone, and the
        // suppression tests below prove the decision itself.
        assert_eq!(grid(&hub, "amber-1-1-0-a"), Some((46, 40)));
    }

    #[test]
    fn release_is_suppressed_when_the_desktop_refit_since() {
        // Last writer wins: a restore must never clobber a newer desktop fit.
        let hub = borrow_hub(vec![s("amber-1-1-0-a", "claude")]);
        let (id, _rx) = hub.add_client();
        hub.handle_browser(id, r#"{"t":"open","name":"amber-1-1-0-a"}"#);
        hub.handle_browser(id, r#"{"t":"resize","name":"amber-1-1-0-a","cols":46,"rows":40}"#);
        // The DESKTOP resized after the phone did.
        set_grid(&hub, "amber-1-1-0-a", 200, 60);

        hub.handle_browser(id, r#"{"t":"release"}"#);
        assert!(hub.inner.lock().unwrap().borrows.is_empty());
        assert_eq!(grid(&hub, "amber-1-1-0-a"), Some((200, 60)), "desktop geometry kept");
    }

    #[test]
    fn a_socket_close_releases_the_borrow() {
        // A phone that leaves Wi-Fi never sends `release`. This is why the
        // borrow map lives in the Hub and not in the browser shim.
        let hub = borrow_hub(vec![s("amber-1-1-0-a", "claude")]);
        let (id, _rx) = hub.add_client();
        hub.handle_browser(id, r#"{"t":"open","name":"amber-1-1-0-a"}"#);
        hub.handle_browser(id, r#"{"t":"resize","name":"amber-1-1-0-a","cols":46,"rows":40}"#);
        assert_eq!(hub.inner.lock().unwrap().borrows.len(), 1);

        hub.remove_client(id);
        assert!(hub.inner.lock().unwrap().borrows.is_empty());
    }

    #[test]
    fn opening_another_session_releases_the_first() {
        let hub = borrow_hub(vec![s("amber-1-1-0-a", "claude"), s("amber-1-1-1-b", "shell")]);
        let (id, _rx) = hub.add_client();
        hub.handle_browser(id, r#"{"t":"open","name":"amber-1-1-0-a"}"#);
        hub.handle_browser(id, r#"{"t":"resize","name":"amber-1-1-0-a","cols":46,"rows":40}"#);
        hub.handle_browser(id, r#"{"t":"open","name":"amber-1-1-1-b"}"#);

        let inner = hub.inner.lock().unwrap();
        assert!(!inner.borrows.contains_key("amber-1-1-0-a"), "first borrow released");
        assert!(inner.borrows.contains_key("amber-1-1-1-b"), "second recorded");
    }

    #[test]
    fn another_clients_release_cannot_take_a_borrow() {
        let hub = borrow_hub(vec![s("amber-1-1-0-a", "claude")]);
        let (a, _ra) = hub.add_client();
        let (b, _rb) = hub.add_client();
        hub.handle_browser(a, r#"{"t":"open","name":"amber-1-1-0-a"}"#);
        hub.handle_browser(a, r#"{"t":"resize","name":"amber-1-1-0-a","cols":46,"rows":40}"#);

        hub.handle_browser(b, r#"{"t":"release"}"#);
        assert_eq!(hub.inner.lock().unwrap().borrows.len(), 1, "not client b's to release");
    }

    #[test]
    fn release_maps_to_no_daemon_control_message() {
        // It acts on Hub state only; the restore Resize it triggers is built by
        // `map_browser_msg` itself, so a browser can never name a geometry
        // through `release`.
        let live = vec![s("amber-1-1-0-a", "claude")];
        assert!(map_browser_msg(&BrowserMsg::Release, Some("amber-1-1-0-a"), &live).is_empty());
    }

    #[test]
    fn parse_browser_msg_accepts_the_whole_whitelist() {
        assert_eq!(
            parse_browser_msg(r#"{"t":"open","name":"amber-1-1-0-a"}"#),
            Some(BrowserMsg::Open { name: "amber-1-1-0-a".into() })
        );
        assert_eq!(
            parse_browser_msg(r#"{"t":"close","name":"s"}"#),
            Some(BrowserMsg::Close { name: "s".into() })
        );
        assert_eq!(
            parse_browser_msg(r#"{"t":"focus","name":"s"}"#),
            Some(BrowserMsg::Focus { name: "s".into() })
        );
        assert_eq!(
            parse_browser_msg(r#"{"t":"create","name":"s","cwd":"/tmp","kind":"shell"}"#),
            Some(BrowserMsg::Create { name: "s".into(), cwd: "/tmp".into(), kind: "shell".into() })
        );
        assert_eq!(
            parse_browser_msg(r#"{"t":"kill","name":"s"}"#),
            Some(BrowserMsg::Kill { name: "s".into() })
        );
        assert_eq!(
            parse_browser_msg(r#"{"t":"move","from":"s","to":"t"}"#),
            Some(BrowserMsg::Move { from: "s".into(), to: "t".into() })
        );
        assert_eq!(
            parse_browser_msg(r#"{"t":"suspend","name":"s"}"#),
            Some(BrowserMsg::Suspend { name: "s".into() })
        );
        assert_eq!(
            parse_browser_msg(r#"{"t":"resume","name":"s"}"#),
            Some(BrowserMsg::Resume { name: "s".into() })
        );
        assert_eq!(
            parse_browser_msg(r#"{"t":"resize","name":"s","cols":80,"rows":24}"#),
            Some(BrowserMsg::Resize { name: "s".into(), cols: 80, rows: 24 })
        );
        for junk in [
            "",
            "not json",
            "[]",
            r#"{"t":"rename","from":"s","to":"t"}"#,
            r#"{"t":"snapshot"}"#,
            r#"{"t":"dumpbacklog","name":"s"}"#,
            r#"{"t":"reportrunstate","name":"s","state":"claude"}"#,
            r#"{"t":"open"}"#,
            r#"{"t":"open","name":123}"#,
            r#"{"name":"s"}"#,
            // resize with a non-numeric or out-of-u16-range cols/rows must
            // not parse at all (never a BrowserMsg carrying garbage that
            // `map_browser_msg` then has to bounds-check).
            r#"{"t":"resize","name":"s","cols":"wide","rows":24}"#,
            r#"{"t":"resize","name":"s","cols":999999,"rows":24}"#,
            r#"{"t":"resize","name":"s","rows":24}"#,
        ] {
            assert_eq!(parse_browser_msg(junk), None, "must ignore {junk:?}");
        }
    }

    /// Every control message the browser must never be able to cause (spec §4,
    /// widened by the pane-parity pass and the 2026-08-01 resize reversal).
    /// `Snapshot`/`ReportRunState` are daemon/supervisor-internal; `Resize` is
    /// deliberately NOT here any more — it is validated (live + bounds), not
    /// forbidden — see `map_browser_msg_resize_validates_session_and_bounds`.
    fn is_forbidden(msg: &ControlMsg) -> bool {
        // `DumpBacklog` is deliberately NOT here: the 2026-08-01 webapp pivot
        // widened the whitelist to include it (spec §3 "Backlog" row) behind
        // its own `live(name)` gate in `map_browser_msg`. `Resize` is
        // deliberately NOT here either, as of the 2026-08-01 resize reversal:
        // it is validated (live + bounds), not forbidden.
        matches!(
            msg,
            ControlMsg::Snapshot
                | ControlMsg::ReportRunState { .. }
                | ControlMsg::SupervisorHello { .. }
                | ControlMsg::SupervisorCommand { .. }
        )
    }

    #[test]
    fn map_browser_msg_attaches_and_detaches_only() {
        let live = [s("s", "shell"), s("t", "shell")];
        // open with nothing open -> just Attach.
        assert_eq!(
            map_browser_msg(&BrowserMsg::Open { name: "s".into() }, None, &live),
            vec![ControlMsg::Attach { name: "s".into(), raw_client: false, preview: false, resume: None }]
        );
        // open while another is open -> switch (Detach old, Attach new).
        assert_eq!(
            map_browser_msg(&BrowserMsg::Open { name: "t".into() }, Some("s"), &live),
            vec![
                ControlMsg::Detach { name: "s".into() },
                ControlMsg::Attach { name: "t".into(), raw_client: false, preview: false, resume: None },
            ]
        );
        // re-open the same session -> no churn.
        assert_eq!(
            map_browser_msg(&BrowserMsg::Open { name: "s".into() }, Some("s"), &live),
            vec![ControlMsg::Attach { name: "s".into(), raw_client: false, preview: false, resume: None }]
        );
        // close -> Detach.
        assert_eq!(
            map_browser_msg(&BrowserMsg::Close { name: "s".into() }, Some("s"), &live),
            vec![ControlMsg::Detach { name: "s".into() }]
        );
    }

    #[test]
    fn map_browser_msg_ignores_names_not_in_the_live_set() {
        // A browser naming a session the daemon does not have must not reach
        // the daemon at all (spec §5: "only for a name currently in the live
        // session list").
        let live = [s("s", "shell")];
        assert!(map_browser_msg(&BrowserMsg::Open { name: "ghost".into() }, None, &live).is_empty());
        assert!(map_browser_msg(&BrowserMsg::Close { name: "ghost".into() }, None, &live)
            .is_empty());
        assert!(map_browser_msg(&BrowserMsg::Focus { name: "ghost".into() }, None, &live)
            .is_empty());
    }

    #[test]
    fn browser_focus_reaches_only_live_sessions() {
        let live = [s("live", "shell")];
        assert_eq!(
            map_browser_msg(&BrowserMsg::Focus { name: "live".into() }, None, &live),
            vec![ControlMsg::Focus { name: "live".into() }]
        );
        assert!(map_browser_msg(&BrowserMsg::Focus { name: "missing".into() }, None, &live)
            .is_empty());
    }

    #[test]
    fn create_requires_the_pane_grammar_and_a_known_kind() {
        let live = [s("amber-1-1-0-aa", "shell")];
        let mk = |name: &str, kind: &str| {
            map_browser_msg(
                &BrowserMsg::Create { name: name.into(), cwd: "/tmp".into(), kind: kind.into() },
                None,
                &live,
            )
        };
        assert_eq!(mk("amber-1-1-1-bb", "shell").len(), 1);
        assert_eq!(mk("amber-1-1-1-bb", "grok").len(), 1);
        assert_eq!(mk("amber-1-1-1-bb", "opencode").len(), 1);
        // Outside the pane grammar: no pane could ever show it, and `s<n>`
        // would shadow the bare-`amber` CLI namespace.
        assert!(mk("s3", "shell").is_empty());
        assert!(mk("amber-1-1-1-bb!", "shell").is_empty());
        assert!(mk("browser-1-1-1-bb", "shell").is_empty());
        // Unknown kind.
        assert!(mk("amber-1-1-1-bb", "bash").is_empty());
        // A name that is already live.
        assert!(mk("amber-1-1-0-aa", "shell").is_empty());
    }

    #[test]
    fn create_requires_an_existing_cwd() {
        let live: [SessionInfo; 0] = [];
        let out = map_browser_msg(
            &BrowserMsg::Create {
                name: "amber-1-1-0-aa".into(),
                cwd: "/definitely/not/a/real/dir".into(),
                kind: "shell".into(),
            },
            None,
            &live,
        );
        assert!(out.is_empty(), "a non-existent cwd must be refused: {out:?}");
    }

    #[test]
    fn kill_and_move_only_touch_live_sessions_and_valid_targets() {
        let live = [s("amber-1-1-0-aa", "shell")];
        assert!(matches!(
            map_browser_msg(&BrowserMsg::Kill { name: "amber-1-1-0-aa".into() }, None, &live)
                .as_slice(),
            [ControlMsg::Kill { .. }]
        ));
        assert!(map_browser_msg(&BrowserMsg::Kill { name: "nope".into() }, None, &live).is_empty());

        assert!(matches!(
            map_browser_msg(
                &BrowserMsg::Move { from: "amber-1-1-0-aa".into(), to: "amber-2-1-0-aa".into() },
                None,
                &live
            )
            .as_slice(),
            [ControlMsg::Rename { .. }]
        ));
        // Target outside the grammar.
        assert!(map_browser_msg(
            &BrowserMsg::Move { from: "amber-1-1-0-aa".into(), to: "s9".into() },
            None,
            &live
        )
        .is_empty());
        // Source not live.
        assert!(map_browser_msg(
            &BrowserMsg::Move { from: "ghost".into(), to: "amber-2-1-0-aa".into() },
            None,
            &live
        )
        .is_empty());
    }

    #[test]
    fn suspend_and_resume_are_refused_for_non_agent_sessions() {
        let live = [
            s("amber-1-1-0-aa", "shell"),
            s("amber-1-1-1-bb", "claude"),
            s("amber-1-1-2-cc", "grok"),
            s("amber-1-1-3-dd", "opencode"),
        ];
        for kind_name in ["amber-1-1-1-bb", "amber-1-1-2-cc", "amber-1-1-3-dd"] {
            assert_eq!(
                map_browser_msg(&BrowserMsg::Suspend { name: kind_name.into() }, None, &live).len(),
                1,
                "agent {kind_name} should suspend"
            );
            assert_eq!(
                map_browser_msg(&BrowserMsg::Resume { name: kind_name.into() }, None, &live).len(),
                1,
                "agent {kind_name} should resume"
            );
        }
        // A shell has no supervisor to signal — refuse before the daemon has to.
        assert!(
            map_browser_msg(&BrowserMsg::Suspend { name: "amber-1-1-0-aa".into() }, None, &live)
                .is_empty()
        );
        assert!(
            map_browser_msg(&BrowserMsg::Resume { name: "amber-1-1-0-aa".into() }, None, &live)
                .is_empty()
        );
    }

    #[test]
    fn dump_backlog_is_gated_on_liveness_like_kill() {
        let live = [s("amber-1-1-0-aa", "shell")];
        assert_eq!(
            parse_browser_msg(r#"{"t":"dumpBacklog","name":"amber-1-1-0-aa"}"#),
            Some(BrowserMsg::DumpBacklog { name: "amber-1-1-0-aa".into() })
        );
        assert!(matches!(
            map_browser_msg(
                &BrowserMsg::DumpBacklog { name: "amber-1-1-0-aa".into() },
                None,
                &live
            )
            .as_slice(),
            [ControlMsg::DumpBacklog { name }] if name == "amber-1-1-0-aa"
        ));
        assert!(
            map_browser_msg(&BrowserMsg::DumpBacklog { name: "ghost".into() }, None, &live).is_empty(),
            "a dump request for a dead/unknown session must not reach the daemon"
        );
    }

    #[test]
    fn snapshot_and_reportrunstate_remain_unreachable() {
        // There is no BrowserMsg that parses to them, so no mapping exists.
        // (`resize` used to be in this list — it now parses, see
        // `map_browser_msg_resize_validates_session_and_bounds` for its gate.)
        for text in [
            r#"{"t":"snapshot"}"#,
            r#"{"t":"dumpbacklog","name":"amber-1-1-0-aa"}"#,
            r#"{"t":"reportrunstate","name":"amber-1-1-0-aa","state":"claude"}"#,
        ] {
            assert!(parse_browser_msg(text).is_none(), "{text} parsed");
        }
    }

    #[test]
    fn map_browser_msg_resize_validates_session_and_bounds() {
        let live = [s("s", "shell")];
        // Live session, in-bounds size -> reaches the daemon, constructed
        // (not passed through) from the validated name/cols/rows.
        assert_eq!(
            map_browser_msg(&BrowserMsg::Resize { name: "s".into(), cols: 80, rows: 24 }, None, &live),
            vec![ControlMsg::Resize { name: "s".into(), cols: 80, rows: 24 }]
        );
        // Dead/unknown session -> nothing reaches the daemon.
        assert!(map_browser_msg(
            &BrowserMsg::Resize { name: "ghost".into(), cols: 80, rows: 24 },
            None,
            &live
        )
        .is_empty());
        // Below the floor (a crushed/backgrounded browser window) -> rejected,
        // never clamped up to something plausible-looking.
        assert!(map_browser_msg(
            &BrowserMsg::Resize { name: "s".into(), cols: 1, rows: 1 },
            None,
            &live
        )
        .is_empty());
        assert!(map_browser_msg(
            &BrowserMsg::Resize { name: "s".into(), cols: RESIZE_MIN_COLS - 1, rows: 24 },
            None,
            &live
        )
        .is_empty());
        assert!(map_browser_msg(
            &BrowserMsg::Resize { name: "s".into(), cols: 80, rows: RESIZE_MIN_ROWS - 1 },
            None,
            &live
        )
        .is_empty());
        // Above the ceiling -> rejected.
        assert!(map_browser_msg(
            &BrowserMsg::Resize { name: "s".into(), cols: RESIZE_MAX_COLS + 1, rows: 24 },
            None,
            &live
        )
        .is_empty());
        assert!(map_browser_msg(
            &BrowserMsg::Resize { name: "s".into(), cols: 80, rows: RESIZE_MAX_ROWS + 1 },
            None,
            &live
        )
        .is_empty());
        // Exactly at the floor/ceiling -> accepted (inclusive bounds).
        assert_eq!(
            map_browser_msg(
                &BrowserMsg::Resize { name: "s".into(), cols: RESIZE_MIN_COLS, rows: RESIZE_MIN_ROWS },
                None,
                &live
            ),
            vec![ControlMsg::Resize { name: "s".into(), cols: RESIZE_MIN_COLS, rows: RESIZE_MIN_ROWS }]
        );
        assert_eq!(
            map_browser_msg(
                &BrowserMsg::Resize { name: "s".into(), cols: RESIZE_MAX_COLS, rows: RESIZE_MAX_ROWS },
                None,
                &live
            ),
            vec![ControlMsg::Resize { name: "s".into(), cols: RESIZE_MAX_COLS, rows: RESIZE_MAX_ROWS }]
        );
    }

    #[test]
    fn no_browser_input_can_reach_a_forbidden_control_message() {
        // Exhaustive over the parseable surface: every JSON the browser could
        // send, crossed with every open-state and live-set, must never produce
        // Snapshot/ReportRunState, and every message it DOES produce is one of
        // the widened whitelist's variants — Resize included, but ONLY within
        // `map_browser_msg`'s bounds (checked in the loop below).
        let live = [s("s", "shell"), s("t", "shell")];
        let texts = [
            r#"{"t":"open","name":"s"}"#,
            r#"{"t":"open","name":"ghost"}"#,
            r#"{"t":"close","name":"s"}"#,
            r#"{"t":"close","name":"ghost"}"#,
            r#"{"t":"focus","name":"s"}"#,
            r#"{"t":"resize","name":"s","cols":80,"rows":24}"#,
            r#"{"t":"kill","name":"s"}"#,
            r#"{"t":"create","name":"s","cwd":"/tmp","kind":"shell"}"#,
            r#"{"t":"rename","from":"s","to":"t"}"#,
            r#"{"t":"move","from":"s","to":"amber-1-1-0-aa"}"#,
            r#"{"t":"suspend","name":"s"}"#,
            r#"{"t":"resume","name":"s"}"#,
            r#"{"t":"dumpbacklog","name":"s"}"#,
            r#"{"t":"dumpBacklog","name":"s"}"#,
            r#"{"t":"snapshot"}"#,
            r#"{"t":"input","name":"s","data":"eA=="}"#,
            "garbage",
        ];
        for text in texts {
            let Some(msg) = parse_browser_msg(text) else { continue };
            for open in [None, Some("s"), Some("t")] {
                for set in [&live[..], &[][..]] {
                    for out in map_browser_msg(&msg, open, set) {
                        assert!(!is_forbidden(&out), "{text:?} produced {out:?}");
                        assert!(
                            matches!(
                                out,
                                ControlMsg::Attach { .. }
                                    | ControlMsg::Detach { .. }
                                    | ControlMsg::Focus { .. }
                                    | ControlMsg::Create { .. }
                                    | ControlMsg::Kill { .. }
                                    | ControlMsg::Rename { .. }
                                    | ControlMsg::Suspend { .. }
                                    | ControlMsg::Resume { .. }
                                    | ControlMsg::DumpBacklog { .. }
                                    | ControlMsg::Resize { .. }
                            ),
                            "{text:?} produced non-whitelisted {out:?}"
                        );
                        // A Resize that DID make it out must be within bounds —
                        // the whitelist match above only checks the variant,
                        // not that map_browser_msg actually enforced its gate.
                        if let ControlMsg::Resize { cols, rows, .. } = out {
                            assert!(
                                (RESIZE_MIN_COLS..=RESIZE_MAX_COLS).contains(&cols)
                                    && (RESIZE_MIN_ROWS..=RESIZE_MAX_ROWS).contains(&rows),
                                "{text:?} produced an out-of-bounds Resize {cols}x{rows}"
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn status_json_lists_open_sessions_per_client() {
        let dir = tempfile::tempdir().unwrap();
        let hub = Hub::new(dir.path().join("daemon.sock"), dir.path().to_path_buf());
        let (id, _rx) = hub.add_client();
        hub.inner.lock().unwrap().clients[0].open = Some("amber-1-1-0-ab".into());

        let body = hub.status_json(7717);
        let v: serde_json::Value = serde_json::from_str(&body).expect("valid json");
        assert_eq!(v["port"], 7717);
        assert_eq!(v["clients"][0]["id"], id);
        assert_eq!(v["clients"][0]["open"], "amber-1-1-0-ab");
        // Phase B (spec §2.2) fills this; the field exists now so the payload
        // shape does not change under the app when it lands.
        assert!(v["clients"][0]["borrow"].is_null());
        assert!(v["uptime_secs"].is_number());
        assert!(v["sessions"].is_number());
    }

    #[test]
    fn status_json_never_carries_a_secret() {
        let dir = tempfile::tempdir().unwrap();
        let hub = Hub::new(dir.path().join("daemon.sock"), dir.path().to_path_buf());
        let body = hub.status_json(7717);
        // The desktop dialog polls this every 3 s. A token here would sit in
        // renderer memory and every IPC trace continuously.
        assert!(!body.contains("t="), "{body}");
        assert!(!body.contains("token"), "{body}");
    }

    #[test]
    fn load_token_reads_but_never_creates() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load_token(dir.path()), None);
        // The read must not have minted one — that is the whole point.
        assert!(!dir.path().join(TOKEN_FILE).exists());

        let made = load_or_create_token(dir.path(), false).unwrap();
        assert_eq!(load_token(dir.path()).as_deref(), Some(made.as_str()));
    }

    #[test]
    fn token_creation_uses_platform_private_file() {
        let root = tempfile::tempdir().unwrap();
        let token = load_or_create_token(root.path(), false).unwrap();

        assert_eq!(token.len(), 43);
        assert!(crate::platform::is_user_private(&root.path().join(TOKEN_FILE)).unwrap());
    }

    #[test]
    fn memory_pressure_is_broadcast_to_every_browser_client() {
        let dir = tempfile::tempdir().unwrap();
        let hub = Hub::new(dir.path().join("daemon.sock"), dir.path().to_path_buf());
        let (_a, rx_a) = hub.add_client();
        let (_b, rx_b) = hub.add_client();
        for rx in [&rx_a, &rx_b] {
            let _ = recv_out(rx);
            let _ = recv_out(rx);
        }

        hub.on_frame(Frame::Control(ControlMsg::MemoryPressure {
            level: "critical".into(),
            current_kb: 7_000_000,
            budget_kb: 8_000_000,
            blocked: false,
        }));

        for rx in [&rx_a, &rx_b] {
            let Out::Text(text) = recv_out(rx) else { panic!("expected pressure text") };
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&text).unwrap(),
                serde_json::json!({
                    "t": "memoryPressure",
                    "level": "critical",
                    "current_kb": 7_000_000,
                    "budget_kb": 8_000_000,
                    "blocked": false,
                })
            );
        }
    }

    #[test]
    fn resource_pressure_is_broadcast_to_every_browser_client() {
        let dir = tempfile::tempdir().unwrap();
        let hub = Hub::new(dir.path().join("daemon.sock"), dir.path().to_path_buf());
        let (_a, rx_a) = hub.add_client();
        let (_b, rx_b) = hub.add_client();
        for rx in [&rx_a, &rx_b] {
            let _ = recv_out(rx);
            let _ = recv_out(rx);
        }

        hub.on_frame(Frame::Control(ControlMsg::ResourcePressure {
            level: amber_core::proto::ResourcePressureLevel::Critical,
            causes: vec![amber_core::proto::ResourcePressureCause::Cpu],
            blocked: false,
        }));

        for rx in [&rx_a, &rx_b] {
            let Out::Text(text) = recv_out(rx) else { panic!("expected resource-pressure text") };
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&text).unwrap(),
                serde_json::json!({
                    "t": "resourcePressure",
                    "level": "critical",
                    "causes": ["cpu"],
                    "blocked": false,
                })
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn daemon_link_subscribes_to_resource_pressure_version_two() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("fake-daemon.sock");
        let listener = transport::bind(&sock).unwrap();
        let hub = Hub::new(sock, dir.path().to_path_buf());
        {
            let hub = Arc::clone(&hub);
            thread::spawn(move || run_daemon_link(hub));
        }

        let conn = listener.accept().unwrap();
        conn.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let (mut conn_read, _conn_write) = conn.into_split().unwrap();
        let mut reader = FrameReader::new(&mut conn_read);
        let first = reader.next();
        let second = reader.next();
        assert!(matches!(
            [first, second].as_slice(),
            [Frame::Control(ControlMsg::WatchSessions), Frame::Control(ControlMsg::WatchMemoryPressure { version: 2 })]
                | [Frame::Control(ControlMsg::WatchMemoryPressure { version: 2 }), Frame::Control(ControlMsg::WatchSessions)]
        ));
    }

    #[cfg(unix)]
    #[test]
    fn failed_daemon_write_wakes_reader_and_reconnects() {
        use std::net::Shutdown;
        use std::os::unix::net::UnixListener;

        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("failed-write-reconnect.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        let hub = Hub::new(sock, dir.path().to_path_buf());
        {
            let hub = Arc::clone(&hub);
            thread::spawn(move || run_daemon_link(hub));
        }

        let (mut first, _) = listener.accept().unwrap();
        first
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut decoder = Decoder::new();
        let mut buf = [0_u8; 4096];
        let mut frames = 0;
        while frames < 2 {
            while decoder.next_frame().unwrap().is_some() {
                frames += 1;
            }
            if frames < 2 {
                let read = first.read(&mut buf).unwrap();
                assert_ne!(read, 0, "daemon link closed during initial subscription");
                decoder.feed(&buf[..read]);
            }
        }

        first.shutdown(Shutdown::Read).unwrap();
        {
            let mut inner = hub.inner.lock().unwrap();
            assert!(inner.daemon.is_some());
            Hub::write_daemon(&mut inner, &Frame::Control(ControlMsg::WatchSessions));
            assert!(inner.daemon.is_none());
        }

        listener.set_nonblocking(true).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match listener.accept() {
                Ok((_second, _)) => break,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        Instant::now() < deadline,
                        "daemon reader stayed blocked after its writer failed"
                    );
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("second daemon accept failed: {error}"),
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn daemon_link_skips_unknown_control_and_keeps_decoding() {
        let dir = tempfile::tempdir().unwrap();
        let hub = Arc::new(Hub::new(
            dir.path().join("daemon.sock"),
            dir.path().to_path_buf(),
        ));
        let (peer, web_end) = transport::test_pair().unwrap();
        let (_peer_read, mut peer_write) = peer.into_split().unwrap();
        let (web_read, _web_write) = web_end.into_split().unwrap();
        let reader_hub = Arc::clone(&hub);
        let reader = std::thread::spawn(move || reader_hub.read_loop(web_read));

        let json = br#"{"FutureDaemonEvent":{"version":2}}"#;
        let mut unknown_body = vec![0u8];
        unknown_body.extend_from_slice(json);
        let mut unknown = (unknown_body.len() as u32).to_be_bytes().to_vec();
        unknown.extend_from_slice(&unknown_body);
        peer_write.write_all(&unknown).unwrap();
        peer_write.write_all(&proto::encode(&Frame::Control(ControlMsg::Sessions {
            sessions: vec![s("still-connected", "shell")],
        })))
        .unwrap();
        peer_write.shutdown().unwrap();
        reader.join().unwrap();

        assert_eq!(hub.inner.lock().unwrap().sessions[0].name, "still-connected");
    }

    /// Reads whole `Frame`s off a raw fake-daemon connection, keeping the
    /// `Decoder`'s state across calls (two frames can arrive in one `read()`).
    #[cfg(unix)]
    struct FrameReader<'a> {
        stream: &'a mut LocalReader,
        dec: Decoder,
    }
    #[cfg(unix)]
    impl<'a> FrameReader<'a> {
        fn new(stream: &'a mut LocalReader) -> Self {
            Self { stream, dec: Decoder::new() }
        }
        fn next(&mut self) -> Frame {
            let mut buf = [0u8; 4096];
            loop {
                if let Some(f) = self.dec.next_frame().unwrap() {
                    return f;
                }
                let n = self.stream.read(&mut buf).unwrap();
                assert!(n > 0, "fake daemon connection closed unexpectedly");
                self.dec.feed(&buf[..n]);
            }
        }
    }

    fn recv_out(rx: &Receiver<Out>) -> Out {
        rx.recv_timeout(Duration::from_secs(5)).expect("browser client queue starved")
    }

    /// `serde_json::json!` does not guarantee key order, so assert on parsed
    /// structure rather than the literal string.
    fn is_backlog_marker(text: &str, name: &str) -> bool {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else { return false };
        v["t"] == "backlog" && v["name"] == name
    }

    /// Drain `rx` up to the `backlog` marker for `name`, tolerating whatever
    /// else the hub also broadcasts in between (e.g. the `sessions`/`error`
    /// pair a daemon disconnect fires) — this test cares only that the marker
    /// itself is present and correctly paired with the payload that follows.
    fn expect_backlog(rx: &Receiver<Out>, name: &str) -> Vec<u8> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            assert!(Instant::now() < deadline, "backlog marker for {name} never arrived");
            if let Out::Text(t) = recv_out(rx) {
                if is_backlog_marker(&t, name) {
                    break;
                }
            }
        }
        match recv_out(rx) {
            Out::Binary(b) => b.as_ref().clone(),
            other => panic!("expected the backlog payload right after its marker, got {other:?}"),
        }
    }

    /// 2026-08-01 webapp-pivot §4.1 regression: `amber web` re-Attaches on ITS
    /// OWN reconnect to the daemon, independent of any browser event, and that
    /// path used to arrive untagged — the browser couldn't tell it was a
    /// replay, so history duplicated (confirmed live: an extra unearned prompt
    /// line after a daemon-only restart). Drives a fake daemon by hand (a raw
    /// `UnixListener`, not the real `Daemon`/`SessionManager`) so the
    /// disconnect/reconnect is deterministic rather than racing a real child
    /// process. Revert `write_daemon_tracking`'s use in `run_daemon_link` (i.e.
    /// go back to plain `write_daemon` there) and this test fails on the
    /// second `backlog` assertion.
    #[cfg(unix)]
    #[test]
    fn daemon_reconnect_reattach_tags_its_backlog_reply() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("fake-daemon.sock");
        let listener = transport::bind(&sock).unwrap();

        let hub = Hub::new(sock, dir.path().to_path_buf());
        {
            let hub = Arc::clone(&hub);
            thread::spawn(move || run_daemon_link(hub));
        }

        // --- First "daemon" connection ---------------------------------
        let conn = listener.accept().unwrap();
        conn.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let (mut conn_read, mut conn_write_half) = conn.into_split().unwrap();
        let mut r1 = FrameReader::new(&mut conn_read);

        conn_write(&mut conn_write_half, &Frame::Control(ControlMsg::Sessions { sessions: vec![s("s1", "shell")] }));
        let deadline = Instant::now() + Duration::from_secs(5);
        while !hub.inner.lock().unwrap().sessions.iter().any(|x| x.name == "s1") {
            assert!(Instant::now() < deadline, "hub never learned about s1");
            thread::sleep(Duration::from_millis(10));
        }

        let (id, rx) = hub.add_client();
        // The initial push `add_client` queues before any Attach happens.
        match recv_out(&rx) {
            Out::Text(t) => assert!(t.contains("\"t\":\"sessions\""), "{t}"),
            other => panic!("expected the initial sessions push, got {other:?}"),
        }

        hub.handle_browser(id, r#"{"t":"open","name":"s1"}"#);
        // `run_daemon_link` already wrote a `WatchSessions` the moment it
        // connected (before any client existed) — skip past it to the Attach
        // the just-issued Open produced.
        loop {
            if matches!(r1.next(), Frame::Control(ControlMsg::Attach { name, .. }) if name == "s1") {
                break;
            }
        }
        conn_write(&mut conn_write_half, &Frame::Data { session: "s1".into(), bytes: b"first-backlog".to_vec() });
        assert_eq!(expect_backlog(&rx, "s1"), b"first-backlog");

        // --- The daemon dies and a fresh connection replaces it, with NO
        // browser-side event at all: this is the bug's exact trigger. ------
        drop(r1);
        conn_write_half.shutdown().unwrap();
        let conn2 = listener.accept().unwrap();
        conn2.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let (mut conn2_read, mut conn2_write) = conn2.into_split().unwrap();
        let mut r2 = FrameReader::new(&mut conn2_read);
        // `run_daemon_link` sends WatchSessions before re-attaching every
        // session a client still has open — skip past it.
        loop {
            if matches!(r2.next(), Frame::Control(ControlMsg::Attach { name, .. }) if name == "s1") {
                break;
            }
        }
        conn_write(&mut conn2_write, &Frame::Data { session: "s1".into(), bytes: b"replayed-after-restart".to_vec() });

        // The fix: the browser gets the SAME tagged marker for this
        // reconnect-driven re-attach as it did for the browser-initiated one
        // (tolerating the "daemon unreachable" sessions/error pair the
        // disconnect itself broadcasts first).
        assert_eq!(expect_backlog(&rx, "s1"), b"replayed-after-restart");
    }

    #[cfg(unix)]
    fn conn_write(stream: &mut LocalWriter, frame: &Frame) {
        stream.write_all(&proto::encode(frame)).unwrap();
    }

    #[test]
    fn websocket_accept_key_matches_rfc6455() {
        // RFC 6455 §1.3 worked example. Locking it here proves the upgrade
        // handshake this server writes is the one browsers expect.
        let accept = tungstenite::handshake::derive_accept_key(b"dGhlIHNhbXBsZSBub25jZQ==");
        assert_eq!(accept, "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }
}
