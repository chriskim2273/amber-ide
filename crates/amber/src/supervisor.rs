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
    /// The user quit `claude` — a clean exit (code 0) or a ^C (SIGINT). No
    /// retry; the caller drops the pane to a shell.
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
    // Escalation within a run of the SAME recorded id: Resume (escalation 0) ->
    // Fresh (every later attempt). Reset whenever the recorded id changes (e.g.
    // the hook records a new id after a fresh start), so a crash then resumes
    // the new id rather than continuing to escalate. See `select_start`.
    let mut escalation = 0u32;
    let mut prev_id: Option<String> = None;
    loop {
        let session_id = store.read_claude(name)?.map(|m| m.session_id);
        if session_id != prev_id {
            escalation = 0;
            prev_id = session_id.clone();
        }
        let start = select_start(session_id.as_deref(), escalation);
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

        let class = classify_run(&outcome);
        if class.is_user_quit() {
            return Ok(SuperviseOutcome::CleanExit);
        }
        if let Err(e) = &outcome {
            eprintln!("amber: failed to launch claude for session {name}: {e}");
        }

        attempts += 1;
        escalation += 1;
        match retry_decision(attempts, max_attempts) {
            None => return Ok(SuperviseOutcome::Exhausted),
            Some(delay) => std::thread::sleep(delay),
        }
    }
}

/// Pick how to start `claude` for one attempt (spec §6.2 resume ladder). A
/// recorded id on the first, un-escalated attempt is resumed; every other case
/// — no recorded id, or a later attempt after Resume already failed for this
/// same id — starts `Fresh`. Deliberately NOT `--continue`: it resumes the most
/// recent conversation in the cwd, which can hijack an UNRELATED one (e.g. a
/// separate `claude` run in the same dir). A stale/empty id should start clean.
fn select_start(session_id: Option<&str>, escalation: u32) -> claude::ClaudeStart {
    match (session_id, escalation) {
        (Some(id), 0) => claude::ClaudeStart::Resume(id.to_string()),
        _ => claude::ClaudeStart::Fresh,
    }
}

/// How a single `claude` run terminated. The supervisor collapses everything
/// but [`RunClass::Success`] into "crashed, count it against the budget"; the
/// finer variants exist so the classification is testable in isolation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RunClass {
    /// Exited 0 (clean exit / user quit).
    Success,
    /// Killed by SIGINT — the terminal delivered ^C and claude did not absorb
    /// it. Treated as a deliberate user quit, NOT a crash: no retry, straight
    /// to the shell fallback (spec §6.2).
    UserInterrupt,
    /// Exited with a non-zero status code.
    Nonzero,
    /// Killed by some other signal (Unix).
    Signaled,
    /// The child could not be launched at all (e.g. ENOENT / ETXTBSY).
    LaunchFailed,
}

impl RunClass {
    /// A run that ends the supervision loop without retrying: either a clean
    /// exit or a user ^C. Everything else counts against the retry budget.
    fn is_user_quit(self) -> bool {
        matches!(self, RunClass::Success | RunClass::UserInterrupt)
    }
}

/// Classify the result of spawning `claude` once.
fn classify_run(outcome: &std::io::Result<std::process::ExitStatus>) -> RunClass {
    match outcome {
        Ok(status) if status.success() => RunClass::Success,
        Ok(_status) => {
            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;
                match _status.signal() {
                    Some(sig) if sig == nix::libc::SIGINT => return RunClass::UserInterrupt,
                    Some(_) => return RunClass::Signaled,
                    None => {}
                }
            }
            RunClass::Nonzero
        }
        Err(_) => RunClass::LaunchFailed,
    }
}

/// After a failed attempt, decide whether to retry. `attempts` is the number of
/// failures so far (including the one that just occurred). Returns the backoff
/// to sleep before retrying, or `None` once the budget is exhausted.
fn retry_decision(attempts: u32, max_attempts: u32) -> Option<Duration> {
    if attempts >= max_attempts {
        None
    } else {
        Some(backoff_delay(attempts))
    }
}

