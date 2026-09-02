# Agent usage-limit tracking — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show, inside amber, how much of each agent plan is left this 5-hour window and this week — claude and codex with real provider numbers, grok honestly marked as having none.

**Architecture:** The daemon owns a 60 s poller that collects a `ProviderUsage` per provider into an in-memory cache: claude by shelling out to `curl` against `api/oauth/usage` with the user's own stored OAuth token, codex by reading the newest non-null `rate_limits` out of `~/.codex/sessions/**/rollout-*.jsonl`. A new additive control message pair (`GetUsage` → `Usage`) serves the cached snapshot to every client, so the desktop app, `amber ctl usage`, and Pocket/`amber web` all read the same truth for the machine the sessions actually run on.

**Tech Stack:** Rust (std only — no new Cargo dependency; the one HTTPS call is a `std::process::Command` spawn of `curl`), serde JSON on the existing control wire, TypeScript strict + React for the desktop pill/dialog, vitest + `cargo test`.

**Spec:** `docs/superpowers/specs/2026-09-01-usage-limit-tracking-design.md`

## Global Constraints

- **No new Cargo dependency.** `amber`/`amberd` stay std-only (CLAUDE.md core rule #8). The claude HTTPS call is a `curl` **invocation**, never a linked TLS stack. Rule #8 constrains linking, not invoking — the same reading already applied to `login_path()` and `systemctl --user show-environment`.
- **The claude OAuth token never leaves the daemon.** Read per poll from `.credentials.json`, passed only as an argv element to `curl`, never logged, never written to the state store, never placed in any frame, HTTP body, or CLI output.
- **Amber never refreshes or mints the claude credential.** An expired token yields `state:"needs-auth"` and no spawn.
- **No derived percentages.** A gauge is rendered only from a number the provider itself reports. Never divide transcript tokens by a guessed plan limit.
- **Grok quota is never inferred from pane bytes.** Same antipattern as inferring "waiting" from TUI output, already ruled out in the Pocket pass.
- **Nothing runs on a connection read thread.** The poller is its own thread; the `GetUsage` handler returns a cached clone and never blocks on curl or disk (backlog head-of-line lesson).
- **`Usage` is never broadcast** through the watcher registry — it is a poll reply only.
- **Wire is additive**: every new field carries `#[serde(default)]`, and the TypeScript decoder is updated in the same change (it throws on unknown keys).
- `percent` on the wire is **USED** (0..=100). Remaining is derived in the UI only.
- Poll cadence: daemon 60 s; desktop pill 60 s; open dialog 15 s; `amber web` 60 s.
- Conventional commits, no `Co-Authored-By` line.
- Gates before done: `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace` (twice), `npm run typecheck`, `npm test`, `npm run build`, `npm run build:web` (all from `app/`).

---

## File Structure

| File | Responsibility |
|---|---|
| `crates/amber/src/usage.rs` (new) | All collection. Pure parsers (`parse_claude_usage`, `scan_codex_rate_limits`), the credential read, the curl seam, `collect_all`, `UsageCache`, the poller thread. |
| `crates/amber-core/src/proto.rs` | `Gauge`, `ProviderUsage`, `ControlMsg::GetUsage`, `ControlMsg::Usage`. |
| `crates/amber/src/daemon.rs` | `GetUsage` handler; `Daemon::with_usage`. |
| `crates/amber/src/lib.rs` | `pub mod usage;` + poller startup in `daemon_main`. |
| `crates/amber/src/main.rs` | `amber ctl usage [--json]`. |
| `crates/amber/src/web.rs` | 60 s `GetUsage` tick on the hub's daemon link; `GET /api/usage`. |
| `app/src/shared/proto.ts` | Encode/decode for the new pair. |
| `app/src/shared/usageView.ts` (new) | Pure display model: remaining %, tone, reset countdown, tightest gauge. |
| `app/src/preload/index.ts`, `app/src/client/index.ts`, `app/src/main/index.ts` | `getUsage()` → `daemon-command` → `GetUsage`; reply rides the existing `onDaemonEvent`. |
| `app/src/renderer/main.tsx`, `app/src/renderer/UsagePanel.tsx` (new) | Toolbar pill + dialog. |
| `app/src/web/amber.ts` | Web shim `getUsage()` over `GET /api/usage`. |
| `app/src/renderer/PocketCommandCenter.tsx` | Compact mobile row. |

---

### Task 1: Protocol — `Gauge`, `ProviderUsage`, `GetUsage`, `Usage`

**Files:**
- Modify: `crates/amber-core/src/proto.rs`
- Test: `crates/amber-core/src/proto.rs` (the existing `#[cfg(test)] mod tests` at the bottom of the file)

**Interfaces:**
- Consumes: nothing.
- Produces: `amber_core::proto::Gauge { kind: String, label: String, percent: f64, resets_at: Option<i64>, stale: bool }`; `amber_core::proto::ProviderUsage { provider: String, plan: Option<String>, gauges: Vec<Gauge>, updated: u64, state: String, detail: Option<String> }`; `ControlMsg::GetUsage`; `ControlMsg::Usage { providers: Vec<ProviderUsage> }`.

- [ ] **Step 1: Write the failing tests**

Append to the `mod tests` block in `crates/amber-core/src/proto.rs`:

```rust
    #[test]
    fn usage_control_roundtrips() {
        let msg = ControlMsg::Usage {
            providers: vec![ProviderUsage {
                provider: "claude".into(),
                plan: Some("pro".into()),
                gauges: vec![Gauge {
                    kind: "session".into(),
                    label: "5h window".into(),
                    percent: 15.0,
                    resets_at: Some(1_788_321_600),
                    stale: false,
                }],
                updated: 1_788_300_000,
                state: "ok".into(),
                detail: None,
            }],
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert_eq!(serde_json::from_str::<ControlMsg>(&json).unwrap(), msg);
    }

    #[test]
    fn get_usage_is_a_unit_variant_on_the_wire() {
        // Unit variants serialize as a bare string; the TS decoder relies on it.
        assert_eq!(serde_json::to_string(&ControlMsg::GetUsage).unwrap(), "\"GetUsage\"");
    }

    #[test]
    fn provider_usage_tolerates_a_minimal_peer_payload() {
        // Every optional field defaults, so a leaner/older sender still decodes.
        let p: ProviderUsage =
            serde_json::from_str(r#"{"provider":"grok","state":"unavailable"}"#).unwrap();
        assert_eq!(p.provider, "grok");
        assert!(p.gauges.is_empty());
        assert_eq!(p.plan, None);
        assert_eq!(p.detail, None);
        assert_eq!(p.updated, 0);
    }
```

`ControlMsg` derives `Eq`, and `f64` is not `Eq`. Deriving `Eq` on `Gauge` is therefore impossible — Step 3 drops `Eq` from `ControlMsg` **only if** the compiler demands it. It will: `#[derive(Eq)]` on an enum requires every field type to be `Eq`. So `ControlMsg`'s derive list loses `Eq` and keeps `PartialEq`. Check the tree for `ControlMsg` uses that need `Eq` (a `HashSet<ControlMsg>` or a `BTreeMap` key) before assuming this is free:

```bash
grep -rn "HashSet<ControlMsg>\|BTreeSet<ControlMsg>\|Ord for ControlMsg" crates/ app/ || echo "no Eq-dependent uses"
```

If that grep finds nothing (expected), dropping `Eq` from `ControlMsg`, `Frame`, and any enum that embeds them is safe. `SessionInfo` and the other structs keep their derives untouched.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cargo test -p amber-core proto::tests::usage 2>&1 | tail -20
```

Expected: compile error — `cannot find type Gauge` / `no variant named Usage`.

- [ ] **Step 3: Implement**

Add above `pub enum ControlMsg` in `crates/amber-core/src/proto.rs`:

```rust
/// One quota window a provider reports about itself.
///
/// `percent` is **used**, 0..=100, exactly as the provider states it. The UI
/// derives "remaining"; amber never computes a percentage of its own (a
/// number divided by a guessed plan limit would be this feature wearing a
/// mask — see the design's "No derived percentages" rule).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Gauge {
    /// Provider's own window identity: "session" (5h) | "weekly" | other.
    pub kind: String,
    /// Short human label: "5h window", "weekly".
    pub label: String,
    pub percent: f64,
    /// Unix seconds this window resets. `None` when the provider omits it.
    #[serde(default)]
    pub resets_at: Option<i64>,
    /// `resets_at` is in the past: the window has rolled since this sample was
    /// written, so `percent` describes a window that no longer exists. The UI
    /// must render this as "rolled", never as a number.
    #[serde(default)]
    pub stale: bool,
}

/// One provider's quota snapshot. `state` is `"ok" | "unavailable" |
/// "needs-auth" | "error"`; anything but `"ok"` renders as words, not numbers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderUsage {
    pub provider: String,
    #[serde(default)]
    pub plan: Option<String>,
    #[serde(default)]
    pub gauges: Vec<Gauge>,
    /// Unix seconds of this sample.
    #[serde(default)]
    pub updated: u64,
    pub state: String,
    #[serde(default)]
    pub detail: Option<String>,
}
```

Add the two variants next to `GetMemoryBudget`/`BudgetApplied` inside `ControlMsg`:

```rust
    /// Client -> daemon: report each agent provider's plan-quota snapshot.
    /// Answered from the daemon's 60 s poller cache — never a live fetch on
    /// the connection read thread. Replies `Usage`.
    GetUsage,
    /// Daemon -> client: the cached quota snapshot, one entry per provider.
    /// NEVER broadcast to watchers (a once-a-minute payload has no business on
    /// the bounded lifecycle queue); it is a poll reply only.
    Usage { providers: Vec<ProviderUsage> },
