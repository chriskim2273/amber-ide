//! `amber web` end-to-end: HTTP auth surface + WebSocket terminal, against a
//! live private daemon (its own socket + state dir, never the user's).

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::sync::Arc;
use std::time::{Duration, Instant};

use amber::daemon::{prepare_socket, Daemon};
use amber::manager::SessionManager;
use amber::transport;
use amber::watchers::Watchers;
use amber::web;
use amber_core::proto::{self, ControlMsg, Frame};

struct Fixture {
    dir: tempfile::TempDir,
    sock: std::path::PathBuf,
    addr: std::net::SocketAddr,
    token: String,
    manager: Arc<SessionManager>,
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
    let root = dir.path().to_path_buf();
    {
        let sock = sock.clone();
        let root = root.clone();
        let token = token.clone();
        std::thread::spawn(move || {
            let _ = web::serve(tcp, sock, root, token);
        });
    }
    Fixture { dir, sock, addr, token, manager }
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
        self.get_ex(path, cookie, "")
    }

    fn get_ex(&self, path: &str, cookie: Option<&str>, extra: &str) -> (String, Vec<String>, String) {
        let c = cookie.map(|c| format!("Cookie: {c}\r\n")).unwrap_or_default();
        self.request(&format!(
            "GET {path} HTTP/1.1\r\nHost: {}\r\n{c}{extra}Connection: close\r\n\r\n",
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

    fn post(&self, path: &str, cookie: Option<&str>, body: &str) -> (String, Vec<String>, String) {
        let c = cookie.map(|c| format!("Cookie: {c}\r\n")).unwrap_or_default();
        self.request(&format!(
            "POST {path} HTTP/1.1\r\nHost: {}\r\n{c}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            self.addr,
            body.len()
        ))
    }

    fn put(&self, path: &str, cookie: Option<&str>, body: &str) -> (String, Vec<String>, String) {
        let c = cookie.map(|c| format!("Cookie: {c}\r\n")).unwrap_or_default();
        self.request(&format!(
            "PUT {path} HTTP/1.1\r\nHost: {}\r\n{c}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            self.addr,
            body.len()
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
        self.create_named("amber-1-1-0-web")
    }

    fn create_named(&self, name: &str) -> String {
        let name = name.to_string();
        let mut s = transport::connect(&self.sock).unwrap();
        s.write_all(&proto::encode(&Frame::Control(ControlMsg::Create {
            name: name.clone(),
            cwd: self.dir.path().to_string_lossy().into_owned(),
            kind: "shell".into(),
        })))
        .unwrap();
        let mut dec = proto::Decoder::new();
        let mut buf = [0u8; 8192];
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(Frame::Control(ControlMsg::Created { .. })) = dec.next_frame().unwrap() {
                return name;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "timed out waiting for Created");
            let n = s.read_with_timeout(&mut buf, remaining).unwrap();
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
    // /api/bootstrap (homeDir for the real-renderer web build) is gated the
    // same way as /api/sessions — the token now reaches a much larger API
    // (spec §5), and this is the one new route this pass added.
    let (status, _, _) = f.get("/api/bootstrap", None);
    assert!(status.contains("401"), "bootstrap leaked without a cookie: {status}");
    let (status, _, _) = f.get("/api/bootstrap", Some("amber_web=forged"));
    assert!(status.contains("401"), "bootstrap accepted a forged cookie: {status}");
    // The WebSocket upgrade is gated the same way (no cookie -> no 101).
    let (status, _, _) = f.request(&format!(
        "GET /ws HTTP/1.1\r\nHost: {}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        f.addr
    ));
    assert!(status.contains("401"), "unauthenticated upgrade accepted: {status}");
}

const SERVE_HOP: &str = "X-Forwarded-Proto: https\r\n\
X-Forwarded-Host: teapot-dev.tail3d57b4.ts.net\r\n\
Tailscale-User-Login: alice@github\r\n";

#[test]
fn tailscale_serve_identity_skips_the_fragment_token() {
    let f = fixture();
    let (status, _, body) = f.get_ex("/api/sessions", None, SERVE_HOP);
    assert!(status.contains("200"), "Serve hop should be logged in: {status} {body}");
    assert!(body.contains("sessions"), "{body}");

    let (status, _, _) = f.get_ex("/api/bootstrap", None, SERVE_HOP);
    assert!(status.contains("200"), "bootstrap over Serve: {status}");

    let (status, _, _) = f.request(&format!(
        "GET /ws HTTP/1.1\r\nHost: {}\r\n{SERVE_HOP}Upgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        f.addr
    ));
    assert!(status.contains("101"), "Serve hop WS upgrade refused: {status}");
}

#[test]
fn funnel_and_spoofed_serve_headers_still_need_the_token() {
    let f = fixture();
    // Funnel: HTTPS + ts.net host, no identity header.
    let (status, _, _) = f.get_ex(
        "/api/sessions",
        None,
        "X-Forwarded-Proto: https\r\nX-Forwarded-Host: teapot-dev.tail3d57b4.ts.net\r\n",
    );
    assert!(status.contains("401"), "Funnel must not skip the token: {status}");

    // Identity header but not HTTPS (LAN / http).
    let (status, _, _) = f.get_ex(
        "/api/sessions",
        None,
        "X-Forwarded-Proto: http\r\nX-Forwarded-Host: teapot-dev.tail3d57b4.ts.net\r\n\
         Tailscale-User-Login: alice@github\r\n",
    );
    assert!(status.contains("401"), "http forwarded proto accepted: {status}");

    // Identity header but host is not a tailnet MagicDNS name.
    let (status, _, _) = f.get_ex(
        "/api/sessions",
        None,
        "X-Forwarded-Proto: https\r\nX-Forwarded-Host: evil.example\r\n\
         Tailscale-User-Login: alice@github\r\n",
    );
    assert!(status.contains("401"), "non-ts.net host accepted: {status}");
}

#[test]
fn static_assets_are_public_so_the_page_can_exchange_its_token() {
    // The QR carries the token in the URL FRAGMENT, which the browser never
    // sends; only JS on the served page can read it and POST it. So the page
    // and its assets must load without a cookie (they hold no secrets).
    let f = fixture();
    for path in [
        "/",
        "/app.js",
        "/style.css",
        "/xterm.js",
        "/xterm-unicode-graphemes.js",
        "/xterm.css",
    ] {
        let (status, _, _) = f.get(path, None);
        assert!(status.contains("200"), "{path} -> {status}");
    }
    let (status, _, _) = f.get("/nope", None);
    assert!(status.contains("404"), "{status}");
}

#[test]
fn legacy_web_installs_unicode_graphemes_before_rendering() {
    let f = fixture();
    let (_, _, index) = f.get("/", None);
    let xterm = index.find("/xterm.js").expect("xterm script");
    let unicode = index
        .find("/xterm-unicode-graphemes.js")
        .expect("unicode grapheme script");
    let app = index.find("/app.js").expect("app script");
    assert!(
        xterm < unicode && unicode < app,
        "scripts loaded out of order"
    );

    let (_, _, app_js) = f.get("/app.js", None);
    assert!(app_js.contains("allowProposedApi: true"));
    assert!(app_js.contains("new window.UnicodeGraphemesAddon.UnicodeGraphemesAddon()"));
}

#[test]
fn bootstrap_carries_a_non_empty_home_behind_the_cookie() {
    let f = fixture();
    let cookie = f.login();
    let (status, _, body) = f.get("/api/bootstrap", Some(&cookie));
    assert!(status.contains("200"), "{status}");
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    let home = v["home"].as_str().unwrap_or("");
    // A boot-managed `amber web` can start with a minimal/empty env (the
    // 2026-07-29 display-env lesson: this repo has been bitten by exactly
    // this class of gap before). `main.tsx`'s `homeDir` fallback is `?? '/'`,
    // which does NOT rescue an empty string (only null/undefined) — so an
    // empty `home` here would silently become `cwd: ""` and every `+ Pane`
    // would 404 out of `map_browser_msg`'s `Path::new(cwd).is_dir()` gate
    // with no visible error (the "wrong shape looks like a dead button"
    // failure this whole task exists to avoid).
    assert!(!home.is_empty(), "bootstrap must never serve an empty home: {body}");
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
        let s = &v["sessions"].as_array().unwrap()[0];
        (s["cols"].as_u64().unwrap(), s["rows"].as_u64().unwrap())
    };
    let (cols, rows) = geometry(&body);
    assert!(cols > 0 && rows > 0, "no pty geometry reported: {body}");

    // ...and it must TRACK a daemon-side resize (the desktop app moving a
    // divider), not report a stale snapshot.
    let mut s = transport::connect(&f.sock).unwrap();
    s.write_all(&proto::encode(&Frame::Control(ControlMsg::Resize {
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
    #[cfg(windows)]
    let command = b"echo amber-web-marker\r\n";
    #[cfg(not(windows))]
    let command = b"echo amber-web-marker\n";
    ws.send(tungstenite::Message::Binary(command.to_vec().into()))
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
fn websocket_focus_refreshes_a_live_session() {
    let f = fixture();
    let name = f.create_session();
    let cookie = f.login();
    assert!(wait_until(Duration::from_secs(10), || {
        f.get("/api/sessions", Some(&cookie)).2.contains(&name)
    }));
    let session = f.manager.session(&name).unwrap();
    let before = session.last_used_ms();
    std::thread::sleep(Duration::from_millis(2));

    let mut ws = ws_connect(&f, &cookie);
    ws.send(tungstenite::Message::Text(
        format!(r#"{{"t":"focus","name":"{name}"}}"#).into(),
    ))
    .unwrap();

    assert!(
        wait_until(Duration::from_secs(5), || session.last_used_ms() > before),
        "browser focus never refreshed the live session"
    );
}

#[test]
fn token_file_is_private_and_stable_until_regenerated() {
    let dir = tempfile::tempdir().unwrap();
    let a = web::load_or_create_token(dir.path(), false).unwrap();
    let b = web::load_or_create_token(dir.path(), false).unwrap();
    assert_eq!(a, b, "token must persist across runs");
    assert!(a.len() >= 40, "token too short: {a}");
    let path = dir.path().join("web-token");
    assert!(amber::platform::is_user_private(&path).unwrap());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let meta = std::fs::metadata(&path).unwrap();
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);
    }
    let c = web::load_or_create_token(dir.path(), true).unwrap();
    assert_ne!(a, c, "--new-token must rotate the token");
}

#[cfg(windows)]
#[test]
fn concurrent_token_creation_returns_the_single_established_token() {
    use std::sync::{Arc, Barrier};

    let dir = tempfile::tempdir().unwrap();
    let root = Arc::new(dir.path().to_path_buf());
    let start = Arc::new(Barrier::new(2));
    let mut workers = Vec::new();
    for _ in 0..2 {
        let root = Arc::clone(&root);
        let start = Arc::clone(&start);
        workers.push(std::thread::spawn(move || {
            start.wait();
            web::load_or_create_token(&root, false).unwrap()
        }));
    }
    let first = workers.pop().unwrap().join().unwrap();
    let second = workers.pop().unwrap().join().unwrap();
    assert_eq!(first, second, "a loser must load, never overwrite, the winner token");
    assert_eq!(web::load_or_create_token(&root, false).unwrap(), first);
}

#[test]
fn sessions_response_carries_the_mosaic_and_the_slot() {
    let f = fixture();
    let name = f.create_session();
    let cookie = f.login();

    std::fs::write(
        f.dir.path().join("ui-layout.json"),
        format!(
            r#"{{"version":1,"activeWorkspace":1,"workspaces":{{"1":{{"activeTab":1,"label":"main","tabs":{{
               "1":{{"label":"api","tree":{{"kind":"split","dir":"h","ratio":0.7,
                 "a":{{"kind":"leaf","paneId":"{name}"}},
                 "b":{{"kind":"leaf","paneId":"editor-1-1-1-zz"}}}}}}}}}}}}}}"#
        ),
    )
    .unwrap();

    let mut body = String::new();
    let ok = wait_until(Duration::from_secs(10), || {
        let (status, _, b) = f.get("/api/sessions", Some(&cookie));
        body = b;
        if !status.contains("200") {
            return false;
        }
        let v: serde_json::Value = match serde_json::from_str(&body) {
            Ok(v) => v,
            Err(_) => return false,
        };
        // "kind"=="leaf" alone is also produced by the transient fallback
        // render (the sidecar not loaded yet, session appended as a bare
        // leaf) — checking the label too, which only the real sidecar
        // carries, is what actually proves the mosaic loaded and pruned.
        v["layout"]["workspaces"][0]["label"] == "main"
            && v["layout"]["workspaces"][0]["tabs"][0]["tree"]["kind"] == "leaf"
    });
    assert!(ok, "mosaic never appeared / editor leaf never pruned: {body}");

    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(v["sessions"].is_array(), "{body}");
    assert_eq!(v["layout"]["workspaces"][0]["tabs"][0]["tree"]["paneId"], name.as_str());
    assert_eq!(v["layout"]["workspaces"][0]["label"], "main");
    assert_eq!(v["layout"]["workspaces"][0]["tabs"][0]["label"], "api");
    assert!(
        v["sessions"][0]["slot"].as_u64().is_some(),
        "sessions listing has no slot: {body}"
    );
}

