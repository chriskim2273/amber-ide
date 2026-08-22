# Remote Access Control Plane (Phase A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the desktop IDE first-class controls for running, hosting and sharing the browser build of amber (`amber web`) — service lifecycle, tailnet URL + QR, token rotation, connected clients, diagnostics — without ever hand-running a CLI.

**Architecture:** Rust owns everything stateful: a new `amber ctl web <action>` subcommand installs/enables/starts/stops the existing `amber-web` boot unit (templates embedded from `infra/daemon/` with `include_str!`, so the packaged AppImage path works without a git checkout), drives `tailscale serve`, and reads a new authenticated `GET /api/status` on `amber web` itself. The Electron app is a thin controller: `webService.ts` builds argv and parses `--json`, IPC carries it to a toolbar status pill and a "Remote access" dialog. No new daemon protocol, no daemon change at all.

**Tech Stack:** Rust (`crates/amber`, std + `serde_json` + `anyhow`, no new crates), TypeScript strict (Electron main + React renderer), vitest, `qrcode` (pure-JS npm dep, renderer only).

**Spec:** `docs/superpowers/specs/2026-08-22-mobile-web-experience-design.md` (§9 in full; §2.2's borrow bookkeeping is Phase B and only appears here as a nullable field in the status payload).

## Global Constraints

- **No new Rust crates.** `serde_json`, `anyhow`, `clap` and std are already in the tree; `tailscale`, `systemctl`, `launchctl` and `journalctl` are **invoked**, never linked (core rule #8 governs linking; `login_path()` and the 2026-07-29 display-env fix already shell out).
- **No daemon change.** Not `crates/amber/src/daemon.rs`, not `manager.rs`, not `amber-core::proto`. Phase A touches `web.rs`, new Rust modules, `main.rs` CLI wiring, and the app.
- **The token is a full-authority credential.** It never appears outside a URL fragment, never in a log line, never in a window title, never in the pill tooltip, never in a CLI's non-`--json` stdout unless the user asked for the URL explicitly. QR renders only on explicit reveal.
- **The CLI never retries a rejected `/api/auth`.** `Auth::throttled` buckets by peer IP and behind `tailscale serve` every peer is 127.0.0.1, so a retry loop locks the phone out for 60 s (`AUTH_MAX_FAILS = 8`, `AUTH_WINDOW = 60s`).
- **The app parses only `--json`.** Never human text from a CLI.
- Rust gate: `cargo clippy --workspace --all-targets -- -D warnings` clean, `cargo test --workspace` green.
- App gate: `npm run typecheck` and `npx vitest run` green in `app/`.
- Conventional commits, no `Co-Authored-By` lines.

---

### Task 1: `webctl` — unit templates and service argv (Rust, pure)

**Files:**
- Create: `crates/amber/src/webctl.rs`
- Modify: `crates/amber/src/lib.rs` (add `pub mod webctl;`)
- Test: inline `#[cfg(test)] mod tests` in `crates/amber/src/webctl.rs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `pub const SYSTEMD_UNIT_NAME: &str = "amber-web.service"`
  - `pub const LAUNCHD_LABEL: &str = "com.amber-ide.web"`
  - `pub fn render_systemd_unit(bin: &Path, port: u16) -> String`
  - `pub fn render_launchd_plist(bin: &Path, port: u16) -> String`
  - `pub fn unit_path(home: &Path) -> PathBuf`
  - `pub struct Argv { pub cmd: String, pub args: Vec<String> }`
  - `pub fn enable_argv() -> Vec<Argv>`, `disable_argv`, `start_argv`, `stop_argv`, `restart_argv`, `is_active_argv` — each `Vec<Argv>`/`Argv`, platform-gated by `cfg!(target_os)`.

- [ ] **Step 1: Write the failing tests**

Create `crates/amber/src/webctl.rs` with only the test module plus `use` lines:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn systemd_unit_carries_bin_and_port() {
        let u = render_systemd_unit(Path::new("/home/u/.local/bin/amber"), 7717);
        assert!(u.contains("ExecStart=/home/u/.local/bin/amber web --port 7717"), "{u}");
        // The shipped unit is the source of truth for everything else.
        assert!(u.contains("WantedBy=default.target"));
        assert!(u.contains("Wants=amber.service"));
        // %h expansion must be GONE — we write an absolute path, because the
        // packaged app may install the binary somewhere else entirely.
        assert!(!u.contains("%h/.local/bin/amber"), "{u}");
    }

    #[test]
    fn launchd_plist_carries_bin_and_port() {
        let p = render_launchd_plist(Path::new("/opt/amber"), 9001);
        assert!(p.contains("<string>/opt/amber</string>"), "{p}");
        assert!(p.contains("<string>9001</string>"), "{p}");
        assert!(p.contains("<string>com.amber-ide.web</string>"), "{p}");
        assert!(!p.contains("__AMBER_BIN__"), "{p}");
    }

    #[test]
    fn unit_path_is_under_the_users_home() {
        let p = unit_path(Path::new("/home/u"));
        let s = p.to_string_lossy();
        assert!(s.starts_with("/home/u/"), "{s}");
        if cfg!(target_os = "macos") {
            assert!(s.ends_with("Library/LaunchAgents/com.amber-ide.web.plist"), "{s}");
        } else {
            assert!(s.ends_with(".config/systemd/user/amber-web.service"), "{s}");
        }
    }

    #[test]
    fn lifecycle_argv_names_the_web_unit_only() {
        for argv in [start_argv(), stop_argv(), restart_argv(), is_active_argv()] {
            let joined = format!("{} {}", argv.cmd, argv.args.join(" "));
            assert!(
                joined.contains("amber-web") || joined.contains("com.amber-ide.web"),
                "lifecycle argv must never target the daemon unit: {joined}"
            );
            assert!(!joined.contains("amber.service"), "{joined}");
        }
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p amber webctl`
Expected: FAIL to compile — `render_systemd_unit` etc. not found.

- [ ] **Step 3: Write the implementation**

Put this ABOVE the test module in `crates/amber/src/webctl.rs`:

```rust
//! Lifecycle control for the `amber web` boot unit.
//!
//! The units themselves already ship in `infra/daemon/` and are installed by
//! `install.sh --web`. That path needs a git checkout, which a packaged
//! AppImage does not have (its cargo-free first-run install writes only the
//! DAEMON unit), so the templates are embedded here and Rust owns writing
//! them. One implementation serves the repo install, the packaged install and
//! the app's Remote access dialog.

use std::path::{Path, PathBuf};

/// systemd user unit file name (matches `infra/daemon/amber-web.service`).
pub const SYSTEMD_UNIT_NAME: &str = "amber-web.service";
/// launchd label (matches `infra/daemon/com.amber-ide.web.plist.in`).
pub const LAUNCHD_LABEL: &str = "com.amber-ide.web";

const SYSTEMD_TEMPLATE: &str = include_str!("../../../infra/daemon/amber-web.service");
const LAUNCHD_TEMPLATE: &str = include_str!("../../../infra/daemon/com.amber-ide.web.plist.in");

/// One command to run. Mirrors the app's `serviceManager.ts` `Argv` shape so
/// both sides of the boundary describe a process the same way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Argv {
    pub cmd: String,
    pub args: Vec<String>,
}

fn argv(cmd: &str, args: &[&str]) -> Argv {
    Argv { cmd: cmd.to_string(), args: args.iter().map(|s| s.to_string()).collect() }
}

/// The systemd unit with an ABSOLUTE binary path substituted for the shipped
/// `%h/.local/bin/amber`: the packaged app may install `amber` elsewhere, and
/// `%h` would silently point at a binary that is not the one we control.
pub fn render_systemd_unit(bin: &Path, port: u16) -> String {
    SYSTEMD_TEMPLATE.replace(
        "ExecStart=%h/.local/bin/amber web --port 7717",
        &format!("ExecStart={} web --port {port}", bin.display()),
    )
}

pub fn render_launchd_plist(bin: &Path, port: u16) -> String {
    LAUNCHD_TEMPLATE
        .replace("__AMBER_BIN__", &bin.display().to_string())
        .replace("<string>7717</string>", &format!("<string>{port}</string>"))
}

/// Where the unit file belongs for this platform.
pub fn unit_path(home: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        home.join("Library").join("LaunchAgents").join(format!("{LAUNCHD_LABEL}.plist"))
    } else {
        home.join(".config").join("systemd").join("user").join(SYSTEMD_UNIT_NAME)
    }
}

pub fn enable_argv() -> Vec<Argv> {
    if cfg!(target_os = "macos") {
        vec![argv("launchctl", &["load", "-w", "__UNIT__"])]
    } else {
        vec![
            argv("systemctl", &["--user", "daemon-reload"]),
            argv("systemctl", &["--user", "enable", SYSTEMD_UNIT_NAME]),
            argv("systemctl", &["--user", "restart", SYSTEMD_UNIT_NAME]),
        ]
    }
}

pub fn disable_argv() -> Vec<Argv> {
    if cfg!(target_os = "macos") {
        vec![argv("launchctl", &["unload", "-w", "__UNIT__"])]
    } else {
        vec![
            argv("systemctl", &["--user", "stop", SYSTEMD_UNIT_NAME]),
            argv("systemctl", &["--user", "disable", SYSTEMD_UNIT_NAME]),
        ]
    }
}

pub fn start_argv() -> Argv {
    if cfg!(target_os = "macos") {
        argv("launchctl", &["load", "__UNIT__"])
    } else {
        argv("systemctl", &["--user", "start", SYSTEMD_UNIT_NAME])
    }
}

pub fn stop_argv() -> Argv {
    if cfg!(target_os = "macos") {
        argv("launchctl", &["unload", "__UNIT__"])
    } else {
        argv("systemctl", &["--user", "stop", SYSTEMD_UNIT_NAME])
    }
}

pub fn restart_argv() -> Argv {
    if cfg!(target_os = "macos") {
        argv("launchctl", &["kickstart", "-k", &format!("gui/__UID__/{LAUNCHD_LABEL}")])
    } else {
        argv("systemctl", &["--user", "restart", SYSTEMD_UNIT_NAME])
    }
}

pub fn is_active_argv() -> Argv {
    if cfg!(target_os = "macos") {
        argv("launchctl", &["print", &format!("gui/__UID__/{LAUNCHD_LABEL}")])
    } else {
        argv("systemctl", &["--user", "is-active", SYSTEMD_UNIT_NAME])
    }
}
```

The `__UNIT__` / `__UID__` placeholders are substituted by the runner in Task 4 (they need a home dir and a uid, which these pure functions deliberately do not take).

Add to `crates/amber/src/lib.rs`:

```rust
pub mod webctl;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p amber webctl`
Expected: PASS, 4 tests.

- [ ] **Step 5: Clippy**

Run: `cargo clippy -p amber --all-targets -- -D warnings`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add crates/amber/src/webctl.rs crates/amber/src/lib.rs
git commit -m "feat(webctl): embed amber-web unit templates and lifecycle argv"
```

---

### Task 2: `tailscale` — state detection and serve mapping (Rust)

**Files:**
- Create: `crates/amber/src/tailscale.rs`
- Modify: `crates/amber/src/lib.rs` (add `pub mod tailscale;`)
- Test: inline `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `pub enum TailState { NotInstalled, NotLoggedIn, NotRunning, ServeNotMapped { host: String }, Serving { host: String } }`
  - `pub fn parse_status(json: &str) -> Result<(String /*dns name*/, bool /*logged in*/), String>`
  - `pub fn parse_serve(json: &str, port: u16) -> bool`
  - `pub fn https_url(host: &str, token: &str) -> String`
  - `pub fn detect(port: u16) -> TailState` (runs the commands)
  - `pub fn enable_serve(port: u16) -> Result<(), String>`

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    // Trimmed shape of `tailscale status --json`. Only the fields we read.
    const STATUS_UP: &str = r#"{
      "BackendState": "Running",
      "Self": { "DNSName": "desk.tailnet-abc.ts.net.", "Online": true }
    }"#;

    const STATUS_LOGGED_OUT: &str = r#"{
      "BackendState": "NeedsLogin",
      "Self": { "DNSName": "", "Online": false }
    }"#;

    // `tailscale serve status --json` with 7717 mapped.
    const SERVE_MAPPED: &str = r#"{
      "TCP": { "443": { "HTTPS": true } },
      "Web": { "desk.tailnet-abc.ts.net:443": { "Handlers": {
          "/": { "Proxy": "http://127.0.0.1:7717" } } } }
    }"#;

    const SERVE_OTHER_PORT: &str = r#"{
      "Web": { "desk.tailnet-abc.ts.net:443": { "Handlers": {
          "/": { "Proxy": "http://127.0.0.1:8080" } } } }
    }"#;

    #[test]
    fn status_yields_dns_name_without_trailing_dot() {
        let (host, logged_in) = parse_status(STATUS_UP).expect("parses");
        assert_eq!(host, "desk.tailnet-abc.ts.net");
        assert!(logged_in);
    }

    #[test]
    fn logged_out_is_reported_not_guessed() {
        let (_host, logged_in) = parse_status(STATUS_LOGGED_OUT).expect("parses");
        assert!(!logged_in);
    }

    #[test]
    fn malformed_status_is_an_error_not_a_panic() {
        assert!(parse_status("not json").is_err());
        assert!(parse_status("{}").is_err());
    }

    #[test]
    fn serve_mapping_matches_only_our_port() {
        assert!(parse_serve(SERVE_MAPPED, 7717));
        assert!(!parse_serve(SERVE_MAPPED, 8080));
        assert!(!parse_serve(SERVE_OTHER_PORT, 7717));
        assert!(!parse_serve("not json", 7717));
    }

    #[test]
    fn url_puts_the_token_in_the_fragment_and_targets_the_app_build() {
        let u = https_url("desk.tailnet-abc.ts.net", "abc123");
        assert_eq!(u, "https://desk.tailnet-abc.ts.net/app#t=abc123");
        // The token must never precede the '#': everything before it is sent
        // to the server and lands in logs.
        let (before, _after) = u.split_once('#').expect("has a fragment");
        assert!(!before.contains("abc123"), "{u}");
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p amber tailscale`
Expected: FAIL to compile — functions not found.

- [ ] **Step 3: Implement**

```rust
//! `tailscale` integration for `amber web`.
//!
//! Shelling out, not linking (core rule #8 governs linking; `login_path()` and
//! the 2026-07-29 display-env fix already invoke external commands). Every
//! failure is CLASSIFIED, never collapsed into "it didn't work" — the UI shows
//! the user which of the four things to fix.

use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TailState {
    NotInstalled,
    NotRunning,
    NotLoggedIn,
    ServeNotMapped { host: String },
    Serving { host: String },
}

/// `(dns name without trailing dot, logged in)`.
pub fn parse_status(json: &str) -> Result<(String, bool), String> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let backend = v.get("BackendState").and_then(|b| b.as_str()).ok_or("no BackendState")?;
    let host = v
        .get("Self")
        .and_then(|s| s.get("DNSName"))
        .and_then(|d| d.as_str())
        .unwrap_or("")
        .trim_end_matches('.')
        .to_string();
    Ok((host, backend == "Running"))
}

