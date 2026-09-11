//! Loopback operations against `amber-router`, shared by `amber ctl router`
//! and the cookie-gated `/api/router/*` surface on `amber web`.
//!
//! The browser never sees the router's bearer token. These helpers load it
//! from the 0600 state file and talk to 127.0.0.1 only.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use crate::platform;
use crate::router_pi;
use crate::routerctl;
use crate::web;
use crate::webctl;

/// Lifecycle verbs the desktop dialog and the hosted `/app` UI may send.
/// Anything else is a 400 — the argument crosses a renderer/browser boundary.
pub const ACTIONS: &[&str] = &[
    "start",
    "stop",
    "restart",
    "enable",
    "disable",
    "rotate-token",
    "install-pi-provider",
];

/// Slot names as the router itself accepts them: letters, digits, `-`, `_`.
/// Rejects empty, overlong, and anything that could be a path (`../…`).
pub fn valid_slot_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[derive(Debug)]
pub struct OpsError {
    pub status: u16,
    pub message: String,
}

impl OpsError {
    fn new(status: u16, message: impl Into<String>) -> Self {
        Self { status, message: message.into() }
    }
}

/// CLI-shaped status JSON. `managed` is always true here: the caller is the
/// host that can actually reach the unit and the 0600 files. Never mints a
/// token, never includes one, never includes a plaintext provider key.
pub fn status_json(root: &Path, port: u16) -> String {
    let home = platform::user_home().unwrap_or_else(|| PathBuf::from("."));
    let unit = routerctl::unit_path(&home);
    #[cfg(windows)]
    let unit_state = "unsupported";
    #[cfg(not(windows))]
    let unit_state = match run_argv(&routerctl::is_active_argv(), &unit) {
        Ok(o) if o.status.success() => "active",
        Ok(_) => "inactive",
        Err(_) => "unknown",
    };
    let token = web::read_secret(root, router_pi::TOKEN_FILE);
    let live = token.as_deref().and_then(|t| fetch_router_status(port, t));
    let pi = router_pi::state(root, port);
    let mut out = json!({
        "managed": true,
        "unit": unit_state,
        "port": port,
        "url": format!("http://127.0.0.1:{port}/v1"),
        "has_token": token.is_some(),
        "pi": pi.label(),
        "error": Value::Null,
    });
    match live {
        Some(v) => {
            for key in ["uptime_secs", "slots", "keys", "alias", "queue_available"] {
                out[key] = v.get(key).cloned().unwrap_or(Value::Null);
            }
        }
        None => {
            out["error"] = json!("router unreachable");
        }
    }
    out.to_string()
}

pub fn slots_json(root: &Path, port: u16) -> Result<String, OpsError> {
    let token = router_token(root)?;
    let (status, body) = router_request(port, &token, "GET", "/admin/slots", None)?;
    if status != 200 {
        return Err(OpsError::new(status, extract_error(&body).unwrap_or(body)));
    }
    Ok(body)
}

pub fn set_slots(root: &Path, port: u16, body: &str) -> Result<String, OpsError> {
    let _: Value = serde_json::from_str(body)
        .map_err(|e| OpsError::new(400, format!("stdin is not valid JSON: {e}")))?;
    let token = router_token(root)?;
    let (status, resp) = router_request(port, &token, "PUT", "/admin/slots", Some(body))?;
    if status != 200 {
        return Err(OpsError::new(status, extract_error(&resp).unwrap_or(resp)));
    }
    if !matches!(router_pi::state(root, port), router_pi::PiState::NoConfig) {
        let _ = router_pi::install(root, port);
    }
    Ok(resp)
}

pub fn reveal_key(root: &Path, port: u16, name: &str) -> Result<String, OpsError> {
    if !valid_slot_name(name) {
        return Err(OpsError::new(400, "invalid slot name"));
    }
    let token = router_token(root)?;
    let (status, body) = router_request(
        port,
        &token,
        "GET",
        &format!("/admin/slots/{name}/key"),
        None,
    )?;
    if status != 200 {
        return Err(OpsError::new(status, extract_error(&body).unwrap_or(body)));
    }
    let key = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| v.get("api_key").and_then(|k| k.as_str()).map(str::to_string))
        .unwrap_or_default();
    Ok(key)
}

