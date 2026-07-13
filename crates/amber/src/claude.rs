//! Claude supervision helpers: build the resume/continue argv, generate the
//! per-session settings file with the SessionStart hook, record the rotating
//! session id from hook input, and resolve the claude binary via a login shell
//! (spec §6.2, §8). Pure/testable; the supervisor loop lives in `supervisor`.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use amber_core::state::{ClaudeMeta, StateStore};

/// Build claude's argument vector (excluding the program itself). Resumes a
/// recorded conversation when `session_id` is known, else continues the most
/// recent one in the cwd.
pub fn claude_argv(session_id: Option<&str>, settings_path: &Path) -> Vec<String> {
    let mut argv = vec!["--dangerously-skip-permissions".to_string()];
    match session_id {
        Some(id) => {
            argv.push("--resume".to_string());
            argv.push(id.to_string());
        }
        None => argv.push("--continue".to_string()),
    }
    argv.push("--settings".to_string());
    argv.push(settings_path.to_string_lossy().to_string());
    argv
}

/// Path of a session's generated claude settings file.
pub fn settings_path(root: &Path, session_name: &str) -> PathBuf {
    root.join("claude").join(format!("{session_name}.settings.json"))
}

/// Write the per-session settings file whose `SessionStart` hook runs
/// `hook_command` (which records the rotating session id). Returns its path.
pub fn write_settings(root: &Path, session_name: &str, hook_command: &str) -> anyhow::Result<PathBuf> {
    let path = settings_path(root, session_name);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let settings = serde_json::json!({
        "hooks": {
            "SessionStart": [
                { "hooks": [ { "type": "command", "command": hook_command } ] }
            ]
        }
    });
    std::fs::write(&path, serde_json::to_vec_pretty(&settings)?)?;
    Ok(path)
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Record the session id from a SessionStart hook's stdin JSON. Fires on every
/// hook invocation — ids rotate on resume/clear/compaction, last write wins.
pub fn record_session(store: &StateStore, session_name: &str, hook_stdin: &str) -> anyhow::Result<()> {
    let v: serde_json::Value = serde_json::from_str(hook_stdin)?;
    let session_id = v
        .get("session_id")
        .and_then(|s| s.as_str())
        .ok_or_else(|| anyhow::anyhow!("hook input missing session_id"))?
        .to_string();
    let cwd = v
        .get("cwd")
        .and_then(|s| s.as_str())
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    store.write_claude(
        session_name,
        &ClaudeMeta {
            session_id,
            cwd,
            updated: now(),
        },
    )
}

/// Resolve the claude binary through a shell, using an explicit env overlay
/// (tests inject `PATH`). `login` selects `-lic` (user's real PATH) vs `-c`.
pub fn resolve_claude_with(shell: &str, login: bool, extra_env: &[(String, String)]) -> Option<PathBuf> {
    let flag = if login { "-lic" } else { "-c" };
    let out = Command::new(shell)
        .arg(flag)
        .arg("command -v claude")
        .envs(extra_env.iter().cloned())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(PathBuf::from(path))
    }
}

/// Resolve claude via the user's login shell (the distribution-safe path — see
/// spec §8; never trusts the daemon's own PATH).
pub fn resolve_claude() -> Option<PathBuf> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    resolve_claude_with(&shell, true, &[])
}

#[cfg(test)]
mod tests {
    use super::*;
    use amber_core::state::StateStore;
    use std::path::Path;
    use tempfile::tempdir;

    #[test]
    fn argv_resumes_when_session_id_present() {
        let argv = claude_argv(Some("sid-123"), Path::new("/s/set.json"));
        assert_eq!(argv[0], "--dangerously-skip-permissions");
        assert!(argv.iter().any(|a| a == "--resume"));
        assert!(argv.iter().any(|a| a == "sid-123"));
        assert!(!argv.iter().any(|a| a == "--continue"));
        let i = argv.iter().position(|a| a == "--settings").unwrap();
        assert_eq!(argv[i + 1], "/s/set.json");
    }

    #[test]
    fn argv_continues_when_no_session_id() {
        let argv = claude_argv(None, Path::new("/s/set.json"));
        assert!(argv.iter().any(|a| a == "--continue"));
        assert!(!argv.iter().any(|a| a == "--resume"));
    }

    #[test]
    fn record_session_writes_claude_meta() {
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());
        let hook_json = r#"{"session_id":"sid-1","cwd":"/tmp/proj","hook_event_name":"SessionStart"}"#;
        record_session(&store, "work", hook_json).unwrap();
        let meta = store.read_claude("work").unwrap().unwrap();
        assert_eq!(meta.session_id, "sid-1");
        assert_eq!(meta.cwd, Path::new("/tmp/proj"));
    }

    #[test]
    fn record_session_last_write_wins() {
        let dir = tempdir().unwrap();
        let store = StateStore::new(dir.path());
        record_session(&store, "w", r#"{"session_id":"first","cwd":"/a"}"#).unwrap();
        record_session(&store, "w", r#"{"session_id":"second","cwd":"/a"}"#).unwrap();
        assert_eq!(store.read_claude("w").unwrap().unwrap().session_id, "second");
    }

    #[test]
    fn write_settings_embeds_sessionstart_hook() {
        let dir = tempdir().unwrap();
        let path = write_settings(dir.path(), "work", "/usr/bin/amber hook").unwrap();
        assert!(path.exists());
        let v: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let cmd = &v["hooks"]["SessionStart"][0]["hooks"][0]["command"];
        assert_eq!(cmd, "/usr/bin/amber hook");
    }

    #[test]
    fn resolve_finds_claude_on_path() {
        let dir = tempdir().unwrap();
        // fake executable named `claude`
        let fake = dir.path().join("claude");
        std::fs::write(&fake, "#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let path_env = format!("{}:/bin:/usr/bin", dir.path().display());
        let resolved =
            resolve_claude_with("sh", false, &[("PATH".to_string(), path_env)]).unwrap();
        assert_eq!(resolved, fake);
    }

    #[test]
    fn resolve_returns_none_when_absent() {
        let dir = tempdir().unwrap(); // empty PATH dir, no claude
        let path_env = format!("{}:/bin:/usr/bin", dir.path().display());
        let resolved = resolve_claude_with("sh", false, &[("PATH".to_string(), path_env)]);
        assert!(resolved.is_none());
    }
}