/// Whether `tailscale serve` proxies anything to `127.0.0.1:<port>`.
pub fn parse_serve(json: &str, port: u16) -> bool {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return false };
    let needle = format!("127.0.0.1:{port}");
    fn walk(v: &serde_json::Value, needle: &str) -> bool {
        match v {
            serde_json::Value::String(s) => s.ends_with(needle),
            serde_json::Value::Array(a) => a.iter().any(|x| walk(x, needle)),
            serde_json::Value::Object(o) => o.values().any(|x| walk(x, needle)),
            _ => false,
        }
    }
    walk(&v, &needle)
}

/// The phone URL. Token rides the FRAGMENT — never a query string, which the
/// server would receive and log.
pub fn https_url(host: &str, token: &str) -> String {
    format!("https://{host}/app#t={token}")
}

fn run(args: &[&str]) -> Result<String, std::io::Error> {
    let out = Command::new("tailscale").args(args).output()?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

pub fn detect(port: u16) -> TailState {
    let status = match run(&["status", "--json"]) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return TailState::NotInstalled,
        Err(_) => return TailState::NotRunning,
    };
    let Ok((host, logged_in)) = parse_status(&status) else { return TailState::NotRunning };
    if !logged_in || host.is_empty() {
        return TailState::NotLoggedIn;
    }
    let mapped = run(&["serve", "status", "--json"]).map(|s| parse_serve(&s, port)).unwrap_or(false);
    if mapped { TailState::Serving { host } } else { TailState::ServeNotMapped { host } }
}

