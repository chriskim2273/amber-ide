//! Agent plan-quota collection (design 2026-09-01).
//!
//! Two real sources, one honest absence:
//! - **claude**: `GET https://api.anthropic.com/api/oauth/usage` with the
//!   user's own stored OAuth token — the call `/usage` makes. HTTPS happens by
//!   INVOKING `curl`, never by linking a TLS stack: `amber` stays std-only
//!   (core rule #8 constrains linking, not invoking, as `login_path()` and the
//!   `systemctl --user show-environment` display-env fix already establish).
//! - **codex**: the newest non-null `rate_limits` in its rollout JSONL.
//! - **grok**: nothing exists to read. It gets a row that says so.
//!
//! The token is read per poll, passed only as a `curl` argv element, and never
//! logged, persisted, or placed in any frame. Amber never refreshes it: minting
//! or rotating a credential as a side effect of a read-only status poll is the
//! mistake `load_token()` exists to avoid.

use amber_core::proto::{Gauge, ProviderUsage};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// What the collectors need from an external command. Deliberately NOT
/// `std::process::Output`: its `ExitStatus` can only be constructed through a
/// platform extension trait, which would make every test unix-only in a repo
/// that ships on Windows too.
#[derive(Debug, Clone)]
pub struct RunOutput {
    pub ok: bool,
    /// Human description of a failure ("exit status: 6"), for `detail`.
    pub status: String,
    pub stdout: String,
}

/// Seam for the one external command, so collectors are testable offline.
pub type Runner = dyn Fn(&[&str]) -> std::io::Result<RunOutput> + Send + Sync;

const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CURL_TIMEOUT_SECS: &str = "5";

/// `$CLAUDE_CONFIG_DIR` when it is an existing directory, else `~/.claude`.
pub fn claude_config_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        let p = PathBuf::from(dir);
        if p.is_dir() {
            return Some(p);
        }
    }
    crate::platform::user_home().map(|home| home.join(".claude"))
}

/// Parse an RFC3339 timestamp to unix seconds without pulling in chrono.
/// Accepts the two shapes this endpoint emits: `...+00:00` and `...Z`, with or
/// without fractional seconds.
fn rfc3339_to_unix(s: &str) -> Option<i64> {
    if s.len() < 19 {
        return None;
    }
    let num = |a: usize, b: usize| s.get(a..b).and_then(|t| t.parse::<i64>().ok());
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    // Days from civil (Howard Hinnant's algorithm) — exact, no leap-second lies.
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let offset = parse_utc_offset(s);
    Some(days * 86_400 + h * 3_600 + mi * 60 + sec - offset)
}

/// Trailing `Z` / `+HH:MM` / `-HH:MM` as seconds to SUBTRACT.
fn parse_utc_offset(s: &str) -> i64 {
    let tail = &s[19..];
    let Some(idx) = tail.rfind(['+', '-']) else {
        return 0;
    };
    let sign = if tail.as_bytes()[idx] == b'-' { -1 } else { 1 };
    let rest = &tail[idx + 1..];
    let (hh, mm) = match rest.split_once(':') {
        Some((h, m)) => (h.parse::<i64>().unwrap_or(0), m.parse::<i64>().unwrap_or(0)),
        None => (rest.parse::<i64>().unwrap_or(0), 0),
    };
    sign * (hh * 3_600 + mm * 60)
}

fn gauge(kind: &str, label: &str, percent: f64, resets_at: Option<i64>, now: i64) -> Gauge {
    Gauge {
        kind: kind.to_string(),
        label: label.to_string(),
        percent,
        resets_at,
        stale: resets_at.is_some_and(|r| r <= now),
    }
}

/// Map a provider window group to amber's short label.
fn label_for(group: &str, kind: &str) -> String {
    match group {
        "session" => "5h window".to_string(),
        "weekly" => "weekly".to_string(),
        _ => kind.to_string(),
    }
}

