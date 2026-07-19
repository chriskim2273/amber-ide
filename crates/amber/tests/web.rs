//! `amber web` end-to-end: HTTP auth surface + WebSocket terminal, against a
//! live private daemon (its own socket + state dir, never the user's).

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::time::{Duration, Instant};

use amber::daemon::{prepare_socket, Daemon};
use amber::manager::SessionManager;
use amber::watchers::Watchers;
use amber::web;
use amber_core::proto::{self, ControlMsg, Frame};

struct Fixture {
    dir: tempfile::TempDir,
    sock: std::path::PathBuf,
    addr: std::net::SocketAddr,
    token: String,
}

/// Boot a private daemon + an `amber web` bound to an ephemeral port.
fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("amberd.sock");
    let manager = Arc::new(SessionManager::new(dir.path()).unwrap());
    let watchers = Arc::new(Watchers::new());
    let listener = prepare_socket(&sock).unwrap();
    let daemon = Daemon::new(Arc::clone(&manager), Arc::clone(&watchers));
    std::thread::spawn(move || {
        let _ = daemon.serve(listener);
    });

    let token = web::load_or_create_token(dir.path(), true).unwrap();
    let tcp = web::bind(0).unwrap();
    let addr = tcp.local_addr().unwrap();
    {
        let sock = sock.clone();
        let token = token.clone();
        std::thread::spawn(move || {
            let _ = web::serve(tcp, sock, token);
        });
    }
    Fixture { dir, sock, addr, token }
}

impl Fixture {
    /// Send a raw request; return (status line, headers, body).
    fn request(&self, req: &str) -> (String, Vec<String>, String) {
        let mut s = TcpStream::connect(self.addr).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        s.write_all(req.as_bytes()).unwrap();
        let mut r = BufReader::new(s);
        let mut status = String::new();
        r.read_line(&mut status).unwrap();
        let mut headers = Vec::new();
        let mut len = 0usize;
        loop {
            let mut line = String::new();
            r.read_line(&mut line).unwrap();
            let line = line.trim_end().to_string();
            if line.is_empty() {
                break;
            }
            if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                len = v.trim().parse().unwrap();
            }
            headers.push(line);
        }
        let mut body = vec![0u8; len];
        r.read_exact(&mut body).unwrap();
        (status.trim_end().to_string(), headers, String::from_utf8_lossy(&body).into_owned())
    }

    fn get(&self, path: &str, cookie: Option<&str>) -> (String, Vec<String>, String) {
        let c = cookie.map(|c| format!("Cookie: {c}\r\n")).unwrap_or_default();
        self.request(&format!(
            "GET {path} HTTP/1.1\r\nHost: {}\r\n{c}Connection: close\r\n\r\n",
            self.addr
        ))
    }

    fn post_auth(&self, token: &str) -> (String, Vec<String>, String) {
        self.request(&format!(
            "POST /api/auth HTTP/1.1\r\nHost: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{token}",
            self.addr,
            token.len()
        ))
    }

    /// Authenticate and return the `amber_web=<id>` cookie pair.
    fn login(&self) -> String {
        let (status, headers, _) = self.post_auth(&self.token);
        assert!(status.contains("204"), "auth failed: {status}");
        headers
            .iter()
            .find_map(|h| {
                let v = h.strip_prefix("Set-Cookie: ")?;
                Some(v.split(';').next().unwrap().to_string())
            })
            .expect("no Set-Cookie")
    }

    /// Create a session on the private daemon and return its name.
    fn create_session(&self) -> String {
        let name = "amber-1-1-0-web".to_string();
        let mut s = UnixStream::connect(&self.sock).unwrap();
        s.write_all(&proto::encode(&Frame::Control(ControlMsg::Create {
            name: name.clone(),
            cwd: self.dir.path().to_string_lossy().into_owned(),
            kind: "shell".into(),
        })))
        .unwrap();
        let mut dec = proto::Decoder::new();
        let mut buf = [0u8; 8192];
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        loop {
            if let Some(Frame::Control(ControlMsg::Created { .. })) = dec.next_frame().unwrap() {
                return name;
            }
            let n = s.read(&mut buf).unwrap();
            assert!(n > 0);
            dec.feed(&buf[..n]);
        }
    }
}