pub fn run_action(root: &Path, port: u16, action: &str) -> Result<(), OpsError> {
    if !ACTIONS.contains(&action) {
        return Err(OpsError::new(400, format!("unknown action {action}")));
    }
    #[cfg(windows)]
    {
        let _ = (root, port);
        return Err(OpsError::new(
            501,
            "managed amber-router lifecycle is not supported on Windows; run `amber-router serve` manually",
        ));
    }
    #[cfg(not(windows))]
    {
        let home = platform::user_home().unwrap_or_else(|| PathBuf::from("."));
        let unit = routerctl::unit_path(&home);
        match action {
            "start" => run_unit(&routerctl::start_argv(), &unit),
            "stop" => run_unit(&routerctl::stop_argv(), &unit),
            "restart" => run_unit(&routerctl::restart_argv(), &unit),
            "enable" => enable(&unit, port),
            "disable" => {
                for a in routerctl::disable_argv() {
                    let _ = run_argv(&a, &unit);
                }
                Ok(())
            }
            "rotate-token" => {
                web::load_or_create_secret(root, router_pi::TOKEN_FILE, true)
                    .map_err(|e| OpsError::new(500, e.to_string()))?;
                let restarted = run_argv(&routerctl::restart_argv(), &unit)
                    .map(|o| o.status.success())
                    .unwrap_or(false);
                if restarted {
                    Ok(())
                } else {
                    Err(OpsError::new(
                        503,
                        "router token rotated, but the service could not be restarted — a running router still accepts the OLD token; restart it yourself",
                    ))
                }
            }
            "install-pi-provider" => {
                router_pi::install(root, port).map_err(|e| OpsError::new(500, e.to_string()))?;
                Ok(())
            }
            other => Err(OpsError::new(400, format!("unknown action {other}"))),
        }
    }
}

pub fn log_tail() -> String {
    #[cfg(target_os = "linux")]
    {
        let out = std::process::Command::new("journalctl")
            .args(["--user", "-u", routerctl::SYSTEMD_UNIT_NAME, "-n", "200", "--no-pager"])
            .output();
        match out {
            Ok(o) => {
                let stdout = String::from_utf8_lossy(&o.stdout).into_owned();
                if stdout.trim().is_empty() {
                    String::from_utf8_lossy(&o.stderr).into_owned()
                } else {
                    stdout
                }
            }
            Err(e) => format!("no log available: {e}"),
        }
    }
    #[cfg(target_os = "macos")]
    {
        let home = platform::user_home().unwrap_or_else(|| PathBuf::from("."));
        let path = home.join("Library").join("Logs").join("amber-router.log");
        std::fs::read_to_string(&path).unwrap_or_else(|e| format!("no log available: {e}"))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        "no log available on this platform".into()
    }
}

#[cfg(not(windows))]
fn enable(unit: &Path, port: u16) -> Result<(), OpsError> {
    let bin = routerctl::sibling_binary(
        &std::env::current_exe().map_err(|e| OpsError::new(500, e.to_string()))?,
    );
    if !bin.exists() {
        return Err(OpsError::new(
            500,
            format!("no amber-router binary beside this one at {}; reinstall amber", bin.display()),
        ));
    }
    if let Some(parent) = unit.parent() {
        std::fs::create_dir_all(parent).map_err(|e| OpsError::new(500, e.to_string()))?;
    }
    let body = if cfg!(target_os = "macos") {
        routerctl::render_launchd_plist(&bin, port)
    } else {
        routerctl::render_systemd_unit(&bin, port)
    };
    std::fs::write(unit, body).map_err(|e| OpsError::new(500, e.to_string()))?;
    for a in routerctl::enable_argv() {
        run_unit(&a, unit)?;
    }
    Ok(())
}

fn run_unit(a: &webctl::Argv, unit: &Path) -> Result<(), OpsError> {
    let out = run_argv(a, unit).map_err(|e| OpsError::new(500, e.to_string()))?;
    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(OpsError::new(
            503,
            if err.trim().is_empty() {
                format!("{} failed", a.cmd)
            } else {
                err.trim().to_string()
            },
        ))
    }
}

fn run_argv(a: &webctl::Argv, unit: &Path) -> std::io::Result<std::process::Output> {
    let uid = current_uid();
    let args: Vec<String> = a
        .args
        .iter()
        .map(|s| s.replace("__UNIT__", &unit.display().to_string()).replace("__UID__", &uid))
        .collect();
    std::process::Command::new(&a.cmd).args(&args).output()
}