/// Gauges (and the plan, when stated) from an `/api/oauth/usage` body.
///
/// Prefers the server-driven `limits[]` array — it names its own windows, so a
/// new window type appears without a client change. Falls back to the
/// `five_hour`/`seven_day` objects. The codename-keyed siblings (`tangelo`,
/// `iguana_necktie`, `nimbus_quill`, …) are deliberately NOT read: they are
/// unstable server-side experiment slots with no user-interpretable meaning.
pub fn parse_claude_usage(body: &str, now: i64) -> Result<(Vec<Gauge>, Option<String>), String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("unreadable usage response: {e}"))?;
    let plan = v
        .get("organization")
        .and_then(|o| o.get("plan_type"))
        .or_else(|| v.get("plan_type"))
        .and_then(|p| p.as_str())
        .map(str::to_string);

    let mut gauges = Vec::new();
    if let Some(limits) = v.get("limits").and_then(|l| l.as_array()) {
        for entry in limits {
            let Some(percent) = entry.get("percent").and_then(serde_json::Value::as_f64) else {
                continue;
            };
            let kind = entry.get("kind").and_then(|k| k.as_str()).unwrap_or("limit");
            let group = entry.get("group").and_then(|g| g.as_str()).unwrap_or(kind);
            let resets = entry
                .get("resets_at")
                .and_then(|r| r.as_str())
                .and_then(rfc3339_to_unix);
            gauges.push(gauge(group, &label_for(group, kind), percent, resets, now));
        }
    }
    if gauges.is_empty() {
        for (key, group, label) in [
            ("five_hour", "session", "5h window"),
            ("seven_day", "weekly", "weekly"),
        ] {
            if let Some(block) = v.get(key).filter(|b| !b.is_null()) {
                let Some(percent) = block.get("utilization").and_then(serde_json::Value::as_f64)
                else {
                    continue;
                };
                let resets = block
                    .get("resets_at")
                    .and_then(|r| r.as_str())
                    .and_then(rfc3339_to_unix);
                gauges.push(gauge(group, label, percent, resets, now));
            }
        }
    }
    if gauges.is_empty() {
        return Err("usage response carried no readable windows".into());
    }
    Ok((gauges, plan))
}

fn unavailable(provider: &str, detail: &str, now: i64) -> ProviderUsage {
    ProviderUsage {
        provider: provider.into(),
        plan: None,
        gauges: Vec::new(),
        updated: now.max(0) as u64,
        state: "unavailable".into(),
        detail: Some(detail.into()),
    }
}

fn errored(provider: &str, detail: String, now: i64) -> ProviderUsage {
    ProviderUsage {
        provider: provider.into(),
        plan: None,
        gauges: Vec::new(),
        updated: now.max(0) as u64,
        state: "error".into(),
        detail: Some(detail),
    }
}

/// Collect claude's quota. `dir` defaults to [`claude_config_dir`].
pub fn claude_usage_with(dir: Option<&Path>, now: i64, run: &Runner) -> ProviderUsage {
    let Some(dir) = dir.map(Path::to_path_buf).or_else(claude_config_dir) else {
        return unavailable("claude", "no home directory", now);
    };
    let Ok(raw) = std::fs::read_to_string(dir.join(".credentials.json")) else {
        return unavailable("claude", "claude not logged in", now);
    };
    let Ok(creds) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return unavailable("claude", "claude credentials unreadable", now);
    };
    let Some(oauth) = creds.get("claudeAiOauth") else {
        return unavailable("claude", "claude not logged in", now);
    };
    let Some(token) = oauth.get("accessToken").and_then(|t| t.as_str()) else {
        return unavailable("claude", "claude not logged in", now);
    };
    // expiresAt is milliseconds. Amber never refreshes the credential itself:
    // minting or rotating one as a side effect of a read-only status poll is
    // exactly the mistake `load_token()` was added to avoid.
    if let Some(exp_ms) = oauth.get("expiresAt").and_then(serde_json::Value::as_i64) {
        if exp_ms / 1000 <= now {
            let mut u = unavailable("claude", "claude token expired — run claude to refresh", now);
            u.state = "needs-auth".into();
            return u;
        }
    }
    let auth = format!("Authorization: Bearer {token}");
    let out = run(&[
        "-sS",
        "--max-time",
        CURL_TIMEOUT_SECS,
        "-H",
        &auth,
        "-H",
        "anthropic-beta: oauth-2025-04-20",
        CLAUDE_USAGE_URL,
    ]);
    let out = match out {
        Ok(out) if out.ok => out,
        // Never surface curl's stderr verbatim: it can echo the request line,
        // and the request line carries the bearer token.
        Ok(out) => {
            return errored("claude", format!("usage request failed ({})", out.status), now);
        }
        Err(e) => return errored("claude", format!("could not run curl: {e}"), now),
    };
    match parse_claude_usage(&out.stdout, now) {
        Ok((gauges, plan)) => ProviderUsage {
            provider: "claude".into(),
            plan,
            gauges,
            updated: now.max(0) as u64,
            state: "ok".into(),
            detail: None,
        },
        Err(e) => errored("claude", e, now),
    }
}

