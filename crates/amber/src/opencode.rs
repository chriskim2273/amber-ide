//! OpenCode supervision helpers: build resume/fresh argv and install the
//! global plugin that records the session id. Pure/testable; the supervisor
//! loop lives in `supervisor`.
//!
//! OpenCode is Claude-shaped, not Grok-shaped: `-s` / `--session` continues an
//! existing conversation and does not assign an id on create. Amber therefore
//! installs a global plugin at `~/.config/opencode/plugins/amber-hook.js` that
//! fires on `session.created` and runs `amber hook`, reusing the same recorder
//! path as claude (`claude/<name>.json` + `AMBER_SESSION`).
//!
//! Resume is `opencode --auto -s <ses_…>`. Fresh is `opencode --auto`. Never
//! `-c` / `--continue` (that hijacks the most recent conversation in the cwd).

use std::path::{Path, PathBuf};

/// How to start `opencode`: reopen a recorded conversation, or begin a new one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenCodeStart {
    Resume(String),
    Fresh,
}

/// Plugin filename under the OpenCode plugins directory. Stable so we can
/// overwrite our own file on upgrade without touching anyone else's plugins.
pub const PLUGIN_FILE: &str = "amber-hook.js";

/// The plugin amber installs. It is env-driven (`AMBER_SESSION` / `AMBER_BIN`)
/// so a dangling binary path never accumulates the way a hardcoded hook
/// command does. Subagent sessions (`parentID` set) are ignored so a child
/// conversation cannot clobber the pane's recorded id.
pub const PLUGIN_JS: &str = r#"// amber-hook.js — records OpenCode session ids for amber resume.
// Loaded from the OpenCode plugins directory. Uses AMBER_SESSION / AMBER_BIN
// set by `amber run`; does nothing outside an amber pane.
export const AmberHook = async ({ directory }) => ({
  event: async ({ event }) => {
    if (event.type !== "session.created") return
    if (!process.env.AMBER_SESSION) return
    const props = event.properties || {}
    if (props.info && props.info.parentID) return
    const id = props.sessionID || (props.info && props.info.id)
    if (!id) return
    const cwd = (props.info && props.info.directory) || directory || process.cwd()
    const bin = process.env.AMBER_BIN || "amber"
    try {
      const { spawn } = await import("node:child_process")
      const child = spawn(bin, ["hook"], { stdio: ["pipe", "ignore", "ignore"] })
      child.on("error", () => {})
      child.stdin.end(JSON.stringify({ session_id: id, cwd }))
    } catch {}
  },
})
"#;

/// Build opencode's argument vector (excluding the program itself).
///
/// `--auto` is opencode's unattended equivalent of claude's
/// `--dangerously-skip-permissions`: a pane runs detached in the daemon's pty,
/// so an approval prompt nobody is watching would hang the session.
pub fn opencode_argv(start: &OpenCodeStart) -> Vec<String> {
    let mut argv = vec!["--auto".to_string()];
    if let OpenCodeStart::Resume(id) = start {
        argv.push("-s".to_string());
        argv.push(id.clone());
    }
    argv
}

/// Is `id` a plausible OpenCode session id (`ses_` + alphanumerics)?
///
/// Guards the `Resume` arm: `-c` / `--continue` would silently resume the
/// most recent conversation in the cwd — the same hijack the claude ladder
/// avoids by never using `--continue`. A blank or garbage id must start Fresh
/// rather than be handed to `-s`.
pub fn is_session_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("ses_") else {
        return false;
    };
    !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// Resolve the opencode binary via the user's login shell — never the daemon's
/// own PATH (same distribution-safe path claude/grok/codex take).
pub fn resolve_opencode() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        let shell = crate::platform::default_shell();
        crate::claude::resolve_bin_with(&shell.to_string_lossy(), true, "opencode", &[])
    }
    #[cfg(windows)]
    {
        crate::claude::resolve_bin_windows("opencode")
    }
}

/// OpenCode config directory: `$OPENCODE_CONFIG_DIR` when set, else
/// `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`.
pub fn config_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("OPENCODE_CONFIG_DIR") {
        let p = PathBuf::from(dir);
        if !p.as_os_str().is_empty() {
            return Some(p);
        }
    }
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        let p = PathBuf::from(xdg);
        if !p.as_os_str().is_empty() {
            return Some(p.join("opencode"));
        }
    }
    crate::platform::user_home().map(|home| home.join(".config").join("opencode"))
}