fn current_uid() -> String {
    std::process::Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

fn router_token(root: &Path) -> Result<String, OpsError> {
    web::read_secret(root, router_pi::TOKEN_FILE).ok_or_else(|| {
        OpsError::new(
            503,
            "no router token yet — start the router once (`amber ctl router start`)",
        )
    })
}

/// Largest prompt `complete_prompt` accepts, in chars. A prompt rewrite takes a
/// short instruction, not a document — and the whole thing rides one stdin
/// write plus one router request, so an unbounded prompt is just a stuck CLI.
pub const ENHANCE_MAX_CHARS: usize = 12_000;

/// The rewrite instruction behind `complete_prompt`. It lives here rather
/// than in the UI so every caller gets the same contract: raw prompt in,
/// rewritten prompt out, no commentary.
pub const ENHANCE_SYSTEM: &str = "You rewrite the user's prompt so it is clearer, more specific, and easier for an AI assistant to act on. Preserve the user's intent and every requirement; do not add new requirements, do not drop any, and do not answer the prompt. Return ONLY the rewritten prompt — no preamble, no quotes, no explanation.";

fn enhance_input_error(message: impl Into<String>) -> OpsError {
    OpsError::new(400, message)
}

/// Validate the `{"prompt": ...}` document the `complete` CLI action reads on
/// stdin. Fails fast here rather than letting the router answer 422 to
/// something the app never meant to send.
pub fn parse_enhance_prompt(doc: &str) -> Result<String, OpsError> {
    let value: Value =
        serde_json::from_str(doc).map_err(|e| enhance_input_error(format!("stdin is not valid JSON: {e}")))?;
    let prompt = value
        .get("prompt")
        .and_then(Value::as_str)
        .ok_or_else(|| enhance_input_error("stdin must be a JSON object with a string `prompt`"))?;
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err(enhance_input_error("`prompt` must not be blank"));
    }
    if prompt.chars().count() > ENHANCE_MAX_CHARS {
        return Err(enhance_input_error(format!(
            "`prompt` is too long (max {ENHANCE_MAX_CHARS} chars)"
        )));
    }
    Ok(prompt)
}

/// The OpenAI-compatible request body for one enhancement turn. Always the
/// `auto` alias: the point is the user's own ordered failover chain, not a
/// pinned provider.
pub fn enhance_chat_body(prompt: &str) -> String {
    serde_json::json!({
        "model": "auto",
        "stream": false,
        "messages": [
            { "role": "system", "content": ENHANCE_SYSTEM },
            { "role": "user", "content": prompt },
        ],
    })
    .to_string()
}

/// Pull the assistant text out of a `/v1/chat/completions` response. A
/// non-200 surfaces the router's own error message when it has one.
pub fn extract_enhanced_text(status: u16, body: &str) -> Result<String, OpsError> {
    if status != 200 {
        return Err(OpsError::new(status, extract_error(body).unwrap_or(body.to_string())));
    }
    let text = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v.get("choices")?
                .as_array()?
                .first()?
                .get("message")?
                .get("content")?
                .as_str()
                .map(str::to_string)
        })
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    text.ok_or_else(|| OpsError::new(502, "the router returned no assistant text"))
}

/// One prompt-rewrite turn through the router. Reads the 0600 token here so
/// the desktop process never holds it: the only thing crossing into Node is
/// the prompt and the rewritten text.
pub fn complete_prompt(root: &Path, port: u16, prompt: &str) -> Result<String, OpsError> {
    let token = router_token(root)?;
    let req = enhance_chat_body(prompt);
    let (status, body) = router_request_timeout(
        port,
        &token,
        "POST",
        "/v1/chat/completions",
        Some(&req),
        Duration::from_secs(120),
    )?;
    extract_enhanced_text(status, &body)
}

/// One bearer-authed request to the router's loopback admin surface.
pub fn router_request(
    port: u16,
    token: &str,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> Result<(u16, String), OpsError> {
    router_request_timeout(port, token, method, path, body, Duration::from_secs(10))
}

/// Same, with an explicit deadline. Completions wait longer than admin reads:
/// a rewrite turn can legitimately take a minute on a slow provider.
pub fn router_request_timeout(
    port: u16,
    token: &str,
    method: &str,
    path: &str,
    body: Option<&str>,
    deadline: Duration,
) -> Result<(u16, String), OpsError> {
    let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).map_err(|e| {
        OpsError::new(503, format!("router not reachable on 127.0.0.1:{port}: {e}"))
    })?;
    s.set_read_timeout(Some(deadline))
        .map_err(|e| OpsError::new(503, e.to_string()))?;
    s.set_write_timeout(Some(deadline))
        .map_err(|e| OpsError::new(503, e.to_string()))?;
    let body = body.unwrap_or("");
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    s.write_all(req.as_bytes())
        .map_err(|e| OpsError::new(503, e.to_string()))?;
    let mut raw = String::new();
    s.read_to_string(&mut raw)
        .map_err(|e| OpsError::new(503, e.to_string()))?;
    let status = raw
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse::<u16>().ok())
        .ok_or_else(|| OpsError::new(502, "malformed response from the router"))?;
    let body = raw.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
    Ok((status, body))
}