```

Then remove `Eq` from the `#[derive(...)]` on `ControlMsg` and on `Frame` (and fix any `assert_eq!`-adjacent compile fallout — `PartialEq` is what assertions need).

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cargo test -p amber-core 2>&1 | tail -5
cargo clippy -p amber-core --all-targets -- -D warnings
```

Expected: all pass, clippy clean.

- [ ] **Step 5: Commit**

```bash
git add crates/amber-core/src/proto.rs
git commit -m "feat(proto): add GetUsage/Usage quota control messages"
```

---

### Task 2: `usage.rs` — claude collector

**Files:**
- Create: `crates/amber/src/usage.rs`
- Modify: `crates/amber/src/lib.rs` (add `pub mod usage;` in the alphabetical list, between `tailscale` and `transport`)
- Test: inline `#[cfg(test)] mod tests` in `crates/amber/src/usage.rs`

**Interfaces:**
- Consumes: `amber_core::proto::{Gauge, ProviderUsage}` from Task 1.
- Produces:
  - `pub type Runner = dyn Fn(&[&str]) -> std::io::Result<std::process::Output> + Send + Sync;`
  - `pub fn claude_config_dir() -> Option<PathBuf>`
  - `pub fn parse_claude_usage(body: &str, now: i64) -> Result<(Vec<Gauge>, Option<String>), String>`
  - `pub fn claude_usage_with(dir: Option<&Path>, now: i64, run: &Runner) -> ProviderUsage`

- [ ] **Step 1: Write the failing tests**

