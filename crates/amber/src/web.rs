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
//! - a BINARY frame — raw input bytes for this connection's currently-open
//!   session. With no open session it is ignored.
//!
//! server → browser:
//! - a BINARY frame — raw pty output of this connection's open session.
//! - `{"t":"sessions","sessions":[{"name","kind","cwd","run_state","alive",
//!   "cols","rows"}]}` — sent once on connect and on every change (including
//!   an empty list when the daemon is unreachable). `cols`/`rows` are the
//!   pty's LIVE winsize: the phone renders at that geometry because it may
//!   never resize (spec §4).
//! - `{"t":"exit","name":"..","code":n}`
//! - `{"t":"error","msg":".."}`
//!
//! Unknown `t`, malformed JSON, or a binary frame with no open session are
//! **ignored** — never an error that closes the socket.
//!
//! # Invariants
//!
//! - **The browser can never resize a pty** (spec §4). A pty's winsize is
//!   shared with the desktop app, so a phone-driven resize would reflow the
//!   user's live panes and corrupt a claude TUI. [`map_browser_msg`] is the
//!   ONLY path from a browser message to a daemon control message, and it
//!   emits nothing but `Attach`/`Detach`.
//! - **The browser can never change which sessions exist** (spec §5):
//!   `Create`/`Kill`/`Rename`/`Suspend`/`Resume`/`DumpBacklog`/`Snapshot` are
//!   unreachable from [`map_browser_msg`] by construction.
//! - A large `Attach` backlog is delivered on the per-client writer thread,
//!   never on the shared daemon-read thread (the backlog head-of-line lesson
//!   in CLAUDE.md).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use amber_core::proto::{self, ControlMsg, Decoder, Frame, SessionInfo};

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

/// The complete set of browser-originated control messages (spec §5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrowserMsg {
    Open { name: String },
    Close { name: String },
}

/// Parse a browser control (JSON text) frame. `None` for malformed JSON, an
/// unknown `t`, or a missing/!string `name` — the caller ignores it.
pub fn parse_browser_msg(text: &str) -> Option<BrowserMsg> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let name = || v.get("name")?.as_str().map(str::to_string);
    match v.get("t")?.as_str()? {
        "open" => Some(BrowserMsg::Open { name: name()? }),
        "close" => Some(BrowserMsg::Close { name: name()? }),
        // Anything else — including a hand-crafted `resize`/`kill` — has no
        // representation here, so it can never reach the daemon.
        _ => None,
    }
}

/// The ONLY mapping from a browser message to daemon control messages
/// (spec §5). `open` is this connection's currently-open session; `live` is
/// the daemon's current session-name set.
///
/// By construction this returns nothing but `Detach` and `Attach`: there is no
/// path from any browser input to `Create`, `Kill`, `Rename`, **`Resize`**,
/// `Suspend`, `Resume`, `DumpBacklog` or `Snapshot`.
pub fn map_browser_msg(msg: &BrowserMsg, open: Option<&str>, live: &[String]) -> Vec<ControlMsg> {
    // Exhaustive match: adding a browser message forces a decision here, so a
    // forbidden control can never become reachable by accident.
    match msg {
        BrowserMsg::Open { name } => {
            if !live.iter().any(|n| n == name) {
                return Vec::new();
            }
            let mut out = Vec::new();
            if let Some(prev) = open {
                if prev != name {
                    out.push(ControlMsg::Detach { name: prev.to_string() });
                }
            }
            out.push(ControlMsg::Attach { name: name.clone(), raw_client: false });
            out
        }
        BrowserMsg::Close { name } => {
            if !live.iter().any(|n| n == name) {
                return Vec::new();
            }
            vec![ControlMsg::Detach { name: name.clone() }]
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

/// 32 bytes from the kernel CSPRNG. std has no RNG and this is the only
/// randomness the feature needs, so `/dev/urandom` (present on both supported
/// OSes) beats pulling a crate.
fn random_token() -> String {
    let mut buf = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .expect("/dev/urandom is readable");
    base64url(&buf)
}

/// Load the web token from `<root>/web-token`, creating it (mode 0600) if it
/// is missing/empty or `regenerate` is set (`amber web --new-token`).
pub fn load_or_create_token(root: &Path, regenerate: bool) -> anyhow::Result<String> {
    let path = root.join(TOKEN_FILE);
    if !regenerate {
        if let Ok(existing) = std::fs::read_to_string(&path) {
            let existing = existing.trim().to_string();
            if !existing.is_empty() {
                return Ok(existing);
            }
        }
    }
    std::fs::create_dir_all(root)?;
    let token = random_token();
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&path)?;
    f.write_all(token.as_bytes())?;
    f.flush()?;
    // `.mode()` only applies at creation — re-assert it for an existing file.
    std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
    Ok(token)
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
            let id = random_token();
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
#[derive(Clone)]
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
    daemon: Option<UnixStream>,
    sessions: Vec<SessionInfo>,
    clients: Vec<Client>,
}

/// The single daemon connection, multiplexed across every browser client.
pub struct Hub {
    socket: PathBuf,
    inner: Mutex<HubInner>,
    next_id: AtomicU64,
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
    })
}