/// Bounds on the rollout walk: a large `~/.codex` must never turn a 60 s poll
/// into a disk storm.
const MAX_ROLLOUT_FILES: usize = 200;
const MAX_ROLLOUT_BYTES: u64 = 2 * 1024 * 1024;

/// Every `rollout-*.jsonl` under `dir`, newest mtime first, capped.
fn rollout_files(dir: &Path) -> Vec<PathBuf> {
    let mut found: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(path);
            } else if path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("rollout-") && n.ends_with(".jsonl"))
            {
                let when = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
                found.push((when, path));
            }
        }
    }
    found.sort_by_key(|(when, _)| std::cmp::Reverse(*when));
    found.truncate(MAX_ROLLOUT_FILES);
    found.into_iter().map(|(_, p)| p).collect()
}

/// The tail of a file, capped — a rollout's newest records are at the end.
fn tail_of(path: &Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    if len > MAX_ROLLOUT_BYTES {
        f.seek(SeekFrom::End(-(MAX_ROLLOUT_BYTES as i64))).ok()?;
    }
    let mut buf = Vec::new();
    f.take(MAX_ROLLOUT_BYTES).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Where a `token_count` record can carry its `rate_limits`, most specific
/// first. Codex has emitted both shapes; both are present on a real box.
const RATE_LIMIT_PATHS: [&str; 4] = [
    "/payload/rate_limits",
    "/payload/info/rate_limits",
    "/rate_limits",
    "/info/rate_limits",
];

/// The newest non-null `rate_limits` object across codex's rollout logs.
///
/// "Newest non-null RECORD", not "newest file": the most recent rollout very
/// often carries `"rate_limits":null` on every line (observed live), so a
/// newest-file rule reports nothing at all.
fn newest_rate_limits(sessions_dir: &Path) -> Option<serde_json::Value> {
    for path in rollout_files(sessions_dir) {
        let Some(text) = tail_of(&path) else { continue };
        for line in text.lines().rev() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            // Codex has moved this block between releases: some rollouts put
            // it INSIDE `info`, newer ones write it as `info`'s SIBLING under
            // `payload` (verified live on both shapes). Checking one path only
            // silently reports "no usage recorded" on a machine full of it.
            let rl = RATE_LIMIT_PATHS.iter().find_map(|path| v.pointer(path));
            if let Some(rl) = rl.filter(|rl| !rl.is_null()) {
                return Some(rl.clone());
            }
        }
    }
    None
}

/// Codex quota from a specific `sessions/` directory (the testable form).
pub fn codex_usage_in(sessions_dir: &Path, now: i64) -> ProviderUsage {
    let Some(rl) = newest_rate_limits(sessions_dir) else {
        return unavailable("codex", "no codex usage recorded yet", now);
    };
    let mut gauges = Vec::new();
    for (key, group, label) in [
        ("primary", "session", "5h window"),
        ("secondary", "weekly", "weekly"),
    ] {
        let Some(block) = rl.get(key).filter(|b| !b.is_null()) else {
            continue;
        };
        let Some(percent) = block.get("used_percent").and_then(serde_json::Value::as_f64) else {
            continue;
        };
        let resets = block.get("resets_at").and_then(serde_json::Value::as_i64);
        gauges.push(gauge(group, label, percent, resets, now));
    }
    if gauges.is_empty() {
        return unavailable("codex", "no codex usage recorded yet", now);
    }
    ProviderUsage {
        provider: "codex".into(),
        plan: rl
            .get("plan_type")
            .and_then(|p| p.as_str())
            .map(str::to_string),
        gauges,
        updated: now.max(0) as u64,
        state: "ok".into(),
        detail: None,
    }
}

