//! Codex (OpenAI Codex CLI) supervision helpers: build resume/fresh argv and
//! install the global SessionStart hook. Pure/testable; the supervisor loop
//! lives in `supervisor`.
//!
//! Codex is Claude-shaped, not Grok-shaped: it does not let amber assign a
//! session id on create (`codex resume <id>` only). Amber therefore installs a
//! global SessionStart hook in `$CODEX_HOME/hooks.json` (default
//! `~/.codex/hooks.json`) that runs `amber hook`, reusing the same recorder
//! path as claude (`claude/<name>.json` + `AMBER_SESSION`).

use std::path::{Path, PathBuf};

/// How to start `codex`: reopen a recorded conversation, or begin a new one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodexStart {
    Resume(String),
    Fresh,
}

/// Build codex's argument vector (excluding the program itself).
///
/// `--dangerously-bypass-approvals-and-sandbox` is codex's unattended equivalent
/// of claude's `--dangerously-skip-permissions` / grok's `bypassPermissions`.
/// `--dangerously-bypass-hook-trust` is required so an untrusted SessionStart
/// hook cannot hang a detached pane waiting for interactive trust.
pub fn codex_argv(start: &CodexStart) -> Vec<String> {
    let mut argv = match start {
        CodexStart::Resume(id) => vec!["resume".to_string(), id.clone()],
        CodexStart::Fresh => Vec::new(),
    };
    argv.push("--dangerously-bypass-approvals-and-sandbox".to_string());
    argv.push("--dangerously-bypass-hook-trust".to_string());
    argv
}

/// Non-empty id suitable for `codex resume <id>`. Empty/whitespace would make
/// clap treat the next flag as the session id or open the interactive picker
/// — both wrong for a detached supervisor.
pub fn is_session_id(id: &str) -> bool {
    !id.trim().is_empty()
}

/// Resolve the codex binary via the user's login shell — never the daemon's
/// own PATH (same distribution-safe path claude/grok take).
pub fn resolve_codex() -> Option<PathBuf> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    crate::claude::resolve_bin_with(&shell, true, "codex", &[])
}

/// Path of the Codex hooks file amber merges into.
///
/// Honours `CODEX_HOME` when set (must be a directory — matches codex's own
/// `find_codex_home`); otherwise `~/.codex/hooks.json`.
pub fn hooks_path() -> Option<PathBuf> {
    if let Ok(home) = std::env::var("CODEX_HOME") {
        let p = PathBuf::from(home);
        if p.is_dir() {
            return Some(p.join("hooks.json"));
        }
    }
    std::env::var("HOME")
        .ok()
        .map(|h| PathBuf::from(h).join(".codex").join("hooks.json"))
}

/// Ensure a global Codex `SessionStart` hook running `hook_command` exists in
/// the Codex hooks file. Idempotent and merge-preserving. Shape (Codex rejects
/// root-level event keys):
///
/// ```json
/// { "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": "…" }] }] } }
/// ```
pub fn ensure_global_codex_hook(hook_command: &str) {
    if let Some(path) = hooks_path() {
        add_global_hook_in(&path, hook_command);
    }
}

