//! Claude supervisor loop (spec §6.2): bounded-retry relaunch of `claude`
//! with resume/continue argv selection, falling back to an interactive shell
//! so a pane never silently dies.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

use amber_core::proto::{self, ControlMsg, Decoded, Decoder, Frame};
use amber_core::state::{SessionKind, StateStore};

use crate::{claude, codex, grok};

/// Upper bound on one run-state report attempt. The ordered reporter retries a
/// timed-out attempt without blocking the child-monitoring loop.
const REPORT_WRITE_TIMEOUT: Duration = Duration::from_secs(2);
const REPORT_RETRY_DELAY: Duration = Duration::from_millis(100);

/// How often the interruptible run-wait polls for claude's exit or a suspend
/// request (Slice 3). Replaces a blocking wait so a SIGUSR1 can park claude
/// promptly; 150 ms is imperceptible for a long-lived TUI and negligible CPU.
const WAIT_POLL: Duration = Duration::from_millis(150);
/// How often a parked (suspended) supervisor polls for the resume request.
const IDLE_POLL: Duration = Duration::from_millis(250);
const WORKLOAD_KILL_LOG_INTERVAL: u32 = 20;

/// How many consecutive launches may try to `--resume` grok's recorded
/// conversation before the ladder gives up and starts a new one. See
/// [`select_grok_start`] — a just-killed session can 404 once and then resume
/// fine, so a single failure must not cost the conversation.
const GROK_RESUME_ATTEMPTS: u32 = 2;

/// Suspend/resume signalling for a claude session (Slice 3, freeze grace). The
/// daemon sets `suspend` (SIGUSR1) to park claude — the supervisor kills it,
/// freeing its RAM, and idles holding the pty — and `resume` (SIGUSR2) to
/// relaunch it. Two one-shot flags, drained with `swap(false)`.
#[derive(Clone, Default)]
pub struct SuspendControl {
    pub suspend: Arc<AtomicBool>,
    pub resume: Arc<AtomicBool>,
}

impl SuspendControl {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Outcome of [`supervise_claude`]'s bounded retry loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SuperviseOutcome {
    /// The user quit `claude` — a clean exit (code 0) or a ^C (SIGINT). No
    /// retry; the caller drops the pane to a shell.
    CleanExit,
    /// `claude` crashed `max_attempts` times in a row.
    Exhausted,
}

/// Which coding agent a supervised session runs. All share this module's
/// retry/suspend/fallback machinery; only the argv differs — see
/// [`claude::claude_argv`], [`grok::grok_argv`], and [`codex::codex_argv`].
pub enum Agent {
    /// claude, whose rotating session id is recorded by its `SessionStart` hook
    /// into the generated per-session settings file at this path.
    Claude { settings: PathBuf },
    /// grok, whose session id amber assigns itself (`--session-id`).
    Grok,
    /// codex, whose session id is recorded by a global SessionStart hook
    /// (`amber hook`) — Claude-shaped, not assign-on-create.
    Codex,
}

impl Agent {
    fn label(&self) -> &'static str {
        match self {
            Agent::Claude { .. } => "claude",
            Agent::Grok => "grok",
            Agent::Codex => "codex",
        }
    }
}