/// Exponential backoff before the `attempts`-th retry: 200ms, 400ms, 800ms, …
fn backoff_delay(attempts: u32) -> Duration {
    let backoff_ms = 200u64 * (1u64 << (attempts - 1));
    Duration::from_millis(backoff_ms)
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

        // Both outcomes fall through to the shell. On a user quit (Ctrl-C /
        // clean exit) the pane becomes a plain login shell instead of closing;
        // exiting THAT shell ends `amber run` and closes the pane normally. On
        // exhausted retries we do the same rather than let the pane die (spec
        // §6.2 — "a session never silently dies").
        match supervise_claude(&claude_path, root, name, &cwd, &settings, 3)? {
            SuperviseOutcome::CleanExit => {}
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::ExitStatus;

    #[test]
    fn select_start_resumes_recorded_id_first() {
        // A recorded id on the first (un-escalated) attempt -> resume it.
        assert_eq!(
            select_start(Some("sid-7"), 0),
            claude::ClaudeStart::Resume("sid-7".to_string())
        );
    }

    #[test]
    fn select_start_falls_back_to_fresh_after_resume_fails() {
        // The ladder: once Resume has been tried (escalation > 0) for the same
        // recorded id, every later attempt starts Fresh — NOT Continue and NOT
        // another Resume.
        for escalation in 1..=3 {
            assert_eq!(
                select_start(Some("sid-7"), escalation),
                claude::ClaudeStart::Fresh,
                "escalation {escalation} should fall back to Fresh"
            );
        }
    }

    #[test]
    fn select_start_fresh_when_no_recorded_id() {
        // A never-run session (no recorded id) always starts Fresh, regardless
        // of escalation.
        assert_eq!(select_start(None, 0), claude::ClaudeStart::Fresh);
        assert_eq!(select_start(None, 2), claude::ClaudeStart::Fresh);
    }

    #[cfg(unix)]
    #[test]
    fn classify_clean_exit_is_success() {
        use std::os::unix::process::ExitStatusExt;
        let ok: std::io::Result<ExitStatus> = Ok(ExitStatus::from_raw(0));
        assert_eq!(classify_run(&ok), RunClass::Success);
    }

    #[cfg(unix)]
    #[test]
    fn classify_nonzero_exit_is_nonzero() {
        use std::os::unix::process::ExitStatusExt;
        // wait-status for a normal exit with code 1 is (code << 8).
        let bad: std::io::Result<ExitStatus> = Ok(ExitStatus::from_raw(1 << 8));
        assert_eq!(classify_run(&bad), RunClass::Nonzero);
    }

    #[cfg(unix)]
    #[test]
    fn classify_signal_death_is_signaled() {
        use std::os::unix::process::ExitStatusExt;
        // wait-status for death by signal 9 is the raw signal number.
        let killed: std::io::Result<ExitStatus> = Ok(ExitStatus::from_raw(9));
        assert_eq!(classify_run(&killed), RunClass::Signaled);
    }

    #[cfg(unix)]
    #[test]
    fn classify_sigint_death_is_user_interrupt() {
        use std::os::unix::process::ExitStatusExt;
        // Death by ^C (SIGINT) is a deliberate user quit, not a crash: it must
        // classify distinctly so the loop drops to a shell without retrying.
        let interrupted: std::io::Result<ExitStatus> =
            Ok(ExitStatus::from_raw(nix::libc::SIGINT));
        assert_eq!(classify_run(&interrupted), RunClass::UserInterrupt);
    }

    #[test]
    fn classify_launch_failure_is_launch_failed() {
        // A child that never launches (e.g. ENOENT / ETXTBSY) counts as a crash
        // against the retry budget, not a clean exit.
        let err: std::io::Result<ExitStatus> =
            Err(std::io::Error::from(std::io::ErrorKind::NotFound));
        assert_eq!(classify_run(&err), RunClass::LaunchFailed);
    }

    #[test]
    fn only_user_quit_short_circuits_the_loop() {
        // A clean exit and a ^C both end supervision without retrying; every
        // crash class stays on the retry ladder.
        assert!(RunClass::Success.is_user_quit());
        assert!(RunClass::UserInterrupt.is_user_quit());
        assert!(!RunClass::Nonzero.is_user_quit());
        assert!(!RunClass::Signaled.is_user_quit());
        assert!(!RunClass::LaunchFailed.is_user_quit());
    }

    #[test]
    fn retry_decision_caps_at_max_attempts() {
        // Below the cap: keep retrying (Some backoff). At/above the cap: give up.
        assert!(retry_decision(1, 3).is_some());
        assert!(retry_decision(2, 3).is_some());
        assert!(retry_decision(3, 3).is_none(), "3rd failure exhausts the budget");
        assert!(retry_decision(4, 3).is_none());
    }

    #[test]
    fn backoff_doubles_per_attempt() {
        assert_eq!(backoff_delay(1), Duration::from_millis(200));
        assert_eq!(backoff_delay(2), Duration::from_millis(400));
        assert_eq!(backoff_delay(3), Duration::from_millis(800));
    }
}