/// Path of the plugins directory amber writes `amber-hook.js` into.
pub fn plugins_dir() -> Option<PathBuf> {
    config_dir().map(|d| d.join("plugins"))
}

/// Install (or refresh) the global OpenCode plugin that records session ids.
pub fn ensure_global_opencode_plugin() {
    if let Some(dir) = plugins_dir() {
        ensure_plugin_in(&dir);
    }
}

/// Testable core of [`ensure_global_opencode_plugin`].
pub fn ensure_plugin_in(dir: &Path) {
    if let Err(e) = std::fs::create_dir_all(dir) {
        eprintln!(
            "amber: failed to create OpenCode plugins dir {}: {e}",
            dir.display()
        );
        return;
    }
    let path = dir.join(PLUGIN_FILE);
    if let Ok(existing) = std::fs::read_to_string(&path) {
        if existing == PLUGIN_JS {
            return;
        }
    }
    if let Err(e) = std::fs::write(&path, PLUGIN_JS) {
        eprintln!(
            "amber: failed to write OpenCode plugin {}: {e}",
            path.display()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn argv_fresh_is_unattended_without_session_or_continue() {
        let argv = opencode_argv(&OpenCodeStart::Fresh);
        assert_eq!(argv, ["--auto"]);
        assert!(!argv.iter().any(|a| a == "-s" || a == "--session"));
        assert!(!argv.iter().any(|a| a == "-c" || a == "--continue"));
    }

    #[test]
    fn argv_resumes_a_recorded_id() {
        let id = "ses_fd8f8accaffeTWUvgvTimbhECs";
        let argv = opencode_argv(&OpenCodeStart::Resume(id.into()));
        assert_eq!(argv, ["--auto", "-s", id]);
        assert!(!argv.iter().any(|a| a == "-c" || a == "--continue"));
    }

    #[test]
    fn accepts_the_documented_ses_id_shape() {
        assert!(is_session_id("ses_fd8f8accaffeTWUvgvTimbhECs"));
        assert!(is_session_id("ses_0123456789abCDEfghijklmnop"));
    }

    #[test]
    fn rejects_ids_that_would_make_resume_hijack() {
        assert!(!is_session_id(""));
        assert!(!is_session_id("latest"));
        assert!(!is_session_id("ses_"));
        assert!(!is_session_id("ses_has space"));
        assert!(!is_session_id("ses_has-dash"));
        assert!(!is_session_id("SES_fd8f8accaffeTWUvgvTimbhECs"));
        assert!(!is_session_id("fd8f8accaffeTWUvgvTimbhECs"));
    }

    #[test]
    fn plugin_install_is_idempotent_and_refreshes_drift() {
        let dir = tempfile::tempdir().unwrap();
        let plugins = dir.path().join("plugins");
        ensure_plugin_in(&plugins);
        let path = plugins.join(PLUGIN_FILE);
        let first = fs::read_to_string(&path).unwrap();
        assert_eq!(first, PLUGIN_JS);
        assert!(first.contains("session.created"));
        assert!(first.contains("AMBER_SESSION"));
        assert!(first.contains("amber"));
        assert!(first.contains("parentID"));

        ensure_plugin_in(&plugins);
        assert_eq!(fs::read_to_string(&path).unwrap(), PLUGIN_JS);

        fs::write(&path, "// stale\n").unwrap();
        ensure_plugin_in(&plugins);
        assert_eq!(fs::read_to_string(&path).unwrap(), PLUGIN_JS);
    }

    #[test]
    fn plugin_install_leaves_other_plugins_alone() {
        let dir = tempfile::tempdir().unwrap();
        let plugins = dir.path().join("plugins");
        fs::create_dir_all(&plugins).unwrap();
        let other = plugins.join("mine.js");
        fs::write(&other, "export const Mine = async () => ({})").unwrap();
        ensure_plugin_in(&plugins);
        assert_eq!(
            fs::read_to_string(&other).unwrap(),
            "export const Mine = async () => ({})"
        );
        assert!(plugins.join(PLUGIN_FILE).is_file());
    }
}