/// Run `agent_path` in `cwd`, resuming the recorded session id (if any) or
/// starting a new conversation, retrying with exponential backoff on non-zero
/// exit up to `max_attempts` times.
///
/// `report` is invoked at each supervision transition with the phase string
/// (`"claude"` on every (re)start, `"claude-retrying"` before a backoff). Those
/// strings are agent-NEUTRAL despite their spelling — grok reports them too, so
/// the daemon's validation, the app's kind-dot, and the tab label need no new
/// vocabulary. It is fire-and-forget from the loop's perspective — the closure
/// must never block supervision (the socket-backed reporter used in production
/// time-bounds its I/O and swallows errors); tests pass a recording closure to
/// assert the exact transition sequence.
// Nine params (the original seven + suspend control + stable cgroup slot).
// Grouping them into a config struct would add ceremony without clarity here;
// the call sites are few.
#[allow(clippy::too_many_arguments)]
pub fn supervise_agent(
    agent: &Agent,
    agent_path: &Path,
    root: &Path,
    name: &str,
    cwd: &Path,
    max_attempts: u32,
    report: impl Fn(&str),
    ctl: &SuspendControl,
    slot: Option<u32>,
) -> anyhow::Result<SuperviseOutcome> {
    let store = StateStore::new(root);
    let mut attempts = 0u32;
    // Escalation within one unchanged recording: Resume (escalation 0) -> Fresh
    // (every later attempt). Codex also resets when SessionStart refreshes the
    // recording's timestamp with the same id; Claude/Grok retain their id-only
    // ladder.
    let mut escalation = 0u32;
    let mut prev_recording = None;
    'sup: loop {
        let recording = store.read_claude(name)?;
        let recording_key = recording.as_ref().map(|meta| {
            (
                meta.session_id.clone(),
                if matches!(agent, Agent::Codex) {
                    meta.updated
                } else {
                    0
                },
            )
        });
        if recording_key != prev_recording {
            escalation = 0;
            prev_recording = recording_key;
        }
        let session_id = recording.as_ref().map(|m| m.session_id.as_str());
        let argv = match agent {
            Agent::Claude { settings } => {
                let start = select_start(session_id, escalation);
                claude::claude_argv(&start, settings)
            }
            Agent::Grok => grok::grok_argv(&select_grok_start(
                &store,
                name,
                cwd,
                session_id,
                escalation,
            )?),
            Agent::Codex => codex::codex_argv(&select_codex_start(session_id, escalation)),
        };

        // Spawn (not `.status()`) so the run is interruptible: a SIGUSR1-set
        // suspend request parks claude mid-run. A launch failure (e.g. a
        // transient ETXTBSY while the binary is replaced) counts against the
        // retry budget rather than aborting supervision ("a session never
        // silently dies", spec §6.2).
        let mut command = agent_command(agent_path, &argv, slot)?;
        command
            .current_dir(cwd)
            .env("AMBER_SESSION", name)
            .env("AMBER_STATE_DIR", root);
        let outcome = match spawn_agent(&mut command, slot) {
            Err(e) => Err(e),
            Ok(mut child) => {
                // The exec-status handshake proves that the cgroup wrapper
                // reached the real agent's exec. Wrapper spawn alone is not
                // process truth and must not produce a running report.
                report("claude");
                'wait: loop {
                    // Prefer a real exit over a coincident suspend: if claude has
                    // already exited (e.g. a user quit), handle that normally.
                    match child.try_wait() {
                        Ok(Some(status)) => break 'wait Ok(status),
                        Ok(None) => {}
                        Err(e) => break 'wait Err(e),
                    }
                    if ctl.suspend.swap(false, Ordering::SeqCst) {
                        // Park: kill claude (frees its RAM), idle holding the pty
                        // until a resume, then relaunch via the resume ladder. NOT
                        // counted as a crash — escalation/prev_id reset so the
                        // recorded id is Resumed on relaunch.
                        reclaim_workload(&mut child, slot)?;
                        // SIGUSR1 is a coalescing flag. A duplicate manual request
                        // (or a Memory→Manual upgrade) can arrive after the first
                        // request was consumed but while cleanup is still running.
                        // It belongs to this parked transition, not the next child.
                        ctl.suspend.store(false, Ordering::SeqCst);
                        report("suspended");
                        while !ctl.resume.swap(false, Ordering::SeqCst) {
                            ctl.suspend.store(false, Ordering::SeqCst);
                            std::thread::sleep(IDLE_POLL);
                        }
                        ctl.suspend.store(false, Ordering::SeqCst);
                        escalation = 0;
                        prev_recording = None;
                        continue 'sup;
                    }
                    std::thread::sleep(WAIT_POLL);
                }
            }
        };

        let class = classify_run(&outcome);
        if class.is_user_quit() {
            return Ok(SuperviseOutcome::CleanExit);
        }
        if let Err(e) = &outcome {
            eprintln!("amber: failed to launch {} for session {name}: {e}", agent.label());
        }

        attempts += 1;
        escalation += 1;
        match retry_decision(attempts, max_attempts) {
            None => return Ok(SuperviseOutcome::Exhausted),
            Some(delay) => {
                // A crash that will be retried after a backoff.
                report("claude-retrying");
                std::thread::sleep(delay);
            }
        }
    }
}

fn agent_command(
    agent_path: &Path,
    argv: &[String],
    _slot: Option<u32>,
) -> anyhow::Result<Command> {
    let mut command = Command::new(agent_path);
    command.args(argv);
    Ok(command)
}

fn spawn_agent(command: &mut Command, slot: Option<u32>) -> std::io::Result<Child> {
    #[cfg(target_os = "linux")]
    if let Some(slot) = slot {
        configure_workload_placement(command, slot);
    }
    #[cfg(not(target_os = "linux"))]
    let _ = slot;
    command.spawn()
}

#[cfg(target_os = "linux")]
fn configure_workload_placement(command: &mut Command, slot: u32) {
    use std::os::fd::AsRawFd;
    use std::os::unix::process::CommandExt;

    match crate::cgroup::open_workload_procs_from_current(slot) {
        Ok(Some(procs)) => {
            let fd = procs.as_raw_fd();
            // SAFETY: the hook captures the opened file to keep `fd` alive and
            // calls only async-signal-safe `write`; all `/proc` work, opening,
            // allocation, and logging happened in the parent above.
            unsafe {
                command.pre_exec(move || {
                    let _keep_open = &procs;
                    libc::write(fd, b"0".as_ptr().cast(), 1);
                    Ok(())
                });
            }
        }
        Ok(None) => {}
        Err(error) => {
            eprintln!("amber: cgroup placement unavailable; continuing uncontained: {error}")
        }
    }
}