impl Hub {
    fn new(socket: PathBuf) -> Arc<Self> {
        Arc::new(Hub {
            socket,
            inner: Mutex::new(HubInner { daemon: None, sessions: Vec::new(), clients: Vec::new() }),
            next_id: AtomicU64::new(0),
        })
    }

    /// JSON array for `GET /api/sessions`.
    fn sessions_json(&self) -> String {
        let inner = self.inner.lock().unwrap();
        let list: Vec<_> = inner.sessions.iter().map(session_json).collect();
        serde_json::to_string(&list).unwrap_or_else(|_| "[]".into())
    }

    fn sessions_msg(sessions: &[SessionInfo]) -> Out {
        let list: Vec<_> = sessions.iter().map(session_json).collect();
        Out::Text(Arc::new(
            serde_json::json!({ "t": "sessions", "sessions": list }).to_string(),
        ))
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
        let _ = tx.try_send(Self::sessions_msg(&inner.sessions));
        if inner.daemon.is_none() {
            let _ = tx.try_send(Self::error_msg("daemon unreachable"));
        }
        inner.clients.push(Client { id, open: None, tx });
        (id, rx)
    }

    fn remove_client(&self, id: u64) {
        let mut inner = self.inner.lock().unwrap();
        let Some(pos) = inner.clients.iter().position(|c| c.id == id) else { return };
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

    /// Write one frame to the daemon. Bounded by `SO_SNDTIMEO`; a failure
    /// drops the link so the supervisor reconnects.
    fn write_daemon(inner: &mut HubInner, frame: &Frame) {
        let bytes = proto::encode(frame);
        let ok = match inner.daemon.as_mut() {
            Some(s) => s.write_all(&bytes).and_then(|()| s.flush()).is_ok(),
            None => false,
        };
        if !ok {
            inner.daemon = None;
        }
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

    /// A browser control (JSON text) frame. The ONLY path from browser input
    /// to daemon control messages, via [`map_browser_msg`].
    fn handle_browser(&self, id: u64, text: &str) {
        // Unknown `t` / malformed JSON: ignored, never an error that closes.
        let Some(msg) = parse_browser_msg(text) else { return };
        let mut inner = self.inner.lock().unwrap();
        let live: Vec<String> =
            inner.sessions.iter().filter(|s| s.alive).map(|s| s.name.clone()).collect();
        let Some(pos) = inner.clients.iter().position(|c| c.id == id) else { return };
        let previous = inner.clients[pos].open.clone();
        let controls = map_browser_msg(&msg, previous.as_deref(), &live);
        if controls.is_empty() {
            let err = Self::error_msg("no such session");
            Self::queue(&mut inner, |c| c.id == id, err);
            return;
        }
        inner.clients[pos].open = match &msg {
            BrowserMsg::Open { name } => Some(name.clone()),
            BrowserMsg::Close { .. } => None,
        };
        for control in controls {
            if let ControlMsg::Detach { name } = &control {
                // Another tab still wants this session's output.
                if inner.clients.iter().any(|c| c.open.as_deref() == Some(name.as_str())) {
                    continue;
                }
            }
            Self::write_daemon(&mut inner, &Frame::Control(control));
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
                let msg = Out::Binary(Arc::new(bytes));
                Self::queue(&mut inner, |c| c.open.as_deref() == Some(session.as_str()), msg);
            }
            Frame::Control(ControlMsg::Sessions { sessions }) => {
                // Unchanged is the common case for the geometry poll — don't
                // churn every browser with an identical push.
                if inner.sessions == sessions {
                    return;
                }
                inner.sessions = sessions;
                let msg = Self::sessions_msg(&inner.sessions);
                Self::queue(&mut inner, |_| true, msg);
            }
            Frame::Control(ControlMsg::SessionsChanged { added, removed }) => {
                inner.sessions.retain(|s| {
                    !removed.contains(&s.name) && !added.iter().any(|a| a.name == s.name)
                });
                inner.sessions.extend(added);
                let msg = Self::sessions_msg(&inner.sessions);
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
            // Activity / MemoryStat / acks: nothing the phone UI needs.
            _ => {}
        }
    }

    fn read_loop(&self, mut stream: UnixStream) {
        let mut decoder = Decoder::new();
        let mut buf = [0u8; 65536];
        loop {
            let n = match stream.read(&mut buf) {
                Ok(0) | Err(_) => return,
                Ok(n) => n,
            };
            decoder.feed(&buf[..n]);
            loop {
                match decoder.next_frame() {
                    Ok(Some(frame)) => self.on_frame(frame),
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
        match UnixStream::connect(&hub.socket) {
            Ok(stream) => {
                backoff = RECONNECT_MIN;
                let _ = stream.set_write_timeout(Some(DAEMON_WRITE_TIMEOUT));
                let Ok(read_half) = stream.try_clone() else { continue };
                {
                    let mut inner = hub.inner.lock().unwrap();
                    inner.daemon = Some(stream);
                    Hub::write_daemon(&mut inner, &Frame::Control(ControlMsg::WatchSessions));
                    let mut reattach: Vec<String> =
                        inner.clients.iter().filter_map(|c| c.open.clone()).collect();
                    reattach.sort();
                    reattach.dedup();
                    for name in reattach {
                        Hub::write_daemon(
                            &mut inner,
                            &Frame::Control(ControlMsg::Attach { name, raw_client: false }),
                        );
                    }
                }
                hub.read_loop(read_half);
                let mut inner = hub.inner.lock().unwrap();
                inner.daemon = None;
                inner.sessions.clear();
                let sessions = Hub::sessions_msg(&[]);
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
/// socket; `token` is the shared secret from `<state>/web-token`.
pub fn serve(listener: TcpListener, daemon_socket: PathBuf, token: String) -> anyhow::Result<()> {
    let hub = Hub::new(daemon_socket);
    {
        let hub = Arc::clone(&hub);
        thread::spawn(move || run_daemon_link(hub));
    }
    // Geometry poll. `SessionInfo.cols/rows` is the pty's live winsize, and the
    // phone must render at it (spec §4 — it may never resize). A `Resize` from
    // the desktop app broadcasts NO SessionsChanged, so the cache would go
    // stale and the phone would paint an alt-screen TUI onto the wrong grid.
    // A 1 s `ListSessionsDetailed` (one tiny control frame) refreshes it; the
    // reply only reaches browsers when the set actually changed.
    // ponytail: polling here, not a new daemon broadcast — a divider drag emits
    // resizes far faster than the bounded watcher queue should carry.
    {
        let hub = Arc::clone(&hub);
        thread::spawn(move || loop {
            thread::sleep(GEOMETRY_POLL);
            let mut inner = hub.inner.lock().unwrap();
            if inner.daemon.is_some() {
                Hub::write_daemon(&mut inner, &Frame::Control(ControlMsg::ListSessionsDetailed));
            }
        });
    }
    let auth = Arc::new(Auth::new(token));
    for conn in listener.incoming() {
        let Ok(stream) = conn else { continue };
        let hub = Arc::clone(&hub);
        let auth = Arc::clone(&auth);
        thread::spawn(move || {
            if let Err(e) = handle_conn(stream, &hub, &auth) {
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

fn handle_conn(mut stream: TcpStream, hub: &Arc<Hub>, auth: &Arc<Auth>) -> anyhow::Result<()> {
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
        ("GET", path) => match asset(path) {
            Some((body, ctype)) => Ok(respond(&mut stream, "200 OK", ctype, &[], body)?),
            None => Ok(respond(&mut stream, "404 Not Found", "", &[], b"")?),
        },
        _ => Ok(respond(&mut stream, "405 Method Not Allowed", "", &[], b"")?),
    }
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

    #[test]
    fn parse_browser_msg_accepts_only_open_and_close() {
        assert_eq!(
            parse_browser_msg(r#"{"t":"open","name":"amber-1-1-0-a"}"#),
            Some(BrowserMsg::Open { name: "amber-1-1-0-a".into() })
        );
        assert_eq!(
            parse_browser_msg(r#"{"t":"close","name":"s"}"#),
            Some(BrowserMsg::Close { name: "s".into() })
        );
        for junk in [
            "",
            "not json",
            "[]",
            r#"{"t":"resize","cols":80,"rows":24}"#,
            r#"{"t":"kill","name":"s"}"#,
            r#"{"t":"open"}"#,
            r#"{"t":"open","name":123}"#,
            r#"{"name":"s"}"#,
        ] {
            assert_eq!(parse_browser_msg(junk), None, "must ignore {junk:?}");
        }
    }

    /// Every control message the browser must never be able to cause (spec §5
    /// + §4). This is the single most important invariant in the feature.
    fn is_forbidden(msg: &ControlMsg) -> bool {
        matches!(
            msg,
            ControlMsg::Create { .. }
                | ControlMsg::Kill { .. }
                | ControlMsg::Rename { .. }
                | ControlMsg::Resize { .. }
                | ControlMsg::Suspend { .. }
                | ControlMsg::Resume { .. }
                | ControlMsg::DumpBacklog { .. }
                | ControlMsg::Snapshot
        )
    }

    #[test]
    fn map_browser_msg_attaches_and_detaches_only() {
        let live = vec!["s".to_string(), "t".to_string()];
        // open with nothing open -> just Attach.
        assert_eq!(
            map_browser_msg(&BrowserMsg::Open { name: "s".into() }, None, &live),
            vec![ControlMsg::Attach { name: "s".into(), raw_client: false }]
        );
        // open while another is open -> switch (Detach old, Attach new).
        assert_eq!(
            map_browser_msg(&BrowserMsg::Open { name: "t".into() }, Some("s"), &live),
            vec![
                ControlMsg::Detach { name: "s".into() },
                ControlMsg::Attach { name: "t".into(), raw_client: false },
            ]
        );
        // re-open the same session -> no churn.
        assert_eq!(
            map_browser_msg(&BrowserMsg::Open { name: "s".into() }, Some("s"), &live),
            vec![ControlMsg::Attach { name: "s".into(), raw_client: false }]
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
        let live = vec!["s".to_string()];
        assert!(map_browser_msg(&BrowserMsg::Open { name: "ghost".into() }, None, &live).is_empty());
        assert!(map_browser_msg(&BrowserMsg::Close { name: "ghost".into() }, None, &live)
            .is_empty());
    }

    #[test]
    fn no_browser_input_can_reach_a_forbidden_control_message() {
        // Exhaustive over the parseable surface: every JSON the browser could
        // send, crossed with every open-state and live-set, must never produce
        // Resize/Create/Kill/Rename/Suspend/Resume/DumpBacklog/Snapshot.
        let live = ["s".to_string(), "t".to_string()];
        let texts = [
            r#"{"t":"open","name":"s"}"#,
            r#"{"t":"open","name":"ghost"}"#,
            r#"{"t":"close","name":"s"}"#,
            r#"{"t":"close","name":"ghost"}"#,
            r#"{"t":"resize","name":"s","cols":80,"rows":24}"#,
            r#"{"t":"kill","name":"s"}"#,
            r#"{"t":"create","name":"s","cwd":"/tmp","kind":"shell"}"#,
            r#"{"t":"rename","from":"s","to":"t"}"#,
            r#"{"t":"suspend","name":"s"}"#,
            r#"{"t":"resume","name":"s"}"#,
            r#"{"t":"dumpbacklog","name":"s"}"#,
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
                            matches!(out, ControlMsg::Attach { .. } | ControlMsg::Detach { .. }),
                            "{text:?} produced non-whitelisted {out:?}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn websocket_accept_key_matches_rfc6455() {
        // RFC 6455 §1.3 worked example. Locking it here proves the upgrade
        // handshake this server writes is the one browsers expect.
        let accept = tungstenite::handshake::derive_accept_key(b"dGhlIHNhbXBsZSBub25jZQ==");
        assert_eq!(accept, "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }
}
