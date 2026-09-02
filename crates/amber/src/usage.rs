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
}
