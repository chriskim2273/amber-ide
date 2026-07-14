//! Claude supervisor loop (spec §6.2): bounded-retry relaunch of `claude`
//! with resume/continue argv selection, falling back to an interactive shell
//! so a pane never silently dies.

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use amber_core::state::StateStore;

use crate::claude;

/// Outcome of [`supervise_claude`]'s bounded retry loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SuperviseOutcome {
    /// `claude` exited successfully (clean exit / user quit).
    CleanExit,
    /// `claude` crashed `max_attempts` times in a row.
    Exhausted,
}

/// Run `claude_path` in `cwd`, resuming the recorded session id (if any) or
/// continuing the most recent conversation, retrying with exponential
/// backoff on non-zero exit up to `max_attempts` times.
pub fn supervise_claude(
    claude_path: &Path,
    root: &Path,
    name: &str,
    cwd: &Path,
    settings: &Path,
    max_attempts: u32,
) -> anyhow::Result<SuperviseOutcome> {
    let store = StateStore::new(root);
    let mut attempts = 0u32;
    // Escalation within a run of the SAME recorded id: Resume -> Continue ->
    // Fresh. Reset whenever the recorded id changes (e.g. the hook records a
    // new id after a fresh start), so a crash then resumes the new id rather
    // than continuing to escalate.
    let mut escalation = 0u32;
    let mut prev_id: Option<String> = None;
    loop {
        let session_id = store.read_claude(name)?.map(|m| m.session_id);
        if session_id != prev_id {
            escalation = 0;
            prev_id = session_id.clone();
        }
        let start = match (&session_id, escalation) {
            // A never-run session (no recorded id) starts Fresh — never --continue.
            (None, _) => claude::ClaudeStart::Fresh,
            (Some(id), 0) => claude::ClaudeStart::Resume(id.clone()),
            (Some(_), 1) => claude::ClaudeStart::Continue,
            (Some(_), _) => claude::ClaudeStart::Fresh,
        };
        let argv = claude::claude_argv(&start, settings);

        // A failure to even launch the child (e.g. a transient ETXTBSY while
        // the binary is being replaced) is treated the same as a crash: it
        // counts against the retry budget instead of aborting supervision
        // outright, since "a session never silently dies" (spec §6.2).
        let outcome = Command::new(claude_path)
            .args(&argv)
            .current_dir(cwd)
            .env("AMBER_SESSION", name)
            .env("AMBER_STATE_DIR", root)
            .status();

        match outcome {
            Ok(status) if status.success() => return Ok(SuperviseOutcome::CleanExit),
            Ok(_) => {}
            Err(e) => eprintln!("amber: failed to launch claude for session {name}: {e}"),
        }

        attempts += 1;
        escalation += 1;
        if attempts >= max_attempts {
            return Ok(SuperviseOutcome::Exhausted);
        }
        let backoff_ms = 200u64 * (1u64 << (attempts - 1));
        std::thread::sleep(Duration::from_millis(backoff_ms));
    }
}

/// Resolve claude, supervise it for `name`, and fall through to an
/// interactive shell (replacing this process) if claude is unresolvable or
/// exhausts its retries. Runs inside the pty, so the child inherits the tty.
pub fn run_session(root: &Path, name: &str) -> anyhow::Result<()> {
    let store = StateStore::new(root);
    let mut cfg = store.load_config()?;

    let claude_path = match cfg.claude_path.clone() {
        Some(p) => Some(p),
        None => {
            let resolved = claude::resolve_claude();
            if let Some(ref p) = resolved {
                cfg.claude_path = Some(p.clone());
                store.save_config(&cfg)?;
            }
            resolved
        }
    };

    let cwd = store
        .read_session(name)?
        .map(|m| m.cwd)
        .unwrap_or(std::env::current_dir()?);

    if let Some(claude_path) = claude_path {
        // A detached claude blocks forever on the interactive folder-trust
        // prompt for an untrusted cwd (never starting the session / recording
        // the resume id). Pre-accept trust for this cwd.
        claude::ensure_cwd_trusted(&cwd);
        let current_exe = std::env::current_exe()?;
        let hook_command = format!("{} hook", current_exe.display());
        let settings = claude::write_settings(root, name, &hook_command)?;

        match supervise_claude(&claude_path, root, name, &cwd, &settings, 3)? {
            SuperviseOutcome::CleanExit => return Ok(()),
            SuperviseOutcome::Exhausted => {
                eprintln!(
                    "amber: claude exhausted retries for session {name}; falling back to shell"
                );
            }
        }
    } else {
        eprintln!("amber: claude not found on PATH; falling back to shell");
    }

    shell_fallback(&cwd)
}

/// `exec $SHELL -l` in `cwd`, replacing this process so the pane never dies.
/// Only returns on error (exec never returns on success).
#[cfg(unix)]
fn shell_fallback(cwd: &Path) -> anyhow::Result<()> {
    use std::os::unix::process::CommandExt;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let err = Command::new(&shell).arg("-l").current_dir(cwd).exec();
    Err(anyhow::anyhow!("failed to exec shell fallback {shell}: {err}"))
}