pub fn enable_serve(port: u16) -> Result<(), String> {
    let out = Command::new("tailscale")
        .args(["serve", "--bg", &port.to_string()])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p amber tailscale`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add crates/amber/src/tailscale.rs crates/amber/src/lib.rs
git commit -m "feat(tailscale): classify tailnet state and build the phone URL"
```

---

### Task 3: `GET /api/status` on `amber web`

**Files:**
- Modify: `crates/amber/src/web.rs` (add the route beside `("GET", "/api/sessions")` at ~`:1136`; add a `Hub` accessor near `sessions_json` at `:626`)
- Test: `crates/amber/src/web.rs` inline tests (the file already has a large `#[cfg(test)]` module)

**Interfaces:**
- Consumes: `Auth::valid_cookie` (existing), `HubInner::clients` (existing, `Client { id, open, tx }` at `web.rs:555`).
- Produces: `Hub::status_json(&self, port: u16) -> String` — a JSON object:
  ```json
  {"port":7717,"uptime_secs":123,"clients":[{"id":4,"open":"amber-1-1-0-ab","borrow":null}],
   "sessions":6}
  ```
  `borrow` is always `null` in Phase A; Phase B (§2.2) fills it.

- [ ] **Step 1: Write the failing tests**

Add to `web.rs`'s existing test module:

```rust
#[test]
fn status_json_lists_open_sessions_per_client() {
    let hub = test_hub();               // existing helper in this module
    let (tx, _rx) = std::sync::mpsc::sync_channel(4);
    {
        let mut inner = hub.inner.lock().unwrap();
        inner.clients.push(Client { id: 7, open: Some("amber-1-1-0-ab".into()), tx });
    }
    let body = hub.status_json(7717);
    let v: serde_json::Value = serde_json::from_str(&body).expect("valid json");
    assert_eq!(v["port"], 7717);
    assert_eq!(v["clients"][0]["id"], 7);
    assert_eq!(v["clients"][0]["open"], "amber-1-1-0-ab");
    assert!(v["clients"][0]["borrow"].is_null());
    assert!(v["uptime_secs"].is_number());
}

#[test]
fn status_json_never_contains_the_token() {
    let hub = test_hub();
    let body = hub.status_json(7717);
    assert!(!body.contains("t="), "{body}");
    // Belt and braces: no 32-byte hex blob shape anywhere in the payload.
    assert!(!body.chars().collect::<String>().contains("token"), "{body}");
}
```

If `test_hub()` does not already exist in the module, add it next to the other helpers:

```rust
fn test_hub() -> Hub {
    Hub::new(std::path::PathBuf::from("/nonexistent.sock"), std::path::PathBuf::from("/tmp"))
}
```

(Check the real `Hub::new` signature first with `grep -n "impl Hub" -A 20 crates/amber/src/web.rs` and match it — do not guess.)

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p amber status_json`
Expected: FAIL — `status_json` not found.

- [ ] **Step 3: Implement `Hub::status_json` + the route**

Add a `started: Instant` field to `Hub` (set in `Hub::new`), then beside `sessions_json`:

```rust
    /// Operator-facing snapshot for `amber ctl web status`. Deliberately holds
    /// NO secret: the token is a full-authority credential and this payload is
    /// logged, piped and pasted by definition.
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
```

Route, immediately after the `/api/sessions` arm:

```rust
        ("GET", "/api/status") => {
            if !auth.valid_cookie(&req) {
                return Ok(respond(&mut stream, "401 Unauthorized", "", &[], b"")?);
            }
            let body = hub.status_json(port);
            Ok(respond(&mut stream, "200 OK", CT_JSON, &[], body.as_bytes())?)
        }
```

`handle_conn` does not currently know the port; thread it through from `serve()` (which already binds the listener) as a `u16` parameter alongside `hub`/`auth`.

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p amber status_json` then `cargo test -p amber`
Expected: PASS; the whole `amber` suite still green.

- [ ] **Step 5: Add the auth test**

```rust
#[test]
fn status_requires_the_cookie() {
    // Mirror the existing `/api/sessions` auth test in this module exactly —
    // find it with: grep -n "api/sessions" crates/amber/src/web.rs
    // and copy its request-construction, changing only the path.
}
```

Fill it in from the neighbouring `/api/sessions` test rather than inventing a new harness.

- [ ] **Step 6: Commit**

```bash
git add crates/amber/src/web.rs
git commit -m "feat(web): authenticated GET /api/status for operator tooling"
```

---

### Task 4: `amber ctl web <action>` CLI

**Files:**
- Modify: `crates/amber/src/main.rs` (add a `Web` variant to `enum CtlAction` at `:172`; add `run_ctl_web`)
- Test: `crates/amber/tests/ctl_web.rs` (new integration test)

**Interfaces:**
- Consumes: `webctl::*` (Task 1), `tailscale::*` (Task 2), `/api/status` (Task 3), `amber::web::{load_or_create_token, TOKEN_FILE}`.
- Produces: CLI surface
  `amber ctl web status|start|stop|restart|enable|disable|url|rotate-token [--json] [--port N] [--root PATH]`.
  `--json` shape for `status`:
  ```json
  {"unit":"active","port":7717,"url":"https://desk.ts.net/app#t=…","tailscale":"serving",
   "host":"desk.ts.net","clients":[…],"sessions":6,"uptime_secs":123,"error":null}
  ```
  `tailscale` is one of `not-installed|not-logged-in|not-running|serve-not-mapped|serving`.

- [ ] **Step 1: Write the failing test**

`crates/amber/tests/ctl_web.rs`:

```rust
//! `amber ctl web` surface tests. These drive the BINARY, because the point of
//! the subcommand is its argv/JSON contract with the Electron app.

use std::process::Command;

fn amber() -> Command {
    Command::new(env!("CARGO_BIN_EXE_amber"))
}

#[test]
fn status_json_is_json_even_when_nothing_is_running() {
    let dir = tempfile::tempdir().expect("tmp");
    let out = amber()
        .args(["ctl", "web", "status", "--json", "--root"])
        .arg(dir.path())
        .output()
        .expect("runs");
    let body = String::from_utf8_lossy(&out.stdout);
    let v: serde_json::Value = serde_json::from_str(&body).expect("valid json, got: {body}");
    assert!(v.get("unit").is_some(), "{body}");
    assert!(v.get("tailscale").is_some(), "{body}");
    // Nothing is serving in a fresh root, and that is a REPORT, not an error:
    // exit 0 so the app can distinguish "off" from "the CLI broke".
    assert!(out.status.success(), "{body}");
}

#[test]
fn url_prints_the_token_only_on_the_url_subcommand() {
    let dir = tempfile::tempdir().expect("tmp");
    let url_out = amber().args(["ctl", "web", "url", "--root"]).arg(dir.path()).output().expect("runs");
    let url = String::from_utf8_lossy(&url_out.stdout).trim().to_string();
    assert!(url.contains("#t="), "{url}");

    let status_out = amber()
        .args(["ctl", "web", "status", "--json", "--root"])
        .arg(dir.path())
        .output()
        .expect("runs");
    let status = String::from_utf8_lossy(&status_out.stdout);
    let token = url.split("#t=").nth(1).unwrap().to_string();
    // `status --json` MAY carry the url (the app renders it), but must never
    // leak the token through any other field.
    let v: serde_json::Value = serde_json::from_str(&status).expect("json");
    for (k, val) in v.as_object().unwrap() {
        if k == "url" { continue }
        assert!(!val.to_string().contains(&token), "token leaked in field {k}");
    }
}
```

Add `tempfile` to `[dev-dependencies]` of `crates/amber/Cargo.toml` if it is not already there (check first: `grep -n tempfile crates/amber/Cargo.toml`).

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p amber --test ctl_web`
Expected: FAIL — `error: unrecognized subcommand 'web'`.

- [ ] **Step 3: Add the CLI variant**

In `enum CtlAction`:

```rust
    /// Control the `amber web` browser/mobile server: service lifecycle, the
    /// phone URL, tailscale mapping, and live status. `--json` is the contract
    /// the desktop app consumes; human output is for people only.
    Web {
        #[command(subcommand)]
        action: WebAction,
        /// Port the service listens on (must match the installed unit).
        #[arg(long, default_value_t = 7717, global = true)]
        port: u16,
        /// Emit machine-readable JSON.
        #[arg(long, global = true)]
        json: bool,
        #[arg(long, global = true)]
        root: Option<PathBuf>,
    },
```

```rust
#[derive(clap::Subcommand, Debug)]
enum WebAction {
    /// Report unit state, tailscale state, URL and connected clients.
    Status,
    Start,
    Stop,
    Restart,
    /// Install + enable the boot unit (opt-in: it opens a local port), then
    /// map it with `tailscale serve`.
    Enable,
    /// Stop + disable the boot unit. Leaves the tailscale mapping alone.
    Disable,
    /// Print the tokenised phone URL.
    Url,
    /// Regenerate the token, invalidating every existing link and cookie.
    RotateToken,
}
```

- [ ] **Step 4: Implement `run_ctl_web`**

```rust
/// `amber ctl web <action>`.
///
/// Two hard rules live here:
/// 1. The token appears ONLY in `url` (and in `status --json`'s `url` field,
///    which the app renders behind an explicit reveal). Never elsewhere.
/// 2. `/api/status` is reached with a token→cookie exchange and EXACTLY ONE
///    attempt. `Auth::throttled` buckets by peer IP and behind
///    `tailscale serve` every peer is 127.0.0.1, so a retry loop would burn
///    the 8-failure budget and lock the PHONE out for 60 s.
fn run_ctl_web(
    action: WebAction,
    port: u16,
    json: bool,
    root: Option<PathBuf>,
) -> anyhow::Result<()> {
    let root = root.unwrap_or_else(default_root);
    std::fs::create_dir_all(&root)?;
    match action {
        WebAction::Url => {
            let token = amber::web::load_or_create_token(&root, false)?;
            println!("{}", local_url(port, &token));
            Ok(())
        }
        WebAction::RotateToken => {
            let token = amber::web::load_or_create_token(&root, true)?;
            // Rotation only takes effect for NEW cookie exchanges once the
            // server re-reads it, and existing cookies live in the server's
            // memory — so restart it. That is the invalidation.
            let _ = run_argv(&webctl::restart_argv(), &root);
            if json {
                println!("{}", serde_json::json!({ "ok": true }));
            } else {
                println!("token rotated; every existing link and device is logged out");
            }
            let _ = token;
            Ok(())
        }
        WebAction::Enable => { /* write unit, run enable_argv, then tailscale::enable_serve(port) */ }
        WebAction::Disable => { /* run disable_argv */ }
        WebAction::Start | WebAction::Stop | WebAction::Restart => { /* run the matching argv */ }
        WebAction::Status => { /* gather + print */ }
    }
}
```

Write out each arm fully — the sketch above marks WHERE, the bodies follow this shape:

```rust
        WebAction::Enable => {
            let home = std::env::var("HOME").map(PathBuf::from)?;
            let bin = std::env::current_exe()?;
            let unit = webctl::unit_path(&home);
            if let Some(parent) = unit.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let body = if cfg!(target_os = "macos") {
                webctl::render_launchd_plist(&bin, port)
            } else {
                webctl::render_systemd_unit(&bin, port)
            };
            std::fs::write(&unit, body)?;
            for a in webctl::enable_argv() {
                run_argv(&a, &unit)?;
            }
            match tailscale::enable_serve(port) {
                Ok(()) => {}
                Err(e) => eprintln!("amber ctl web: tailscale serve failed: {e}"),
            }
            if json {
                println!("{}", serde_json::json!({ "ok": true, "unit": unit.display().to_string() }));
            } else {
                println!("amber web enabled at boot ({})", unit.display());
            }
            Ok(())
        }
```

Helper for placeholder substitution and execution:

```rust
/// Run one `webctl::Argv`, substituting the placeholders those pure builders
/// deliberately leave in (`__UNIT__`, `__UID__`).
fn run_argv(a: &webctl::Argv, unit: &Path) -> anyhow::Result<std::process::Output> {
    let uid = unsafe { libc::getuid() }.to_string();
    let args: Vec<String> = a
        .args
        .iter()
        .map(|s| s.replace("__UNIT__", &unit.display().to_string()).replace("__UID__", &uid))
        .collect();
    Ok(std::process::Command::new(&a.cmd).args(&args).output()?)
}
```

`nix` is already a dependency of this crate — prefer `nix::unistd::getuid()` over `unsafe libc` (check with `grep -n "^nix" crates/amber/Cargo.toml`; if `nix` is present use it and drop the `unsafe` block entirely).

Status arm:

```rust
        WebAction::Status => {
            let unit_state = match run_argv(&webctl::is_active_argv(), &webctl::unit_path(&PathBuf::from(std::env::var("HOME").unwrap_or_default()))) {
                Ok(o) if o.status.success() => "active",
                Ok(_) => "inactive",
                Err(_) => "unknown",
            };
            let tail = tailscale::detect(port);
            let token = amber::web::load_or_create_token(&root, false)?;
            let (tail_label, host) = match &tail {
                tailscale::TailState::NotInstalled => ("not-installed", String::new()),
                tailscale::TailState::NotRunning => ("not-running", String::new()),
                tailscale::TailState::NotLoggedIn => ("not-logged-in", String::new()),
                tailscale::TailState::ServeNotMapped { host } => ("serve-not-mapped", host.clone()),
                tailscale::TailState::Serving { host } => ("serving", host.clone()),
            };
            let url = if host.is_empty() {
                local_url(port, &token)
            } else {
                tailscale::https_url(&host, &token)
            };
            let live = fetch_status(port, &token);   // None when the server is down
            if json {
                let mut out = serde_json::json!({
                    "unit": unit_state,
                    "port": port,
                    "url": url,
                    "tailscale": tail_label,
                    "host": host,
                    "error": serde_json::Value::Null,
                });
                match live {
                    Some(v) => {
                        out["clients"] = v.get("clients").cloned().unwrap_or(serde_json::Value::Null);
                        out["sessions"] = v.get("sessions").cloned().unwrap_or(serde_json::Value::Null);
                        out["uptime_secs"] = v.get("uptime_secs").cloned().unwrap_or(serde_json::Value::Null);
                    }
                    None => out["error"] = serde_json::Value::String("server unreachable".into()),
                }
                println!("{out}");
            } else {
                println!("unit: {unit_state}\nport: {port}\ntailscale: {tail_label}");
                println!("url:  (run `amber ctl web url`)");
            }
            Ok(())
        }
```

```rust
fn local_url(port: u16, token: &str) -> String {
    format!("http://127.0.0.1:{port}/app#t={token}")
}

/// Token → cookie → `/api/status`, over plain TCP to 127.0.0.1. ONE auth
/// attempt, ever (see this function's caller for why).
fn fetch_status(port: u16, token: &str) -> Option<serde_json::Value> {
    use std::io::{Read, Write};
    let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).ok()?;
    s.set_read_timeout(Some(std::time::Duration::from_secs(3))).ok()?;
    let req = format!(
        "POST /api/auth HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{token}",
        token.len()
    );
    s.write_all(req.as_bytes()).ok()?;
    let mut head = String::new();
    s.read_to_string(&mut head).ok()?;
    // No retry on 401: the throttle buckets every peer at 127.0.0.1 behind
    // `tailscale serve`, so retrying locks the phone out.
    let cookie = head
        .lines()
        .find_map(|l| l.strip_prefix("Set-Cookie: "))
        .and_then(|c| c.split(';').next())?
        .to_string();

    let mut s2 = std::net::TcpStream::connect(("127.0.0.1", port)).ok()?;
    s2.set_read_timeout(Some(std::time::Duration::from_secs(3))).ok()?;
    let req2 = format!(
        "GET /api/status HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: {cookie}\r\nConnection: close\r\n\r\n"
    );
    s2.write_all(req2.as_bytes()).ok()?;
    let mut body = String::new();
    s2.read_to_string(&mut body).ok()?;
    let json = body.split("\r\n\r\n").nth(1)?;
    serde_json::from_str(json).ok()
}
```

Wire the dispatch in `main()`'s `Command::Ctl { action } => match action { … }` (`main.rs:275`):

```rust
                CtlAction::Web { action, port, json, root } => run_ctl_web(action, port, json, root),
