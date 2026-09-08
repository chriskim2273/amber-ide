//! Cookie-gated loopback client for the resident Electron browser host.
//!
//! `amber web` talks to `browser-host.sock` with the UI role. The
//! `browser-host-token` never leaves this module.

use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};

use crate::browser_host_ctl;

const MAX_JSON: usize = 1024 * 1024;
const MAX_BINARY: usize = 10 * 1024 * 1024;

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

#[derive(Debug)]
pub struct UiReply {
    pub value: Value,
    pub attachment: Option<Vec<u8>>,
    pub events: Vec<Value>,
}

fn encode(value: &Value) -> Result<Vec<u8>, OpsError> {
    let body = serde_json::to_vec(value).map_err(|_| OpsError::new(500, "INTERNAL_ERROR"))?;
    if body.len() > MAX_JSON {
        return Err(OpsError::new(400, "REQUEST_LIMIT"));
    }
    let mut out = Vec::with_capacity(body.len() + 4);
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(&body);
    Ok(out)
}

fn read_frame(stream: &mut impl Read, max: usize) -> Result<Vec<u8>, OpsError> {
    let mut prefix = [0_u8; 4];
    stream
        .read_exact(&mut prefix)
        .map_err(|_| OpsError::new(503, "BROWSER_HOST_UNAVAILABLE"))?;
    let length = u32::from_be_bytes(prefix) as usize;
    if length == 0 || length > max {
        return Err(OpsError::new(502, "BROWSER_HOST_UNAVAILABLE"));
    }
    let mut body = vec![0_u8; length];
    stream
        .read_exact(&mut body)
        .map_err(|_| OpsError::new(503, "BROWSER_HOST_UNAVAILABLE"))?;
    Ok(body)
}

fn read_json(stream: &mut impl Read) -> Result<Value, OpsError> {
    let body = read_frame(stream, MAX_JSON)?;
    serde_json::from_slice(&body).map_err(|_| OpsError::new(502, "BROWSER_HOST_UNAVAILABLE"))
}

/// One UI-role session: token hello, `{role:ui}`, then every `request` on the
/// same connection. Context then command MUST share a connection — the host
/// actor is per-socket, so a follow-up HTTP open with no context is
/// `NO_ACTIVE_TAB`.
#[cfg(unix)]
pub fn ui_roundtrip(socket: &Path, token: &str, requests: &[Value]) -> Result<UiReply, OpsError> {
    let mut stream = std::os::unix::net::UnixStream::connect(socket)
        .map_err(|_| OpsError::new(503, "BROWSER_HOST_UNAVAILABLE"))?;
    let timeout = Some(Duration::from_secs(30));
    stream
        .set_read_timeout(timeout)
        .and_then(|_| stream.set_write_timeout(timeout))
        .map_err(|_| OpsError::new(503, "BROWSER_HOST_UNAVAILABLE"))?;
    stream
        .write_all(&encode(&json!({ "token": token }))?)
        .map_err(|_| OpsError::new(503, "BROWSER_HOST_UNAVAILABLE"))?;
    let hello = read_json(&mut stream)?;
    if hello.get("ok") != Some(&Value::Bool(true)) {
        return Err(OpsError::new(503, "BROWSER_HOST_UNAVAILABLE"));
    }
    stream
        .write_all(&encode(&json!({ "version": 1, "role": "ui" }))?)
        .map_err(|_| OpsError::new(503, "BROWSER_HOST_UNAVAILABLE"))?;
    let role = read_json(&mut stream)?;
    if role.get("ok") != Some(&Value::Bool(true)) {
        let message = role.get("error").and_then(Value::as_str).unwrap_or("BROWSER_HOST_UNAVAILABLE");
        // A host from before the 2026-09-07 UI-role treats `{role:"ui"}` as a
        // Pi broker request and replies INVALID_REQUEST. Collapsing that to a
        // generic unavailable made the /app Browser button look dead.
        if message == "INVALID_REQUEST" {
            return Err(OpsError::new(
                503,
                "BROWSER_HOST_OUTDATED: restart Amber on the daemon machine to enable web browser control",
            ));
        }
        return Err(OpsError::new(503, message.to_string()));
    }
    let mut events = Vec::new();
    let mut last = None;
    for request in requests {
        stream
            .write_all(&encode(request)?)
            .map_err(|_| OpsError::new(503, "BROWSER_HOST_UNAVAILABLE"))?;
        let expected_id = request.get("requestId").and_then(Value::as_str);
        let value = loop {
            let candidate = read_json(&mut stream)?;
            if expected_id.is_some()
                && candidate.get("requestId").and_then(Value::as_str) != expected_id
            {
                events.push(candidate);
                continue;
            }
            break candidate;
        };
        if value.get("ok") != Some(&Value::Bool(true)) {
            let message = value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("BROWSER_HOST_UNAVAILABLE");
            let status = if message == "UNAUTHORIZED" { 401 } else { 502 };
            return Err(OpsError::new(status, message.to_string()));
        }
        last = Some(value);
    }
    let value = last.ok_or_else(|| OpsError::new(400, "INVALID_REQUEST"))?;
    let mut attachment = None;
    if value
        .pointer("/result/attachment/encoding")
        .and_then(Value::as_str)
        == Some("binary-frame")
    {
        let expected = value
            .pointer("/result/attachment/byteLength")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        let bytes = read_frame(&mut stream, MAX_BINARY)?;
        if bytes.len() != expected {
            return Err(OpsError::new(502, "BROWSER_HOST_UNAVAILABLE"));
        }
        attachment = Some(bytes);
    }
    Ok(UiReply { value, attachment, events })
}