Create `crates/amber/src/usage.rs` with ONLY the test module for now (the rest arrives in Step 3):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;
    use std::process::{ExitStatus, Output};

    /// A `Runner` that returns a canned stdout and records that it was called.
    fn ok_runner(body: &'static str) -> impl Fn(&[&str]) -> std::io::Result<Output> {
        move |_args: &[&str]| {
            Ok(Output {
                status: ExitStatus::from_raw(0),
                stdout: body.as_bytes().to_vec(),
                stderr: Vec::new(),
            })
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
        assert_eq!(gauges[0].resets_at, Some(1_788_321_600));
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
        let called = std::sync::atomic::AtomicBool::new(false);
        let run = |_a: &[&str]| {
            called.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(Output { status: ExitStatus::from_raw(0), stdout: vec![], stderr: vec![] })
        };
        let u = claude_usage_with(Some(dir.path()), 2_000, &run);
        assert_eq!(u.state, "needs-auth");
        assert!(!called.load(std::sync::atomic::Ordering::SeqCst), "must not spawn curl");
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
}
```

`tempfile` is already a dev-dependency of `crates/amber` (used by the existing tests); confirm with `grep -n tempfile crates/amber/Cargo.toml` and add it under `[dev-dependencies]` only if absent.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cargo test -p amber usage:: 2>&1 | tail -20
```

Expected: `cannot find function parse_claude_usage` / module not declared.

- [ ] **Step 3: Implement**

Add `pub mod usage;` to `crates/amber/src/lib.rs`. Then prepend to `crates/amber/src/usage.rs`:

```rust
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
use std::process::Output;

/// Seam for the one external command, so collectors are testable offline.
pub type Runner = dyn Fn(&[&str]) -> std::io::Result<Output> + Send + Sync;

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
    let bytes = s.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let num = |a: usize, b: usize| s.get(a..b)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
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
    let Some(idx) = tail.rfind(['+', '-']) else { return 0 };
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
    let raw = match std::fs::read_to_string(dir.join(".credentials.json")) {
        Ok(raw) => raw,
        Err(_) => return unavailable("claude", "claude not logged in", now),
    };
    let creds: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return unavailable("claude", "claude credentials unreadable", now),
    };
    let Some(oauth) = creds.get("claudeAiOauth") else {
        return unavailable("claude", "claude not logged in", now);
    };
    let Some(token) = oauth.get("accessToken").and_then(|t| t.as_str()) else {
        return unavailable("claude", "claude not logged in", now);
    };
    // expiresAt is milliseconds. Amber never refreshes the credential itself.
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
        Ok(out) if out.status.success() => out,
        Ok(out) => {
            // stderr may echo the request line; never surface it verbatim.
            return errored("claude", format!("usage request failed (curl {})", out.status), now);
        }
        Err(e) => return errored("claude", format!("could not run curl: {e}"), now),
    };
    let body = String::from_utf8_lossy(&out.stdout);
    match parse_claude_usage(&body, now) {
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
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cargo test -p amber usage:: 2>&1 | tail -10
cargo clippy -p amber --all-targets -- -D warnings
```

Expected: 8 usage tests pass, clippy clean.

- [ ] **Step 5: Commit**

```bash
git add crates/amber/src/usage.rs crates/amber/src/lib.rs
git commit -m "feat(usage): collect claude plan quota via the oauth usage endpoint"
```

---

### Task 2b: `rfc3339_to_unix` against the real endpoint's own strings

**Files:**
- Modify: `crates/amber/src/usage.rs` (test module only)

**Interfaces:**
- Consumes: `rfc3339_to_unix` from Task 2.
- Produces: nothing new.

This is its own task because a date routine written by hand is exactly where a
silent off-by-a-timezone hides, and the gauge's whole value is its countdown.

- [ ] **Step 1: Write the failing tests**

```rust
    #[test]
    fn rfc3339_matches_known_epochs() {
        // Verified against `date -u -d '<s>' +%s`.
        assert_eq!(rfc3339_to_unix("2026-09-02T06:00:00.362063+00:00"), Some(1_788_321_600));
        assert_eq!(rfc3339_to_unix("2026-09-06T05:00:00.362087+00:00"), Some(1_788_663_600));
        assert_eq!(rfc3339_to_unix("2026-09-02T06:00:00Z"), Some(1_788_321_600));
        assert_eq!(rfc3339_to_unix("1970-01-01T00:00:00Z"), Some(0));
        // A non-UTC offset must be normalized, not ignored.
        assert_eq!(rfc3339_to_unix("2026-09-02T08:00:00+02:00"), Some(1_788_321_600));
        assert_eq!(rfc3339_to_unix("nonsense"), None);
    }
```

Before running, regenerate the expected numbers on the box so the test asserts
truth rather than this document's arithmetic:

```bash
for s in '2026-09-02T06:00:00' '2026-09-06T05:00:00' '1970-01-01T00:00:00'; do
  printf '%s -> %s\n' "$s" "$(date -u -d "$s" +%s)"
done
```

Substitute any value that differs, then proceed.

- [ ] **Step 2: Run to verify**

```bash
cargo test -p amber usage::tests::rfc3339 2>&1 | tail -10
```

Expected: PASS if Task 2's implementation is right; a FAIL here is a real bug to
fix in `rfc3339_to_unix`, not a test to adjust.

- [ ] **Step 3: Commit**

```bash
git add crates/amber/src/usage.rs
git commit -m "test(usage): pin rfc3339 parsing to verified epochs"
```

---

### Task 3: `usage.rs` — codex collector

**Files:**
- Modify: `crates/amber/src/usage.rs`
- Test: inline test module

**Interfaces:**
- Consumes: `gauge`, `unavailable` from Task 2.
- Produces: `pub fn codex_usage_in(sessions_dir: &Path, now: i64) -> ProviderUsage`; `pub fn codex_usage(now: i64) -> ProviderUsage`.

- [ ] **Step 1: Write the failing tests**

```rust
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

    #[test]
    fn reads_the_newest_non_null_rate_limits() {
        let tmp = tempfile::tempdir().unwrap();
        let sessions = tmp.path().join("sessions");
        let old = write_rollout(&sessions.join("2026/09/01"), "rollout-a.jsonl",
            &[NULL_LINE, &rl_line(10.0, 2_000_000_000, 3.0, 2_000_600_000)]);
        // The NEWEST file carries only nulls — the observed live shape. Picking
        // "newest file" instead of "newest non-null record" reports nothing.
        let new = write_rollout(&sessions.join("2026/09/02"), "rollout-b.jsonl",
            &[NULL_LINE, NULL_LINE]);
        filetime_set_newer(&new, &old);

        let u = codex_usage_in(&sessions, 1_000_000_000);
        assert_eq!(u.state, "ok");
        assert_eq!(u.plan.as_deref(), Some("pro"));
        assert_eq!(u.gauges.len(), 2);
        assert_eq!(u.gauges[0].label, "5h window");
        assert_eq!(u.gauges[0].percent, 10.0);
        assert_eq!(u.gauges[1].label, "weekly");
        assert_eq!(u.gauges[1].percent, 3.0);
    }

    #[test]
    fn a_passed_reset_marks_the_gauge_stale() {
        let tmp = tempfile::tempdir().unwrap();
        let sessions = tmp.path().join("sessions");
        write_rollout(&sessions.join("2026/09/01"), "rollout-a.jsonl",
            &[&rl_line(88.0, 1_000, 4.0, 2_000_600_000)]);
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
        write_rollout(&sessions.join("2026/09/01"), "rollout-a.jsonl", &[NULL_LINE, NULL_LINE]);
        assert_eq!(codex_usage_in(&sessions, 0).state, "unavailable");
    }

    #[test]
    fn the_walk_is_bounded() {
        let tmp = tempfile::tempdir().unwrap();
        let sessions = tmp.path().join("sessions");
        for i in 0..(MAX_ROLLOUT_FILES + 50) {
            write_rollout(&sessions.join("2026/09/01"), &format!("rollout-{i}.jsonl"), &[NULL_LINE]);
        }
        // Completes without walking every file; the assertion is that it returns.
        assert_eq!(codex_usage_in(&sessions, 0).state, "unavailable");
    }
```

Add this helper next to the other test helpers (no new dependency — it bumps
mtime by rewriting):

```rust
    /// Make `newer` strictly newer than `older` by mtime, portably.
    fn filetime_set_newer(newer: &Path, older: &Path) {
        let older_meta = std::fs::metadata(older).unwrap();
        loop {
            let content = std::fs::read(newer).unwrap();
            std::fs::write(newer, &content).unwrap();
            let m = std::fs::metadata(newer).unwrap();
            if m.modified().unwrap() > older_meta.modified().unwrap() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
```

- [ ] **Step 2: Run to verify they fail**

```bash
cargo test -p amber usage::tests::reads_the_newest 2>&1 | tail -10
```

Expected: `cannot find function codex_usage_in`.

- [ ] **Step 3: Implement**

Append to `crates/amber/src/usage.rs`:

```rust
/// Bounds on the rollout walk: a large `~/.codex` must never turn a 60 s poll
/// into a disk storm.
const MAX_ROLLOUT_FILES: usize = 200;
const MAX_ROLLOUT_BYTES: u64 = 2 * 1024 * 1024;

/// Every `rollout-*.jsonl` under `dir`, newest mtime first, capped.
fn rollout_files(dir: &Path) -> Vec<PathBuf> {
    let mut found: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
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
    found.sort_by(|a, b| b.0.cmp(&a.0));
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

/// The newest non-null `rate_limits` object across codex's rollout logs.
///
/// "Newest non-null RECORD", not "newest file": the most recent rollout very
/// often carries `"rate_limits":null` on every line (observed live), so a
/// newest-file rule reports nothing at all.
fn newest_rate_limits(sessions_dir: &Path) -> Option<serde_json::Value> {
    for path in rollout_files(sessions_dir) {
        let Some(text) = tail_of(&path) else { continue };
        for line in text.lines().rev() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            let rl = v
                .pointer("/payload/info/rate_limits")
                .or_else(|| v.pointer("/info/rate_limits"));
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
        let Some(block) = rl.get(key).filter(|b| !b.is_null()) else { continue };
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
        plan: rl.get("plan_type").and_then(|p| p.as_str()).map(str::to_string),
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
```

- [ ] **Step 4: Run to verify they pass**

```bash
cargo test -p amber usage:: 2>&1 | tail -10
cargo clippy -p amber --all-targets -- -D warnings
```

- [ ] **Step 5: Commit**

```bash
git add crates/amber/src/usage.rs
git commit -m "feat(usage): read codex plan quota from rollout rate_limits"
```

---

### Task 4: `collect_all`, grok's honest row, and the poller

**Files:**
- Modify: `crates/amber/src/usage.rs`
- Test: inline test module

**Interfaces:**
- Consumes: `claude_usage_with`, `codex_usage`, `Runner`.
- Produces:
  - `pub fn grok_usage(now: i64) -> ProviderUsage`
  - `pub fn collect_all(now: i64, run: &Runner) -> Vec<ProviderUsage>`
  - `pub fn curl_runner() -> Box<Runner>`
  - `pub struct UsageCache` with `UsageCache::new() -> Arc<UsageCache>`, `snapshot(&self) -> Vec<ProviderUsage>`, `store(&self, Vec<ProviderUsage>)`
  - `pub fn start(cache: Arc<UsageCache>)`
  - `pub const POLL_INTERVAL: Duration` (60 s)

- [ ] **Step 1: Write the failing tests**

```rust
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
        assert_eq!(rows[0].provider, "claude");
        assert!(rows[0].state == "error" || rows[0].state == "unavailable");
        assert_eq!(rows[2].state, "unavailable"); // grok row still present
        assert_eq!(rows.len(), 3);
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
```

- [ ] **Step 2: Run to verify they fail**

```bash
cargo test -p amber usage::tests::grok_is_unavailable 2>&1 | tail -10
```

Expected: `cannot find function grok_usage`.

- [ ] **Step 3: Implement**

Append to `crates/amber/src/usage.rs`:

```rust
use std::sync::{Arc, Mutex};
use std::time::Duration;

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
    vec![claude_usage_with(None, now, run), codex_usage(now), grok_usage(now)]
}

/// The real runner: spawn `curl`.
pub fn curl_runner() -> Box<Runner> {
    Box::new(|args: &[&str]| std::process::Command::new("curl").args(args).output())
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
        self.inner.lock().map(|g| g.clone()).unwrap_or_default()
    }

    pub fn store(&self, rows: Vec<ProviderUsage>) {
        if let Ok(mut g) = self.inner.lock() {
            *g = rows;
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
```

- [ ] **Step 4: Run to verify they pass**

```bash
cargo test -p amber usage:: 2>&1 | tail -10
cargo clippy -p amber --all-targets -- -D warnings
```

- [ ] **Step 5: Commit**

```bash
git add crates/amber/src/usage.rs
git commit -m "feat(usage): add the 60s poller cache and grok's unavailable row"
```

---

### Task 5: Daemon handler + startup wiring

**Files:**
- Modify: `crates/amber/src/daemon.rs` (`Daemon` struct, `Daemon::with_usage`, `handle_connection`, `handle_control`)
- Modify: `crates/amber/src/lib.rs` (`daemon_main`)
- Test: create `crates/amber/tests/usage_control.rs`

**Interfaces:**
- Consumes: `usage::UsageCache`, `ControlMsg::{GetUsage, Usage}`.
- Produces: `Daemon::with_usage(self, cache: Arc<crate::usage::UsageCache>) -> Self`.

- [ ] **Step 1: Write the failing test**

Create `crates/amber/tests/usage_control.rs`, modelled on the existing
`crates/amber/tests/watch.rs` harness (read it first for the exact
`SessionManager`/temp-root setup this repo uses and mirror it):

```rust
//! `GetUsage` answers from the daemon's cache, never from a live fetch.

use amber::daemon::Daemon;
use amber::usage::UsageCache;
use amber_core::proto::{ControlMsg, Frame, ProviderUsage};
use std::sync::Arc;

mod common; // if watch.rs uses a shared helper module; otherwise inline its setup

#[test]
fn get_usage_replies_with_the_cached_snapshot() {
    let (manager, _tmp) = common::manager(); // mirror watch.rs
    let watchers = Arc::new(amber::watchers::Watchers::new());
    let cache = UsageCache::new();
    cache.store(vec![ProviderUsage {
        provider: "codex".into(),
        plan: Some("pro".into()),
        gauges: vec![],
        updated: 42,
        state: "ok".into(),
        detail: None,
    }]);
    let daemon = Daemon::new(Arc::clone(&manager), Arc::clone(&watchers))
        .with_usage(Arc::clone(&cache));

    let (client, server) = common::socket_pair();
    std::thread::spawn(move || {
        let _ = daemon.serve_one_for_test(server);
    });
    common::send(&client, ControlMsg::GetUsage);

    match common::read_control(&client) {
        Frame::Control(ControlMsg::Usage { providers }) => {
            assert_eq!(providers.len(), 1);
            assert_eq!(providers[0].provider, "codex");
            assert_eq!(providers[0].updated, 42);
        }
        other => panic!("expected Usage, got {other:?}"),
    }
}

#[test]
fn get_usage_on_a_daemon_without_a_poller_is_an_empty_list_not_an_error() {
    let (manager, _tmp) = common::manager();
    let watchers = Arc::new(amber::watchers::Watchers::new());
    let daemon = Daemon::new(Arc::clone(&manager), Arc::clone(&watchers));
    let (client, server) = common::socket_pair();
    std::thread::spawn(move || {
        let _ = daemon.serve_one_for_test(server);
    });
    common::send(&client, ControlMsg::GetUsage);
    match common::read_control(&client) {
        Frame::Control(ControlMsg::Usage { providers }) => assert!(providers.is_empty()),
        other => panic!("expected an empty Usage, got {other:?}"),
    }
}
```

If `watch.rs` has no shared `common` module, copy its inline setup into this
file rather than inventing a new harness — matching the existing pattern is the
point.

- [ ] **Step 2: Run to verify it fails**

```bash
cargo test -p amber --test usage_control 2>&1 | tail -20
```

Expected: `no method named with_usage`.

- [ ] **Step 3: Implement**

In `crates/amber/src/daemon.rs`:

```rust
pub struct Daemon {
    manager: Arc<SessionManager>,
    watchers: Arc<crate::watchers::Watchers>,
    /// Quota snapshot cache, filled by `usage::start`. Defaults to an empty
    /// cache so every existing `Daemon::new` call site (and every test)
    /// compiles unchanged and answers `GetUsage` with an empty list.
    usage: Arc<crate::usage::UsageCache>,
}

impl Daemon {
    pub fn new(manager: Arc<SessionManager>, watchers: Arc<crate::watchers::Watchers>) -> Self {
        Daemon { manager, watchers, usage: crate::usage::UsageCache::new() }
    }

    /// Attach the poller's cache.
    pub fn with_usage(mut self, cache: Arc<crate::usage::UsageCache>) -> Self {
        self.usage = cache;
        self
    }
```

Thread it through: `serve`'s spawn clones `self.usage` alongside manager and
watchers; `handle_connection` takes `usage: Arc<crate::usage::UsageCache>` and
passes `&usage` to `handle_control`; `serve_one_for_test` passes
`Arc::clone(&self.usage)`. Add the parameter to `handle_control`'s signature
after `watchers`, then the arm (place it next to `GetMemoryBudget`):

```rust
        ControlMsg::GetUsage => {
            // Cache read only. A live fetch here would put curl and a
            // directory walk on the connection read thread, behind which every
            // multiplexed control frame would queue (the backlog HOL lesson).
            let providers = usage.snapshot();
            let _ = write_frame(writer, &Frame::Control(ControlMsg::Usage { providers }));
        }
        ControlMsg::Usage { .. } => {} // daemon -> client only; ignore inbound
```

In `crates/amber/src/lib.rs` `daemon_main`, immediately before
`let daemon = daemon::Daemon::new(...)`:

```rust
    let usage_cache = usage::UsageCache::new();
    usage::start(Arc::clone(&usage_cache));
```

and change the construction to:

```rust
    let daemon = daemon::Daemon::new(Arc::clone(&manager), Arc::clone(&watchers))
        .with_usage(Arc::clone(&usage_cache));
```

- [ ] **Step 4: Run to verify it passes**

```bash
cargo test -p amber --test usage_control 2>&1 | tail -10
cargo test --workspace 2>&1 | tail -5
cargo clippy --workspace --all-targets -- -D warnings
```

- [ ] **Step 5: Commit**

```bash
git add crates/amber/src/daemon.rs crates/amber/src/lib.rs crates/amber/tests/usage_control.rs
git commit -m "feat(daemon): answer GetUsage from the poller cache"
```

---

### Task 6: `amber ctl usage [--json]`

**Files:**
- Modify: `crates/amber/src/main.rs` (`CtlAction` enum, its `match`, and a new `run_usage`)
- Test: inline `#[cfg(test)] mod tests` in `crates/amber/src/main.rs` for the pure formatter

**Interfaces:**
- Consumes: `ControlMsg::{GetUsage, Usage}`, `ProviderUsage`.
- Produces: `fn format_usage(rows: &[ProviderUsage], now: i64) -> String` (pure, tested); `fn run_usage(json: bool, socket: &Path) -> anyhow::Result<()>`.

- [ ] **Step 1: Write the failing test**

Add to `main.rs`'s test module:

```rust
    #[test]
    fn format_usage_shows_remaining_and_names_absent_sources() {
        let rows = vec![
            ProviderUsage {
                provider: "claude".into(),
                plan: Some("pro".into()),
                gauges: vec![Gauge {
                    kind: "session".into(),
                    label: "5h window".into(),
                    percent: 15.0,
                    resets_at: Some(3_600),
                    stale: false,
                }],
                updated: 0,
                state: "ok".into(),
                detail: None,
            },
            ProviderUsage {
                provider: "grok".into(),
                plan: None,
                gauges: vec![],
                updated: 0,
                state: "unavailable".into(),
                detail: Some("grok exposes no quota data".into()),
            },
        ];
        let out = format_usage(&rows, 0);
        assert!(out.contains("claude"));
        assert!(out.contains("85% left"), "remaining, not used: {out}");
        assert!(out.contains("1h 0m"), "reset countdown missing: {out}");
        assert!(out.contains("grok exposes no quota data"));
        assert!(!out.contains("0%"), "an absent source must not render as a number: {out}");
    }

    #[test]
    fn format_usage_renders_a_rolled_window_as_words() {
        let rows = vec![ProviderUsage {
            provider: "codex".into(),
            plan: None,
            gauges: vec![Gauge {
                kind: "session".into(),
                label: "5h window".into(),
                percent: 88.0,
                resets_at: Some(10),
                stale: true,
            }],
            updated: 0,
            state: "ok".into(),
            detail: None,
        }];
        let out = format_usage(&rows, 1_000);
        assert!(out.contains("rolled"), "{out}");
        assert!(!out.contains("88"), "a stale number must not be shown: {out}");
    }
```

- [ ] **Step 2: Run to verify it fails**

```bash
cargo test -p amber format_usage 2>&1 | tail -10
```

Expected: `cannot find function format_usage`.

- [ ] **Step 3: Implement**

Add the subcommand to `CtlAction`:

```rust
    /// Report each agent provider's plan quota (5h window and weekly).
    Usage {
        #[arg(long)]
        json: bool,
        #[arg(long)]
        socket: Option<PathBuf>,
    },
```

Its match arm, beside `CtlAction::Status`:

```rust
            CtlAction::Usage { json, socket } => run_usage(json, &resolve_socket(socket)?),
```

And the functions (place them next to `run_budget`):

```rust
/// "in 4h 12m" / "in 6d" / "" when unknown.
fn until(resets_at: Option<i64>, now: i64) -> String {
    let Some(at) = resets_at else { return String::new() };
    let secs = at - now;
    if secs <= 0 {
        return String::new();
    }
    if secs >= 86_400 {
        format!("in {}d", secs / 86_400)
    } else {
        format!("in {}h {}m", secs / 3_600, (secs % 3_600) / 60)
    }
}

/// Human table. Remaining is the headline — it is the number the user asked
/// for. A non-`ok` provider prints its reason; it never prints a number.
fn format_usage(rows: &[ProviderUsage], now: i64) -> String {
    let mut out = String::new();
    for row in rows {
        let plan = row.plan.as_deref().map(|p| format!(" · {p}")).unwrap_or_default();
        if row.state != "ok" {
            let why = row.detail.as_deref().unwrap_or(row.state.as_str());
            out.push_str(&format!("{}{plan}: {why}\n", row.provider));
            continue;
        }
        out.push_str(&format!("{}{plan}\n", row.provider));
        for g in &row.gauges {
            if g.stale {
                out.push_str(&format!("  {:<12} window rolled — reopen {}\n", g.label, row.provider));
                continue;
            }
            let left = (100.0 - g.percent).clamp(0.0, 100.0);
            out.push_str(&format!("  {:<12} {left:.0}% left   {}\n", g.label, until(g.resets_at, now)));
        }
    }
    out
}

fn run_usage(json: bool, socket: &Path) -> anyhow::Result<()> {
    let mut stream = transport::connect(socket)
        .map_err(|e| anyhow::anyhow!("daemon unreachable at {}: {e}", socket.display()))?;
    write_frame(&mut stream, &Frame::Control(ControlMsg::GetUsage))?;
    let mut decoder = Decoder::new();
    let rows = loop {
        match read_next(&mut stream, &mut decoder)? {
            Frame::Control(ControlMsg::Usage { providers }) => break providers,
            Frame::Control(ControlMsg::Error { msg }) => anyhow::bail!("{msg}"),
            _ => continue,
        }
    };
    if json {
        println!("{}", serde_json::to_string_pretty(&rows)?);
    } else {
        print!("{}", format_usage(&rows, amber::usage::now_secs()));
    }
    Ok(())
}
```

`read_next` / `Decoder` / `write_frame` already have an established shape in
`run_budget` and `run_status` — copy their exact reply-reading idiom rather than
the sketch above if it differs (an older daemon that does not know `GetUsage`
replies `Error`, which the loop already surfaces as a clean message).

- [ ] **Step 4: Run to verify it passes**

```bash
cargo test -p amber format_usage 2>&1 | tail -5
cargo build -p amber 2>&1 | tail -3
cargo clippy --workspace --all-targets -- -D warnings
```

- [ ] **Step 5: Commit**

```bash
git add crates/amber/src/main.rs
git commit -m "feat(cli): add amber ctl usage"
```

---

### Task 7: `proto.ts` — decode/encode the new pair

**Files:**
- Modify: `app/src/shared/proto.ts`
- Test: `app/src/shared/proto.test.ts`

**Interfaces:**
- Consumes: the Rust wire shape from Task 1.
- Produces: TS types `Gauge`, `ProviderUsage`, and `ControlMsg` members `{ kind: 'GetUsage' }` and `{ kind: 'Usage'; providers: ProviderUsage[] }`.

- [ ] **Step 1: Write the failing tests**

Append to `app/src/shared/proto.test.ts`:

```ts
  it('encodes GetUsage as a bare string, matching serde unit variants', () => {
    const frame = encodeFrame({ type: 'control', msg: { kind: 'GetUsage' } })
    const json = JSON.parse(new TextDecoder().decode(frame.subarray(5)))
    expect(json).toBe('GetUsage')
  })

  it('decodes a Usage reply with all fields', () => {
    const msg = decodeControl({
      Usage: {
        providers: [
          {
            provider: 'claude',
            plan: 'pro',
            gauges: [
              { kind: 'session', label: '5h window', percent: 15, resets_at: 1788321600, stale: false },
            ],
            updated: 1788300000,
            state: 'ok',
            detail: null,
          },
        ],
      },
    })
    expect(msg).toEqual({
      kind: 'Usage',
      providers: [
        {
          provider: 'claude',
          plan: 'pro',
          gauges: [
            { kind: 'session', label: '5h window', percent: 15, resets_at: 1788321600, stale: false },
          ],
          updated: 1788300000,
          state: 'ok',
          detail: null,
        },
      ],
    })
  })

  it('tolerates a Usage row that omits every optional field', () => {
    const msg = decodeControl({ Usage: { providers: [{ provider: 'grok', state: 'unavailable' }] } })
    expect(msg).toEqual({
      kind: 'Usage',
      providers: [
        { provider: 'grok', plan: null, gauges: [], updated: 0, state: 'unavailable', detail: null },
      ],
    })
  })
```

Match the existing helper names in `proto.test.ts` (`encodeFrame`,
`decodeControl` or whatever it actually exports) — read the file's other tests
first and mirror them exactly.

- [ ] **Step 2: Run to verify they fail**

```bash
cd app && npx vitest run src/shared/proto.test.ts 2>&1 | tail -20
```

Expected: FAIL — the decoder returns `null` for the unknown `Usage` key.

- [ ] **Step 3: Implement**

Add the types near `SearchResult` in `app/src/shared/proto.ts`:

```ts
/** One quota window as the provider reports it. `percent` is USED, 0..100. */
export interface Gauge {
  kind: string
  label: string
  percent: number
  /** Unix seconds, or null when the provider omits it. */
  resets_at: number | null
  /** The window rolled since this sample: render as words, never the number. */
  stale: boolean
}

/** One provider's quota snapshot. Anything but state 'ok' renders as words. */
export interface ProviderUsage {
  provider: string
  plan: string | null
  gauges: Gauge[]
  updated: number
  state: 'ok' | 'unavailable' | 'needs-auth' | 'error' | string
  detail: string | null
}
```

Add to the `ControlMsg` union, beside `GetMemoryBudget`:

```ts
  | { kind: 'GetUsage' }
  | { kind: 'Usage'; providers: ProviderUsage[] }
```

Encode side, beside `case 'GetMemoryBudget'`:

```ts
    case 'GetUsage':
      return 'GetUsage'
    case 'Usage':
      return { Usage: { providers: m.providers } }
```

Decode side — add `'GetUsage'` to the bare-string list in `jsonToMsg`, and next
to `case 'BudgetApplied'`:

```ts
      case 'Usage': {
        const raw = Array.isArray(body['providers']) ? (body['providers'] as unknown[]) : []
        return { kind: 'Usage', providers: raw.map(decodeProviderUsage) }
      }
```

with the decoder beside the other `decode*` helpers:

```ts
function decodeGauge(v: unknown): Gauge {
  const o = (v ?? {}) as Record<string, unknown>
  return {
    kind: typeof o['kind'] === 'string' ? o['kind'] : '',
    label: typeof o['label'] === 'string' ? o['label'] : '',
    percent: typeof o['percent'] === 'number' ? o['percent'] : 0,
    resets_at: typeof o['resets_at'] === 'number' ? o['resets_at'] : null,
    stale: o['stale'] === true,
  }
}

function decodeProviderUsage(v: unknown): ProviderUsage {
  const o = (v ?? {}) as Record<string, unknown>
  const gauges = Array.isArray(o['gauges']) ? (o['gauges'] as unknown[]).map(decodeGauge) : []
  return {
    provider: typeof o['provider'] === 'string' ? o['provider'] : '',
    plan: typeof o['plan'] === 'string' ? o['plan'] : null,
    gauges,
    updated: typeof o['updated'] === 'number' ? o['updated'] : 0,
    state: typeof o['state'] === 'string' ? o['state'] : 'unavailable',
    detail: typeof o['detail'] === 'string' ? o['detail'] : null,
  }
}
```

- [ ] **Step 4: Run to verify they pass**

```bash
cd app && npx vitest run src/shared/proto.test.ts 2>&1 | tail -5 && npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add app/src/shared/proto.ts app/src/shared/proto.test.ts
git commit -m "feat(app): decode GetUsage/Usage on the control wire"
```

---

### Task 8: `shared/usageView.ts` — the pure display model

**Files:**
- Create: `app/src/shared/usageView.ts`
- Test: create `app/src/shared/usageView.test.ts`

**Interfaces:**
- Consumes: `Gauge`, `ProviderUsage` from Task 7.
- Produces:
  - `export function remaining(g: Gauge): number`
  - `export function tone(percentUsed: number): 'normal' | 'warning' | 'danger'`
  - `export function resetLabel(g: Gauge, now: number): string`
  - `export function tightest(rows: ProviderUsage[]): { row: ProviderUsage; gauge: Gauge } | null`
  - `export function pillLabel(rows: ProviderUsage[]): string | null`

- [ ] **Step 1: Write the failing tests**

Create `app/src/shared/usageView.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { remaining, tone, resetLabel, tightest, pillLabel } from './usageView'
import type { Gauge, ProviderUsage } from './proto'

const g = (over: Partial<Gauge> = {}): Gauge => ({
  kind: 'session', label: '5h window', percent: 15, resets_at: null, stale: false, ...over,
})
const row = (over: Partial<ProviderUsage> = {}): ProviderUsage => ({
  provider: 'claude', plan: 'pro', gauges: [g()], updated: 0, state: 'ok', detail: null, ...over,
})

describe('usageView', () => {
  it('reports remaining, not used', () => {
    expect(remaining(g({ percent: 15 }))).toBe(85)
    expect(remaining(g({ percent: 0 }))).toBe(100)
  })

  it('clamps a nonsense percent instead of rendering it', () => {
    expect(remaining(g({ percent: 140 }))).toBe(0)
    expect(remaining(g({ percent: -5 }))).toBe(100)
  })

  it('tones on used, at the documented thresholds', () => {
    expect(tone(69)).toBe('normal')
    expect(tone(70)).toBe('warning')
    expect(tone(89)).toBe('warning')
    expect(tone(90)).toBe('danger')
  })

  it('labels a reset as a countdown, and a rolled window as words', () => {
    expect(resetLabel(g({ resets_at: 3600 }), 0)).toBe('in 1h 0m')
    expect(resetLabel(g({ resets_at: 6 * 86400 }), 0)).toBe('in 6d')
    expect(resetLabel(g({ resets_at: null }), 0)).toBe('')
    expect(resetLabel(g({ stale: true, resets_at: 5 }), 100)).toBe('window rolled')
  })

  it('picks the tightest live gauge across providers', () => {
    const rows = [
      row({ provider: 'claude', gauges: [g({ percent: 15 })] }),
      row({ provider: 'codex', gauges: [g({ percent: 82 })] }),
    ]
    expect(tightest(rows)?.row.provider).toBe('codex')
    expect(tightest(rows)?.gauge.percent).toBe(82)
  })

  it('ignores stale gauges and non-ok providers when picking', () => {
    const rows = [
      row({ provider: 'claude', gauges: [g({ percent: 20 })] }),
      row({ provider: 'codex', gauges: [g({ percent: 99, stale: true })] }),
      row({ provider: 'grok', state: 'unavailable', gauges: [] }),
    ]
    expect(tightest(rows)?.row.provider).toBe('claude')
  })

  it('hides the pill entirely when nothing is known', () => {
    expect(pillLabel([])).toBeNull()
    expect(pillLabel([row({ state: 'unavailable', gauges: [] })])).toBeNull()
    expect(pillLabel([row({ gauges: [g({ percent: 15 })] })])).toBe('85% left')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd app && npx vitest run src/shared/usageView.test.ts 2>&1 | tail -10
```

Expected: cannot resolve `./usageView`.

- [ ] **Step 3: Implement**

Create `app/src/shared/usageView.ts`:

```ts
// Pure display model for agent plan quota (design 2026-09-01).
//
// In `shared/` for the same reason as `routerStatus`/`webStatus`: the daemon
// produces the numbers, the renderer renders them, and the web build must
// answer the same calls without importing from `main/`.
//
// The wire carries USED percent. Everything user-facing is REMAINING, because
// "how much do I have left" is the question this feature exists to answer.

import type { Gauge, ProviderUsage } from './proto'

/** Percent of the window still available, clamped. */
export function remaining(g: Gauge): number {
  return Math.min(100, Math.max(0, 100 - g.percent))
}

/** Tone from USED percent. */
export function tone(percentUsed: number): 'normal' | 'warning' | 'danger' {
  if (percentUsed >= 90) return 'danger'
  if (percentUsed >= 70) return 'warning'
  return 'normal'
}

/**
 * "in 4h 12m" / "in 6d" / "window rolled" / ''. A stale gauge never shows a
 * countdown OR its number — the window it measured no longer exists.
 */
export function resetLabel(g: Gauge, now: number): string {
  if (g.stale) return 'window rolled'
  if (g.resets_at === null) return ''
  const secs = g.resets_at - now
  if (secs <= 0) return ''
  if (secs >= 86400) return `in ${Math.floor(secs / 86400)}d`
  return `in ${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
}

/** The most-consumed live gauge across every ok provider, or null. */
export function tightest(rows: ProviderUsage[]): { row: ProviderUsage; gauge: Gauge } | null {
  let best: { row: ProviderUsage; gauge: Gauge } | null = null
  for (const row of rows) {
    if (row.state !== 'ok') continue
    for (const gauge of row.gauges) {
      if (gauge.stale) continue
      if (!best || gauge.percent > best.gauge.percent) best = { row, gauge }
    }
  }
  return best
}

/**
 * Pill text, or null to HIDE the pill. Null rather than a dead badge: the web
 * build shipped a permanently-red remote pill once by rendering an error state
 * instead of hiding an unmanaged one.
 */
export function pillLabel(rows: ProviderUsage[]): string | null {
  const best = tightest(rows)
  return best ? `${Math.round(remaining(best.gauge))}% left` : null
}
```

- [ ] **Step 4: Run to verify they pass**

```bash
cd app && npx vitest run src/shared/usageView.test.ts 2>&1 | tail -5 && npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add app/src/shared/usageView.ts app/src/shared/usageView.test.ts
git commit -m "feat(app): add the pure usage display model"
```

---

### Task 9: IPC — `getUsage()` from renderer to daemon

**Files:**
- Modify: `app/src/preload/index.ts` (the `amber` bridge object AND its type declaration block)
- Modify: `app/src/client/index.ts` (the `daemon-command` dispatch chain)
- Modify: `app/src/main/index.ts` only if `daemon-command` payloads are validated there (grep for `'getMemoryBudget'`; if main forwards blindly, no change)
- Test: `app/src/client/router.test.ts` or `app/src/client/connection.test.ts` — whichever already covers a `daemon-command` → `ControlMsg` mapping; mirror it

**Interfaces:**
- Consumes: `ControlMsg.GetUsage` (Task 7).
- Produces: `window.amber.getUsage(): void` — the `Usage` reply arrives through the existing `onDaemonEvent` stream, exactly like `BudgetApplied`.

- [ ] **Step 1: Write the failing test**

In the client test file that already asserts command mapping, add:

```ts
  it('maps the getUsage command to a GetUsage control message', () => {
    const sent: unknown[] = []
    const conn = { send: (f: unknown) => sent.push(f) }
    handleDaemonCommand(conn as never, { cmd: 'getUsage' })
    expect(sent).toEqual([{ type: 'control', msg: { kind: 'GetUsage' } }])
  })
```

If the dispatch chain in `app/src/client/index.ts` is an inline `else if` ladder
with no exported function (it is), extract it to an exported
`handleDaemonCommand(conn, cmd)` in the same file as part of Step 3 and have the
message handler call it. That extraction is what makes this testable at all;
keep it mechanical — move the ladder, change nothing inside it.

- [ ] **Step 2: Run to verify it fails**

```bash
cd app && npx vitest run src/client 2>&1 | tail -10
```

- [ ] **Step 3: Implement**

`app/src/client/index.ts` — extract the ladder and add:

```ts
      } else if (cmd.cmd === 'getUsage') {
        conn.send({ type: 'control', msg: { kind: 'GetUsage' } })
```

`app/src/preload/index.ts` — bridge method, beside `getMemoryBudget`:

```ts
  // Agent plan quota (design 2026-09-01). The `Usage` reply arrives via
  // onDaemonEvent, like BudgetApplied — this is a request, not a promise.
  getUsage: () => ipcRenderer.send('daemon-command', { cmd: 'getUsage' }),
```

and in the `window.amber` type declaration:

```ts
      // Agent plan quota; the `Usage` reply arrives via onDaemonEvent.
      getUsage?: () => void
```

Optional (`?`) because the web build's shim answers usage over HTTP instead —
Task 12 fills that in, and an optional method lets the renderer call it with
`?.()` on both hosts.

- [ ] **Step 4: Run to verify it passes**

```bash
cd app && npx vitest run src/client 2>&1 | tail -5 && npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add app/src/client/index.ts app/src/preload/index.ts
git commit -m "feat(app): wire getUsage through preload and the client"
```

---

### Task 10: Desktop pill + `UsagePanel` dialog

**Files:**
- Create: `app/src/renderer/UsagePanel.tsx`
- Modify: `app/src/renderer/main.tsx` (state, the `Usage` event arm, the 60 s / 15 s poll effect, the toolbar pill, the panel mount)
- Modify: `app/src/renderer/theme.css` only if a new tone token is genuinely missing (check `web-pill-normal` / `-warning` / `-danger` first — the router/remote pills already define this exact tone set; reuse it)
- Test: create `app/src/renderer/usagePanel.test.ts` (pure props → rows model, mirroring `routerPanel.test.ts`'s style)

**Interfaces:**
- Consumes: `ProviderUsage` (Task 7), `usageView` (Task 8), `window.amber.getUsage` (Task 9).
- Produces: `export function UsagePanel(props: { rows: ProviderUsage[]; now: number; onClose: () => void }): JSX.Element`; `export function panelRows(rows: ProviderUsage[], now: number): PanelRow[]` where `PanelRow = { provider: string; plan: string | null; lines: Array<{ label: string; text: string; tone: 'normal'|'warning'|'danger'|'muted'; percentUsed: number | null }> }`.

- [ ] **Step 1: Write the failing test**

Create `app/src/renderer/usagePanel.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { panelRows } from './UsagePanel'
import type { ProviderUsage } from '../shared/proto'

const ok: ProviderUsage = {
  provider: 'claude', plan: 'pro', updated: 0, state: 'ok', detail: null,
  gauges: [
    { kind: 'session', label: '5h window', percent: 15, resets_at: 3600, stale: false },
    { kind: 'weekly', label: 'weekly', percent: 2, resets_at: 6 * 86400, stale: false },
  ],
}

describe('panelRows', () => {
  it('renders remaining plus a countdown per gauge', () => {
    const [row] = panelRows([ok], 0)
    expect(row.plan).toBe('pro')
    expect(row.lines[0]).toMatchObject({ label: '5h window', tone: 'normal', percentUsed: 15 })
    expect(row.lines[0].text).toContain('85% left')
    expect(row.lines[0].text).toContain('in 1h 0m')
  })

  it('states a non-ok provider in words, with no bar', () => {
    const rows = panelRows(
      [{ ...ok, provider: 'grok', state: 'unavailable', gauges: [], plan: null,
         detail: 'grok exposes no quota data' }],
      0,
    )
    expect(rows[0].lines).toEqual([
      { label: '', text: 'grok exposes no quota data', tone: 'muted', percentUsed: null },
    ])
  })

  it('states needs-auth as an action, not a number', () => {
    const rows = panelRows(
      [{ ...ok, state: 'needs-auth', gauges: [], detail: 'claude token expired — run claude to refresh' }],
      0,
    )
    expect(rows[0].lines[0].percentUsed).toBeNull()
    expect(rows[0].lines[0].text).toContain('run claude')
  })

  it('states a rolled window instead of its number', () => {
    const rows = panelRows(
      [{ ...ok, gauges: [{ kind: 'session', label: '5h window', percent: 88, resets_at: 5, stale: true }] }],
      1000,
    )
    expect(rows[0].lines[0].text).toBe('window rolled')
    expect(rows[0].lines[0].percentUsed).toBeNull()
    expect(JSON.stringify(rows)).not.toContain('88')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd app && npx vitest run src/renderer/usagePanel.test.ts 2>&1 | tail -10
```

- [ ] **Step 3: Implement**

Create `app/src/renderer/UsagePanel.tsx`:

```tsx
// Agent plan-quota dialog (design 2026-09-01 §4).
//
// Built on the repo's own .help-overlay / .help-card shell. Inventing CSS
// classes here is the mistake the remote-access dialog shipped and had to undo.

import type { ProviderUsage } from '../shared/proto'
import { remaining, resetLabel, tone } from '../shared/usageView'

export interface PanelLine {
  label: string
  text: string
  tone: 'normal' | 'warning' | 'danger' | 'muted'
  /** USED percent for the bar, or null when there is no number to draw. */
  percentUsed: number | null
}

export interface PanelRow {
  provider: string
  plan: string | null
  lines: PanelLine[]
}

/** Pure props → rows. Every non-ok state renders as words, never a number. */
export function panelRows(rows: ProviderUsage[], now: number): PanelRow[] {
  return rows.map((row) => {
    if (row.state !== 'ok') {
      return {
        provider: row.provider,
        plan: row.plan,
        lines: [{ label: '', text: row.detail ?? row.state, tone: 'muted', percentUsed: null }],
      }
    }
    return {
      provider: row.provider,
      plan: row.plan,
      lines: row.gauges.map((g) =>
        g.stale
          ? { label: g.label, text: 'window rolled', tone: 'muted' as const, percentUsed: null }
          : {
              label: g.label,
              text: `${Math.round(remaining(g))}% left  ${resetLabel(g, now)}`.trimEnd(),
              tone: tone(g.percent),
              percentUsed: g.percent,
            },
      ),
    }
  })
}

export function UsagePanel({
  rows,
  now,
  onClose,
}: {
  rows: ProviderUsage[]
  now: number
  onClose: () => void
}) {
  const model = panelRows(rows, now)
  return (
    <div className="help-overlay" role="dialog" aria-modal="true" aria-label="Agent plan usage">
      <div className="help-card">
        <h2>Plan usage</h2>
        {model.length === 0 && <p className="muted">No usage reported yet.</p>}
        {model.map((row) => (
          <section key={row.provider} className="usage-row">
            <h3>
              {row.provider}
              {row.plan ? <span className="muted"> · {row.plan}</span> : null}
            </h3>
            {row.lines.map((line, i) => (
              <div className="usage-line" key={`${row.provider}-${i}`}>
                <span className="usage-label">{line.label}</span>
                {line.percentUsed === null ? null : (
                  <span className={`usage-bar usage-bar-${line.tone}`} aria-hidden="true">
                    <span style={{ width: `${Math.min(100, Math.max(0, line.percentUsed))}%` }} />
                  </span>
                )}
                <span className={line.tone === 'muted' ? 'muted' : undefined}>{line.text}</span>
              </div>
            ))}
          </section>
        ))}
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}
```

In `app/src/renderer/main.tsx`:

1. Imports beside the router ones:

```tsx
import { UsagePanel } from './UsagePanel'
import { pillLabel, tightest, tone as usageTone } from '../shared/usageView'
import type { ProviderUsage } from '../shared/proto'
```

2. State beside `budgetOpen`/`budget`:

```tsx
  // Agent plan quota. The daemon owns the truth (it polls the providers); this
  // is only the last `Usage` reply plus the dialog's open flag.
  const [usageOpen, setUsageOpen] = useState(false)
  const [usage, setUsage] = useState<ProviderUsage[]>([])
```

3. In the daemon-event handler, beside the `BudgetApplied` arm:

```tsx
      if (bf?.type === 'control' && bf.msg?.kind === 'Usage') {
        setUsage((bf.msg as ControlMsg & { kind: 'Usage' }).providers)
        return
      }
```

4. The poll effect (place it near the other interval effects):

```tsx
  // Pill: 60 s, matching the daemon's own refresh — polling faster only
  // re-reads the same cache. Open dialog: 15 s so a manual check feels live.
  useEffect(() => {
    const ask = () => window.amber?.getUsage?.()
    ask()
    const ms = usageOpen ? 15_000 : 60_000
    const t = setInterval(ask, ms)
    return () => clearInterval(t)
  }, [usageOpen])
```

5. The toolbar pill, next to the router pill (copy the router pill's exact
   element shape from around `main.tsx:1937`), rendered only when
   `pillLabel(usage)` is non-null:

```tsx
        {pillLabel(usage) !== null && (
          <button
            className={`btn web-pill usage-pill web-pill-${usageTone(tightest(usage)?.gauge.percent ?? 0)}`}
            onClick={() => setUsageOpen(true)}
            title="Agent plan usage"
            aria-label={`Agent plan usage: ${pillLabel(usage)}`}
          >
            {pillLabel(usage)}
          </button>
        )}
```

6. The mount, beside `<RouterPanel …/>`:

```tsx
        {usageOpen && (
          <UsagePanel rows={usage} now={Math.floor(Date.now() / 1000)} onClose={() => setUsageOpen(false)} />
        )}
```

7. Add the three small classes to `theme.css` **only** if `.usage-bar` has no
   analogue already — check for an existing bar/meter first:

```bash
grep -n "usage-bar\|meter\|progress" app/src/renderer/theme.css | head
```

If nothing fits, add them next to the existing `.web-pill` block, reusing the
existing tone custom properties rather than new colour literals.

- [ ] **Step 4: Run to verify it passes**

```bash
cd app && npx vitest run src/renderer/usagePanel.test.ts 2>&1 | tail -5
npm run typecheck && npm test 2>&1 | tail -5 && npm run build 2>&1 | tail -3
```

- [ ] **Step 5: Commit**

```bash
git add app/src/renderer/UsagePanel.tsx app/src/renderer/usagePanel.test.ts app/src/renderer/main.tsx app/src/renderer/theme.css
git commit -m "feat(app): add the plan-usage pill and dialog"
```

---

### Task 11: `amber web` — 60 s tick and `GET /api/usage`

**Files:**
- Modify: `crates/amber/src/web.rs` (`HubInner`, the `on_frame` match, a usage tick thread beside the existing 1 s geometry poll, the route table)
- Test: inline tests in `crates/amber/src/web.rs` (mirror the existing route/whitelist tests)

**Interfaces:**
- Consumes: `ControlMsg::{GetUsage, Usage}`.
- Produces: `Hub::usage_json(&self) -> String`; route `("GET", "/api/usage")`.

- [ ] **Step 1: Write the failing tests**

Add to `web.rs`'s test module:

```rust
    #[test]
    fn usage_json_is_an_empty_list_before_the_first_reply() {
        let hub = test_hub(); // mirror the existing helper in this module
        assert_eq!(hub.usage_json(), r#"{"providers":[]}"#);
    }

    #[test]
    fn a_usage_frame_is_cached_for_the_route() {
        let hub = test_hub();
        hub.on_frame(Frame::Control(ControlMsg::Usage {
            providers: vec![ProviderUsage {
                provider: "codex".into(),
                plan: Some("pro".into()),
                gauges: vec![],
                updated: 5,
                state: "ok".into(),
                detail: None,
            }],
        }));
        let body = hub.usage_json();
        assert!(body.contains("\"codex\""), "{body}");
        assert!(body.contains("\"pro\""), "{body}");
    }

    #[test]
    fn the_browser_control_whitelist_is_unchanged_by_usage() {
        // Usage rides an authenticated HTTP route the SERVER owns; no browser
        // socket message may map to any control message it could not before.
        let live = [s("s", "shell")];
        for msg in browser_msgs_for_test() {
            for control in map_browser_msg(&msg, None, &live) {
                assert!(
                    !matches!(control, ControlMsg::GetUsage | ControlMsg::Snapshot
                                     | ControlMsg::ReportRunState { .. }),
                    "browser reached a forbidden control: {control:?}"
                );
            }
        }
    }
```

`browser_msgs_for_test()` may not exist; if not, enumerate the `BrowserMsg`
variants inline in the test, matching how the existing forbidden-control tests
in this file are written.

- [ ] **Step 2: Run to verify they fail**

```bash
cargo test -p amber web::tests::usage 2>&1 | tail -10
```

- [ ] **Step 3: Implement**

Add to `HubInner`:

```rust
    /// Last `Usage` reply, already serialized for `/api/usage`. Empty until the
    /// first tick answers.
    usage: String,
```

initialised to `String::new()`. Add to `Hub`:

```rust
    /// Cached quota snapshot for `/api/usage`. `{"providers":[]}` until the
    /// daemon has answered once — an empty list, never a fabricated zero.
    pub fn usage_json(&self) -> String {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.usage.is_empty() {
            r#"{"providers":[]}"#.to_string()
        } else {
            inner.usage.clone()
        }
    }
```

In `on_frame`'s control match, add:

```rust
        ControlMsg::Usage { providers } => {
            let body = serde_json::json!({ "providers": providers }).to_string();
            if let Ok(mut inner) = self.inner.lock() {
                inner.usage = body;
            }
        }
```

Beside the existing 1 s geometry-poll thread (around `web.rs:1344`), add a
second thread:

```rust
    {
        // Quota tick. Separate from the 1 s session poll on purpose: quota
        // moves on a scale of minutes, and this one crosses the network.
        let hub = Arc::clone(&hub);
        thread::spawn(move || loop {
            hub.write_daemon(&ControlMsg::GetUsage);
            thread::sleep(Duration::from_secs(60));
        });
    }
```

Use whatever the hub's existing "send a control message to the daemon link"
method is actually called (`write_daemon` / `write_daemon_tracking` — read the
geometry poll thread and copy its call). Route, beside `/api/status`:

```rust
        // Agent plan quota (design 2026-09-01 §3). Same cookie boundary as
        // /api/sessions. The browser control whitelist is deliberately NOT
        // widened: the server owns this fetch, so no new ControlMsg becomes
        // reachable from a browser socket.
        ("GET", "/api/usage") => {
            if !auth.authorized(peer, &req) {
                return Ok(respond(&mut stream, "401 Unauthorized", "", &[], b"")?);
            }
            let body = hub.usage_json();
            Ok(respond(&mut stream, "200 OK", CT_JSON, &[], body.as_bytes())?)
        }
```

- [ ] **Step 4: Run to verify they pass**

```bash
cargo test -p amber web:: 2>&1 | tail -10
cargo clippy --workspace --all-targets -- -D warnings
```

- [ ] **Step 5: Commit**

```bash
git add crates/amber/src/web.rs
git commit -m "feat(web): serve agent plan usage behind the session cookie"
```

---

### Task 12: Web shim + Pocket row

**Files:**
- Modify: `app/src/web/amber.ts` (the shim's `amber` object)
- Modify: `app/src/renderer/PocketCommandCenter.tsx` (a compact usage line in the header)
- Test: `app/src/renderer/PocketCommandCenter.test.ts` (extend), and the web shim's existing test file if it has one

**Interfaces:**
- Consumes: `pillLabel`, `tightest`, `tone` (Task 8); `GET /api/usage` (Task 11).
- Produces: `window.amber.getUsage()` on the web host, delivering a synthetic `{type:'control', msg:{kind:'Usage', providers}}` through the same `onDaemonEvent` stream the desktop uses, so the renderer needs no host branch.

- [ ] **Step 1: Write the failing test**

In `PocketCommandCenter.test.ts`:

```ts
  it('shows a compact usage line when a gauge is known', () => {
    expect(usageLine([
      { provider: 'claude', plan: 'pro', updated: 0, state: 'ok', detail: null,
        gauges: [{ kind: 'session', label: '5h window', percent: 15, resets_at: null, stale: false }] },
    ])).toBe('claude 85% left')
  })

  it('shows nothing when no provider reports a gauge', () => {
    expect(usageLine([
      { provider: 'grok', plan: null, updated: 0, state: 'unavailable',
        detail: 'grok exposes no quota data', gauges: [] },
    ])).toBeNull()
  })
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd app && npx vitest run src/renderer/PocketCommandCenter.test.ts 2>&1 | tail -10
```

- [ ] **Step 3: Implement**

In `app/src/renderer/PocketCommandCenter.tsx`, export the pure helper and render
it in the header (beside the machine name):

```tsx
/** "claude 85% left", or null when no provider reports a live gauge. */
export function usageLine(rows: ProviderUsage[]): string | null {
  const best = tightest(rows)
  return best ? `${best.row.provider} ${Math.round(remaining(best.gauge))}% left` : null
}
```

In `app/src/web/amber.ts`, beside the existing `routerStatus` shim:

```ts
  // Quota rides an authenticated HTTP route rather than the pane socket: the
  // browser control whitelist is deliberately not widened. The reply is pushed
  // into the same daemon-event stream the desktop uses, so the renderer needs
  // no host branch.
  getUsage: () => {
    void fetch('/api/usage', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : { providers: [] }))
      .then((body) => {
        emitDaemonEvent({
          type: 'control',
          msg: { kind: 'Usage', providers: decodeUsageProviders(body?.providers) },
        })
      })
      .catch(() => {
        /* a failed poll leaves the last snapshot in place; the next tick retries */
      })
  },
```

`emitDaemonEvent` is whatever this shim already uses to push a frame at the
renderer — read how it delivers `Sessions` and reuse that exact path. Reuse
`proto.ts`'s `decodeProviderUsage` (export it from Task 7 if it is not already)
rather than trusting the HTTP body's shape.

- [ ] **Step 4: Run to verify it passes**

```bash
cd app && npm test 2>&1 | tail -5 && npm run typecheck && npm run build:web 2>&1 | tail -3
```

- [ ] **Step 5: Commit**

```bash
git add app/src/web/amber.ts app/src/renderer/PocketCommandCenter.tsx app/src/renderer/PocketCommandCenter.test.ts
git commit -m "feat(pocket): show plan usage on the mobile command center"
```

---

### Task 13: Gates, live verification, and the CLAUDE.md status entry

**Files:**
- Modify: `CLAUDE.md` (append a build-status entry)
- Create: `.reports/usage-limits.md` (the live-verification record, matching `.reports/remote-access.md`'s style)

**Interfaces:**
- Consumes: everything above.
- Produces: the record this repo keeps for every shipped pass.

- [ ] **Step 1: Run every gate**

```bash
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace 2>&1 | tail -5
cargo test --workspace 2>&1 | tail -5   # twice: this repo has caught flakes on the second run
cd app && npm run typecheck && npm test 2>&1 | tail -5 && npm run build 2>&1 | tail -3 && npm run build:web 2>&1 | tail -3
git diff --check
```

All must pass before proceeding. Record the exact test counts.

- [ ] **Step 2: Live-verify against an ISOLATED private daemon**

Never against the user's real daemon. Follow the `verify-isolated-dev-instance`
memory: a private `XDG_STATE_HOME` and a short `/tmp` socket path.

```bash
export AMBER_TEST_ROOT=$(mktemp -d /tmp/amber-usage.XXXX)
export XDG_STATE_HOME="$AMBER_TEST_ROOT/state"
export AMBER_SOCKET="$AMBER_TEST_ROOT/s"
cargo build -p amber 2>&1 | tail -2
./target/debug/amberd --socket "$AMBER_SOCKET" &          # match the real flag name
sleep 2
./target/debug/amber ctl usage --socket "$AMBER_SOCKET"
./target/debug/amber ctl usage --json --socket "$AMBER_SOCKET"
```

Check, and write each result into `.reports/usage-limits.md`:

1. **claude matches its own truth.** Run claude's `/usage` (or the same curl by
   hand) within the same minute and confirm the percentages agree.
2. **codex matches the newest non-null record**:
   ```bash
   grep -ho '"rate_limits":{.*' $(ls -t ~/.codex/sessions/*/*/*/rollout-*.jsonl | head -20) | tail -1
   ```
3. **grok** prints its unavailable reason and no number.
4. **needs-auth path, without touching the real credential**:
   ```bash
   export CLAUDE_CONFIG_DIR="$AMBER_TEST_ROOT/fakeclaude"; mkdir -p "$CLAUDE_CONFIG_DIR"
   echo '{"claudeAiOauth":{"accessToken":"x","expiresAt":1}}' > "$CLAUDE_CONFIG_DIR/.credentials.json"
   ```
   Restart the private daemon with that env and confirm `needs-auth` with no
   curl spawn (`strace -f -e trace=execve` or simply that it returns instantly).
5. **No token leakage**: `./target/debug/amber ctl usage --json --socket "$AMBER_SOCKET" | grep -c 'sk-ant'` must print `0`.
6. **`/api/usage` is authenticated**: start a private `amber web` on a spare
   port and confirm `curl -s -o /dev/null -w '%{http_code}' localhost:<port>/api/usage`
   returns `401`, then `200` with the cookie.
7. **The GUI**: launch the app against the private daemon (xvfb + CDP, per the
   `verify` skill) and confirm the pill renders, the dialog opens on the real
   `.help-overlay` shell, and the numbers match the CLI's.

Tear the instance down (`kill` the private daemon and web; `rm -rf $AMBER_TEST_ROOT`).

- [ ] **Step 3: Write the report and the status entry**

`.reports/usage-limits.md`: what was run, what was observed, what remains
manual. `CLAUDE.md`: append a build-status bullet in the established voice —
what shipped, the decisions that are load-bearing (curl invocation vs linking;
newest **non-null** codex record; no derived percentages; token never leaves the
daemon; browser whitelist not widened), what is still open, and the standard
**"a running daemon must be restarted to answer `GetUsage`"** note.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md .reports/usage-limits.md
git commit -m "docs: record the usage-limit tracking pass"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1.1 shape (`Gauge`, `ProviderUsage`) | 1 |
| §1.2 claude collector (dir, creds, expiry, curl, `limits[]` preference, codename keys ignored, error states) | 2, 2b |
| §1.3 codex collector (newest non-null, stale, bounds, unavailable) | 3 |
| §1.4 grok honest row | 4 |
| §1.5 poller (60 s, own thread, cache) | 4, 5 |
| §2 protocol (additive, TS mirror, never broadcast) | 1, 5, 7 |
| §3 `amber web` (60 s tick, `/api/usage`, whitelist NOT widened) | 11 |
| §4 desktop pill + dialog (tones, hidden when unknown, `.help-overlay` shell, word-states) | 8, 10 |
| §5 testing (pure parsers, no network, no token in fixtures, live verification) | 2, 2b, 3, 4, 7, 8, 10, 13 |
| §6 files touched | all |
| Pocket row | 12 |
| CLI mirror | 6 |

No gap found.

**Type consistency:** `Gauge`/`ProviderUsage` field names are identical across
Rust (Task 1) and TypeScript (Task 7): `kind`, `label`, `percent`, `resets_at`,
`stale`; `provider`, `plan`, `gauges`, `updated`, `state`, `detail`. `percent`
is USED everywhere on the wire; `remaining()` is the only place it inverts.
`tone()` takes USED. `usage_json` (Rust, Task 11) and `getUsage` (TS, Tasks 9
and 12) are the only two names each side exposes.

**Known adaptation points** (real code the executor must read rather than trust
this document's sketch): the `Eq` derive removal in Task 1; `watch.rs`'s test
harness shape in Task 5; `run_budget`'s exact reply-reading idiom in Task 6;
`proto.test.ts`'s helper names in Task 7; the client dispatch ladder's actual
structure in Task 9; the router pill's exact markup and `theme.css`'s existing
tone tokens in Task 10; the hub's daemon-write method name and test-hub helper
in Task 11; the web shim's event-emit path in Task 12.