```

- [ ] **Step 5: Run to verify pass**

Run: `cargo test -p amber --test ctl_web`
Expected: PASS, 2 tests.

- [ ] **Step 6: Full gate + commit**

```bash
cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings
git add crates/amber/src/main.rs crates/amber/tests/ctl_web.rs crates/amber/Cargo.toml
git commit -m "feat(cli): amber ctl web status/start/stop/enable/url/rotate-token"
```

---

### Task 5: `webService.ts` — the app's typed view of the CLI

**Files:**
- Create: `app/src/main/webService.ts`
- Create: `app/src/main/webService.test.ts`

**Interfaces:**
- Consumes: the `--json` contract from Task 4.
- Produces:
  ```ts
  export type TailscaleState =
    | 'not-installed' | 'not-logged-in' | 'not-running' | 'serve-not-mapped' | 'serving'
  export interface WebClient { id: number; open: string | null; borrow: unknown | null }
  export interface WebStatus {
    unit: 'active' | 'inactive' | 'unknown'
    port: number
    url: string
    tailscale: TailscaleState
    host: string
    clients: WebClient[]
    sessions: number | null
    uptimeSecs: number | null
    error: string | null
  }
  export function webCtlArgv(action: string, port: number): string[]
  export function parseWebStatus(stdout: string): WebStatus
  export function redactUrl(url: string): string
  ```

- [ ] **Step 1: Write the failing tests**

`app/src/main/webService.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { webCtlArgv, parseWebStatus, redactUrl } from './webService'