#[cfg(not(unix))]
pub fn ui_roundtrip(_socket: &Path, _token: &str, _requests: &[Value]) -> Result<UiReply, OpsError> {
    Err(OpsError::new(503, "BROWSER_HOST_UNAVAILABLE"))
}

/// Send UI requests on one connection. Ensure the host only if the socket is down.
/// Never returns the token.
pub fn send(root: &Path, requests: &[Value]) -> Result<UiReply, OpsError> {
    let socket = browser_host_ctl::socket_path(None);
    send_on(root, &socket, requests)
}

fn send_on(root: &Path, socket: &Path, requests: &[Value]) -> Result<UiReply, OpsError> {
    let roundtrip = || {
        let token = browser_host_ctl::token(root).ok_or_else(|| OpsError::new(503, "BROWSER_HOST_UNAVAILABLE"))?;
        ui_roundtrip(socket, &token, requests)
    };
    match roundtrip() {
        Ok(reply) => Ok(reply),
        Err(error) if error.status == 503 && error.message == "BROWSER_HOST_UNAVAILABLE" => {
            let _ = browser_host_ctl::ensure(root, socket, Duration::from_secs(10));
            roundtrip()
        }
        Err(error) => Err(error),
    }
}

pub fn json_ok(reply: &UiReply) -> String {
    let result = reply.value.get("result").cloned().unwrap_or(Value::Null);
    let association = reply.events.iter().rev().find(|event| event.get("kind") == Some(&Value::String("association".into())));
    let mut out = json!({ "ok": true, "result": result });
    if let Some(event) = association {
        out["association"] = event.clone();
    }
    let events: Vec<&Value> = reply
        .events
        .iter()
        .filter(|event| event.get("kind") == Some(&Value::String("event".into())))
        .collect();
    if !events.is_empty() {
        out["events"] = Value::Array(events.into_iter().cloned().collect());
    }
    out.to_string()
}

