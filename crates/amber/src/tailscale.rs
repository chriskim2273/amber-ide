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

impl TailState {
    /// Stable label for the `--json` contract the app consumes.
    pub fn label(&self) -> &'static str {
        match self {
            TailState::NotInstalled => "not-installed",
            TailState::NotRunning => "not-running",
            TailState::NotLoggedIn => "not-logged-in",
            TailState::ServeNotMapped { .. } => "serve-not-mapped",
            TailState::Serving { .. } => "serving",
        }
    }

    /// The tailnet host, when we know one.
    pub fn host(&self) -> &str {
        match self {
            TailState::ServeNotMapped { host } | TailState::Serving { host } => host,
            _ => "",
        }
    }
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
///
/// A recursive value walk rather than a fixed path: the serve-status shape has
/// changed across tailscale releases, and the only thing we actually need to
/// know is whether OUR backend appears anywhere in it.
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

    #[test]
    fn labels_are_the_json_contract_the_app_matches_on() {
        assert_eq!(TailState::NotInstalled.label(), "not-installed");
        assert_eq!(TailState::NotRunning.label(), "not-running");
        assert_eq!(TailState::NotLoggedIn.label(), "not-logged-in");
        assert_eq!(TailState::ServeNotMapped { host: "h".into() }.label(), "serve-not-mapped");
        assert_eq!(TailState::Serving { host: "h".into() }.label(), "serving");
        assert_eq!(TailState::Serving { host: "h".into() }.host(), "h");
        assert_eq!(TailState::NotRunning.host(), "");
    }
}