/// Testable core of [`ensure_global_codex_hook`].
pub fn add_global_hook_in(config: &Path, hook_command: &str) {
    let parsed = std::fs::read_to_string(config)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
    let mut root = match parsed {
        Some(v) if v.is_object() => v,
        Some(_) => {
            eprintln!(
                "amber: {} has a non-object root; skipping Codex SessionStart hook install",
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
            "amber: {} key `hooks` is not an object; skipping Codex SessionStart hook install",
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
            "amber: {} key `hooks.SessionStart` is not an array; skipping Codex SessionStart hook install",
            config.display()
        );
        return;
    }
    let arr = ss.as_array_mut().expect("SessionStart is an array here");

    // GC dangling amber hooks first (same class as claude's global settings).
    for group in arr.iter_mut() {
        let Some(hooks) = group.get_mut("hooks").and_then(|h| h.as_array_mut()) else {
            continue;
        };
        hooks.retain(|h| {
            let Some(cmd) = h.get("command").and_then(|c| c.as_str()) else {
                return true;
            };
            !crate::claude::is_dangling_amber_hook(cmd)
        });
    }
    arr.retain(|group| {
        group
            .get("hooks")
            .and_then(|h| h.as_array())
            .map(|hs| !hs.is_empty())
            .unwrap_or(true)
    });

    let already = arr.iter().any(|group| {
        group
            .get("hooks")
            .and_then(|h| h.as_array())
            .is_some_and(|hs| {
                hs.iter().any(|h| {
                    h.get("command").and_then(|c| c.as_str()) == Some(hook_command)
                        && h.get("type").and_then(|t| t.as_str()) == Some("command")
                })
            })
    });
    if already {
        // Still rewrite if GC removed anything, so the file stays clean.
        // Fall through only when we need to append; if nothing changed, write
        // is still fine (idempotent).
    } else {
        arr.push(serde_json::json!({
            "hooks": [{ "type": "command", "command": hook_command }]
        }));
    }

    if let Some(parent) = config.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match serde_json::to_vec_pretty(&root) {
        Ok(bytes) => {
            if let Err(e) = std::fs::write(config, bytes) {
                eprintln!(
                    "amber: failed to write Codex hooks {}: {e}",
                    config.display()
                );
            }
        }
        Err(e) => {
            eprintln!(
                "amber: failed to serialize Codex hooks {}: {e}",
                config.display()
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn argv_fresh_is_unattended_without_resume() {
        let argv = codex_argv(&CodexStart::Fresh);
        assert!(!argv.iter().any(|a| a == "resume"));
        assert!(!argv.iter().any(|a| a == "--last"));
        assert!(argv.iter().any(|a| a == "--dangerously-bypass-approvals-and-sandbox"));
        assert!(argv.iter().any(|a| a == "--dangerously-bypass-hook-trust"));
    }

    #[test]
    fn argv_resumes_a_recorded_id() {
        let id = "7f9f9a2e-1b3c-4c7a-9b0e-example-id";
        let argv = codex_argv(&CodexStart::Resume(id.into()));
        assert_eq!(argv[0], "resume");
        assert_eq!(argv[1], id);
        assert!(!argv.iter().any(|a| a == "--last"));
        assert!(argv.iter().any(|a| a == "--dangerously-bypass-approvals-and-sandbox"));
        assert!(argv.iter().any(|a| a == "--dangerously-bypass-hook-trust"));
    }

    #[test]
    fn session_id_rejects_empty() {
        assert!(!is_session_id(""));
        assert!(!is_session_id("   "));
        assert!(is_session_id("7f9f9a2e-1b3c-4c7a-9b0e-example-id"));
        assert!(is_session_id("my-named-session"));
    }

    #[test]
    fn installs_session_start_hook_under_hooks_key() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("hooks.json");
        add_global_hook_in(&config, "/opt/amber hook");

        let v: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&config).unwrap()).unwrap();
        let cmd = &v["hooks"]["SessionStart"][0]["hooks"][0]["command"];
        assert_eq!(cmd, "/opt/amber hook");
        assert_eq!(v["hooks"]["SessionStart"][0]["hooks"][0]["type"], "command");
        // Root-level SessionStart would be rejected by Codex.
        assert!(v.get("SessionStart").is_none());
    }

    #[test]
    fn dedupes_exact_command() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("hooks.json");
        add_global_hook_in(&config, "/opt/amber hook");
        add_global_hook_in(&config, "/opt/amber hook");

        let v: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&config).unwrap()).unwrap();
        let arr = v["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
    }

    #[test]
    fn preserves_unrelated_hooks_and_events() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("hooks.json");
        fs::write(
            &config,
            r#"{
              "description": "user hooks",
              "hooks": {
                "PreToolUse": [{ "hooks": [{ "type": "command", "command": "echo pre" }] }],
                "SessionStart": [{ "hooks": [{ "type": "command", "command": "other hook" }] }]
              }
            }"#,
        )
        .unwrap();

        add_global_hook_in(&config, "/opt/amber hook");

        let v: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&config).unwrap()).unwrap();
        assert_eq!(v["description"], "user hooks");
        assert_eq!(
            v["hooks"]["PreToolUse"][0]["hooks"][0]["command"],
            "echo pre"
        );
        let cmds: Vec<&str> = v["hooks"]["SessionStart"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|g| g["hooks"].as_array().unwrap())
            .map(|h| h["command"].as_str().unwrap())
            .collect();
        assert!(cmds.contains(&"other hook"));
        assert!(cmds.contains(&"/opt/amber hook"));
    }

    #[test]
    fn gcs_dangling_amber_hook() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("hooks.json");
        let missing = dir.path().join("gone").join("amber");
        fs::write(
            &config,
            serde_json::json!({
                "hooks": {
                    "SessionStart": [{
                        "hooks": [
                            { "type": "command", "command": format!("{} hook", missing.display()) },
                            { "type": "command", "command": "other" }
                        ]
                    }]
                }
            })
            .to_string(),
        )
        .unwrap();

        add_global_hook_in(&config, "/opt/amber hook");

        let v: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&config).unwrap()).unwrap();
        let cmds: Vec<String> = v["hooks"]["SessionStart"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|g| g["hooks"].as_array().unwrap())
            .filter_map(|h| h["command"].as_str().map(str::to_string))
            .collect();
        assert!(!cmds.iter().any(|c| c.contains("gone")));
        assert!(cmds.iter().any(|c| c == "other"));
        assert!(cmds.iter().any(|c| c == "/opt/amber hook"));
    }

    #[test]
    fn leaves_wrong_shape_file_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("hooks.json");
        let original = r#"["not","an","object"]"#;
        fs::write(&config, original).unwrap();

        add_global_hook_in(&config, "/opt/amber hook");

        assert_eq!(fs::read_to_string(&config).unwrap(), original);
    }
}
