//! Live, read-only quota via Codex's documented stdio app-server protocol.
//! Never starts a thread/turn, reads tokens, logs raw RPC errors, or binds TCP.
use amber_core::proto::{Gauge, ProviderUsage};
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

pub fn window_label(minutes: Option<u64>, fallback: &str) -> (String, String) {
    match minutes {
        Some(300) => ("session".into(), "5h window".into()),
        Some(10080) => ("weekly".into(), "weekly".into()),
        Some(n) if n > 0 && n <= 525600 => (format!("{n}m"), format!("{n}m window")),
        _ => (fallback.into(), format!("{fallback} window")),
    }
}

pub fn parse_live(result: &Value, now: i64) -> Result<ProviderUsage, &'static str> {
    let buckets: Vec<(&str, &Value)> = match result.get("rateLimitsByLimitId").and_then(Value::as_object) {
        Some(map) if !map.is_empty() => map.iter().take(32).map(|(id, value)| (id.as_str(), value)).collect(),
        _ => result.get("rateLimits").map(|value| vec![(value["limitId"].as_str().unwrap_or("codex"), value)])
            .unwrap_or_default(),
    };
    let mut gauges = Vec::new();
    let mut plan = None;
    for (id, snapshot) in buckets {
        if id.len() > 64 || !id.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-')) {
            continue;
        }
        if id == "codex" || plan.is_none() {
            plan = snapshot.get("planType").and_then(Value::as_str).map(str::to_owned);
        }
        for key in ["primary", "secondary"] {
            let block = &snapshot[key];
            let Some(percent) = block["usedPercent"].as_f64().filter(|n| n.is_finite() && (0.0..=100.0).contains(n)) else { continue };
            let (kind, label) = window_label(block["windowDurationMins"].as_u64(), key);
            let reset = block["resetsAt"].as_i64();
            gauges.push(Gauge {
                kind: if id == "codex" { kind } else { format!("{id}:{kind}") },
                label: if id == "codex" { label } else { format!("{id} · {label}") },
                percent, resets_at: reset, stale: reset.is_some_and(|r| r <= now),
            });
        }
    }
    if gauges.is_empty() { return Err("Codex returned no readable quota windows") }
    Ok(ProviderUsage {
        provider: "codex".into(), plan, gauges, updated: now.max(0) as u64,
        state: "ok".into(), detail: Some("Live quota · Codex login".into()),
    })
}

/// No credentials are passed on argv: Codex handles its own existing login.
/// A short-lived, owned stdio server avoids a long-lived extra agent process.
pub fn collect(binary: &Path, now: i64) -> ProviderUsage {
    let began = std::time::Instant::now();
    match request(binary, Duration::from_secs(8)).and_then(|result| {
        parse_live(&result, now.saturating_add(began.elapsed().as_secs() as i64))
    }) {
        Ok(row) => row,
        Err(message) => ProviderUsage {
            provider: "codex".into(), plan: None, gauges: vec![], updated: 0,
            state: "error".into(), detail: Some(message.into()),
        },
    }
}

