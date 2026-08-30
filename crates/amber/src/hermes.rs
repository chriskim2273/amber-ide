//! Hermes Agent supervision helpers: build resume/fresh argv and install the
//! global plugin that records Hermes session ids. The supervisor loop lives in
//! [`crate::supervisor`].

use std::path::{Path, PathBuf};

/// How to start Hermes: reopen a recorded conversation, or begin a new one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HermesStart { Resume(String), Fresh }

pub const PLUGIN_NAME: &str = "amber-session-hook";
const PLUGIN_MANIFEST: &str = r#"name: amber-session-hook
version: 1.0.0
description: Records Hermes CLI session ids for Amber pane recovery.
provides_hooks:
  - on_session_start
  - on_session_reset
"#;
const PLUGIN_INIT: &str = r#"# Amber-owned Hermes plugin. Records only sessions running in an Amber pane.
import json
import os
import subprocess
import threading

def _record(session_id, platform, **_kwargs):
    if platform not in ("cli", "tui") or not os.environ.get("AMBER_SESSION"):
        return
    payload = json.dumps({"session_id": session_id, "cwd": os.getcwd()}).encode()
    binary = os.environ.get("AMBER_BIN", "amber")
    def write_record():
        try:
            subprocess.run([binary, "hook"], input=payload, stdin=subprocess.PIPE,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           timeout=2, check=False)
        except Exception:
            pass
    threading.Thread(target=write_record, daemon=True).start()

def register(ctx):
    ctx.register_hook("on_session_start", _record)
    ctx.register_hook("on_session_reset", _record)
"#;

/// Build Hermes's argument vector (excluding program itself).
pub fn hermes_argv(start: &HermesStart) -> Vec<String> {
    let mut argv = vec!["--yolo".to_string()];
    if let HermesStart::Resume(id) = start { argv.extend(["--resume".to_string(), id.clone()]); }
    argv
}

/// Hermes CLI/TUI session id: `YYYYMMDD_HHMMSS_<6-or-8-hex>`. Reject titles,
/// prefixes, and `latest`: any could silently resume another detached pane.
pub fn is_session_id(id: &str) -> bool {
    let b = id.as_bytes();
    let suffix = match b.len() { 22 => 6, 24 => 8, _ => return false };
    b[..8].iter().all(u8::is_ascii_digit) && b[8] == b'_'
        && b[9..15].iter().all(u8::is_ascii_digit) && b[15] == b'_'
        && b[16..16 + suffix].iter().all(u8::is_ascii_hexdigit)
}

/// Resolve Hermes through user's login shell, never daemon's own PATH.
pub fn resolve_hermes() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        let shell = crate::platform::default_shell();
        crate::claude::resolve_bin_with(&shell.to_string_lossy(), true, "hermes", &[])
    }
    #[cfg(windows)]
    {
        crate::claude::resolve_bin_windows("hermes")
    }
}

fn hermes_home() -> Option<PathBuf> {
    std::env::var("HERMES_HOME").ok().filter(|p| !p.is_empty()).map(PathBuf::from)
        .or_else(|| crate::platform::user_home().map(|home| home.join(".hermes")))
}

/// Install recorder then enable it through Hermes CLI, never hand-merge user YAML.
pub fn ensure_global_hermes_plugin(hermes_bin: &Path) {
    let Some(home) = hermes_home() else { return };
    ensure_plugin_in(&home);
    match std::process::Command::new(hermes_bin).args(["plugins", "enable", PLUGIN_NAME])
        .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status() {
        Ok(status) if status.success() => {}
        Ok(status) => eprintln!("amber: Hermes plugin enable exited {status}"),
        Err(e) => eprintln!("amber: failed to enable Hermes plugin: {e}"),
    }
}

/// Testable installer core. Only Amber-owned files are changed.
pub fn ensure_plugin_in(home: &Path) {
    let dir = home.join("plugins").join(PLUGIN_NAME);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("amber: failed to create Hermes plugin dir {}: {e}", dir.display()); return;
    }
    for (name, contents) in [("plugin.yaml", PLUGIN_MANIFEST), ("__init__.py", PLUGIN_INIT)] {
        let path = dir.join(name);
        if std::fs::read_to_string(&path).ok().as_deref() == Some(contents) { continue; }
        if let Err(e) = std::fs::write(&path, contents) {
            eprintln!("amber: failed to write Hermes plugin {}: {e}", path.display());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn argv_never_uses_continue() {
        let id = "20260827_091523_a1b2c3";
        assert_eq!(hermes_argv(&HermesStart::Fresh), ["--yolo"]);
        assert_eq!(hermes_argv(&HermesStart::Resume(id.into())), ["--yolo", "--resume", id]);
    }
    #[test]
    fn only_exact_documented_ids_can_resume() {
        assert!(is_session_id("20260827_091523_a1b2c3"));
        assert!(is_session_id("20260827_091523_a1b2c3d4"));
        for id in ["latest", "title", "20260827_091523_a1b2", "20260827_091523_zzzzzz"] { assert!(!is_session_id(id), "{id}"); }
    }
    #[test]
    fn plugin_install_is_idempotent_and_scoped() {
        let home = tempfile::tempdir().unwrap();
        let other = home.path().join("plugins/other.py");
        std::fs::create_dir_all(other.parent().unwrap()).unwrap(); std::fs::write(&other, "keep").unwrap();
        ensure_plugin_in(home.path()); ensure_plugin_in(home.path());
        let dir = home.path().join("plugins").join(PLUGIN_NAME);
        assert_eq!(std::fs::read_to_string(dir.join("plugin.yaml")).unwrap(), PLUGIN_MANIFEST);
        let init = std::fs::read_to_string(dir.join("__init__.py")).unwrap();
        assert!(init.contains("on_session_start") && init.contains("on_session_reset") && init.contains("AMBER_SESSION"));
        assert_eq!(std::fs::read_to_string(other).unwrap(), "keep");
    }
}