fn reclaim_workload(child: &mut std::process::Child, slot: Option<u32>) -> anyhow::Result<()> {
    reclaim_workload_with(
        child,
        slot,
        crate::cgroup::kill_workload_from_current,
        crate::pty::kill_process_tree,
    )
}

fn reclaim_workload_with(
    child: &mut std::process::Child,
    slot: Option<u32>,
    mut kill_workload: impl FnMut(u32) -> std::io::Result<Option<bool>>,
    mut kill_process_tree: impl FnMut(u32),
) -> anyhow::Result<()> {
    let pid = child.id();
    if let Some(slot) = slot {
        let mut attempts = 0u32;
        loop {
            match kill_workload(slot) {
                Ok(Some(true)) => {
                    break;
                }
                Ok(Some(false)) => {
                    attempts = attempts.saturating_add(1);
                    if attempts == 1 || attempts.is_multiple_of(WORKLOAD_KILL_LOG_INTERVAL) {
                        eprintln!(
                            "amber: session slot {slot} workload still populated; retrying cleanup"
                        );
                    }
                    std::thread::sleep(IDLE_POLL);
                }
                Ok(None) => break,
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::Interrupted
                            | std::io::ErrorKind::WouldBlock
                            | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    attempts = attempts.saturating_add(1);
                    if attempts == 1 || attempts.is_multiple_of(WORKLOAD_KILL_LOG_INTERVAL) {
                        eprintln!(
                            "amber: session slot {slot} workload cleanup failed; retrying: {error}"
                        );
                    }
                    std::thread::sleep(IDLE_POLL);
                }
                Err(error) => {
                    eprintln!(
                        "amber: session slot {slot} cgroup cleanup is unavailable; \
                         reclaiming the process tree and keeping the supervisor parked: {error}"
                    );
                    kill_process_tree(pid);
                    let _ = child.kill();
                    if let Err(wait_error) = child.wait() {
                        eprintln!(
                            "amber: workload fallback wait failed after cgroup error: {wait_error}"
                        );
                    }
                    // The workload is gone (or best-effort killed), but the
                    // `amber run` supervisor must stay alive in its parked
                    // loop. Returning this cgroup error used to exit the pty
                    // child, after which daemon reap deleted session metadata
                    // and the resume record — turning a containment failure
                    // into conversation loss.
                    return Ok(());
                }
            }
        }
    }
    match child.try_wait() {
        Ok(Some(_)) => return Ok(()),
        Ok(None) => {}
        Err(error) => {
            eprintln!(
                "amber: workload cleanup status check failed; child is already unowned: {error}"
            );
            return Ok(());
        }
    }
    finish_reclaim_with(child, pid, kill_process_tree, std::process::Child::wait);
    Ok(())
}