fn wait_until(bound: Duration, mut cond: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + bound;
    while Instant::now() < deadline {
        if cond() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

#[test]
fn unauthenticated_data_routes_and_ws_are_refused() {
    let f = fixture();
    let (status, _, _) = f.get("/api/sessions", None);
    assert!(status.contains("401"), "expected 401, got {status}");
    let (status, _, _) = f.get("/api/sessions", Some("amber_web=forged"));
    assert!(status.contains("401"), "forged cookie accepted: {status}");
    // The WebSocket upgrade is gated the same way (no cookie -> no 101).
    let (status, _, _) = f.request(&format!(
        "GET /ws HTTP/1.1\r\nHost: {}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        f.addr
    ));
    assert!(status.contains("401"), "unauthenticated upgrade accepted: {status}");
}

#[test]
fn static_assets_are_public_so_the_page_can_exchange_its_token() {
    // The QR carries the token in the URL FRAGMENT, which the browser never
    // sends; only JS on the served page can read it and POST it. So the page
    // and its assets must load without a cookie (they hold no secrets).
    let f = fixture();
    for path in ["/", "/app.js", "/style.css", "/xterm.js", "/xterm.css"] {
        let (status, _, _) = f.get(path, None);
        assert!(status.contains("200"), "{path} -> {status}");
    }
    let (status, _, _) = f.get("/nope", None);
    assert!(status.contains("404"), "{status}");
}

#[test]
fn bad_token_is_refused_then_throttled() {
    let f = fixture();
    let (status, _, _) = f.post_auth("wrong-token");
    assert!(status.contains("401"), "bad token accepted: {status}");
    // Brute force is throttled: after the bounded number of failures the
    // endpoint stops answering attempts at all.
    let mut saw_429 = false;
    for _ in 0..web::AUTH_MAX_FAILS + 2 {
        let (status, _, _) = f.post_auth("wrong-token");
        if status.contains("429") {
            saw_429 = true;
            break;
        }
    }
    assert!(saw_429, "failed auth attempts are not throttled");
    // Even the RIGHT token is refused while throttled (no bypass).
    let (status, _, _) = f.post_auth(&f.token);
    assert!(status.contains("429"), "throttle bypassed by a good token: {status}");
}

#[test]
fn good_token_yields_a_cookie_that_lists_daemon_sessions_with_real_geometry() {
    let f = fixture();
    let name = f.create_session();
    let cookie = f.login();
    assert!(cookie.starts_with("amber_web="), "{cookie}");

    let mut body = String::new();
    let listed = wait_until(Duration::from_secs(10), || {
        let (status, _, b) = f.get("/api/sessions", Some(&cookie));
        body = b;
        status.contains("200") && body.contains(&name)
    });
    assert!(listed, "session {name} never listed: {body}");
    assert!(body.contains("\"kind\":\"shell\""), "{body}");
    assert!(body.contains("\"alive\":true"), "{body}");

    // The phone renders AT the pty's real geometry and never resizes it
    // (spec §4), so the listing must report the live winsize, not a guess.
    let geometry = |body: &str| -> (u64, u64) {
        let v: serde_json::Value = serde_json::from_str(body).unwrap();
        let s = &v.as_array().unwrap()[0];
        (s["cols"].as_u64().unwrap(), s["rows"].as_u64().unwrap())
    };
    let (cols, rows) = geometry(&body);
    assert!(cols > 0 && rows > 0, "no pty geometry reported: {body}");

    // ...and it must TRACK a daemon-side resize (the desktop app moving a
    // divider), not report a stale snapshot.
    let s = UnixStream::connect(&f.sock).unwrap();
    (&s).write_all(&proto::encode(&Frame::Control(ControlMsg::Resize {
        name: name.clone(),
        cols: cols as u16 + 17,
        rows: rows as u16 + 3,
    })))
    .unwrap();
    let tracked = wait_until(Duration::from_secs(10), || {
        let (_, _, b) = f.get("/api/sessions", Some(&cookie));
        b.contains(&name) && geometry(&b) == (cols + 17, rows + 3)
    });
    let (_, _, after) = f.get("/api/sessions", Some(&cookie));
    assert!(tracked, "geometry did not track resize: before=({cols},{rows}) after={after}");
}

#[test]
fn websocket_open_and_input_reach_the_pty_and_output_comes_back() {
    let f = fixture();
    let name = f.create_session();
    let cookie = f.login();
    // Wait for the hub to learn the session before opening it.
    assert!(
        wait_until(Duration::from_secs(10), || {
            f.get("/api/sessions", Some(&cookie)).2.contains(&name)
        }),
        "hub never saw the session"
    );

    let stream = TcpStream::connect(f.addr).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(15))).unwrap();
    let uri: tungstenite::http::Uri = format!("ws://{}/ws", f.addr).parse().unwrap();
    let req = tungstenite::ClientRequestBuilder::new(uri).with_header("Cookie", cookie);
    let (mut ws, _) = tungstenite::client::client(req, stream).unwrap();

    // Control is JSON text; terminal bytes are raw binary frames.
    ws.send(tungstenite::Message::Text(
        format!(r#"{{"t":"open","name":"{name}"}}"#).into(),
    ))
    .unwrap();
    ws.send(tungstenite::Message::Binary(
        b"echo amber-web-marker\n".to_vec().into(),
    ))
    .unwrap();

    let deadline = Instant::now() + Duration::from_secs(20);
    let mut seen = Vec::new();
    let mut got_sessions_json = false;
    while Instant::now() < deadline {
        match ws.read() {
            Ok(tungstenite::Message::Binary(b)) => {
                seen.extend_from_slice(&b);
                if String::from_utf8_lossy(&seen).contains("amber-web-marker") {
                    break;
                }
            }
            Ok(tungstenite::Message::Text(t)) => {
                if t.contains("\"t\":\"sessions\"") && t.contains(name.as_str()) {
                    got_sessions_json = true;
                    assert!(t.contains("\"cols\":"), "sessions push lacks geometry: {t}");
                }
            }
            Ok(_) => {}
            Err(e) => panic!("websocket read failed: {e}"),
        }
    }
    let text = String::from_utf8_lossy(&seen).into_owned();
    assert!(got_sessions_json, "no sessions push on the websocket");
    assert!(text.contains("amber-web-marker"), "pty output never returned: {text:?}");
}

#[test]
fn token_file_is_0600_and_stable_until_regenerated() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let a = web::load_or_create_token(dir.path(), false).unwrap();
    let b = web::load_or_create_token(dir.path(), false).unwrap();
    assert_eq!(a, b, "token must persist across runs");
    assert!(a.len() >= 40, "token too short: {a}");
    let meta = std::fs::metadata(dir.path().join("web-token")).unwrap();
    assert_eq!(meta.permissions().mode() & 0o777, 0o600);
    let c = web::load_or_create_token(dir.path(), true).unwrap();
    assert_ne!(a, c, "--new-token must rotate the token");
}