#[test]
fn a_sidecar_only_change_still_reaches_the_browser() {
    let f = fixture();
    let a = f.create_named("amber-1-1-0-aa");
    let b = f.create_named("amber-1-1-1-bb");
    let cookie = f.login();
    let write_layout = |ratio: &str| {
        std::fs::write(
            f.dir.path().join("ui-layout.json"),
            format!(
                r#"{{"version":1,"activeWorkspace":1,"workspaces":{{"1":{{"activeTab":1,"tabs":{{
                   "1":{{"tree":{{"kind":"split","dir":"h","ratio":{ratio},
                     "a":{{"kind":"leaf","paneId":"{a}"}},
                     "b":{{"kind":"leaf","paneId":"{b}"}}}}}}}}}}}}}}"#
            ),
        )
        .unwrap();
    };
    let served_ratio = |body: &str| -> Option<f64> {
        let v: serde_json::Value = serde_json::from_str(body).ok()?;
        v["layout"]["workspaces"][0]["tabs"][0]["tree"]["ratio"].as_f64()
    };

    write_layout("0.3");
    assert!(
        wait_until(Duration::from_secs(10), || {
            served_ratio(&f.get("/api/sessions", Some(&cookie)).2)
                .is_some_and(|r| (r - 0.3).abs() < 1e-6)
        }),
        "first layout never served"
    );

    let stream = TcpStream::connect(f.addr).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(15))).unwrap();
    let uri: tungstenite::http::Uri = format!("ws://{}/ws", f.addr).parse().unwrap();
    let req = tungstenite::ClientRequestBuilder::new(uri).with_header("Cookie", cookie.clone());
    let (mut ws, _) = tungstenite::client::client(req, stream).unwrap();

    write_layout("0.8");

    let deadline = Instant::now() + Duration::from_secs(20);
    let mut saw = false;
    while Instant::now() < deadline && !saw {
        if let Ok(tungstenite::Message::Text(t)) = ws.read() {
            if t.contains("\"t\":\"sessions\"") {
                let v: serde_json::Value = serde_json::from_str(&t).unwrap();
                if v["layout"]["workspaces"][0]["tabs"][0]["tree"]["ratio"]
                    .as_f64()
                    .is_some_and(|r| (r - 0.8).abs() < 1e-6)
                {
                    saw = true;
                }
            }
        }
    }
    assert!(saw, "a sidecar-only change never pushed to the browser");
}