/// Codex quota from `$CODEX_HOME/sessions` (default `~/.codex/sessions`).
pub fn codex_usage(now: i64) -> ProviderUsage {
    match crate::codex::codex_home() {
        Some(home) => codex_usage_in(&home.join("sessions"), now),
        None => unavailable("codex", "no codex home directory", now),
    }
}

/// How often the daemon refreshes. A 5h window moves ~0.33%/min at full burn,
/// so 60 s is already finer than the number's own resolution — and it is one
/// HTTPS request per minute against the user's own account.
pub const POLL_INTERVAL: Duration = Duration::from_secs(60);

/// Grok exposes no quota anywhere: no `x-ratelimit` header string and no usage
/// endpoint in its binary, no token or limit data in `~/.grok/logs`, and its
/// sessions are an FTS sqlite index. Its `rate_limit` string is a hook/error
/// EVENT name, not a gauge. This row exists so the UI says that out loud
/// instead of omitting a kind the user runs. Amber does NOT scrape grok's pane
/// output for a limit banner — inferring state from TUI bytes is the
/// antipattern the Pocket pass already ruled out.
pub fn grok_usage(now: i64) -> ProviderUsage {
    unavailable("grok", "grok exposes no quota data", now)
}

/// One snapshot per provider, always in this order, always all three rows.
pub fn collect_all(now: i64, run: &Runner) -> Vec<ProviderUsage> {
    vec![
        claude_usage_with(None, now, run),
        codex_usage(now),
        grok_usage(now),
    ]
}