fn extract_error(body: &str) -> Option<String> {
    serde_json::from_str::<Value>(body)
        .ok()?
        .get("error")?
        .get("message")?
        .as_str()
        .map(str::to_string)
}

fn fetch_router_status(port: u16, token: &str) -> Option<Value> {
    let deadline = Duration::from_secs(3);
    let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).ok()?;
    s.set_read_timeout(Some(deadline)).ok()?;
    s.set_write_timeout(Some(deadline)).ok()?;
    let req = format!(
        "GET /admin/status HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\n\
         Connection: close\r\n\r\n"
    );
    s.write_all(req.as_bytes()).ok()?;
    let mut body = String::new();
    s.read_to_string(&mut body).ok()?;
    serde_json::from_str(body.split("\r\n\r\n").nth(1)?).ok()
}

pub fn query_param<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then_some(v)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slot_names_reject_paths_and_junk() {
        assert!(valid_slot_name("alpha"));
        assert!(valid_slot_name("a_1-b"));
        assert!(!valid_slot_name(""));
        assert!(!valid_slot_name("../router-token"));
        assert!(!valid_slot_name("a/b"));
        assert!(!valid_slot_name("alpha.beta"));
        assert!(!valid_slot_name(&"a".repeat(65)));
    }

    #[test]
    fn query_param_reads_the_named_value() {
        assert_eq!(query_param("name=alpha", "name"), Some("alpha"));
        assert_eq!(query_param("x=1&name=../router-token", "name"), Some("../router-token"));
        assert_eq!(query_param("x=1", "name"), None);
    }

    #[test]
    fn unknown_action_is_rejected_before_any_io() {
        let err = run_action(Path::new("/tmp"), 7719, "snapshot").unwrap_err();
        assert_eq!(err.status, 400);
        assert!(err.message.contains("unknown action snapshot"), "{}", err.message);
    }

    #[test]
    fn enhance_input_validation() {
        assert_eq!(
            parse_enhance_prompt(r#"{"prompt": "  make it better  "}"#).unwrap(),
            "make it better"
        );
        assert_eq!(parse_enhance_prompt("not json").unwrap_err().status, 400);
        assert_eq!(parse_enhance_prompt(r#"{"prompt": 42}"#).unwrap_err().status, 400);
        assert_eq!(parse_enhance_prompt(r#"{"prompt": "   "}"#).unwrap_err().status, 400);
        assert_eq!(parse_enhance_prompt(r#"{}"#).unwrap_err().status, 400);
        let long = "x".repeat(ENHANCE_MAX_CHARS + 1);
        let err = parse_enhance_prompt(&format!(r#"{{"prompt": "{long}"}}"#)).unwrap_err();
        assert_eq!(err.status, 400);
        assert!(err.message.contains("too long"), "{}", err.message);
    }

    #[test]
    fn enhance_body_targets_auto_without_streaming() {
        let body: Value = serde_json::from_str(&enhance_chat_body("do the thing")).unwrap();
        assert_eq!(body["model"], serde_json::json!("auto"));
        assert_eq!(body["stream"], serde_json::json!(false));
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], serde_json::json!("system"));
        assert!(messages[0]["content"].as_str().unwrap().contains("ONLY the rewritten prompt"));
        assert_eq!(messages[1], serde_json::json!({ "role": "user", "content": "do the thing" }));
    }

    #[test]
    fn enhance_extraction_reads_first_choice() {
        let body = serde_json::json!({
            "choices": [{ "message": { "role": "assistant", "content": "  Do the thing, clearly.  " } }],
        })
        .to_string();
        assert_eq!(extract_enhanced_text(200, &body).unwrap(), "Do the thing, clearly.");
        // A router error surfaces its own message, not the raw envelope.
        let err_body = serde_json::json!({ "error": { "message": "every credential in the chain is dead" } }).to_string();
        let err = extract_enhanced_text(502, &err_body).unwrap_err();
        assert_eq!(err.status, 502);
        assert!(err.message.contains("every credential"), "{}", err.message);
        // 200 with no usable choice is an error, not an empty rewrite.
        let empty = serde_json::json!({ "choices": [] }).to_string();
        assert_eq!(extract_enhanced_text(200, &empty).unwrap_err().status, 502);
        let blank = serde_json::json!({ "choices": [{ "message": { "content": "  " } }] }).to_string();
        assert_eq!(extract_enhanced_text(200, &blank).unwrap_err().status, 502);
    }
}