#[test]
fn the_mosaic_is_behind_the_cookie_boundary() {
    let f = fixture();
    let (status, _, body) = f.get("/api/sessions", None);
    assert!(status.contains("401"), "{status}");
    assert!(!body.contains("layout"), "layout leaked to an unauthenticated caller: {body}");
    let (status, _, body) = f.get("/api/sessions", Some("amber_web=forged"));
    assert!(status.contains("401"), "{status}");
    assert!(!body.contains("layout"), "layout leaked to a forged cookie: {body}");
}

/// Open a `/ws` connection with `cookie` already attached (the WebSocket
/// upgrade requires the auth cookie, same as every other data route).
fn ws_connect(f: &Fixture, cookie: &str) -> tungstenite::WebSocket<TcpStream> {
    let stream = TcpStream::connect(f.addr).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let uri: tungstenite::http::Uri = format!("ws://{}/ws", f.addr).parse().unwrap();
    let req = tungstenite::ClientRequestBuilder::new(uri).with_header("Cookie", cookie.to_string());
    tungstenite::client::client(req, stream).unwrap().0
}

#[test]
fn a_valid_browser_resize_reaches_the_pty_within_bounds() {
    // 2026-08-01 decision: the browser may now resize its own pty (reversing
    // the earlier "never resize" rule) — validated at `map_browser_msg`.
    let f = fixture();
    let name = f.create_session();
    let cookie = f.login();
    assert!(
        wait_until(Duration::from_secs(10), || {
            f.get("/api/sessions", Some(&cookie)).2.contains(&name)
        }),
        "hub never saw the session"
    );
    let before: serde_json::Value =
        serde_json::from_str(&f.get("/api/sessions", Some(&cookie)).2).unwrap();
    let (cols, rows) = (
        before["sessions"][0]["cols"].as_u64().unwrap(),
        before["sessions"][0]["rows"].as_u64().unwrap(),
    );
    let (new_cols, new_rows) = (cols + 17, rows + 3);

    let mut ws = ws_connect(&f, &cookie);
    ws.send(tungstenite::Message::Text(
        format!(r#"{{"t":"resize","name":"{name}","cols":{new_cols},"rows":{new_rows}}}"#).into(),
    ))
    .unwrap();

    let resized = wait_until(Duration::from_secs(10), || {
        let (_, _, b) = f.get("/api/sessions", Some(&cookie));
        let v: serde_json::Value = serde_json::from_str(&b).unwrap();
        v["sessions"][0]["cols"].as_u64() == Some(new_cols)
            && v["sessions"][0]["rows"].as_u64() == Some(new_rows)
    });
    assert!(resized, "a valid in-bounds browser resize never reached the pty");
    let after: serde_json::Value =
        serde_json::from_str(&f.get("/api/sessions", Some(&cookie)).2).unwrap();
    assert_eq!(after["sessions"][0]["alive"], true, "session died");
}

#[test]
fn an_out_of_bounds_browser_resize_is_rejected() {
    // A browser window crushed to nothing must not be able to shrink the pty
    // to something degenerate (1x1 SIGWINCHes every full-screen program into
    // repainting garbage, and corrupts the desktop's layout on return).
    let f = fixture();
    let name = f.create_session();
    let cookie = f.login();
    assert!(
        wait_until(Duration::from_secs(10), || {
            f.get("/api/sessions", Some(&cookie)).2.contains(&name)
        }),
        "hub never saw the session"
    );
    let before: serde_json::Value =
        serde_json::from_str(&f.get("/api/sessions", Some(&cookie)).2).unwrap();
    let (cols, rows) = (
        before["sessions"][0]["cols"].as_u64().unwrap(),
        before["sessions"][0]["rows"].as_u64().unwrap(),
    );

    let mut ws = ws_connect(&f, &cookie);
    ws.send(tungstenite::Message::Text(
        format!(r#"{{"t":"resize","name":"{name}","cols":1,"rows":1}}"#).into(),
    ))
    .unwrap();
    // Give the server more than a poll tick to act on it if it were going to.
    std::thread::sleep(Duration::from_secs(3));

    let after: serde_json::Value =
        serde_json::from_str(&f.get("/api/sessions", Some(&cookie)).2).unwrap();
    assert_eq!(after["sessions"][0]["cols"].as_u64().unwrap(), cols, "pty was resized out of bounds");
    assert_eq!(after["sessions"][0]["rows"].as_u64().unwrap(), rows, "pty was resized out of bounds");
    assert_eq!(after["sessions"][0]["alive"], true, "session died");
}

// ---- layout CAS (spec 2026-08-01 §6) ---------------------------------------

#[test]
fn layout_routes_are_behind_the_same_cookie_boundary_as_sessions() {
    let f = fixture();
    let (status, _, _) = f.get("/api/layout", None);
    assert!(status.contains("401"), "{status}");
    let (status, _, _) = f.get("/api/layout", Some("amber_web=forged"));
    assert!(status.contains("401"), "{status}");
    let (status, _, _) = f.post("/api/layout", None, r#"{"text":"{}","version":null}"#);
    assert!(status.contains("401"), "{status}");
}

#[test]
fn layout_load_reports_null_then_a_real_version_after_a_save() {
    let f = fixture();
    let cookie = f.login();
    let (status, _, body) = f.get("/api/layout", Some(&cookie));
    assert!(status.contains("200"), "{status}");
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(v["text"].is_null(), "expected no sidecar yet: {body}");
    assert!(v["version"].is_null(), "{body}");

    let (status, _, body) = f.post("/api/layout", Some(&cookie), r#"{"text":"{\"v\":1}","version":null}"#);
    assert!(status.contains("200"), "{status}: {body}");
    let saved: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(saved["ok"], true);
    assert_eq!(saved["version"], "{\"v\":1}");

    let (_, _, body) = f.get("/api/layout", Some(&cookie));
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["text"], "{\"v\":1}");
    assert_eq!(v["version"], "{\"v\":1}");
}

#[test]
fn layout_save_rejects_a_stale_version_and_returns_409_with_fresh_content() {
    let f = fixture();
    let cookie = f.login();
    f.post("/api/layout", Some(&cookie), r#"{"text":"v1","version":null}"#);
    // Still claims the file didn't exist — stale relative to the write above.
    let (status, _, body) = f.post("/api/layout", Some(&cookie), r#"{"text":"stale","version":null}"#);
    assert!(status.contains("409"), "{status}: {body}");
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["conflict"], true);
    assert_eq!(v["text"], "v1");
    assert_eq!(v["version"], "v1");
}

/// The genuine interleaving over HTTP: two independent GETs of the same
/// version, then a write from each — the second (now stale) must be
/// rejected without clobbering the first writer's content, exactly the
/// desktop-vs-browser race spec §6 exists to fix.
#[test]
fn a_stale_http_writer_is_rejected_after_a_concurrent_write_lands() {
    let f = fixture();
    let cookie = f.login();
    f.post("/api/layout", Some(&cookie), r#"{"text":"v0","version":null}"#);

    let (_, _, body_a) = f.get("/api/layout", Some(&cookie));
    let (_, _, body_b) = f.get("/api/layout", Some(&cookie));
    assert_eq!(body_a, body_b, "two independent reads of the same state must agree");
    let version_a: serde_json::Value = serde_json::from_str(&body_a).unwrap();
    let version_b: serde_json::Value = serde_json::from_str(&body_b).unwrap();

    let (status_b, _, resp_b) = f.post(
        "/api/layout",
        Some(&cookie),
        &format!(r#"{{"text":"v1-from-b","version":{}}}"#, version_b["version"]),
    );
    assert!(status_b.contains("200"), "b's write should succeed: {resp_b}");

    // A's version is now stale — the file moved out from under it.
    let (status_a, _, resp_a) = f.post(
        "/api/layout",
        Some(&cookie),
        &format!(r#"{{"text":"v1-from-a","version":{}}}"#, version_a["version"]),
    );
    assert!(status_a.contains("409"), "a's stale write should be rejected: {resp_a}");
    let v: serde_json::Value = serde_json::from_str(&resp_a).unwrap();
    assert_eq!(v["text"], "v1-from-b", "conflict must report what's really on disk");

    // B's write must be the one that landed — A's content must never appear.
    let (_, _, body) = f.get("/api/layout", Some(&cookie));
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["text"], "v1-from-b");
}

#[test]
fn create_and_kill_from_the_browser_reach_the_daemon() {
    let f = fixture();
    let existing = f.create_session();
    let cookie = f.login();
    assert!(
        wait_until(Duration::from_secs(10), || {
            f.get("/api/sessions", Some(&cookie)).2.contains(&existing)
        }),
        "hub never saw the session"
    );

    let stream = TcpStream::connect(f.addr).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let uri: tungstenite::http::Uri = format!("ws://{}/ws", f.addr).parse().unwrap();
    let req = tungstenite::ClientRequestBuilder::new(uri).with_header("Cookie", cookie.clone());
    let (mut ws, _) = tungstenite::client::client(req, stream).unwrap();

    let made = "amber-1-1-9-webmade";
    let cwd = f.dir.path().to_string_lossy().into_owned();
    ws.send(tungstenite::Message::Text(
        serde_json::json!({
            "t": "create",
            "name": made,
            "cwd": cwd,
            "kind": "shell",
        })
        .to_string()
        .into(),
    ))
    .unwrap();
    assert!(
        wait_until(Duration::from_secs(15), || {
            f.get("/api/sessions", Some(&cookie)).2.contains(made)
        }),
        "browser Create never reached the daemon"
    );

    ws.send(tungstenite::Message::Text(
        format!(r#"{{"t":"kill","name":"{made}"}}"#).into(),
    ))
    .unwrap();
    assert!(
        wait_until(Duration::from_secs(15), || {
            let body = f.get("/api/sessions", Some(&cookie)).2;
            let v: serde_json::Value = serde_json::from_str(&body).unwrap();
            v["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .all(|s| s["name"] != made || s["alive"] == false)
        }),
        "browser Kill never reached the daemon"
    );
}

fn assert_router_unauth(f: &Fixture, method: &str, path: &str, body: &str) {
    let (status, _, response) = match method {
        "GET" => f.get(path, None),
        "POST" => f.post(path, None, body),
        "PUT" => f.put(path, None, body),
        other => panic!("unsupported {other}"),
    };
    assert!(status.contains("401"), "{method} {path} no cookie: {status}");
    assert!(
        !response.to_ascii_lowercase().contains("api_key"),
        "{method} {path} leaked a key without a cookie: {response}"
    );

    let (status, _, response) = match method {
        "GET" => f.get(path, Some("amber_web=forged")),
        "POST" => f.post(path, Some("amber_web=forged"), body),
        "PUT" => f.put(path, Some("amber_web=forged"), body),
        other => panic!("unsupported {other}"),
    };
    assert!(status.contains("401"), "{method} {path} forged cookie: {status}");
    assert!(
        !response.to_ascii_lowercase().contains("api_key"),
        "{method} {path} leaked a key to a forged cookie: {response}"
    );
}

#[test]
fn router_control_is_behind_the_cookie_boundary() {
    let f = fixture();
    assert_router_unauth(&f, "GET", "/api/router/status", "");
    assert_router_unauth(&f, "GET", "/api/router/slots", "");
    assert_router_unauth(&f, "GET", "/api/router/key?name=alpha", "");
    assert_router_unauth(&f, "GET", "/api/router/log", "");
    assert_router_unauth(&f, "POST", "/api/router/action", r#"{"action":"start"}"#);
    assert_router_unauth(&f, "PUT", "/api/router/slots", r#"{"slots":[]}"#);
}

#[test]
fn router_status_is_managed_and_carries_no_secrets() {
    let f = fixture();
    let cookie = f.login();
    let (status, _, body) = f.get("/api/router/status", Some(&cookie));
    assert!(status.contains("200"), "{status} {body}");
    let v: serde_json::Value = serde_json::from_str(&body).unwrap_or_else(|_| panic!("{body}"));
    assert_eq!(v["managed"], true, "{body}");
    assert_eq!(v["port"], 7719, "{body}");
    assert_eq!(v["url"], "http://127.0.0.1:7719/v1", "{body}");
    assert_eq!(v["has_token"], false, "status must not mint a token: {body}");
    assert!(v.get("token").is_none(), "status leaked a token field: {body}");
    assert!(!body.contains(&f.token), "status echoed the web token: {body}");
    assert!(
        !body.to_ascii_lowercase().contains("api_key"),
        "status leaked a provider key: {body}"
    );
}

#[test]
fn router_unknown_action_is_rejected_without_touching_systemd() {
    let f = fixture();
    let cookie = f.login();
    let (status, _, body) = f.post(
        "/api/router/action",
        Some(&cookie),
        r#"{"action":"snapshot"}"#,
    );
    assert!(status.contains("400"), "{status} {body}");
    assert!(
        body.contains("unknown action") || body.contains("snapshot"),
        "{body}"
    );
}

#[test]
fn router_key_reveal_requires_a_real_slot_name() {
    let f = fixture();
    let cookie = f.login();
    let (status, _, body) = f.get("/api/router/key?name=../router-token", Some(&cookie));
    assert!(
        status.contains("400") || status.contains("404"),
        "path-shaped name must not be forwarded: {status} {body}"
    );
    assert!(!body.contains(&f.token), "{body}");
}