/// The real runner: spawn `curl`.
pub fn curl_runner() -> Box<Runner> {
    Box::new(|args: &[&str]| {
        let out = std::process::Command::new("curl").args(args).output()?;
        Ok(RunOutput {
            ok: out.status.success(),
            status: out.status.to_string(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        })
    })
}

/// The daemon's cached snapshot. A `GetUsage` handler clones this and replies —
/// it never fetches, so a control frame can never wait on curl or on disk.
#[derive(Debug, Default)]
pub struct UsageCache {
    inner: Mutex<Vec<ProviderUsage>>,
}

impl UsageCache {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn snapshot(&self) -> Vec<ProviderUsage> {
        self.inner
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    pub fn store(&self, rows: Vec<ProviderUsage>) {
        if let Ok(mut guard) = self.inner.lock() {
            *guard = rows;
        }
    }
}

/// Unix seconds now.
pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Start the poller. Its own thread — never a connection read thread.
pub fn start(cache: Arc<UsageCache>) {
    std::thread::spawn(move || {
        let run = curl_runner();
        loop {
            cache.store(collect_all(now_secs(), run.as_ref()));
            std::thread::sleep(POLL_INTERVAL);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `Runner` that returns a canned stdout.
    fn ok_runner(body: &'static str) -> impl Fn(&[&str]) -> std::io::Result<RunOutput> {
        move |_args: &[&str]| {
            Ok(RunOutput { ok: true, status: String::new(), stdout: body.to_string() })
        }
    }

    const LIVE_BODY: &str = r#"{
      "five_hour": {"utilization": 15.0, "resets_at": "2026-09-02T06:00:00.362063+00:00"},
      "seven_day": {"utilization": 2.0, "resets_at": "2026-09-06T05:00:00.362087+00:00"},
      "limits": [
        {"kind":"session","group":"session","percent":15,"severity":"normal",
         "resets_at":"2026-09-02T06:00:00.362063+00:00","is_active":true},
        {"kind":"weekly_all","group":"weekly","percent":2,"severity":"normal",
         "resets_at":"2026-09-06T05:00:00.362087+00:00","is_active":false}
      ]
    }"#;

    #[test]
    fn parses_the_limits_array_in_preference_to_the_named_blocks() {
        let (gauges, _plan) = parse_claude_usage(LIVE_BODY, 1_788_300_000).unwrap();
        assert_eq!(gauges.len(), 2);
        assert_eq!(gauges[0].kind, "session");
        assert_eq!(gauges[0].label, "5h window");
        assert_eq!(gauges[0].percent, 15.0);
        assert_eq!(gauges[0].resets_at, Some(1_788_328_800));
        assert_eq!(gauges[1].label, "weekly");
        assert_eq!(gauges[1].percent, 2.0);
    }

    #[test]
    fn falls_back_to_five_hour_and_seven_day_when_limits_is_absent() {
        let body = r#"{"five_hour":{"utilization":40.5,"resets_at":"2026-09-02T06:00:00Z"},
                       "seven_day":{"utilization":9.0,"resets_at":null}}"#;
        let (gauges, _) = parse_claude_usage(body, 1_788_300_000).unwrap();
        assert_eq!(gauges.len(), 2);
        assert_eq!(gauges[0].percent, 40.5);
        assert_eq!(gauges[1].resets_at, None);
    }

    #[test]
    fn ignores_the_unstable_codename_keys() {
        // tangelo / iguana_necktie / nimbus_quill are server-side experiment
        // slots; parsing them would invent gauges the user cannot interpret.
        let body = r#"{"nimbus_quill":{"utilization":99.0,"resets_at":null},
                       "five_hour":{"utilization":1.0,"resets_at":null}}"#;
        let (gauges, _) = parse_claude_usage(body, 0).unwrap();
        assert_eq!(gauges.len(), 1);
        assert_eq!(gauges[0].percent, 1.0);
    }

    #[test]
    fn marks_a_rolled_window_stale_rather_than_reporting_its_number() {
        let body = r#"{"limits":[{"kind":"session","group":"session","percent":88,
                       "resets_at":"2026-09-02T06:00:00Z","is_active":true}]}"#;
        // now is AFTER resets_at.
        let (gauges, _) = parse_claude_usage(body, 1_788_400_000).unwrap();
        assert!(gauges[0].stale);
    }

    #[test]
    fn malformed_body_is_an_error_not_a_panic() {
        assert!(parse_claude_usage("<html>502</html>", 0).is_err());
    }

    #[test]
    fn expired_token_is_needs_auth_and_never_spawns() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"sk-expired","expiresAt":1000}}"#,
        )
        .unwrap();
        // `static`, not a local: a `&Runner` is a `'static` trait object, so a
        // closure borrowing a local flag cannot be passed as one.
        static CALLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        CALLED.store(false, std::sync::atomic::Ordering::SeqCst);
        let run = |_a: &[&str]| {
            CALLED.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(RunOutput { ok: true, status: String::new(), stdout: String::new() })
        };
        let u = claude_usage_with(Some(dir.path()), 2_000, &run);
        assert_eq!(u.state, "needs-auth");
        assert!(!CALLED.load(std::sync::atomic::Ordering::SeqCst), "must not spawn curl");
    }

    #[test]
    fn missing_credentials_file_is_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let u = claude_usage_with(Some(dir.path()), 0, &ok_runner("{}"));
        assert_eq!(u.state, "unavailable");
    }

    #[test]
    fn a_rendered_snapshot_never_contains_the_token() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"sk-ant-oat-SECRET","expiresAt":99999999999999}}"#,
        )
        .unwrap();
        let u = claude_usage_with(Some(dir.path()), 0, &ok_runner(LIVE_BODY));
        let rendered = format!("{u:?}") + &serde_json::to_string(&u).unwrap();
        assert!(!rendered.contains("SECRET"), "token leaked into the snapshot");
    }

    #[test]
    fn a_failed_request_never_echoes_curl_stderr() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"sk-ant-oat-SECRET","expiresAt":99999999999999}}"#,
        )
        .unwrap();
        // curl's own diagnostics can echo the request line, which carries the
        // bearer token; only the exit status is ever surfaced.
        let run = |_a: &[&str]| {
            Ok(RunOutput {
                ok: false,
                status: "exit status: 6".into(),
                stdout: "curl: (6) Bearer sk-ant-oat-SECRET".into(),
            })
        };
        let u = claude_usage_with(Some(dir.path()), 0, &run);
        assert_eq!(u.state, "error");
        assert!(!format!("{u:?}").contains("SECRET"));
        assert!(u.detail.unwrap().contains("exit status: 6"));
    }

    #[test]
    fn rfc3339_matches_known_epochs() {
        // Verified against `date -u -d '<s>' +%s` on the box.
        assert_eq!(rfc3339_to_unix("2026-09-02T06:00:00.362063+00:00"), Some(1_788_328_800));
        assert_eq!(rfc3339_to_unix("2026-09-06T05:00:00.362087+00:00"), Some(1_788_670_800));
        assert_eq!(rfc3339_to_unix("2026-09-02T06:00:00Z"), Some(1_788_328_800));
        assert_eq!(rfc3339_to_unix("1970-01-01T00:00:00Z"), Some(0));
        // A non-UTC offset must be normalized, not ignored.
        assert_eq!(rfc3339_to_unix("2026-09-02T08:00:00+02:00"), Some(1_788_328_800));
        assert_eq!(rfc3339_to_unix("nonsense"), None);
    }

    fn write_rollout(dir: &Path, name: &str, lines: &[&str]) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, lines.join("\n")).unwrap();
        p
    }

    /// A `token_count` line with a populated rate_limits block.
    fn rl_line(primary: f64, p_reset: i64, secondary: f64, s_reset: i64) -> String {
        format!(
            r#"{{"type":"event_msg","payload":{{"type":"token_count","info":{{"rate_limits":{{"limit_id":"codex_bengalfox","primary":{{"used_percent":{primary},"window_minutes":300,"resets_at":{p_reset}}},"secondary":{{"used_percent":{secondary},"window_minutes":10080,"resets_at":{s_reset}}},"plan_type":"pro"}}}}}}}}"#
        )
    }

    const NULL_LINE: &str =
        r#"{"type":"event_msg","payload":{"type":"token_count","info":{"rate_limits":null}}}"#;

    /// Make `newer` strictly newer than `older` by mtime, portably.
    fn set_newer(newer: &Path, older: &Path) {
        let older_mtime = std::fs::metadata(older).unwrap().modified().unwrap();
        loop {
            let content = std::fs::read(newer).unwrap();
            std::fs::write(newer, &content).unwrap();
            if std::fs::metadata(newer).unwrap().modified().unwrap() > older_mtime {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    #[test]
    fn reads_the_newest_non_null_rate_limits() {
        let tmp = tempfile::tempdir().unwrap();
        let sessions = tmp.path().join("sessions");
        let old = write_rollout(
            &sessions.join("2026/09/01"),
            "rollout-a.jsonl",
            &[NULL_LINE, &rl_line(10.0, 2_000_000_000, 3.0, 2_000_600_000)],
        );
        // The NEWEST file carries only nulls — the observed live shape. Picking
        // "newest file" instead of "newest non-null record" reports nothing.
        let new = write_rollout(
            &sessions.join("2026/09/02"),
            "rollout-b.jsonl",
            &[NULL_LINE, NULL_LINE],
        );
        set_newer(&new, &old);

        let u = codex_usage_in(&sessions, 1_000_000_000);
        assert_eq!(u.state, "ok");
        assert_eq!(u.plan.as_deref(), Some("pro"));
        assert_eq!(u.gauges.len(), 2);
        assert_eq!(u.gauges[0].label, "5h window");
        assert_eq!(u.gauges[0].percent, 10.0);
        assert_eq!(u.gauges[1].label, "weekly");
        assert_eq!(u.gauges[1].percent, 3.0);
    }

    /// The shape codex actually writes today: `rate_limits` beside `info`,
    /// not inside it. Reading only the nested path reports "no usage recorded"
    /// on a machine whose rollouts are full of it (caught live, 2026-09-01).
    #[test]
    fn reads_rate_limits_written_beside_info() {
        let tmp = tempfile::tempdir().unwrap();
        let sessions = tmp.path().join("sessions");
        let line = r#"{"timestamp":"2026-08-30T22:09:11Z","type":"event_msg","payload":{"type":"token_count","info":{"model_context_window":258400},"rate_limits":{"limit_id":"codex_bengalfox","primary":{"used_percent":21.0,"window_minutes":300,"resets_at":2000000000},"secondary":{"used_percent":6.0,"window_minutes":10080,"resets_at":2000600000},"plan_type":"pro"}}}"#;
        write_rollout(&sessions.join("2026/08/30"), "rollout-a.jsonl", &[line]);
        let u = codex_usage_in(&sessions, 1_000_000_000);
        assert_eq!(u.state, "ok");
        assert_eq!(u.plan.as_deref(), Some("pro"));
        assert_eq!(u.gauges[0].percent, 21.0);
        assert_eq!(u.gauges[1].percent, 6.0);
    }

    #[test]
    fn a_passed_reset_marks_the_gauge_stale() {
        let tmp = tempfile::tempdir().unwrap();
        let sessions = tmp.path().join("sessions");
        write_rollout(
            &sessions.join("2026/09/01"),
            "rollout-a.jsonl",
            &[&rl_line(88.0, 1_000, 4.0, 2_000_600_000)],
        );
        let u = codex_usage_in(&sessions, 1_000_000_000);
        assert!(u.gauges[0].stale, "5h window rolled long ago");
        assert!(!u.gauges[1].stale);
    }

    #[test]
    fn an_empty_tree_is_unavailable_not_zero() {
        let tmp = tempfile::tempdir().unwrap();
        let u = codex_usage_in(&tmp.path().join("sessions"), 0);
        assert_eq!(u.state, "unavailable");
        assert!(u.gauges.is_empty(), "absence must never render as 0% used");
    }

    #[test]
    fn all_null_records_are_unavailable() {
        let tmp = tempfile::tempdir().unwrap();
        let sessions = tmp.path().join("sessions");
        write_rollout(
            &sessions.join("2026/09/01"),
            "rollout-a.jsonl",
            &[NULL_LINE, NULL_LINE],
        );
        assert_eq!(codex_usage_in(&sessions, 0).state, "unavailable");
    }

    #[test]
    fn the_walk_is_bounded() {
        let tmp = tempfile::tempdir().unwrap();
        let sessions = tmp.path().join("sessions");
        for i in 0..(MAX_ROLLOUT_FILES + 50) {
            write_rollout(
                &sessions.join("2026/09/01"),
                &format!("rollout-{i}.jsonl"),
                &[NULL_LINE],
            );
        }
        assert_eq!(rollout_files(&sessions).len(), MAX_ROLLOUT_FILES);
        assert_eq!(codex_usage_in(&sessions, 0).state, "unavailable");
    }

    #[test]
    fn grok_is_unavailable_by_construction() {
        let g = grok_usage(0);
        assert_eq!(g.provider, "grok");
        assert_eq!(g.state, "unavailable");
        assert!(g.gauges.is_empty());
        assert_eq!(g.detail.as_deref(), Some("grok exposes no quota data"));
    }

    #[test]
    fn collect_all_returns_one_row_per_provider_in_order() {
        let rows = collect_all(0, &ok_runner("{}"));
        let names: Vec<&str> = rows.iter().map(|r| r.provider.as_str()).collect();
        assert_eq!(names, vec!["claude", "codex", "grok"]);
    }

    #[test]
    fn one_providers_failure_never_blanks_the_others() {
        // A runner that always fails stands in for a dead network.
        let boom = |_a: &[&str]| Err(std::io::Error::other("no network"));
        let rows = collect_all(0, &boom);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].provider, "claude");
        assert!(rows[0].state == "error" || rows[0].state == "unavailable");
        assert_eq!(rows[2].state, "unavailable"); // grok row still present
    }

    #[test]
    fn the_cache_hands_back_what_was_stored() {
        let cache = UsageCache::new();
        assert!(cache.snapshot().is_empty());
        cache.store(vec![grok_usage(7)]);
        let snap = cache.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].updated, 7);
    }
}