#[cfg(unix)]
fn request(binary: &Path, timeout: Duration) -> Result<Value, &'static str> {
    use std::io::{Read, Write};
    use std::os::fd::AsRawFd;
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use std::time::Instant;

    struct Owned(Child);
    impl Drop for Owned {
        fn drop(&mut self) {
            // The group is created by Command::process_group. Kill before wait
            // so the PID cannot be reused between reaping and signalling.
            unsafe { libc::kill(-(self.0.id() as i32), libc::SIGTERM); }
            let deadline = Instant::now() + Duration::from_millis(300);
            while Instant::now() < deadline {
                if self.0.try_wait().ok().flatten().is_some() { return }
                std::thread::sleep(Duration::from_millis(10));
            }
            unsafe { libc::kill(-(self.0.id() as i32), libc::SIGKILL); }
            let _ = self.0.wait();
        }
    }
    let deadline = Instant::now() + timeout;
    let mut command = Command::new(binary);
    command.args(["app-server", "--listen", "stdio://"])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
        .process_group(0);
    let child = loop {
        match command.spawn() {
            Ok(child) => break child,
            // A binary replacement (or a concurrently forked test holding a
            // script's write fd briefly) can produce ETXTBSY. Retry only that
            // known transient error, inside the same wall-clock deadline.
            Err(error) if error.raw_os_error() == Some(libc::ETXTBSY) && Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => return Err("Could not start Codex quota reader; check Codex installation"),
        }
    };
    let mut child = Owned(child);
    let mut input = child.0.stdin.take().ok_or("Codex quota stdin unavailable")?;
    let mut output = child.0.stdout.take().ok_or("Codex quota stdout unavailable")?;
    let fd = output.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err("Could not bound Codex quota reader");
    }
    let mut buffer = Vec::new();
    let mut total = 0usize;
    fn send(input: &mut impl Write, message: &Value) -> Result<(), &'static str> {
        let mut bytes = serde_json::to_vec(message).map_err(|_| "Could not encode quota request")?;
        bytes.push(b'\n');
        input.write_all(&bytes).map_err(|_| "Codex quota reader closed its input")
    }
    // The only methods used are initialize, initialized, account/read and
    // account/rateLimits/read. Never thread/start, turn/start, login or reset.
    send(&mut input, &serde_json::json!({"id":0,"method":"initialize","params":{
        "clientInfo":{"name":"amber_quota","version":env!("CARGO_PKG_VERSION")}}}))?;
    let mut expected = 0;
    loop {
        if Instant::now() >= deadline { return Err("Live Codex quota timed out") }
        let mut chunk = [0u8; 8192];
        match output.read(&mut chunk) {
            Ok(0) => return Err("Codex quota reader exited before replying"),
            Ok(n) => {
                total += n;
                if total > 1024 * 1024 { return Err("Codex quota response exceeded size limit") }
                buffer.extend_from_slice(&chunk[..n]);
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(10));
                continue;
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err("Could not read live Codex quota"),
        }
        while let Some(end) = buffer.iter().position(|b| *b == b'\n') {
            let bytes: Vec<u8> = buffer.drain(..=end).collect();
            let reply: Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid Codex quota response")?;
            if reply["id"].as_u64() != Some(expected) { continue }
            // Raw server errors can contain account details; return only our
            // static diagnostic, never arbitrary provider/credential strings.
            if reply.get("error").is_some() { return Err("Live Codex quota unavailable; check Codex login or connectivity") }
            let result = reply.get("result").ok_or("Missing Codex quota response")?;
            match expected {
                0 => {
                    send(&mut input, &serde_json::json!({"method":"initialized"}))?;
                    send(&mut input, &serde_json::json!({"id":1,"method":"account/read","params":{"refreshToken":false}}))?;
                    expected = 1;
                }
                1 => {
                    if result["account"]["type"].as_str() != Some("chatgpt") {
                        return Err("Live plan quota requires a ChatGPT login in Codex");
                    }
                    send(&mut input, &serde_json::json!({"id":2,"method":"account/rateLimits/read"}))?;
                    expected = 2;
                }
                _ => return Ok(result.clone()),
            }
        }
    }
}