describe('webCtlArgv', () => {
  it('always asks for json and passes the port', () => {
    expect(webCtlArgv('status', 7717)).toEqual(['ctl', 'web', 'status', '--json', '--port', '7717'])
  })
})

describe('parseWebStatus', () => {
  const ok = JSON.stringify({
    unit: 'active', port: 7717, url: 'https://desk.ts.net/app#t=abc',
    tailscale: 'serving', host: 'desk.ts.net',
    clients: [{ id: 3, open: 'amber-1-1-0-ab', borrow: null }],
    sessions: 6, uptime_secs: 90, error: null,
  })

  it('maps snake_case to camelCase and keeps the client list', () => {
    const s = parseWebStatus(ok)
    expect(s.unit).toBe('active')
    expect(s.uptimeSecs).toBe(90)
    expect(s.clients[0]?.open).toBe('amber-1-1-0-ab')
  })

  it('never throws on garbage — a broken CLI must not kill the dialog', () => {
    const s = parseWebStatus('not json at all')
    expect(s.unit).toBe('unknown')
    expect(s.error).toBeTruthy()
  })

  it('rejects an unknown tailscale label instead of trusting it', () => {
    const s = parseWebStatus(JSON.stringify({ unit: 'active', tailscale: 'wat' }))
    expect(s.tailscale).toBe('not-installed')
  })
})

