//! Claude supervision helpers: build the resume/continue argv, generate the
//! per-session settings file with the SessionStart hook, record the rotating
//! session id from hook input, and resolve the claude binary via a login shell
//! (spec §6.2, §8). Pure/testable; the supervisor loop lives in `supervisor`.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use amber_core::state::{ClaudeMeta, StateStore};

/// How to start `claude`: resume a specific recorded conversation, continue the
/// most recent one in the cwd, or start a brand-new one. A never-run session
/// must start `Fresh` — `--continue` on it prints "No conversation to continue"
/// and exits, which would burn the supervisor's retry budget.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaudeStart {
    Resume(String),
    Continue,
    Fresh,
}

/// Build claude's argument vector (excluding the program itself) for the given
/// start mode.
pub fn claude_argv(start: &ClaudeStart, settings_path: &Path) -> Vec<String> {
    let mut argv = vec!["--dangerously-skip-permissions".to_string()];
    match start {
        ClaudeStart::Resume(id) => {
            argv.push("--resume".to_string());
            argv.push(id.clone());
        }
        ClaudeStart::Continue => argv.push("--continue".to_string()),
        ClaudeStart::Fresh => {}
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

/// Pre-accept claude's interactive folder-trust dialog for `cwd`. A claude
/// session runs detached in the daemon's pty with no client necessarily
/// attached; an untrusted cwd makes claude block forever on the "trust this
/// folder?" prompt, so the session never starts and its SessionStart hook never
/// records the resume id. Setting `projects.<cwd>.hasTrustDialogAccepted=true`
/// in `~/.claude.json` is exactly what accepting the dialog does. Best-effort:
/// any failure leaves claude to prompt as usual.
pub fn ensure_cwd_trusted(cwd: &Path) {
    if let Ok(home) = std::env::var("HOME") {
        trust_cwd_in(&PathBuf::from(home).join(".claude.json"), cwd);
    }
}

/// Ensure a GLOBAL claude `SessionStart` hook running `hook_command` exists in
/// `~/.claude/settings.json`, so a claude the user starts by hand inside an
/// amber shell also records its resume id (the per-session `--settings` hook
/// only covers amber-launched claude). Idempotent and merge-preserving.
pub fn ensure_global_claude_hook(hook_command: &str) {
    if let Ok(home) = std::env::var("HOME") {
        add_global_hook_in(&PathBuf::from(home).join(".claude").join("settings.json"), hook_command);
    }
}

/// True for `"<path> hook"` where `<path>` is an amber binary that is NOT on
/// disk any more — i.e. a hook left behind by an amber that has been deleted
/// (typically a dev build in a removed git worktree). Deliberately narrow: the
/// command must be exactly two whitespace-separated words, the second `hook`,
/// and the first must end in `amber`, so a user's unrelated SessionStart hook
/// can never match.
fn is_dangling_amber_hook(command: &str) -> bool {
    let mut parts = command.split_whitespace();
    let (Some(path), Some("hook"), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    Path::new(path).file_name().is_some_and(|f| f == "amber") && !Path::new(path).exists()
}

fn add_global_hook_in(config: &Path, hook_command: &str) {
    // Absent or unparseable file -> start fresh (created below). A file that
    // parses to valid JSON of the WRONG shape must be left untouched: warn and
    // continue rather than clobbering the user's settings.
    let parsed = std::fs::read_to_string(config)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
    let mut root = match parsed {
        Some(v) if v.is_object() => v,
        Some(_) => {
            eprintln!(
                "amber: {} has a non-object root; skipping global SessionStart hook install",
                config.display()
            );
            return;
        }
        None => serde_json::json!({}),
    };

    let obj = root.as_object_mut().expect("root is an object here");
    let hooks = obj.entry("hooks").or_insert_with(|| serde_json::json!({}));
    if !hooks.is_object() {
        eprintln!(
            "amber: {} key `hooks` is not an object; skipping global SessionStart hook install",
            config.display()
        );
        return;
    }
    let ss = hooks
        .as_object_mut()
        .expect("hooks is an object here")
        .entry("SessionStart")
        .or_insert_with(|| serde_json::json!([]));
    if !ss.is_array() {
        eprintln!(
            "amber: {} key `hooks.SessionStart` is not an array; skipping global SessionStart hook install",
            config.display()
        );
        return;
    }
    let arr = ss.as_array_mut().expect("SessionStart is an array here");

    // Garbage-collect DANGLING amber hooks first. Dedup below is by exact
    // command string, so every distinct binary path installs its own entry —
    // a dev build run out of a git worktree adds one, and deleting that
    // worktree leaves a hook claude fails on at EVERY session start ("hook
    // error ... not found") until the user hand-edits this file. Self-heal
    // instead: drop `<path> hook` entries whose `<path>` is an amber binary
    // that no longer exists. Anything that isn't ours, and any amber binary
    // still on disk, is left strictly alone.
    for group in arr.iter_mut() {
        let Some(hooks) = group.get_mut("hooks").and_then(|h| h.as_array_mut()) else { continue };
        hooks.retain(|h| {
            let Some(cmd) = h.get("command").and_then(|c| c.as_str()) else { return true };
            !is_dangling_amber_hook(cmd)
        });
    }
    // A group emptied by that sweep was ours alone — drop the husk.
    arr.retain(|group| {
        group
            .get("hooks")
            .and_then(|h| h.as_array())
            .map(|hs| !hs.is_empty())
            .unwrap_or(true)
    });

    // Already installed? Don't duplicate.
    let present = arr.iter().any(|group| {
        group
            .get("hooks")
            .and_then(|h| h.as_array())
            .map(|hs| hs.iter().any(|h| h.get("command").and_then(|c| c.as_str()) == Some(hook_command)))
            .unwrap_or(false)
    });
    if present {
        return;
    }
    arr.push(serde_json::json!({ "hooks": [ { "type": "command", "command": hook_command } ] }));

    if let Some(dir) = config.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(out) = serde_json::to_string_pretty(&root) {
        let tmp = config.with_extension("json.amber-tmp");
        if std::fs::write(&tmp, out).is_ok() {
            let _ = std::fs::rename(&tmp, config);
        }
    }
}

fn trust_cwd_in(config: &Path, cwd: &Path) {
    let Ok(text) = std::fs::read_to_string(config) else { return };
    let Ok(mut root) = serde_json::from_str::<serde_json::Value>(&text) else { return };
    // A non-object root would panic on `root["projects"] = ...` (serde_json
    // IndexMut). Leave any wrong-shaped file untouched: warn and continue.
    let Some(obj) = root.as_object_mut() else {
        eprintln!(
            "amber: {} has a non-object root; skipping folder-trust pre-accept",
            config.display()
        );
        return;
    };
    match obj.get("projects") {
        None => {
            obj.insert("projects".to_string(), serde_json::json!({}));
        }
        Some(p) if p.is_object() => {}
        Some(_) => {
            eprintln!(
                "amber: {} key `projects` is not an object; skipping folder-trust pre-accept",
                config.display()
            );
            return;
        }
    }
    let key = cwd.to_string_lossy().to_string();
    let projects = root["projects"].as_object_mut().expect("projects is an object");
    let entry = projects.entry(key).or_insert_with(|| serde_json::json!({}));
    if !entry.is_object() {
        *entry = serde_json::json!({});
    }
    // Already trusted -> don't rewrite (avoids clobbering claude's own writes).
    if entry.get("hasTrustDialogAccepted").and_then(|v| v.as_bool()) == Some(true) {
        return;
    }
    entry["hasTrustDialogAccepted"] = serde_json::Value::Bool(true);
    if let Ok(out) = serde_json::to_string(&root) {
        let tmp = config.with_extension("json.amber-tmp");
        if std::fs::write(&tmp, &out).is_ok() {
            let _ = std::fs::rename(&tmp, config);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use amber_core::state::StateStore;
    use std::path::Path;
    use tempfile::tempdir;

    #[test]
    fn argv_resumes_a_recorded_id() {
        let argv = claude_argv(&ClaudeStart::Resume("sid-123".into()), Path::new("/s/set.json"));
        assert_eq!(argv[0], "--dangerously-skip-permissions");
        assert!(argv.iter().any(|a| a == "--resume"));
        assert!(argv.iter().any(|a| a == "sid-123"));
        assert!(!argv.iter().any(|a| a == "--continue"));
        let i = argv.iter().position(|a| a == "--settings").unwrap();
        assert_eq!(argv[i + 1], "/s/set.json");
    }

    #[test]
    fn argv_continue_mode() {
        let argv = claude_argv(&ClaudeStart::Continue, Path::new("/s/set.json"));
        assert!(argv.iter().any(|a| a == "--continue"));
        assert!(!argv.iter().any(|a| a == "--resume"));
    }

    #[test]
    fn argv_fresh_has_no_resume_or_continue() {
        // A brand-new session must start clean: no --resume and no --continue.
        let argv = claude_argv(&ClaudeStart::Fresh, Path::new("/s/set.json"));
        assert!(!argv.iter().any(|a| a == "--continue"));
        assert!(!argv.iter().any(|a| a == "--resume"));
        assert!(argv.iter().any(|a| a == "--settings"));
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
    fn trust_cwd_sets_flag_and_preserves_other_config() {
        let dir = tempdir().unwrap();
        let config = dir.path().join(".claude.json");
        std::fs::write(
            &config,
            r#"{"numStartups":5,"projects":{"/existing":{"hasTrustDialogAccepted":true}}}"#,
        )
        .unwrap();
        trust_cwd_in(&config, Path::new("/home/u/proj"));
        let v: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&config).unwrap()).unwrap();
        assert_eq!(v["projects"]["/home/u/proj"]["hasTrustDialogAccepted"], serde_json::json!(true));
        // Unrelated keys and existing projects survive the rewrite.
        assert_eq!(v["numStartups"], serde_json::json!(5));
        assert_eq!(v["projects"]["/existing"]["hasTrustDialogAccepted"], serde_json::json!(true));
    }

    #[test]
    fn add_global_hook_prunes_amber_hooks_whose_binary_is_gone() {
        // Every distinct amber binary path appends its OWN SessionStart entry
        // (dedup is by exact command string). A dev build run from a git
        // worktree therefore leaves a dangling hook behind once that worktree
        // is deleted, and claude then reports a failed SessionStart hook on
        // every session start until the user hand-edits their settings.
        // Installing must clean those up.
        let dir = tempdir().unwrap();
        let config = dir.path().join("settings.json");
        let gone = dir.path().join("worktree/target/debug/amber");
        std::fs::write(
            &config,
            serde_json::to_string(&serde_json::json!({
                "hooks": { "SessionStart": [
                    { "hooks": [ { "type": "command", "command": "~/.claude/hooks/unrelated" } ] },
                    { "hooks": [ { "type": "command", "command": format!("{} hook", gone.display()) } ] }
                ] } }))
            .unwrap(),
        )
        .unwrap();

        add_global_hook_in(&config, "/usr/local/bin/amber hook");

        let after: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        let cmds: Vec<String> = after["hooks"]["SessionStart"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|g| g["hooks"].as_array().unwrap().clone())
            .map(|h| h["command"].as_str().unwrap().to_string())
            .collect();
        assert!(
            !cmds.iter().any(|c| c.starts_with(&gone.display().to_string())),
            "the dangling amber hook must be pruned, got {cmds:?}"
        );
        assert!(cmds.iter().any(|c| c == "/usr/local/bin/amber hook"), "the new hook is installed");
        assert!(
            cmds.iter().any(|c| c == "~/.claude/hooks/unrelated"),
            "a hook that is not ours is never touched, got {cmds:?}"
        );
    }

    #[test]
    fn add_global_hook_keeps_amber_hooks_whose_binary_still_exists() {
        // Only MISSING binaries are pruned — a second, live amber install
        // (say ~/.local/bin plus a dev build) is the user's business.
        let dir = tempdir().unwrap();
        let config = dir.path().join("settings.json");
        let live = dir.path().join("amber");
        std::fs::write(&live, "#!/bin/sh\n").unwrap();
        std::fs::write(
            &config,
            serde_json::to_string(&serde_json::json!({
                "hooks": { "SessionStart": [
                    { "hooks": [ { "type": "command", "command": format!("{} hook", live.display()) } ] }
                ] } }))
            .unwrap(),
        )
        .unwrap();

        add_global_hook_in(&config, "/usr/local/bin/amber hook");

        let after: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        let cmds: Vec<String> = after["hooks"]["SessionStart"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|g| g["hooks"].as_array().unwrap().clone())
            .map(|h| h["command"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(cmds.len(), 2, "the live existing hook and the new one both remain: {cmds:?}");
    }

    #[test]
    fn global_hook_merges_preserves_and_is_idempotent() {
        let dir = tempdir().unwrap();
        let config = dir.path().join("settings.json");
        std::fs::write(
            &config,
            r#"{"theme":"dark","hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"other"}]}]}}"#,
        )
        .unwrap();
        add_global_hook_in(&config, "/x/amber hook");
        add_global_hook_in(&config, "/x/amber hook"); // idempotent
        let v: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&config).unwrap()).unwrap();
        assert_eq!(v["theme"], serde_json::json!("dark")); // unrelated key preserved
        let arr = v["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(arr.len(), 2, "existing hook group preserved, amber added once");
        let amber = arr
            .iter()
            .filter(|g| g["hooks"][0]["command"] == serde_json::json!("/x/amber hook"))
            .count();
        assert_eq!(amber, 1, "amber hook present exactly once");
    }

    #[test]
    fn global_hook_creates_missing_config() {
        let dir = tempdir().unwrap();
        let config = dir.path().join("nested").join("settings.json");
        add_global_hook_in(&config, "/x/amber hook");
        let v: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&config).unwrap()).unwrap();
        assert_eq!(
            v["hooks"]["SessionStart"][0]["hooks"][0]["command"],
            serde_json::json!("/x/amber hook")
        );
    }

    #[test]
    fn trust_cwd_missing_config_is_a_noop() {
        let dir = tempdir().unwrap();
        let config = dir.path().join("absent.json");
        trust_cwd_in(&config, Path::new("/x")); // must not panic or create
        assert!(!config.exists());
    }

    #[test]
    fn global_hook_leaves_array_root_untouched() {
        // settings.json whose root is a JSON array (wrong shape) must be left
        // byte-identical, not clobbered into an object.
        let dir = tempdir().unwrap();
        let config = dir.path().join("settings.json");
        let original = r#"[1,2,3]"#;
        std::fs::write(&config, original).unwrap();
        add_global_hook_in(&config, "/x/amber hook"); // must not panic
        let after = std::fs::read_to_string(&config).unwrap();
        assert_eq!(after, original, "array-root settings.json must be untouched");
    }

    #[test]
    fn global_hook_leaves_array_hooks_untouched() {
        // `"hooks": []` (array instead of object) must be left byte-identical.
        let dir = tempdir().unwrap();
        let config = dir.path().join("settings.json");
        let original = r#"{"theme":"dark","hooks":[]}"#;
        std::fs::write(&config, original).unwrap();
        add_global_hook_in(&config, "/x/amber hook"); // must not panic
        let after = std::fs::read_to_string(&config).unwrap();
        assert_eq!(after, original, "array `hooks` must be untouched");
    }

    #[test]
    fn global_hook_leaves_object_sessionstart_untouched() {
        // `SessionStart` as an object instead of an array must be left as-is.
        let dir = tempdir().unwrap();
        let config = dir.path().join("settings.json");
        let original = r#"{"hooks":{"SessionStart":{"oops":true}}}"#;
        std::fs::write(&config, original).unwrap();
        add_global_hook_in(&config, "/x/amber hook"); // must not panic
        let after = std::fs::read_to_string(&config).unwrap();
        assert_eq!(after, original, "object `SessionStart` must be untouched");
    }

    #[test]
    fn trust_cwd_leaves_string_projects_untouched() {
        // `"projects": "..."` (string instead of object) must be left as-is.
        let dir = tempdir().unwrap();
        let config = dir.path().join(".claude.json");
        let original = r#"{"numStartups":5,"projects":"not-an-object"}"#;
        std::fs::write(&config, original).unwrap();
        trust_cwd_in(&config, Path::new("/home/u/proj")); // must not panic
        let after = std::fs::read_to_string(&config).unwrap();
        assert_eq!(after, original, "string `projects` must be untouched");
    }

    #[test]
    fn trust_cwd_leaves_array_root_untouched() {
        // `.claude.json` whose root is a JSON array is the one shape that truly
        // panics today (serde_json IndexMut on `root["projects"]`). Must be a
        // no-op leaving the file byte-identical.
        let dir = tempdir().unwrap();
        let config = dir.path().join(".claude.json");
        let original = r#"[1,2,3]"#;
        std::fs::write(&config, original).unwrap();
        trust_cwd_in(&config, Path::new("/home/u/proj")); // must not panic
        let after = std::fs::read_to_string(&config).unwrap();
        assert_eq!(after, original, "array-root .claude.json must be untouched");
    }

    #[test]
    fn resolve_returns_none_when_absent() {
        let dir = tempdir().unwrap(); // empty PATH dir, no claude
        let path_env = format!("{}:/bin:/usr/bin", dir.path().display());
        let resolved = resolve_claude_with("sh", false, &[("PATH".to_string(), path_env)]);
        assert!(resolved.is_none());
    }
}