pub fn json_err(error: &OpsError) -> (u16, String) {
    let status = error.status;
    let body = json!({ "ok": false, "error": error.message }).to_string();
    (status, body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::net::UnixListener;
    use std::thread;

    fn write_frame(stream: &mut impl Write, value: &Value) {
        let body = serde_json::to_vec(value).unwrap();
        stream.write_all(&(body.len() as u32).to_be_bytes()).unwrap();
        stream.write_all(&body).unwrap();
    }

    fn read_client_json(stream: &mut impl Read) -> Value {
        let mut prefix = [0_u8; 4];
        stream.read_exact(&mut prefix).unwrap();
        let length = u32::from_be_bytes(prefix) as usize;
        let mut body = vec![0_u8; length];
        stream.read_exact(&mut body).unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn ui_roundtrip_does_not_echo_the_token_and_returns_the_host_result() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("browser-host.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let hello = read_client_json(&mut stream);
            assert_eq!(hello["token"], "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
            write_frame(&mut stream, &json!({ "ok": true }));
            let role = read_client_json(&mut stream);
            assert_eq!(role, json!({ "version": 1, "role": "ui" }));
            write_frame(&mut stream, &json!({ "ok": true }));
            let request = read_client_json(&mut stream);
            assert_eq!(request["kind"], "command");
            assert!(request.get("token").is_none());
            write_frame(
                &mut stream,
                &json!({ "version": 1, "requestId": "open", "ok": true, "result": { "id": "browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "presentation": "remote" } }),
            );
        });
        let reply = ui_roundtrip(
            &socket,
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            &[json!({ "version": 1, "requestId": "open", "kind": "command", "command": { "type": "open" } })],
        )
        .unwrap();
        assert_eq!(
            reply.value["result"]["presentation"],
            json!("remote")
        );
        let rendered = json_ok(&reply);
        assert!(!rendered.contains("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
        assert!(rendered.contains("remote"));
        server.join().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn ui_role_rejected_as_invalid_request_is_reported_as_outdated_host() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("browser-host.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_client_json(&mut stream);
            write_frame(&mut stream, &json!({ "ok": true }));
            let role = read_client_json(&mut stream);
            assert_eq!(role["role"], "ui");
            write_frame(&mut stream, &json!({ "ok": false, "error": "INVALID_REQUEST" }));
        });
        let error = ui_roundtrip(
            &socket,
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            &[json!({ "version": 1, "requestId": "open", "kind": "command", "command": { "type": "open" } })],
        )
        .unwrap_err();
        assert_eq!(error.status, 503);
        assert!(error.message.contains("BROWSER_HOST_OUTDATED"), "{}", error.message);
        server.join().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn context_then_command_share_one_connection() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("browser-host.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_client_json(&mut stream);
            write_frame(&mut stream, &json!({ "ok": true }));
            let _ = read_client_json(&mut stream);
            write_frame(&mut stream, &json!({ "ok": true }));
            let context = read_client_json(&mut stream);
            assert_eq!(context["kind"], "context");
            assert_eq!(context["workspace"], 1);
            write_frame(&mut stream, &json!({ "version": 1, "requestId": "c", "ok": true, "result": { "workspace": 1, "tab": 2 } }));
            let command = read_client_json(&mut stream);
            assert_eq!(command["kind"], "command");
            assert_eq!(command["command"]["type"], "open");
            write_frame(&mut stream, &json!({ "version": 1, "requestId": "o", "ok": true, "result": { "id": "browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "presentation": "remote" } }));
        });
        let reply = ui_roundtrip(
            &socket,
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            &[
                json!({ "version": 1, "requestId": "c", "kind": "context", "workspace": 1, "tab": 2, "collapsed": false }),
                json!({ "version": 1, "requestId": "o", "kind": "command", "command": { "type": "open" } }),
            ],
        )
        .unwrap();
        assert_eq!(reply.value["result"]["presentation"], json!("remote"));
        server.join().unwrap();
    }

    #[test]
    #[cfg(unix)]
    #[test]
    fn send_talks_to_a_live_host_without_registering_a_launcher() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let mut perms = std::fs::metadata(dir.path()).unwrap().permissions();
        perms.set_mode(0o700);
        std::fs::set_permissions(dir.path(), perms).unwrap();
        let token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        std::fs::write(dir.path().join("browser-host-token"), format!("{token}\n")).unwrap();
        std::fs::set_permissions(dir.path().join("browser-host-token"), std::fs::Permissions::from_mode(0o600)).unwrap();
        let socket = dir.path().join("browser-host.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_client_json(&mut stream);
            write_frame(&mut stream, &json!({ "ok": true }));
            let _ = read_client_json(&mut stream);
            write_frame(&mut stream, &json!({ "ok": true }));
            let _ = read_client_json(&mut stream);
            write_frame(
                &mut stream,
                &json!({ "version": 1, "requestId": "open", "ok": true, "result": { "presentation": "remote" } }),
            );
        });
        let reply = send_on(
            dir.path(),
            &socket,
            &[json!({ "version": 1, "requestId": "open", "kind": "command", "command": { "type": "open" } })],
        )
        .unwrap();
        assert_eq!(reply.value["result"]["presentation"], json!("remote"));
        server.join().unwrap();
    }

    #[test]
    fn json_err_never_includes_a_token_field() {
        let (status, body) = json_err(&OpsError::new(503, "BROWSER_HOST_UNAVAILABLE"));
        assert_eq!(status, 503);
        let value: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(value["ok"], false);
        assert_eq!(value["error"], "BROWSER_HOST_UNAVAILABLE");
        assert!(value.get("token").is_none());
        assert!(!body.contains("token"));
    }
}