describe('redactUrl', () => {
  it('hides the fragment token for anything that gets logged', () => {
    expect(redactUrl('https://desk.ts.net/app#t=secret123')).toBe('https://desk.ts.net/app#t=…')
  })
  it('leaves a token-free url alone', () => {
    expect(redactUrl('https://desk.ts.net/app')).toBe('https://desk.ts.net/app')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd app && npx vitest run src/main/webService.test.ts`
Expected: FAIL — cannot resolve `./webService`.

- [ ] **Step 3: Implement**

```ts
// Typed view of `amber ctl web --json`. The app parses ONLY json (a plan-level
// constraint): human CLI output is for humans and changes freely.

export type TailscaleState =
  | 'not-installed' | 'not-logged-in' | 'not-running' | 'serve-not-mapped' | 'serving'

const TAIL_STATES: readonly TailscaleState[] = [
  'not-installed', 'not-logged-in', 'not-running', 'serve-not-mapped', 'serving',
]

export interface WebClient { id: number; open: string | null; borrow: unknown | null }

export interface WebStatus {
  unit: 'active' | 'inactive' | 'unknown'
  port: number
  url: string
  tailscale: TailscaleState
  host: string
  clients: WebClient[]
  sessions: number | null
  uptimeSecs: number | null
  error: string | null
}

export function webCtlArgv(action: string, port: number): string[] {
  return ['ctl', 'web', action, '--json', '--port', String(port)]
}

/** Parse, never throw: a dialog that dies on malformed CLI output is worse
 *  than one that shows 'unknown'. */
export function parseWebStatus(stdout: string): WebStatus {
  const base: WebStatus = {
    unit: 'unknown', port: 0, url: '', tailscale: 'not-installed', host: '',
    clients: [], sessions: null, uptimeSecs: null, error: null,
  }
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(stdout) as Record<string, unknown>
  } catch {
    return { ...base, error: 'could not parse `amber ctl web status --json`' }
  }
  const unit = raw['unit']
  const tail = raw['tailscale']
  return {
    ...base,
    unit: unit === 'active' || unit === 'inactive' ? unit : 'unknown',
    port: typeof raw['port'] === 'number' ? raw['port'] : 0,
    url: typeof raw['url'] === 'string' ? raw['url'] : '',
    tailscale: TAIL_STATES.includes(tail as TailscaleState) ? (tail as TailscaleState) : 'not-installed',
    host: typeof raw['host'] === 'string' ? raw['host'] : '',
    clients: Array.isArray(raw['clients'])
      ? (raw['clients'] as Record<string, unknown>[]).map((c) => ({
          id: typeof c['id'] === 'number' ? c['id'] : 0,
          open: typeof c['open'] === 'string' ? c['open'] : null,
          borrow: c['borrow'] ?? null,
        }))
      : [],
    sessions: typeof raw['sessions'] === 'number' ? raw['sessions'] : null,
    uptimeSecs: typeof raw['uptime_secs'] === 'number' ? raw['uptime_secs'] : null,
    error: typeof raw['error'] === 'string' ? raw['error'] : null,
  }
}

/** For logs and any surface that is not the deliberate reveal: the fragment
 *  token grants full session control. */
export function redactUrl(url: string): string {
  const i = url.indexOf('#t=')
  return i === -1 ? url : `${url.slice(0, i)}#t=…`
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd app && npx vitest run src/main/webService.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/webService.ts app/src/main/webService.test.ts
git commit -m "feat(app): typed parser for amber ctl web --json"
```

---

### Task 6: IPC wiring + toolbar status pill

**Files:**
- Modify: `app/src/main/index.ts` (IPC handlers next to the existing daemon-menu handlers around `:340`)
- Modify: `app/src/preload/index.ts` (expose `web` methods on `window.amber`)
- Modify: `app/src/renderer/main.tsx` (pill in the toolbar)
- Modify: `app/src/renderer/theme.css` (pill styles)
- Modify: `app/src/web/install.ts` (the web build's shim must expose the same methods as no-ops — the browser cannot manage a service)
- Test: `app/src/main/webService.test.ts` (extend), plus typecheck

**Interfaces:**
- Consumes: `webCtlArgv`, `parseWebStatus` (Task 5); `amberBinary()` (existing, `app/src/main/amberBin.ts`).
- Produces on `window.amber`:
  ```ts
  webStatus(): Promise<WebStatus>
  webAction(action: 'start'|'stop'|'restart'|'enable'|'disable'|'rotate-token'): Promise<{ ok: boolean; error?: string }>
  webLogTail(): Promise<string>
  webOpenLocal(): Promise<void>
  ```

- [ ] **Step 1: Add the main-process handlers**

In `app/src/main/index.ts`:

```ts
import { webCtlArgv, parseWebStatus, redactUrl, type WebStatus } from './webService'

const WEB_PORT = 7717

function runAmber(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(amberBinary(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    p.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    p.on('error', (e) => resolve({ code: -1, stdout: '', stderr: String(e) }))
  })
}

ipcMain.handle('web:status', async (): Promise<WebStatus> => {
  const { stdout } = await runAmber(webCtlArgv('status', WEB_PORT))
  return parseWebStatus(stdout)
})

ipcMain.handle('web:action', async (_e, action: string) => {
  const allowed = ['start', 'stop', 'restart', 'enable', 'disable', 'rotate-token']
  if (!allowed.includes(action)) return { ok: false, error: `unknown action ${action}` }
  const { code, stderr } = await runAmber(webCtlArgv(action, WEB_PORT))
  return code === 0 ? { ok: true } : { ok: false, error: stderr.trim() }
})

ipcMain.handle('web:logTail', async (): Promise<string> => {
  if (process.platform === 'linux') {
    const p = spawn('journalctl', ['--user', '-u', 'amber-web.service', '-n', '200', '--no-pager'])
    return await new Promise((resolve) => {
      let out = ''
      p.stdout.on('data', (d: Buffer) => { out += d.toString() })
      p.on('close', () => resolve(out))
      p.on('error', (e) => resolve(String(e)))
    })
  }
  // macOS: launchd has no journal — read the agent's stderr file.
  try {
    return await readFile(join(homedir(), 'Library', 'Logs', 'amber-web.log'), 'utf8')
  } catch (e) {
    return `no log available: ${String(e)}`
  }
})

ipcMain.handle('web:openLocal', async () => {
  // The LOCAL url, token included — this opens the user's own browser on the
  // user's own machine. Log the redacted form only.
  const { stdout } = await runAmber(['ctl', 'web', 'url', '--port', String(WEB_PORT)])
  const url = stdout.trim()
  console.log('[amber] opening', redactUrl(url))
  await shell.openExternal(url)
})
```

macOS note: the launchd plist must gain `StandardErrorPath` pointing at `~/Library/Logs/amber-web.log` for that read to find anything — add it to `infra/daemon/com.amber-ide.web.plist.in` in this task (spec §12.2 records the asymmetry).

- [ ] **Step 2: Expose in preload**

`app/src/preload/index.ts`, alongside the existing methods:

```ts
  webStatus: () => ipcRenderer.invoke('web:status'),
  webAction: (action: string) => ipcRenderer.invoke('web:action', action),
  webLogTail: () => ipcRenderer.invoke('web:logTail'),
  webOpenLocal: () => ipcRenderer.invoke('web:openLocal'),
```

- [ ] **Step 3: No-op the methods in the web shim**

`app/src/web/install.ts` — the browser build has no service to manage, and the renderer must not crash reading `window.amber.webStatus`:

```ts
    webStatus: async () => ({
      unit: 'unknown' as const, port: 0, url: '', tailscale: 'not-installed' as const,
      host: '', clients: [], sessions: null, uptimeSecs: null,
      error: 'remote access is managed from the desktop app',
    }),
    webAction: async () => ({ ok: false, error: 'not available in the browser' }),
    webLogTail: async () => '',
    webOpenLocal: async () => {},
```

- [ ] **Step 4: Add the pill**

In `main.tsx`'s toolbar, next to the existing controls:

```tsx
const [webStatus, setWebStatus] = useState<WebStatus | null>(null)
const [remoteOpen, setRemoteOpen] = useState(false)

useEffect(() => {
  let cancelled = false
  const poll = async (): Promise<void> => {
    const s = await window.amber?.webStatus?.()
    if (!cancelled && s) setWebStatus(s)
  }
  void poll()
  // Poll only while the dialog is open; otherwise refresh on focus.
  if (!remoteOpen) {
    const onFocus = (): void => { void poll() }
    window.addEventListener('focus', onFocus)
    return () => { cancelled = true; window.removeEventListener('focus', onFocus) }
  }
  const t = setInterval(() => { void poll() }, 3000)
  return () => { cancelled = true; clearInterval(t) }
}, [remoteOpen])

const webDot =
  webStatus?.unit === 'active' && webStatus.tailscale === 'serving' ? 'serving'
  : webStatus?.unit === 'active' ? 'local'
  : webStatus?.error ? 'error'
  : 'off'
```

```tsx
<button
  className={`web-pill web-pill-${webDot}`}
  title="Remote access"          // NEVER the url — it carries the token
  aria-label={`Remote access: ${webDot}`}
  onClick={() => setRemoteOpen(true)}
>
  <span className="web-dot" /> remote
</button>
```

`theme.css`:

```css
.web-pill { display: inline-flex; align-items: center; gap: 6px; height: 26px;
  padding: 0 10px; border-radius: 13px; font-size: 11.5px; cursor: pointer; }
.web-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fg-dim); }
.web-pill-serving .web-dot { background: #3fb950; }
.web-pill-local   .web-dot { background: #d29922; }
.web-pill-error   .web-dot { background: #f85149; }
```

- [ ] **Step 5: Gate**

Run: `cd app && npm run typecheck && npx vitest run`
Expected: both green.

- [ ] **Step 6: Commit**

```bash
git add app/src/main/index.ts app/src/preload/index.ts app/src/web/install.ts \
        app/src/renderer/main.tsx app/src/renderer/theme.css \
        infra/daemon/com.amber-ide.web.plist.in
git commit -m "feat(app): remote-access IPC and toolbar status pill"
```

---

### Task 7: Remote access dialog

**Files:**
- Create: `app/src/renderer/RemoteAccess.tsx`
- Modify: `app/src/renderer/main.tsx` (render it when `remoteOpen`)
- Modify: `app/src/renderer/theme.css` (dialog styles)
- Modify: `app/package.json` (add `qrcode` + `@types/qrcode`)
- Test: `app/src/renderer/remoteAccess.test.ts` (pure helpers only — renderer components stay test-deferred per repo pattern)

**Interfaces:**
- Consumes: `window.amber.web*` (Task 6), `WebStatus` (Task 5).
- Produces: `export function diagnosticRows(s: WebStatus): { label: string; ok: boolean; hint: string }[]` — the pure part, unit-tested; the component itself is not.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { diagnosticRows } from './RemoteAccess'
import type { WebStatus } from '../main/webService'

const base: WebStatus = {
  unit: 'active', port: 7717, url: 'https://d.ts.net/app#t=x', tailscale: 'serving',
  host: 'd.ts.net', clients: [], sessions: 0, uptimeSecs: 1, error: null,
}

describe('diagnosticRows', () => {
  it('is all-green when the unit is active and tailscale is serving', () => {
    expect(diagnosticRows(base).every((r) => r.ok)).toBe(true)
  })

  it('names the fix for each tailscale failure instead of a dead red row', () => {
    for (const [state, needle] of [
      ['not-installed', 'install'],
      ['not-logged-in', 'tailscale up'],
      ['not-running', 'start'],
      ['serve-not-mapped', 'serve'],
    ] as const) {
      const row = diagnosticRows({ ...base, tailscale: state }).find((r) => r.label === 'tailscale')
      expect(row?.ok).toBe(false)
      expect(row?.hint.toLowerCase()).toContain(needle)
    }
  })

  it('flags an inactive unit', () => {
    const row = diagnosticRows({ ...base, unit: 'inactive' }).find((r) => r.label === 'service')
    expect(row?.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd app && npx vitest run src/renderer/remoteAccess.test.ts`
Expected: FAIL — cannot resolve `./RemoteAccess`.

- [ ] **Step 3: Implement the pure helper + component**

```tsx
import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type { WebStatus } from '../main/webService'

export function diagnosticRows(s: WebStatus): { label: string; ok: boolean; hint: string }[] {
  const tail = ((): { ok: boolean; hint: string } => {
    switch (s.tailscale) {
      case 'serving': return { ok: true, hint: `serving ${s.host}` }
      case 'serve-not-mapped': return { ok: false, hint: 'run: tailscale serve --bg 7717' }
      case 'not-logged-in': return { ok: false, hint: 'run: tailscale up' }
      case 'not-running': return { ok: false, hint: 'start the tailscaled service' }
      case 'not-installed': return { ok: false, hint: 'install tailscale to reach this from a phone' }
    }
  })()
  return [
    { label: 'service', ok: s.unit === 'active', hint: s.unit === 'active' ? `up ${s.uptimeSecs ?? 0}s` : 'not running — press Start' },
    { label: 'tailscale', ...tail },
    { label: 'daemon', ok: s.sessions !== null, hint: s.sessions === null ? 'server unreachable' : `${s.sessions} sessions` },
  ]
}
```

Component behaviour, in order of the dialog:

1. Header: title + close.
2. Toggle row: Start / Stop / Restart buttons calling `window.amber.webAction`, then re-poll.
3. "Enable at boot" button → `webAction('enable')`.
4. URL row: `redactUrl` shown by default with a **Reveal** toggle; Copy button copies the real URL.
5. **Show QR** button — renders `await QRCode.toDataURL(status.url)` into an `<img>`, hidden until clicked, with the warning line: *"Anyone with this code has full control of your sessions."*
6. Rotate token: `window.confirm('Rotate the token? Every phone and browser is logged out.')` then `webAction('rotate-token')`.
7. Clients table: `id`, `open`, borrow marker (`borrow` is `null` in Phase A → render `—`).
8. Diagnostics: `diagnosticRows(status)` as ✓/✗ + hint.
9. Log tail: `<pre>` filled from `webLogTail()`, refresh button.
10. "Open on this machine" → `webOpenLocal()`.

- [ ] **Step 4: Add the dependency**

```bash
cd app && npm install qrcode && npm install -D @types/qrcode
```

`qrcode` is pure JS (no native addon — core rule #8). Verify: `node -e "require('qrcode')"` from `app/`.

- [ ] **Step 5: Run to verify pass**

Run: `cd app && npx vitest run src/renderer/remoteAccess.test.ts && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add app/src/renderer/RemoteAccess.tsx app/src/renderer/remoteAccess.test.ts \
        app/src/renderer/main.tsx app/src/renderer/theme.css app/package.json app/package-lock.json
git commit -m "feat(app): remote access dialog with QR, diagnostics and clients"
```

---

### Task 8: Live verification against a private instance

**Files:**
- Create: `.reports/remote-access.md`
- Modify: `CLAUDE.md` (build-status entry)

Verification runs against an **isolated** instance so the user's real daemon, sessions and tailnet config are never touched — the established pattern in this repo (see the `verify-isolated-dev-instance` memory).

- [ ] **Step 1: Start a private daemon + web server**

```bash
export AMBER_TEST_ROOT=$(mktemp -d /tmp/amber-rt.XXXX)
target/debug/amber daemon --root "$AMBER_TEST_ROOT" --socket "$AMBER_TEST_ROOT/s" &
target/debug/amber web --root "$AMBER_TEST_ROOT" --socket "$AMBER_TEST_ROOT/s" --port 7919 &
```

- [ ] **Step 2: Verify `status --json` reports a LIVE server**

```bash
target/debug/amber ctl web status --json --root "$AMBER_TEST_ROOT" --port 7919 | tee /tmp/st.json
```
Expected: valid JSON; `sessions` and `uptime_secs` are numbers (proves the auth exchange + `/api/status` worked, not just the unit probe).

- [ ] **Step 3: Verify the throttle is not burned by status polling**

```bash
for i in $(seq 1 12); do
  target/debug/amber ctl web status --json --root "$AMBER_TEST_ROOT" --port 7919 >/dev/null
done
target/debug/amber ctl web url --root "$AMBER_TEST_ROOT" --port 7919
```
Then exchange that URL's token by hand (`curl -si -X POST --data "<token>" http://127.0.0.1:7919/api/auth`).
Expected: **204**, not 429. Twelve status calls must not lock out a real client.

- [ ] **Step 4: Verify a bad token is rejected once, without a retry storm**

```bash
target/debug/amber ctl web status --json --root "$AMBER_TEST_ROOT" --port 7919 > /dev/null
printf 'wrong' > "$AMBER_TEST_ROOT/web-token"
target/debug/amber ctl web status --json --root "$AMBER_TEST_ROOT" --port 7919 | grep -c unreachable
```
Expected: `1` — reports the failure, exits 0, one auth attempt.

- [ ] **Step 5: Verify the token never leaks**

```bash
target/debug/amber ctl web status --json --root "$AMBER_TEST_ROOT" --port 7919 \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print([k for k,v in d.items() if k!='url' and 't=' in str(v)])"
```
Expected: `[]`.

- [ ] **Step 6: Verify the app dialog end-to-end**

Use the `verify` skill (`Skill(verify)`) to drive the GUI headless (xvfb + CDP) against this private instance: open the Remote access dialog, confirm the pill colour matches the CLI's `unit`/`tailscale`, reveal + copy the URL, render the QR, run the log tail, and press Restart and see the pill go `off → serving`.

- [ ] **Step 7: Write the report and update CLAUDE.md**

`.reports/remote-access.md` records each command, its real output, and anything that did NOT get verified (a real tailnet, macOS launchd, the packaged AppImage path). Then add a build-status entry to `CLAUDE.md` in the established style, stating plainly what is proven and what is still manual.

- [ ] **Step 8: Commit**

```bash
git add .reports/remote-access.md CLAUDE.md
git commit -m "docs: record remote-access control plane verification"
```

---

## Self-Review

**Spec coverage (§9):** 9.1 service/packaged gap → Tasks 1, 4 (`ctl web enable` writes the unit). 9.2 CLI → Task 4. 9.3 `/api/status` + two-step auth + no-retry → Tasks 3, 4, verified in Task 8 steps 3–4. 9.4 tailscale, four named states → Task 2, surfaced in Task 7's `diagnosticRows`. 9.5 pill + dialog with all four user-chosen features (rotate, clients, diagnostics + log tail, open-locally) → Tasks 6, 7. 9.6 security (fragment-only token, hidden QR, redaction, confirm-gated rotate) → Tasks 2, 5, 6, 7, asserted in Tasks 4 and 8.

**Not in this plan, by design:** §1–§8 (mobile UX) are Phase B. §2.2's borrow appears only as a `null` field so the status payload does not change shape when Phase B lands.

**Known follow-ups for Phase B's plan:** `borrow` population, and whether `WEB_PORT` should stop being a constant in `index.ts` once the dialog can edit the port.