fn finish_reclaim_with(
    child: &mut std::process::Child,
    pid: u32,
    mut kill_process_tree: impl FnMut(u32),
    wait: impl FnOnce(&mut std::process::Child) -> std::io::Result<std::process::ExitStatus>,
) {
    kill_process_tree(pid);
    let _ = child.kill();
    if let Err(error) = wait(child) {
        eprintln!("amber: workload cleanup wait failed; keeping the supervisor parked: {error}");
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

/// Pick how to start `codex` for one attempt. Claude-shaped: a non-empty
/// recorded id on the first un-escalated attempt is resumed; every other case
/// starts Fresh. Never `resume --last` (that hijacks the most recent session in
/// the cwd). The SessionStart hook records the id after a Fresh launch.
fn select_codex_start(session_id: Option<&str>, escalation: u32) -> codex::CodexStart {
    match (session_id, escalation) {
        (Some(id), 0) if codex::is_session_id(id) => codex::CodexStart::Resume(id.to_string()),
        _ => codex::CodexStart::Fresh,
    }
}

/// Pick how to start `grok` for one attempt, and RECORD the id when starting a
/// new conversation.
///
/// Grok has no `SessionStart` hook: amber names the conversation itself with
/// `--session-id`, so the recording that claude gets from its hook has to
/// happen here. Two rules that are not optional:
///
/// * a fresh start always mints a BRAND-NEW uuid — grok refuses an id that
///   already exists ("Session ID … is already in use"), so re-passing the
///   recorded one would fail instantly on every retry;
/// * a recorded id is only resumed if it is UUID-shaped — `--resume` takes an
///   optional value, and a blank/garbage one silently resumes the most recent
///   conversation in the cwd, hijacking an unrelated session.
///
/// Unlike claude's ladder, resume is tried [`GROK_RESUME_ATTEMPTS`] times
/// before giving up on the conversation. Measured on a killed pane: the first
/// relaunch (200 ms later) can still fail with "not found locally, restoring
/// from remote … 404" while the dead process's session files settle, yet the
/// very same `--resume` succeeds moments after. Falling straight to `Fresh`
/// there would silently abandon a live conversation over a transient miss.
fn select_grok_start(
    store: &StateStore,
    name: &str,
    cwd: &Path,
    session_id: Option<&str>,
    escalation: u32,
) -> anyhow::Result<grok::GrokStart> {
    match (session_id, escalation) {
        (Some(id), e) if e < GROK_RESUME_ATTEMPTS && grok::is_session_id(id) => {
            Ok(grok::GrokStart::Resume(id.to_string()))
        }
        _ => {
            let id = grok::new_session_id();
            store.write_claude(
                name,
                &amber_core::state::ClaudeMeta {
                    session_id: id.clone(),
                    cwd: cwd.to_path_buf(),
                    updated: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0),
                },
            )?;
            Ok(grok::GrokStart::Fresh(id))
        }
    }
}

/// How a single `claude` run terminated. The supervisor collapses everything
/// but [`RunClass::Success`] into "crashed, count it against the budget"; the
/// finer variants exist so the classification is testable in isolation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RunClass {
    /// Exited 0 (clean exit / user quit).
    Success,
    /// A ^C quit — either death by SIGINT, or (the common case) a normal exit
    /// with code 130: claude runs in raw mode with ISIG off, so ^C reaches it
    /// as a byte, not a signal; it handles the quit itself and exits 130 by the
    /// shell convention. Either way it's a deliberate user quit, NOT a crash:
    /// no retry, straight to the shell fallback (spec §6.2).
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
        Ok(status) => {
            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;
                match status.signal() {
                    Some(sig) if sig == nix::libc::SIGINT => return RunClass::UserInterrupt,
                    Some(_) => return RunClass::Signaled,
                    None => {}
                }
            }
            // Not signal-terminated, so a real exit code is present. 130 is the
            // shell convention for "terminated by ^C" — claude's own quit path.
            if matches!(status.code(), Some(130)) {
                return RunClass::UserInterrupt;
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

struct QueuedRunState {
    state: String,
    done: Option<mpsc::SyncSender<()>>,
}

/// One ordered report queue per `amber run`. The worker retries each sequence
/// until the daemon acknowledges it, then advances; later states therefore
/// cannot overtake an earlier report on independent best-effort connections.
struct RunStateReporter {
    tx: mpsc::Sender<QueuedRunState>,
}

impl RunStateReporter {
    fn new(socket: &Path, name: &str) -> Self {
        let socket = socket.to_path_buf();
        let name = name.to_string();
        let (tx, rx) = mpsc::channel::<QueuedRunState>();
        std::thread::spawn(move || {
            let mut seq = 1u64;
            while let Ok(report) = rx.recv() {
                if let Err(error) = report_until_acked(&socket, &name, &report.state, seq) {
                    eprintln!(
                        "amber run: run_state reporter stopped for {name} at {}: {error}",
                        report.state
                    );
                    break;
                }
                if let Some(done) = report.done {
                    let _ = done.send(());
                }
                seq = seq.saturating_add(1);
            }
        });
        Self { tx }
    }

    fn report(&self, state: &str) {
        if self
            .tx
            .send(QueuedRunState { state: state.to_string(), done: None })
            .is_err()
        {
            eprintln!("amber run: run_state reporter is unavailable");
        }
    }

    fn report_and_wait(&self, state: &str) -> anyhow::Result<()> {
        let (done_tx, done_rx) = mpsc::sync_channel(0);
        self.tx
            .send(QueuedRunState { state: state.to_string(), done: Some(done_tx) })
            .map_err(|_| anyhow::anyhow!("run_state reporter stopped"))?;
        done_rx.recv().map_err(|_| anyhow::anyhow!("run_state reporter stopped"))
    }
}

fn report_until_acked(socket: &Path, name: &str, state: &str, seq: u64) -> anyhow::Result<()> {
    loop {
        match try_report_run_state(socket, name, state, seq) {
            Ok(()) => return Ok(()),
            Err(error) => {
                eprintln!(
                    "amber run: run_state {state} seq {seq} for {name} not acknowledged: {error}; retrying"
                );
                std::thread::sleep(REPORT_RETRY_DELAY);
            }
        }
    }
}

fn try_report_run_state(
    socket: &Path,
    name: &str,
    state: &str,
    seq: u64,
) -> anyhow::Result<()> {
    let mut stream = UnixStream::connect(socket)?;
    stream.set_write_timeout(Some(REPORT_WRITE_TIMEOUT))?;
    stream.set_read_timeout(Some(REPORT_WRITE_TIMEOUT))?;
    let frame = proto::encode(&Frame::Control(ControlMsg::ReportRunState {
        name: name.to_string(),
        state: state.to_string(),
        seq,
    }));
    stream.write_all(&frame)?;
    stream.flush()?;

    let mut decoder = Decoder::new();
    let mut buf = [0u8; 4096];
    loop {
        while let Some(decoded) = decoder.next_decoded()? {
            match decoded {
                Decoded::Frame(Frame::Control(ControlMsg::RunStateAck {
                    name: ack_name,
                    seq: ack_seq,
                })) if ack_name == name && ack_seq == seq => return Ok(()),
                Decoded::Frame(Frame::Control(ControlMsg::Error { msg })) => {
                    anyhow::bail!("daemon rejected run_state: {msg}")
                }
                Decoded::Frame(_) | Decoded::UndecodableControl(_) => {}
            }
        }
        let n = stream.read(&mut buf)?;
        if n == 0 {
            anyhow::bail!("daemon closed before run_state acknowledgement");
        }
        decoder.feed(&buf[..n]);
    }
}

/// Resolve claude, supervise it for `name`, and fall through to an
/// interactive shell (replacing this process) if claude is unresolvable or
/// exhausts its retries. Runs inside the pty, so the child inherits the tty.
/// `socket` is the daemon socket the supervisor reports its phase to.
pub fn run_session(
    root: &Path,
    name: &str,
    socket: &Path,
    kind: &str,
    slot: Option<u32>,
) -> anyhow::Result<()> {
    let store = StateStore::new(root);
    let reporter = RunStateReporter::new(socket, name);
    let mut cfg = store.load_config()?;

    let meta = store.read_session(name)?;
    let slot = slot.or_else(|| meta.as_ref().and_then(|meta| (meta.slot > 0).then_some(meta.slot)));
    // Which agent this pane runs, from the DAEMON's own argv — deliberately not
    // the store: `SessionManager::create` spawns the pty before persisting the
    // metadata, so reading it here is a race that silently launches claude for
    // a grok/codex pane (observed for grok). Anything unrecognised, including a
    // hand-started supervisor, keeps the historical claude behaviour.
    let agent_kind = match kind {
        k if k == SessionKind::Grok.as_str() => "grok",
        k if k == SessionKind::Codex.as_str() => "codex",
        _ => "claude",
    };

    // The cached path is only trusted while it still EXISTS. Agents ship
    // self-updaters that can relocate their binary; without this check a stale
    // cache makes every launch fail with ENOENT, and the pane drops to a shell
    // permanently until someone runs `amber ctl doctor` by hand.
    let cached = match agent_kind {
        "grok" => cfg.grok_path.clone(),
        "codex" => cfg.codex_path.clone(),
        _ => cfg.claude_path.clone(),
    };
    let agent_path = match cached.filter(|p| p.exists()) {
        Some(p) => Some(p),
        None => {
            let resolved = match agent_kind {
                "grok" => grok::resolve_grok(),
                "codex" => codex::resolve_codex(),
                _ => claude::resolve_claude(),
            };
            if let Some(p) = resolved.clone() {
                match agent_kind {
                    "grok" => cfg.grok_path = Some(p),
                    "codex" => cfg.codex_path = Some(p),
                    _ => cfg.claude_path = Some(p),
                }
                store.save_config(&cfg)?;
            }
            resolved
        }
    };

    let cwd = match meta.map(|m| m.cwd) {
        Some(c) => c,
        None => std::env::current_dir()?,
    };

    if let Some(agent_path) = agent_path {
        let agent = match agent_kind {
            "grok" => {
                // Grok records nothing on our behalf and has no folder-trust
                // dialog to pre-accept: `--session-id` is the whole mechanism.
                Agent::Grok
            }
            "codex" => {
                // Untrusted cwd blocks forever on the directory-trust dialog
                // (SessionStart never fires). Pre-accept like claude's folder
                // trust. Global SessionStart hook + AMBER_SESSION records the id.
                codex::ensure_cwd_trusted(&cwd);
                if let Ok(exe) = crate::manager::resolve_current_exe() {
                    codex::ensure_global_codex_hook(&format!("{} hook", exe.display()));
                }
                Agent::Codex
            }
            _ => {
                // A detached claude blocks forever on the interactive folder-trust
                // prompt for an untrusted cwd (never starting the session /
                // recording the resume id). Pre-accept trust for this cwd.
                claude::ensure_cwd_trusted(&cwd);
                let current_exe = crate::manager::resolve_current_exe()?;
                let hook_command = format!("{} hook", current_exe.display());
                Agent::Claude {
                    settings: claude::write_settings(root, name, &hook_command)?,
                }
            }
        };

        // Both outcomes fall through to the shell. On a user quit (Ctrl-C /
        // clean exit) the pane becomes a plain login shell instead of closing;
        // exiting THAT shell ends `amber run` and closes the pane normally. On
        // exhausted retries we do the same rather than let the pane die (spec
        // §6.2 — "a session never silently dies").
        // Suspend/resume signalling (Slice 3). SIGUSR1 parks claude, SIGUSR2
        // resumes it. `amber run` is a dedicated per-pane process, so these
        // signals are ours. BOTH handlers are a prerequisite for supervised
        // mode: with a default disposition, a later suspend/resume signal can
        // terminate `amber run` and make daemon reap delete the session.
        let ctl = SuspendControl::new();
        match install_suspend_handlers(&ctl) {
            Ok(()) => {
                let report = |state: &str| reporter.report(state);
                match supervise_agent(
                    &agent,
                    &agent_path,
                    root,
                    name,
                    &cwd,
                    3,
                    report,
                    &ctl,
                    slot,
                )? {
                    SuperviseOutcome::CleanExit => {}
                    SuperviseOutcome::Exhausted => {
                        eprintln!(
                            "amber: {} exhausted retries for session {name}; falling back to shell",
                            agent.label()
                        );
                    }
                }
            }
            Err(error) => {
                eprintln!(
                    "amber: cannot safely supervise {} for session {name}: {error}; falling back to shell",
                    agent.label()
                );
            }
        }
    } else {
        eprintln!("amber: {agent_kind} not found on PATH; falling back to shell");
    }

    // The pane is now a plain shell (user quit, exhausted retries, or claude
    // unresolvable). Ignore supervisor-only signals before reporting the
    // transition; ignored dispositions survive exec and close the report race.
    ignore_suspend_signals()?;
    // This thread is about to disappear in `exec`; wait until the terminal
    // state (and every queued predecessor) is acknowledged first.
    reporter.report_and_wait("shell-fallback")?;
    shell_fallback(&cwd)
}

fn install_suspend_handlers(ctl: &SuspendControl) -> anyhow::Result<()> {
    install_suspend_handlers_with(ctl, |signal, flag| {
        signal_hook::flag::register(signal, flag).map(|_| ())
    })
}

fn install_suspend_handlers_with(
    ctl: &SuspendControl,
    mut register: impl FnMut(i32, Arc<AtomicBool>) -> std::io::Result<()>,
) -> anyhow::Result<()> {
    register(signal_hook::consts::SIGUSR1, Arc::clone(&ctl.suspend))?;
    register(signal_hook::consts::SIGUSR2, Arc::clone(&ctl.resume))?;
    Ok(())
}

fn ignore_suspend_signals() -> anyhow::Result<()> {
    use nix::sys::signal::{signal, SigHandler, Signal};

    // SAFETY: fixed valid signals and SIG_IGN, immediately before shell exec.
    unsafe {
        signal(Signal::SIGUSR1, SigHandler::SigIgn)?;
        signal(Signal::SIGUSR2, SigHandler::SigIgn)?;
    }
    Ok(())
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

    #[cfg(target_os = "linux")]
    #[test]
    fn slotted_agent_execs_directly_without_a_stoppable_wrapper() {
        let command = agent_command(Path::new("/usr/bin/claude"), &["--resume".into()], Some(7))
            .unwrap();
        let args: Vec<_> = command.get_args().map(|arg| arg.to_string_lossy()).collect();
        assert_eq!(command.get_program(), "/usr/bin/claude");
        assert_eq!(args, ["--resume"]);
    }

    #[test]
    fn empty_workload_still_reclaims_a_child_that_missed_placement() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "sleep 60"])
            .spawn()
            .unwrap();

        reclaim_workload_with(
            &mut child,
            Some(7),
            |_| Ok(Some(true)),
            crate::pty::kill_process_tree,
        )
        .unwrap();

        assert!(
            child.try_wait().unwrap().is_some(),
            "an empty workload cgroup must not make the supervisor wait on a live misplaced child"
        );
    }

    fn reap_outside_child(child: &std::process::Child) {
        let pid = child.id() as i32;
        let mut status = 0;
        assert_eq!(unsafe { libc::waitpid(pid, &mut status, 0) }, pid);
    }

    #[test]
    fn reclaim_try_wait_error_keeps_the_supervisor_recoverable() {
        let mut child = Command::new("/bin/true").spawn().unwrap();
        reap_outside_child(&child);
        let mut kill_called = false;

        reclaim_workload_with(
            &mut child,
            Some(7),
            |_| Ok(Some(true)),
            |_| kill_called = true,
        )
            .expect("try_wait cleanup failure must not escape the parked supervisor path");

        assert!(!kill_called, "ECHILD must not signal a possibly recycled pid");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn slotted_spawn_is_not_blocked_by_a_stopped_intermediate_process() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("pid");
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            &format!("printf %s $$ > {}; kill -STOP $$; sleep 60", pid_file.display()),
        ]);
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let handle = std::thread::spawn(move || tx.send(spawn_agent(&mut command, Some(7))).unwrap());

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !pid_file.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let timely = rx.recv_timeout(Duration::from_millis(300));
        let was_timely = timely.is_ok();
        if !was_timely {
            let pid: i32 = std::fs::read_to_string(&pid_file).unwrap().parse().unwrap();
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
        let mut child = timely.unwrap_or_else(|_| rx.recv_timeout(Duration::from_secs(2)).unwrap()).unwrap();
        let _ = child.kill();
        let _ = child.wait();
        handle.join().unwrap();

        assert!(was_timely, "spawn waited on a stopped wrapper instead of the real exec boundary");
    }

    #[test]
    fn reclaim_echild_without_cgroup_never_signals_the_stale_pid() {
        let mut child = Command::new("/bin/true").spawn().unwrap();
        reap_outside_child(&child);
        let mut kill_called = false;

        reclaim_workload_with(
            &mut child,
            None,
            |_| Ok(None),
            |_| kill_called = true,
        )
            .expect("ECHILD must keep the supervisor in its parked path");

        assert!(!kill_called, "ECHILD must not signal a possibly recycled pid");
    }

    #[test]
    fn final_wait_io_error_is_swallowed_after_reclaim() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "sleep 60"])
            .spawn()
            .unwrap();
        let pid = child.id();
        let mut kill_called = false;

        finish_reclaim_with(
            &mut child,
            pid,
            |_| kill_called = true,
            |_| Err(std::io::Error::other("injected wait failure")),
        );

        assert!(kill_called);
        child.wait().unwrap();
    }

    #[test]
    fn nonretryable_cgroup_cleanup_failure_keeps_supervisor_recoverable() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "sleep 60"])
            .spawn()
            .unwrap();

        reclaim_workload_with(
            &mut child,
            Some(7),
            |_| {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "injected cgroup cleanup failure",
                ))
            },
            crate::pty::kill_process_tree,
        )
        .expect("fallback process-tree cleanup must keep the supervisor in its parked loop");

        assert!(
            child.try_wait().unwrap().is_some(),
            "failed cgroup cleanup must still reclaim the workload child"
        );
    }

    #[test]
    fn both_suspend_signal_handlers_are_required_before_agent_launch() {
        let ctl = SuspendControl::new();
        let mut calls = 0;
        let error = install_suspend_handlers_with(&ctl, |_, _| {
            calls += 1;
            if calls == 2 {
                Err(std::io::Error::other("injected registration failure"))
            } else {
                Ok(())
            }
        })
        .expect_err("a missing resume handler must reject supervised mode");

        assert!(error.to_string().contains("registration failure"));
        assert_eq!(calls, 2);
    }

    #[test]
    fn spawn_failure_never_reports_a_running_agent() {
        let dir = tempfile::tempdir().unwrap();
        let settings = dir.path().join("settings.json");
        let states = std::sync::Mutex::new(Vec::new());
        let outcome = supervise_agent(
            &Agent::Claude { settings },
            &dir.path().join("missing-agent"),
            dir.path(),
            "agent",
            dir.path(),
            2,
            |state| states.lock().unwrap().push(state.to_string()),
            &SuspendControl::new(),
            None,
        )
        .unwrap();

        assert_eq!(outcome, SuperviseOutcome::Exhausted);
        assert_eq!(states.into_inner().unwrap(), vec!["claude-retrying"]);
    }

    #[test]
    fn dropped_run_state_ack_retries_the_same_sequence() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("report.sock");
        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        let server = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for attempt in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut decoder = amber_core::proto::Decoder::new();
                let mut buf = [0u8; 4096];
                let report = loop {
                    if let Some(Frame::Control(report)) = decoder.next_frame().unwrap() {
                        break report;
                    }
                    let n = std::io::Read::read(&mut stream, &mut buf).unwrap();
                    decoder.feed(&buf[..n]);
                };
                let ControlMsg::ReportRunState { name, state, seq } = report else {
                    panic!("unexpected report frame")
                };
                seen.push((name.clone(), state, seq));
                if attempt == 1 {
                    let ack = proto::encode(&Frame::Control(ControlMsg::RunStateAck { name, seq }));
                    stream.write_all(&ack).unwrap();
                }
            }
            seen
        });

        report_until_acked(&socket, "agent", "shell-fallback", 9).unwrap();
        let seen = server.join().unwrap();
        assert_eq!(
            seen,
            vec![
                ("agent".to_string(), "shell-fallback".to_string(), 9),
                ("agent".to_string(), "shell-fallback".to_string(), 9),
            ]
        );
    }

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

    #[test]
    fn codex_resumes_a_recorded_id_first() {
        assert_eq!(
            select_codex_start(Some("7f9f9a2e-1b3c-4c7a-9b0e-example-id"), 0),
            codex::CodexStart::Resume("7f9f9a2e-1b3c-4c7a-9b0e-example-id".into())
        );
    }

    #[test]
    fn codex_fresh_when_no_id_or_after_resume_fails() {
        assert_eq!(select_codex_start(None, 0), codex::CodexStart::Fresh);
        assert_eq!(select_codex_start(Some(""), 0), codex::CodexStart::Fresh);
        assert_eq!(
            select_codex_start(Some("7f9f9a2e-1b3c-4c7a-9b0e-example-id"), 1),
            codex::CodexStart::Fresh
        );
    }

    #[test]
    fn grok_resumes_a_recorded_uuid_first() {
        let dir = tempfile::tempdir().unwrap();
        let store = StateStore::new(dir.path());
        let id = "9d5ed578-38af-420e-9cb5-80b0d0b68c77";
        let start = select_grok_start(&store, "w", Path::new("/tmp"), Some(id), 0).unwrap();
        assert_eq!(start, grok::GrokStart::Resume(id.to_string()));
    }

    #[test]
    fn grok_mints_and_records_a_new_id_on_a_fresh_start() {
        // No recorded id: mint one AND persist it, since grok has no hook to
        // record it for us — otherwise the next launch could not resume.
        let dir = tempfile::tempdir().unwrap();
        let store = StateStore::new(dir.path());
        let start = select_grok_start(&store, "w", Path::new("/tmp/proj"), None, 0).unwrap();
        let grok::GrokStart::Fresh(id) = start else { panic!("expected a fresh start") };
        let meta = store.read_claude("w").unwrap().unwrap();
        assert_eq!(meta.session_id, id, "the minted id must be recorded");
        assert_eq!(meta.cwd, Path::new("/tmp/proj"));
    }

    #[test]
    fn grok_retries_resume_before_abandoning_the_conversation() {
        // A just-crashed grok session can miss ONCE ("not found locally …
        // 404") and resume fine on the next try. Escalation 1 must still
        // resume; only after that does the ladder mint a new conversation.
        let dir = tempfile::tempdir().unwrap();
        let store = StateStore::new(dir.path());
        let id = "9d5ed578-38af-420e-9cb5-80b0d0b68c77";
        let start = select_grok_start(&store, "w", Path::new("/tmp"), Some(id), 1).unwrap();
        assert_eq!(start, grok::GrokStart::Resume(id.to_string()));
        assert!(
            matches!(
                select_grok_start(&store, "w", Path::new("/tmp"), Some(id), 2).unwrap(),
                grok::GrokStart::Fresh(_)
            ),
            "the ladder must eventually start a new conversation"
        );
    }

    #[test]
    fn grok_never_reuses_an_id_after_a_failed_attempt() {
        // THE grok-specific hazard: `--session-id` is rejected outright if the
        // id already exists, so every escalated attempt must carry a brand-new
        // uuid. Re-passing the recorded one would fail instantly and burn the
        // whole retry budget without ever launching grok.
        let dir = tempfile::tempdir().unwrap();
        let store = StateStore::new(dir.path());
        let recorded = "9d5ed578-38af-420e-9cb5-80b0d0b68c77";
        let mut seen = vec![recorded.to_string()];
        for escalation in GROK_RESUME_ATTEMPTS..GROK_RESUME_ATTEMPTS + 3 {
            let start =
                select_grok_start(&store, "w", Path::new("/tmp"), Some(recorded), escalation)
                    .unwrap();
            let grok::GrokStart::Fresh(id) = start else {
                panic!("escalation {escalation} must start fresh, not resume")
            };
            assert!(!seen.contains(&id), "id {id} reused at escalation {escalation}");
            seen.push(id);
        }
    }

    #[test]
    fn grok_refuses_a_malformed_recorded_id() {
        // `--resume` takes an OPTIONAL value: handing it a non-uuid would
        // resume whatever ran last in this cwd — an unrelated conversation.
        let dir = tempfile::tempdir().unwrap();
        let store = StateStore::new(dir.path());
        for bad in ["", "latest", "not-a-uuid"] {
            let start = select_grok_start(&store, "w", Path::new("/tmp"), Some(bad), 0).unwrap();
            assert!(
                matches!(start, grok::GrokStart::Fresh(_)),
                "recorded id {bad:?} must not be resumed"
            );
        }
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

    #[cfg(unix)]
    #[test]
    fn classify_exit_130_is_user_interrupt() {
        use std::os::unix::process::ExitStatusExt;
        // The common ^C path: claude catches ^C in raw mode and exits normally
        // with code 130 (no signal). Must count as a user quit, not a crash, so
        // it drops straight to a shell instead of relaunching claude.
        let code_130: std::io::Result<ExitStatus> = Ok(ExitStatus::from_raw(130 << 8));
        assert_eq!(classify_run(&code_130), RunClass::UserInterrupt);
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