#[cfg(not(unix))]
fn request(_binary: &Path, _timeout: Duration) -> Result<Value, &'static str> {
    Err("Live Codex quota reader is supported on macOS and Linux")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[cfg(unix)]
    #[test]
    #[ignore = "read-only live Codex account request; requires explicit AMBER_CODEX_QUOTA_SMOKE_BIN"]
    fn live_quota_smoke() {
        let path = std::env::var_os("AMBER_CODEX_QUOTA_SMOKE_BIN").expect("explicit Codex binary required");
        let row = collect(Path::new(&path), crate::usage::now_secs());
        assert_eq!(row.state, "ok", "{:?}", row.detail);
        // Only normalized public quota fields, no account identifiers or raw responses.
        eprintln!("{}", serde_json::to_string(&row).unwrap());
    }

    #[cfg(unix)]
    fn fake_server(dir: &Path, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("codex");
        std::fs::write(&path, format!("#!/usr/bin/env python3\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn rpc_uses_only_read_methods_and_existing_chatgpt_login() {
        let dir = tempfile::tempdir().unwrap();
        let path = fake_server(dir.path(), r#"
import json,sys
assert sys.argv[1:] == ['app-server','--listen','stdio://']
def read(): return json.loads(sys.stdin.readline())
def reply(id, result): print(json.dumps({'id':id,'result':result}),flush=True)
a=read(); assert a['method']=='initialize'; reply(0,{})
assert read()['method']=='initialized'
a=read(); assert a['method']=='account/read' and a['params']=={'refreshToken':False}
reply(1,{'account':{'type':'chatgpt','email':'PRIVATE@example.invalid'}})
a=read(); assert a['method']=='account/rateLimits/read'
reply(2,{'rateLimits':{'primary':{'usedPercent':81,'windowDurationMins':10080}}})
sys.stdin.read()
"#);
        let row = collect(&path, 1000);
        assert_eq!(row.state, "ok", "{:?}", row.detail);
        assert_eq!(row.gauges[0].percent, 81.0);
        assert!(!serde_json::to_string(&row).unwrap().contains("PRIVATE"));
    }

    #[cfg(unix)]
    #[test]
    fn rpc_errors_are_sanitized_and_hung_reader_is_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let path = fake_server(dir.path(), "import time\ntime.sleep(60)");
        let start = std::time::Instant::now();
        assert_eq!(request(&path, Duration::from_millis(100)), Err("Live Codex quota timed out"));
        assert!(start.elapsed() < Duration::from_secs(2));
        let path = fake_server(dir.path(), "import sys\nsys.stdin.readline()\nprint('{\"id\":0,\"error\":{\"message\":\"SECRET token\"}}',flush=True)\nsys.stdin.read()");
        assert!(!request(&path, Duration::from_secs(2)).unwrap_err().contains("SECRET"));
    }

    #[cfg(unix)]
    #[test]
    fn rpc_caps_output_even_without_newlines() {
        let dir = tempfile::tempdir().unwrap();
        let path = fake_server(dir.path(), "import sys\nsys.stdout.write('x' * (2*1024*1024))\nsys.stdout.flush()\nsys.stdin.read()");
        assert_eq!(request(&path, Duration::from_secs(2)), Err("Codex quota response exceeded size limit"));
    }

    #[test]
    fn primary_weekly_is_not_a_five_hour_window() {
        let row = parse_live(&json!({"rateLimits": {"limitId":"codex", "planType":"pro",
            "primary":{"usedPercent":81,"windowDurationMins":10080,"resetsAt":2000}}}), 1000).unwrap();
        assert_eq!(row.gauges[0].kind, "weekly");
        assert_eq!(row.gauges[0].label, "weekly");
        assert_eq!(row.gauges[0].percent, 81.0);
        assert_eq!(row.updated, 1000);
        assert_eq!(row.plan.as_deref(), Some("pro"));
    }

    #[test]
    fn buckets_remain_distinct_and_do_not_duplicate_legacy_snapshot() {
        let row = parse_live(&json!({"rateLimits": {"primary":{"usedPercent":99,"windowDurationMins":300}},
          "rateLimitsByLimitId": {
            "codex":{"primary":{"usedPercent":81,"windowDurationMins":10080}},
            "codex_bengalfox":{"primary":{"usedPercent":0,"windowDurationMins":300},
                               "secondary":{"usedPercent":9,"windowDurationMins":10080}}
          }}), 1000).unwrap();
        assert_eq!(row.gauges.len(), 3);
        assert_eq!(row.gauges[0].label, "weekly");
        assert!(row.gauges[1].label.contains("codex_bengalfox"));
        assert!(row.gauges[1].label.contains("5h"));
        assert!(!row.gauges.iter().any(|g| g.percent == 99.0));
    }

    #[test]
    fn unknown_duration_is_not_guessed_and_invalid_percent_is_rejected() {
        let row = parse_live(&json!({"rateLimits":{"primary":{"usedPercent":7,"windowDurationMins":15}}}), 0).unwrap();
        assert_eq!(row.gauges[0].label, "15m window");
        assert!(parse_live(&json!({"rateLimits":{"primary":{"usedPercent":-1}}}), 0).is_err());
        let row = parse_live(&json!({"rateLimits":{"primary":{"usedPercent":7}}}), 0).unwrap();
        assert_eq!(row.gauges[0].label, "primary window");
    }

    #[test]
    fn expired_window_is_stale_and_empty_response_is_not_zero_usage() {
        let row = parse_live(&json!({"rateLimits":{"primary":{"usedPercent":7,"resetsAt":999}}}), 1000).unwrap();
        assert!(row.gauges[0].stale);
        assert!(parse_live(&json!({}), 1000).is_err());
    }
}
