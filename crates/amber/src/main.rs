//! `amber` CLI: busybox-style subcommands over the daemon's unix socket
//! (spec §2).

use std::ffi::OsString;
use std::io::{IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use amber::attach;
use amber::claude;
use amber::supervisor;
use amber::transport::{self, LocalStream};
use amber_core::proto::{self, ControlMsg, Decoder, Frame};
use amber_core::state::StateStore;
use clap::{Parser, Subcommand, ValueEnum};

#[derive(Parser)]
#[command(name = "amber", about = "amber session daemon + CLI")]
struct Cli {
    /// With no subcommand, `amber` is the tmux reflex: create a fresh shell
    /// session in the current directory and attach to it.
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the daemon (the boot unit runs this).
    Daemon {
        #[arg(long)]
        root: Option<PathBuf>,
        #[arg(long)]
        socket: Option<PathBuf>,
    },
    /// Raw-mode terminal client — the `tmux attach` replacement. Detach with
    /// the prefix key then `d` (default `Ctrl-b`; remap via `AMBER_PREFIX=C-a`,
    /// or disable interception with `--no-prefix`). With no <name>, attaches
    /// the most-recently-updated live session.
    Attach {
        /// Session to attach: a name, or the slot number `amber ls` prints
        /// (stable — it does not change when another session dies). Omit to
        /// attach the newest live session.
        name: Option<String>,
        /// Disable detach-prefix interception; forward stdin fully raw.
        #[arg(long)]
        no_prefix: bool,
        /// Disable the bottom status bar (the terminal title still shows).
        #[arg(long)]
        no_status: bool,
        /// Attach even when already inside an amber session (allow nesting).
        #[arg(long)]
        force: bool,
        #[arg(long)]
        socket: Option<PathBuf>,
    },
    /// List live sessions.
    Ls {
        #[arg(long)]
        socket: Option<PathBuf>,
    },
    /// Create a new session.
    Create {
        name: String,
        #[arg(long)]
        cwd: PathBuf,
        #[arg(long, default_value = "shell")]
        kind: String,
        #[arg(long)]
        socket: Option<PathBuf>,
    },
    /// Kill (destroy) a session.
    Kill {
        /// Session to kill: a name, or the slot number `amber ls` prints.
        name: String,
        #[arg(long)]
        socket: Option<PathBuf>,
    },
    /// Freeze an agent session (kill the child to free RAM; the pane stays).
    Freeze {
        /// Session to freeze: a name, or the slot number `amber ls` prints.
        name: String,
        #[arg(long)]
        socket: Option<PathBuf>,
    },
    /// Unfreeze a previously frozen agent session (resume the same conversation).
    Unfreeze {
        /// Session to unfreeze: a name, or the slot number `amber ls` prints.
        name: String,
        #[arg(long)]
        socket: Option<PathBuf>,
    },
    /// Rename a session (spec §2). Because a pane's workspace/tab is encoded in
    /// its session name, this is also how a pane moves between tabs. A shell is
    /// renamed in place (same child); a claude session is respawned under the
    /// new name and resumes the same conversation.
    Rename {
        from: String,
        to: String,
        #[arg(long)]
        socket: Option<PathBuf>,
    },
    /// Serve the mobile web UI for live sessions on 127.0.0.1 (spec
    /// `2026-07-19-amber-web-mobile-design.md`). A long-lived daemon CLIENT —
    /// it never binds another interface; reach it from a phone by fronting it
    /// with `tailscale serve`.
    Web {
        /// Port on 127.0.0.1.
        #[arg(long, default_value_t = 7717)]
        port: u16,
        /// Rotate the web token, invalidating existing QR links.
        #[arg(long)]
        new_token: bool,
        /// Print the tokenised URL and exit (does not serve).
        #[arg(long)]
        print_url: bool,
        #[arg(long)]
        root: Option<PathBuf>,
        #[arg(long)]
        socket: Option<PathBuf>,
    },
    /// Supervise an agent session inside its pty (spawned by the daemon as the
    /// agent session's child process; not meant to be run directly by users).
    Run {
        name: String,
        /// Which agent to supervise: `claude` (default), `grok`, `codex`,
        /// `opencode`, `hermes`, or `pi`. Passed by the daemon rather than read from the store,
        /// which the spawn races.
        #[arg(long, default_value = "claude")]
        kind: String,
        #[arg(long, hide = true, value_parser = parse_slot)]
        slot: Option<u32>,
    },
    #[command(name = "__cgroup-exec", hide = true)]
    CgroupExec {
        #[arg(long, value_parser = parse_slot)]
        slot: u32,
        #[arg(long)]
        role: CgroupRoleArg,
        #[arg(required = true, trailing_var_arg = true, allow_hyphen_values = true)]
        command: Vec<OsString>,
    },
    /// Session hook target invoked by claude/codex/opencode/hermes/pi; records the
    /// session id from stdin (`AMBER_SESSION`/`AMBER_STATE_DIR` env, spec §6.2).
    Hook,
    /// Print a read-only Claude-session handoff for the current Codex session.
    Handoff {
        /// Claude Code session UUID.
        session_id: String,
    },
    /// Diagnostics + lifecycle helpers.
    Ctl {
        #[command(subcommand)]
        action: CtlAction,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum CgroupRoleArg {
    Supervisor,
    Workload,
}

impl From<CgroupRoleArg> for amber::cgroup::CgroupRole {
    fn from(role: CgroupRoleArg) -> Self {
        match role {
            CgroupRoleArg::Supervisor => Self::Supervisor,
            CgroupRoleArg::Workload => Self::Workload,
        }
    }
}

fn parse_slot(value: &str) -> Result<u32, String> {
    value
        .parse::<u32>()
        .ok()
        .filter(|slot| *slot > 0)
        .ok_or_else(|| "slot must be at least 1".to_string())
}

#[derive(Subcommand)]
enum CtlAction {
    /// Resolve agent binaries (claude, grok, codex, opencode, hermes, pi) via your
    /// login shell and record them in config (the distribution-safe path —
    /// never the daemon's own PATH; spec §8).
    Doctor {
        #[arg(long)]
        root: Option<PathBuf>,
    },
    /// Report whether the daemon is reachable and how many sessions it holds.
    Status {
        #[arg(long)]
        socket: Option<PathBuf>,
    },
    /// View or change amber's aggregate memory budget — the soft ceiling the
    /// guardian enforces by parking agent panes under real pressure, which
    /// also caps every pane leaf's `memory.high`. Changes persist to config
    /// and take effect immediately (no restart).
    ///
    /// The budget cannot exceed the OS-level service cap (`amber.service`
    /// `MemoryHigh`, default 50% of RAM); pass --systemd to move that too.
    Budget {
        /// New budget: `20G`, `1536M`, a bare MiB count like `20480`, or
        /// `auto` (half of physical RAM, capped by the service). Omit to
        /// view the current state.
        set: Option<String>,
        /// ALSO raise/lower `amber.service`'s `MemoryHigh` to match, live +
        /// persistently (`systemctl --user set-property`). This overwrites
        /// any hand-written calibration drop-in. Without it, a budget above
        /// the existing cap is silently clamped to the cap.
        #[arg(long)]
        systemd: bool,
        #[arg(long)]
        socket: Option<PathBuf>,
    },
    /// Ask the running daemon to flush a snapshot to the state store now.
    SnapshotNow {
        #[arg(long)]
        socket: Option<PathBuf>,
    },
    /// Control the `amber web` browser/mobile server: service lifecycle, the
    /// phone URL, tailscale mapping, and live status. `--json` is the contract
    /// the desktop app consumes; the human output is for people only.
    Web {
        #[command(subcommand)]
        action: WebAction,
        // `global = true` so these may follow the leaf subcommand
        // (`ctl web status --json`), which is how a human and the app both
        // type it. Without it clap rejects the flag as unexpected.
        /// Port the service listens on (must match the installed unit).
        #[arg(long, default_value_t = 7717, global = true)]
        port: u16,
        /// Emit machine-readable JSON.
        #[arg(long, global = true)]
        json: bool,
        #[arg(long, global = true)]
        root: Option<PathBuf>,
    },
    /// Build + install the amber binary and boot unit (systemd user unit on
    /// Linux, launchd agent on macOS) by running the repo's install script.
    Install {
        /// Resolve and print what would run, without running it.
        #[arg(long)]
        dry_run: bool,
        /// Also install the `amber web` boot unit (mobile web UI on
        /// 127.0.0.1:7717). Opt-in: it opens a local port.
        #[arg(long)]
        web: bool,
    },
    /// Symmetric to `install`: stop + disable + remove the boot unit (systemd
    /// user unit on Linux, launchd agent on macOS). Keeps the installed binary
    /// and the state store by default; opt into removing them with the flags.
    /// Idempotent — running it twice is not an error.
    Uninstall {
        /// Resolve and print what would run, without running it.
        #[arg(long)]
        dry_run: bool,
        /// Also remove the installed binary copy (`~/.local/bin/amber`).
        #[arg(long)]
        purge_binary: bool,
        /// Also remove the state store (sessions snapshot); destroys history.
        #[arg(long)]
        purge_state: bool,
        /// Also remove the `amber web` boot unit.
        #[arg(long)]
        web: bool,
    },
    #[command(hide = true)]
    InstallCodexSkill,
    #[command(hide = true)]
    PurgeCodexSkill,
    /// Install or repair Amber's global Pi session-id extension.
    InstallPiExtension,
}

fn resolve_socket(explicit: Option<PathBuf>) -> anyhow::Result<PathBuf> {
    explicit.map_or_else(amber::platform::socket_name, Ok)
}

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

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let Some(command) = cli.command else {
        return run_new(&resolve_socket(None)?);
    };
    match command {
        Command::Daemon { root, socket } => amber::daemon_main(root, socket),
        Command::Attach { name, no_prefix, no_status, force, socket } => {
            run_attach(&resolve_socket(socket)?, name, no_prefix, no_status, force)
        }
        Command::Ls { socket } => run_ls(&resolve_socket(socket)?),
        Command::Create { name, cwd, kind, socket } => {
            run_create(&resolve_socket(socket)?, &name, &cwd, &kind)
        }
        Command::Kill { name, socket } => run_kill(&resolve_socket(socket)?, &name),
        Command::Freeze { name, socket } => run_suspend(&resolve_socket(socket)?, &name, true),
        Command::Unfreeze { name, socket } => run_suspend(&resolve_socket(socket)?, &name, false),
        Command::Rename { from, to, socket } => {
            run_rename(&resolve_socket(socket)?, &from, &to)
        }
        Command::Web { port, new_token, print_url, root, socket } => {
            run_web(root, socket, port, new_token, print_url)
        }
        Command::Run { name, kind, slot } => run_supervisor(&name, &kind, slot),
        Command::CgroupExec { slot, role, command } => {
            Ok(amber::cgroup::exec_current_into(slot, role.into(), command)?)
        }
        Command::Hook => run_hook(),
        Command::Handoff { session_id } => run_handoff(&session_id),
        Command::Ctl { action } => match action {
            CtlAction::Doctor { root } => run_doctor(root),
            CtlAction::Status { socket } => run_status(&resolve_socket(socket)?),
            CtlAction::Budget { set, systemd, socket } => {
                run_budget(set.as_deref(), systemd, &resolve_socket(socket)?)
            }
            CtlAction::SnapshotNow { socket } => run_snapshot_now(&resolve_socket(socket)?),
            CtlAction::Install { dry_run, web } => run_install(dry_run, web),
            CtlAction::Uninstall { dry_run, purge_binary, purge_state, web } => {
                run_uninstall(dry_run, purge_binary, purge_state, web)
            }
            CtlAction::Web { action, port, json, root } => run_ctl_web(action, port, json, root),
            CtlAction::InstallCodexSkill => run_install_codex_skill(),
            CtlAction::PurgeCodexSkill => run_purge_codex_skill(),
            CtlAction::InstallPiExtension => run_install_pi_extension(),
        },
    }
}

/// Resolve the agent binaries via the login shell and persist their paths in
/// config, so the daemon (whose own PATH is stripped) always finds them. Fixes
/// the exact class of bug that motivated this rearchitecture.
fn run_doctor(root: Option<PathBuf>) -> anyhow::Result<()> {
    let root = amber::platform::resolve_state_root(root)?;
    std::fs::create_dir_all(&root)?;
    let store = StateStore::new(&root);

    // grok/codex/opencode/hermes/pi are optional: a machine with only claude installed is
    // a working amber, so a missing optional agent is reported but never fails
    // the doctor.
    if let Some(path) = amber::grok::resolve_grok() {
        let mut cfg = store.load_config()?;
        cfg.grok_path = Some(path.clone());
        store.save_config(&cfg)?;
        println!("grok:   {} (recorded in config)", path.display());
    } else {
        println!("grok:   not found via your login shell (grok panes will fall back to a shell)");
    }
    if let Some(path) = amber::codex::resolve_codex() {
        let mut cfg = store.load_config()?;
        cfg.codex_path = Some(path.clone());
        store.save_config(&cfg)?;
        println!("codex:  {} (recorded in config)", path.display());
    } else {
        println!("codex:  not found via your login shell (codex panes will fall back to a shell)");
    }
    if let Some(path) = amber::opencode::resolve_opencode() {
        let mut cfg = store.load_config()?;
        cfg.opencode_path = Some(path.clone());
        store.save_config(&cfg)?;
        println!("opencode: {} (recorded in config)", path.display());
    } else {
        println!("opencode: not found via your login shell (opencode panes will fall back to a shell)");
    }
    if let Some(path) = amber::hermes::resolve_hermes() {
        let mut cfg = store.load_config()?;
        cfg.hermes_path = Some(path.clone());
        store.save_config(&cfg)?;
        amber::hermes::ensure_global_hermes_plugin(&path);
        println!("hermes: {} (recorded in config)", path.display());
    } else {
        println!("hermes: not found via your login shell (hermes panes will fall back to a shell)");
    }
    if let Some(path) = amber::pi::resolve_pi() {
        let mut cfg = store.load_config()?;
        cfg.pi_path = Some(path.clone());
        store.save_config(&cfg)?;
        println!("pi:     {} (recorded in config)", path.display());
    } else {
        println!("pi:     not found via your login shell (pi panes will fall back to a shell)");
    }

    match claude::resolve_claude() {
        Some(path) => {
            let mut cfg = store.load_config()?;
            cfg.claude_path = Some(path.clone());
            store.save_config(&cfg)?;
            println!("claude: {} (recorded in config)", path.display());
            Ok(())
        }
        None => {
            println!("claude: NOT FOUND via your login shell — install it or add it to PATH");
            std::process::exit(1);
        }
    }
}

fn codex_skill_home() -> anyhow::Result<PathBuf> {
    std::env::var("HOME")
        .ok()
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("amber ctl: HOME must be set and non-empty"))
}

fn codex_skill_conflict_warning() {
    eprintln!(
        "amber: ~/.agents/skills/claude-handoff exists but is not Amber-owned; leaving it unchanged"
    );
}

fn run_install_codex_skill() -> anyhow::Result<()> {
    let home = codex_skill_home()?;
    let file = amber::codex_skill::skill_file(&home);
    match amber::codex_skill::install(&home)? {
        amber::codex_skill::InstallOutcome::Installed => println!("installed {}", file.display()),
        amber::codex_skill::InstallOutcome::Updated => println!("updated {}", file.display()),
        amber::codex_skill::InstallOutcome::Conflict => codex_skill_conflict_warning(),
    }
    Ok(())
}

fn run_purge_codex_skill() -> anyhow::Result<()> {
    let home = codex_skill_home()?;
    let file = amber::codex_skill::skill_file(&home);
    match amber::codex_skill::remove(&home)? {
        amber::codex_skill::RemoveOutcome::Removed => println!("removed {}", file.display()),
        amber::codex_skill::RemoveOutcome::Missing => {}
        amber::codex_skill::RemoveOutcome::Conflict => codex_skill_conflict_warning(),
    }
    Ok(())
}

fn run_install_pi_extension() -> anyhow::Result<()> {
    let path = amber::pi::install_global_pi_extension()?;
    println!("installed {}", path.display());
    Ok(())
}

/// Print (and consume) `last-crash-report.json` if the last boot found the
/// previous shutdown unclean and lost sessions restoring. Best-effort: a
/// missing/corrupt report is silently skipped, never fatal to `status`.
fn print_crash_report() {
    let Ok(root) = amber::platform::state_root() else {
        return;
    };
    let path = root.join("last-crash-report.json");
    let Ok(body) = std::fs::read_to_string(&path) else { return };
    let _ = std::fs::remove_file(&path);
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) else { return };
    let lost = v["lost_sessions"].as_array().map(|a| a.len()).unwrap_or(0);
    if lost == 0 {
        return;
    }
    println!("⚠ last daemon start followed an unclean shutdown — {lost} session(s) lost:");
    if let Some(names) = v["lost_sessions"].as_array() {
        for name in names {
            if let Some(s) = name.as_str() {
                println!("    {s}");
            }
        }
    }
}

/// Connect to the daemon and report liveness + session count.
fn run_status(socket: &Path) -> anyhow::Result<()> {
    match transport::connect(socket) {
        Ok(mut stream) => {
            stream.write_all(&proto::encode(&Frame::Control(ControlMsg::ListSessions)))?;
            let mut decoder = Decoder::new();
            let mut buf = [0u8; 8192];
            loop {
                if let Some(Frame::Control(ControlMsg::SessionList { names })) =
                    decoder.next_frame()?
                {
                    println!("daemon: up ({}) — {} session(s)", socket.display(), names.len());
                    print_crash_report();
                    return Ok(());
                }
                let n = stream.read(&mut buf)?;
                if n == 0 {
                    anyhow::bail!("daemon closed the connection before replying");
                }
                decoder.feed(&buf[..n]);
            }
        }
        Err(_) => {
            println!("daemon: unreachable at {}", socket.display());
            print_crash_report();
            std::process::exit(1);
        }
    }
}

/// Locate the repo's `infra/daemon/install.sh`: walk up from the running
/// binary (covers `target/{debug,release}/amber` in a checkout) and from this
/// crate's manifest dir (covers `cargo run` / test builds).
fn find_install_script() -> Option<PathBuf> {
    let mut starts: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        starts.push(exe);
    }
    starts.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    for start in starts {
        for dir in start.ancestors() {
            let candidate = dir.join("infra/daemon/install.sh");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// `ctl install`: thin wrapper over `infra/daemon/install.sh` (which builds
/// the release binary, installs it, and enables the boot unit).
fn run_install(dry_run: bool, web: bool) -> anyhow::Result<()> {
    let Some(script) = find_install_script() else {
        eprintln!(
            "amber ctl install: could not locate infra/daemon/install.sh \
             relative to this binary.\nRun it from a checkout instead:\n\n    \
             bash <amber-repo>/infra/daemon/install.sh\n"
        );
        anyhow::bail!("install script not found");
    };
    let args: Vec<String> = if web {
        vec!["install".to_string(), "--web".to_string()]
    } else {
        Vec::new()
    };
    if dry_run {
        println!("{}", format!("would run: bash {} {}", script.display(), args.join(" ")).trim_end());
        return Ok(());
    }
    let status = std::process::Command::new("bash").arg(&script).args(&args).status()?;
    if !status.success() {
        anyhow::bail!("install script failed with {status}");
    }
    Ok(())
}

/// `ctl uninstall`: symmetric to `install`, delegating to the same
/// `infra/daemon/install.sh` via its `uninstall` subcommand. Stops + disables +
/// removes the boot unit; `--purge-binary`/`--purge-state` opt into removing
/// the installed binary and the state store (both kept by default).
fn run_uninstall(
    dry_run: bool,
    purge_binary: bool,
    purge_state: bool,
    web: bool,
) -> anyhow::Result<()> {
    let Some(script) = find_install_script() else {
        eprintln!(
            "amber ctl uninstall: could not locate infra/daemon/install.sh \
             relative to this binary.\nRun it from a checkout instead:\n\n    \
             bash <amber-repo>/infra/daemon/install.sh uninstall\n"
        );
        anyhow::bail!("install script not found");
    };
    let mut args: Vec<String> = vec!["uninstall".to_string()];
    if purge_binary {
        args.push("--purge-binary".to_string());
    }
    if purge_state {
        args.push("--purge-state".to_string());
    }
    if web {
        args.push("--web".to_string());
    }
    if dry_run {
        println!("would run: bash {} {}", script.display(), args.join(" "));
        return Ok(());
    }
    let status = std::process::Command::new("bash")
        .arg(&script)
        .args(&args)
        .status()?;
    if !status.success() {
        anyhow::bail!("uninstall script failed with {status}");
    }
    Ok(())
}

/// Ask the daemon for an immediate snapshot and wait for the ack.
fn run_snapshot_now(socket: &Path) -> anyhow::Result<()> {
    let mut stream = transport::connect(socket)
        .map_err(|e| anyhow::anyhow!("daemon unreachable at {}: {e}", socket.display()))?;
    stream.write_all(&proto::encode(&Frame::Control(ControlMsg::Snapshot)))?;

    let mut decoder = Decoder::new();
    let mut buf = [0u8; 8192];
    loop {
        match decoder.next_frame()? {
            Some(Frame::Control(ControlMsg::SnapshotOk)) => {
                println!("snapshot written");
                return Ok(());
            }
            Some(Frame::Control(ControlMsg::Error { msg })) => {
                anyhow::bail!("snapshot failed: {msg}");
            }
            _ => {}
        }
        let n = stream.read(&mut buf)?;
        if n == 0 {
            anyhow::bail!("daemon closed the connection before replying");
        }
        decoder.feed(&buf[..n]);
    }
}

/// Parse a human budget size into MiB. Binary units: `20G`, `1536M`, `512K`,
/// `1T`, a bare number is MiB, and `auto` clears the override. Pure.
fn parse_size_mb(text: &str) -> anyhow::Result<Option<u64>> {
    let trimmed = text.trim();
    if trimmed.eq_ignore_ascii_case("auto") {
        return Ok(None);
    }
    let (digits, unit) = trimmed.split_at(trimmed.find(|c: char| c.is_ascii_alphabetic()).unwrap_or(trimmed.len()));
    let value: u64 = digits
        .trim()
        .parse()
        .map_err(|_| anyhow::anyhow!("bad size {text:?}: expected like 20G, 1536M or auto"))?;
    let mb = match unit.trim().to_ascii_lowercase().as_str() {
        "" | "m" => value,
        "g" => value.checked_mul(1024).ok_or_else(|| anyhow::anyhow!("size too large"))?,
        "t" => value
            .checked_mul(1024 * 1024)
            .ok_or_else(|| anyhow::anyhow!("size too large"))?,
        "k" => (value / 1024).max(if value > 0 { 1 } else { 0 }),
        other => anyhow::bail!("unknown size unit {other:?} in {text:?}"),
    };
    Ok(Some(mb))
}

/// Render MiB the way systemctl accepts MemoryHigh values (binary units).
fn format_mb_for_systemctl(mb: u64) -> String {
    if mb.is_multiple_of(1024 * 1024) && mb > 0 {
        format!("{}T", mb / (1024 * 1024))
    } else if mb.is_multiple_of(1024) && mb > 0 {
        format!("{}G", mb / 1024)
    } else {
        format!("{mb}M")
    }
}

/// The human-readable view both the get path and the set path print.
fn render_budget(
    configured_mb: Option<u64>,
    effective_kb: Option<u64>,
    cgroup_limit_kb: Option<u64>,
    session_high_kb: u64,
    physical_kb: Option<u64>,
) -> String {
    let fmt_gib = |kb: u64| {
        if kb.is_multiple_of(1024 * 1024) && kb > 0 {
            format!("{} GiB", kb / (1024 * 1024))
        } else {
            format!("{} MiB", kb / 1024)
        }
    };
    let mut lines = Vec::new();
    lines.push(match configured_mb {
        Some(mb) => format!("configured budget : {} MiB", mb),
        None => "configured budget : auto (half of physical RAM)".to_string(),
    });
    if let Some(kb) = effective_kb {
        lines.push(format!("effective budget  : {}", fmt_gib(kb)));
    } else {
        lines.push("effective budget  : none — automatic parking disabled".to_string());
    }
    if let Some(kb) = physical_kb {
        lines.push(format!("physical RAM      : {}", fmt_gib(kb)));
    }
    match cgroup_limit_kb {
        Some(kb) => lines.push(format!(
            "service cap       : {} (amber.service MemoryHigh)",
            fmt_gib(kb)
        )),
        None => lines.push("service cap       : none".to_string()),
    }
    lines.push(format!("per-pane ceiling  : {}", fmt_gib(session_high_kb)));
    if let (Some(effective), Some(limit)) = (effective_kb, cgroup_limit_kb) {
        if effective == limit {
            lines.push(
                "note: the budget is clamped by the service cap; raise it with \
                 `amber ctl budget <size> --systemd`"
                    .to_string(),
            );
        }
    }
    lines.join("\n")
}

fn run_budget(set: Option<&str>, systemd: bool, socket: &Path) -> anyhow::Result<()> {
    // Parse first so a typo never half-applies anything.
    let requested = set.map(parse_size_mb).transpose()?;

    // --systemd moves the OS-level cap FIRST, so the daemon's live re-derive
    // below sees the new limit rather than clamping the ask to the old one.
    if systemd {
        #[cfg(target_os = "linux")]
        {
            let target_mib = match requested {
                Some(Some(mb)) => mb,
                // "auto": the same half-of-physical the daemon derives.
                Some(None) | None => {
                    amber::procinfo::total_memory_kb()
                        .map(|kb| kb / 2 / 1024)
                        .filter(|_| requested.is_some())
                        .ok_or_else(|| {
                            anyhow::anyhow!("--systemd needs a size, or resolvable physical RAM for 'auto'")
                        })?
                }
            };
            let value = format_mb_for_systemctl(target_mib);
            let status = std::process::Command::new("systemctl")
                .args(["--user", "set-property", "amber.service", &format!("MemoryHigh={value}")])
                .status()
                .map_err(|e| anyhow::anyhow!("could not run systemctl: {e}"))?;
            if !status.success() {
                anyhow::bail!("systemctl set-property failed with {status}");
            }
            println!("amber.service MemoryHigh := {value} (live + persistent drop-in)");
        }
        #[cfg(not(target_os = "linux"))]
        {
            eprintln!("warning: --systemd has no effect off-Linux (no systemd MemoryHigh)");
        }
    }

    // View asks the daemon for its LIVE truth (it knows its real cap); a set
    // goes through the daemon so config persistence, session leaves, and the
    // guardian's budget handle all move together. "auto" is mb=0 on the wire.
    let mut stream = transport::connect(socket)
        .map_err(|e| anyhow::anyhow!("daemon unreachable at {}: {e}", socket.display()))?;
    let request = match set {
        None => ControlMsg::GetMemoryBudget,
        Some(_) => ControlMsg::SetMemoryBudget { mb: requested.and_then(|r| r).unwrap_or(0) },
    };
    stream.write_all(&proto::encode(&Frame::Control(request)))?;

    match read_budget_reply(&mut stream, std::time::Duration::from_secs(5))? {
        ControlMsg::BudgetApplied { mb, effective_budget_kb, cgroup_limit_kb, session_high_kb } => {
            if set.is_some() {
                println!("budget saved; live immediately (no restart)");
            }
            println!(
                "{}",
                render_budget(
                    (mb != 0).then_some(mb),
                    (effective_budget_kb != 0).then_some(effective_budget_kb),
                    (cgroup_limit_kb != 0).then_some(cgroup_limit_kb),
                    session_high_kb,
                    amber::procinfo::total_memory_kb(),
                )
            );
            Ok(())
        }
        ControlMsg::Error { msg } => anyhow::bail!("{msg}"),
        _ => unreachable!("read_budget_reply only yields BudgetApplied/Error"),
    }
}

/// Wait for the BudgetApplied/Error reply to a budget request.
fn read_budget_reply(
    stream: &mut LocalStream,
    timeout: std::time::Duration,
) -> anyhow::Result<ControlMsg> {
    let deadline = std::time::Instant::now() + timeout;
    let mut decoder = Decoder::new();
    let mut buf = [0u8; 8192];
    loop {
        match decoder.next_frame()? {
            Some(Frame::Control(msg @ ControlMsg::BudgetApplied { .. }))
            | Some(Frame::Control(msg @ ControlMsg::Error { .. })) => return Ok(msg),
            _ => {}
        }
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            anyhow::bail!("timed out waiting for the daemon's reply — is it older than this command? restart amber and retry");
        }
        match stream.read_with_timeout(&mut buf, remaining) {
            Ok(0) => anyhow::bail!(
                "no reply from the daemon — is it older than this command? restart amber and retry"
            ),
            Ok(n) => decoder.feed(&buf[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {
                anyhow::bail!("timed out waiting for the daemon's reply — is it older than this command? restart amber and retry")
            }
            Err(e) => return Err(e.into()),
        }
    }
}

/// Root used by `run`/`hook`: `AMBER_STATE_DIR` if set (the daemon sets it
/// when spawning this binary as a session's supervisor), else the same
/// default the daemon itself uses.
fn supervisor_root() -> anyhow::Result<PathBuf> {
    amber::platform::resolve_state_root(std::env::var_os("AMBER_STATE_DIR").map(PathBuf::from))
}

/// Socket the supervisor reports its run-state to. The daemon passes its actual
/// socket via `AMBER_SOCK` when spawning `amber run`; absent that (a
/// hand-started supervisor), fall back to the same default the daemon derives
/// from the state root.
fn supervisor_socket(root: &Path) -> anyhow::Result<PathBuf> {
    let explicit = std::env::var_os("AMBER_SOCK")
        .filter(|socket| !socket.is_empty())
        .map(PathBuf::from);
    explicit.map_or_else(|| amber::platform::socket_name_for_root(root), Ok)
}

fn run_supervisor(name: &str, kind: &str, slot: Option<u32>) -> anyhow::Result<()> {
    let root = supervisor_root()?;
    let socket = supervisor_socket(&root)?;
    supervisor::run_session(&root, name, &socket, kind, slot)
}

/// `SessionStart` hook: read the hook JSON from stdin and record the
/// rotating session id. A hook failure must never crash claude, so errors
/// are reported to stderr and swallowed (always exit 0).
fn run_hook() -> anyhow::Result<()> {
    let name = std::env::var("AMBER_SESSION").unwrap_or_default();
    // No AMBER_SESSION => a claude run outside an amber pane (the global hook
    // fires for every claude). Nothing to record; exit cleanly.
    if name.is_empty() {
        return Ok(());
    }
    let root = supervisor_root()?;

    let mut input = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut input) {
        eprintln!("amber hook: failed to read stdin: {e}");
        return Ok(());
    }

    let store = StateStore::new(root);
    if let Err(e) = claude::record_session(&store, &name, &input) {
        eprintln!("amber hook: failed to record session: {e}");
    }
    Ok(())
}

fn run_handoff(session_id: &str) -> anyhow::Result<()> {
    let handoff = claude::create_handoff(session_id)?;
    print!("{handoff}");
    if !handoff.ends_with('\n') {
        println!();
    }
    Ok(())
}

/// `amber ctl web <action>` — the desktop app's controller surface (spec §9).
///
/// Two rules live here and are load-bearing:
///
/// 1. **The token appears only in `url`.** `status` is polled every few
///    seconds by the Remote access dialog; a token in that payload would sit
///    in renderer memory and every IPC trace continuously. `status` therefore
///    reports `has_token` and a token-FREE url, and the tokenised one is
///    fetched on demand.
/// 2. **`/api/status` gets exactly ONE auth attempt.** `Auth::throttled`
///    buckets by peer IP, and behind `tailscale serve` every peer is
///    127.0.0.1, so a retry loop would burn the 8-failure budget and lock the
///    PHONE out for 60 s.
fn run_ctl_web(
    action: WebAction,
    port: u16,
    json: bool,
    root: Option<PathBuf>,
) -> anyhow::Result<()> {
    let root = amber::platform::resolve_state_root(root)?;
    std::fs::create_dir_all(&root)?;
    let home = PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/".into()));
    let unit = amber::webctl::unit_path(&home);

    match action {
        WebAction::Url => {
            let token = amber::web::load_or_create_token(&root, false)?;
            println!("{}", login_url(&amber::tailscale::detect(port), port, &token));
            Ok(())
        }
        WebAction::RotateToken => {
            amber::web::load_or_create_token(&root, true)?;
            // Rotation only bites once the server re-reads the file, and live
            // cookie sessions are held in the server's memory — so restarting
            // it IS the invalidation.
            let _ = run_web_argv(&amber::webctl::restart_argv(), &unit);
            if json {
                println!("{}", serde_json::json!({ "ok": true }));
            } else {
                println!("token rotated; every existing link and device is logged out");
            }
            Ok(())
        }
        WebAction::Enable => {
            let bin = std::env::current_exe()?;
            if let Some(parent) = unit.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let body = if cfg!(target_os = "macos") {
                amber::webctl::render_launchd_plist(&bin, port)
            } else {
                amber::webctl::render_systemd_unit(&bin, port)
            };
            std::fs::write(&unit, body)?;
            for a in amber::webctl::enable_argv() {
                run_web_argv(&a, &unit)?;
            }
            // Best effort: the unit is up either way, and the tailscale state
            // is reported by `status` with a named reason.
            let tail_err = amber::tailscale::enable_serve(port).err();
            if json {
                println!(
                    "{}",
                    serde_json::json!({
                        "ok": true,
                        "unit": unit.display().to_string(),
                        "tailscale_error": tail_err,
                    })
                );
            } else {
                println!("amber web enabled at boot ({})", unit.display());
                if let Some(e) = tail_err {
                    println!("tailscale serve failed: {e}");
                }
            }
            Ok(())
        }
        WebAction::Disable => {
            for a in amber::webctl::disable_argv() {
                let _ = run_web_argv(&a, &unit);
            }
            if json {
                println!("{}", serde_json::json!({ "ok": true }));
            } else {
                println!("amber web disabled");
            }
            Ok(())
        }
        WebAction::Start | WebAction::Stop | WebAction::Restart => {
            let argv = match action {
                WebAction::Start => amber::webctl::start_argv(),
                WebAction::Stop => amber::webctl::stop_argv(),
                _ => amber::webctl::restart_argv(),
            };
            let out = run_web_argv(&argv, &unit)?;
            if json {
                println!("{}", serde_json::json!({ "ok": out.status.success() }));
            } else if !out.status.success() {
                println!("{}", String::from_utf8_lossy(&out.stderr).trim());
            }
            if out.status.success() {
                Ok(())
            } else {
                anyhow::bail!("{} failed", argv.cmd)
            }
        }
        WebAction::Status => {
            let unit_state = match run_web_argv(&amber::webctl::is_active_argv(), &unit) {
                Ok(o) if o.status.success() => "active",
                Ok(_) => "inactive",
                Err(_) => "unknown",
            };
            let tail = amber::tailscale::detect(port);
            // READ-ONLY: `load_or_create_token` would mint a credential as a
            // side effect of a status query.
            let token = amber::web::load_token(&root);
            let host = tail.host().to_string();
            // NO token in this URL — see rule 1 above.
            let url = public_url(&tail, port);
            let live = token.as_deref().and_then(|t| fetch_web_status(port, t));
            if json {
                let mut out = serde_json::json!({
                    "unit": unit_state,
                    "port": port,
                    "url": url,
                    "has_token": token.is_some(),
                    "tailscale": tail.label(),
                    "host": host,
                    "error": serde_json::Value::Null,
                });
                match live {
                    Some(v) => {
                        for key in ["clients", "sessions", "uptime_secs"] {
                            out[key] = v.get(key).cloned().unwrap_or(serde_json::Value::Null);
                        }
                    }
                    None => {
                        out["error"] = serde_json::Value::String("server unreachable".into());
                    }
                }
                println!("{out}");
            } else {
                println!("unit:      {unit_state}");
                println!("port:      {port}");
                println!("tailscale: {} {}", tail.label(), host);
                println!("url:       {url}  (login url: `amber ctl web url`)");
                match live {
                    Some(v) => println!(
                        "server:    up {}s, {} sessions, {} clients",
                        v.get("uptime_secs").and_then(|x| x.as_u64()).unwrap_or(0),
                        v.get("sessions").and_then(|x| x.as_u64()).unwrap_or(0),
                        v.get("clients").and_then(|x| x.as_array()).map(|a| a.len()).unwrap_or(0),
                    ),
                    None => println!("server:    unreachable"),
                }
            }
            Ok(())
        }
    }
}

/// The address a client should use, WITHOUT the token.
///
/// The tailnet host is claimed ONLY when `tailscale serve` actually proxies
/// THIS port. Live testing caught the alternative: with a tailnet present but
/// mapped to a different port, we happily printed
/// `https://<host>/app` — an address that reaches some other service, or
/// nothing, and sends the user hunting for a server fault that does not exist.
fn public_url(tail: &amber::tailscale::TailState, port: u16) -> String {
    match tail {
        amber::tailscale::TailState::Serving { host } => format!("https://{host}/app"),
        _ => format!("http://127.0.0.1:{port}/app"),
    }
}

/// The login URL: `public_url` plus the token in the FRAGMENT — never a query
/// string, which the server receives and logs.
fn login_url(tail: &amber::tailscale::TailState, port: u16, token: &str) -> String {
    format!("{}#t={token}", public_url(tail, port))
}

/// Run one `webctl::Argv`, substituting the placeholders those pure builders
/// deliberately leave for the caller (`__UNIT__`, `__UID__`).
fn run_web_argv(a: &amber::webctl::Argv, unit: &Path) -> anyhow::Result<std::process::Output> {
    let uid = current_uid();
    let args: Vec<String> = a
        .args
        .iter()
        .map(|s| s.replace("__UNIT__", &unit.display().to_string()).replace("__UID__", &uid))
        .collect();
    Ok(std::process::Command::new(&a.cmd).args(&args).output()?)
}

/// Only the launchd argv needs a uid, and `id -u` is portable to exactly the
/// platform that needs it. Shelling out here keeps the crate free of a libc
/// dependency for one number.
fn current_uid() -> String {
    std::process::Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// Token -> cookie -> `/api/status`, over plain TCP to 127.0.0.1.
///
/// ONE auth attempt, ever: see `run_ctl_web`'s rule 2. Every failure returns
/// `None` (reported as "server unreachable"), never a retry.
fn fetch_web_status(port: u16, token: &str) -> Option<serde_json::Value> {
    use std::io::{Read, Write};
    let deadline = Duration::from_secs(3);

    let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).ok()?;
    s.set_read_timeout(Some(deadline)).ok()?;
    s.set_write_timeout(Some(deadline)).ok()?;
    let req = format!(
        "POST /api/auth HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\n\
         Connection: close\r\n\r\n{token}",
        token.len()
    );
    s.write_all(req.as_bytes()).ok()?;
    let mut head = String::new();
    s.read_to_string(&mut head).ok()?;
    let cookie = head
        .lines()
        .find_map(|l| l.strip_prefix("Set-Cookie: "))
        .and_then(|c| c.split(';').next())?
        .to_string();

    let mut s2 = std::net::TcpStream::connect(("127.0.0.1", port)).ok()?;
    s2.set_read_timeout(Some(deadline)).ok()?;
    s2.set_write_timeout(Some(deadline)).ok()?;
    let req2 = format!(
        "GET /api/status HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: {cookie}\r\n\
         Connection: close\r\n\r\n"
    );
    s2.write_all(req2.as_bytes()).ok()?;
    let mut body = String::new();
    s2.read_to_string(&mut body).ok()?;
    let json = body.split("\r\n\r\n").nth(1)?;
    serde_json::from_str(json).ok()
}

/// `amber web`: serve the mobile UI on 127.0.0.1 as a long-lived daemon
/// client. The token lives in the state dir (0600) and rides the URL fragment,
/// which browsers never send to a server (spec §3.3).
fn run_web(
    root: Option<PathBuf>,
    socket: Option<PathBuf>,
    port: u16,
    new_token: bool,
    print_url: bool,
) -> anyhow::Result<()> {
    let (root, socket) = amber::platform::resolve_paths(root, socket)?;
    std::fs::create_dir_all(&root)?;
    let token = amber::web::load_or_create_token(&root, new_token)?;
    let url = format!("http://127.0.0.1:{port}/#t={token}");
    if print_url {
        println!("{url}");
        return Ok(());
    }
    let listener = amber::web::bind(port)?;
    eprintln!("amber web: listening on 127.0.0.1:{port} (daemon {})", socket.display());
    // The tokenized URL is printed ONLY to an interactive terminal. Run as a
    // service (`amber ctl install --web`) stderr goes to the journal / a log
    // file, and the token is long-lived (rotated only by `--new-token`) — the
    // whole point of carrying it in the URL fragment is that it never lands in
    // a log. Same TTY-only discipline as the attach banner.
    if std::io::stderr().is_terminal() {
        eprintln!("amber web: open {url}");
    } else {
        eprintln!("amber web: run `amber web --print-url` in a terminal for the login URL");
    }
    eprintln!("amber web: expose it to your tailnet with: tailscale serve --bg {port}");
    amber::web::serve(listener, socket, root, token)
}

/// `/home/me/proj` → `~/proj`, so the cwd column stays readable. Exact `$HOME`
/// becomes `~`; an unrelated path (or an empty `$HOME`) is left alone.
fn shorten_home(path: &str, home: &str) -> String {
    if home.is_empty() {
        return path.to_string();
    }
    if path == home {
        return "~".to_string();
    }
    match path.strip_prefix(home) {
        Some(rest) if rest.starts_with('/') => format!("~{rest}"),
        _ => path.to_string(),
    }
}

/// The trailing `(…)` note on an `amber ls` row — shown only when it says
/// something the `kind` column does not. A dead-but-unreaped session still
/// lists (that is what backs the app's "exited · close pane" overlay), so
/// without this a corpse and a live shell print identically.
fn ls_status(s: &proto::SessionInfo) -> String {
    if !s.alive {
        return "  (exited)".to_string();
    }
    match &s.run_state {
        Some(state) if *state != s.kind => format!("  ({state})"),
        _ => String::new(),
    }
}

fn run_ls(socket: &Path) -> anyhow::Result<()> {
    let mut stream = transport::connect(socket)?;
    stream.write_all(&proto::encode(&Frame::Control(ControlMsg::ListSessionsDetailed)))?;

    let mut decoder = Decoder::new();
    let mut buf = [0u8; 8192];
    loop {
        if let Some(Frame::Control(ControlMsg::Sessions { mut sessions })) = decoder.next_frame()? {
            // The printed number is the session's STABLE slot (`attach <n>`
            // resolves it directly), so it does not change when another session
            // dies. Listing ORDER stays by name — stable and readable — and the
            // slot column is width-padded to the widest slot.
            sessions.sort_by(|a, b| a.name.cmp(&b.name));
            let home = std::env::var("HOME").unwrap_or_default();
            let w = sessions.iter().map(|s| s.slot).max().unwrap_or(0).to_string().len();
            let nw = sessions.iter().map(|s| s.name.len()).max().unwrap_or(0);
            let cwds: Vec<String> = sessions.iter().map(|s| shorten_home(&s.cwd, &home)).collect();
            let cw = cwds.iter().map(|c| c.len()).max().unwrap_or(0);
            for (s, cwd) in sessions.iter().zip(&cwds) {
                let status = ls_status(s);
                println!(
                    "{:>w$}  {:<nw$}  {:<cw$}  {}{}",
                    s.slot,
                    s.name,
                    cwd,
                    s.kind,
                    status,
                    w = w,
                    nw = nw,
                    cw = cw
                );
            }
            return Ok(());
        }
        let n = stream.read(&mut buf)?;
        if n == 0 {
            anyhow::bail!("daemon closed the connection before replying");
        }
        decoder.feed(&buf[..n]);
    }
}

/// `amber attach [name|slot]`: resolve the detach prefix (from `--no-prefix` and
/// `AMBER_PREFIX`) and the target session (the newest live one when no name is
/// given), then hand off to the raw-mode client.
fn run_attach(
    socket: &Path,
    name: Option<String>,
    no_prefix: bool,
    no_status: bool,
    force: bool,
) -> anyhow::Result<()> {
    // Refuse to nest inside another amber pane unless forced (--force or
    // AMBER_ALLOW_NEST): two stacked raw streams collide on the detach prefix.
    // An empty AMBER_SESSION is treated as unset.
    let force = force || std::env::var_os("AMBER_ALLOW_NEST").is_some();
    let amber_session = std::env::var("AMBER_SESSION").ok().filter(|s| !s.is_empty());
    if let Some(msg) = attach::nest_refusal(amber_session.as_deref(), force) {
        eprintln!("[amber] {msg}");
        std::process::exit(1);
    }

    let env = std::env::var("AMBER_PREFIX").ok();
    let res = attach::resolve_prefix(no_prefix, env.as_deref());
    if let Some(w) = &res.warning {
        eprintln!("[amber] {w}");
    }

    // Resolve the target session AND its kind in one detailed listing. The bar
    // is shown only for shell sessions: a full-screen TUI session (claude)
    // lives on the alt screen, which the raw client can't observe, so drawing a
    // bar over it would inject escapes into the TUI (and reserving a row is
    // pointless there).
    let (name, is_shell) = resolve_target(socket, name)?;
    let want_bar = !no_status && is_shell;
    attach::attach(socket, &name, res.prefix, want_bar)
}

/// Connect to the daemon, turning a bare ENOENT/ECONNREFUSED into the advice
/// the user actually needs. Every interactive path (attach, bare `amber`) goes
/// through it.
fn connect_daemon(socket: &Path) -> anyhow::Result<LocalStream> {
    transport::connect(socket).map_err(|e| {
        anyhow::anyhow!(
            "cannot reach the amber daemon at {} ({e}) — is it running? \
             start it with `amber daemon` or the systemd/launchd service",
            socket.display()
        )
    })
}

/// `amber` with no subcommand — the tmux reflex. Creates a shell session in the
/// current directory and attaches to it, so the muscle memory of typing `tmux`
/// works. Deliberately NOT "attach the newest session" (that is `amber attach`
/// with no name): bare `tmux` always makes a new one.
///
/// The session is named `s<n>`, outside the app's `amber-<ws>-<tab>-<ord>-<id>`
/// grammar, so it belongs to no workspace and no pane shows it — it is a CLI
/// session. The app's Sessions dialog lists it as `no pane` with an Adopt
/// button, which is the supported way to pull it onto the desktop.
fn run_new(socket: &Path) -> anyhow::Result<()> {
    // Same nesting guard as `attach`: two stacked raw clients fight over the
    // detach prefix, and a shell inside a pane already has a session.
    let force = std::env::var_os("AMBER_ALLOW_NEST").is_some();
    let amber_session = std::env::var("AMBER_SESSION").ok().filter(|s| !s.is_empty());
    if let Some(msg) = attach::nest_refusal(amber_session.as_deref(), force) {
        eprintln!("[amber] {msg}");
        std::process::exit(1);
    }

    let name = attach::next_session_name(&list_session_names(socket)?);
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    create_session(socket, &name, &cwd, "shell")?;

    let env = std::env::var("AMBER_PREFIX").ok();
    let res = attach::resolve_prefix(false, env.as_deref());
    if let Some(w) = &res.warning {
        eprintln!("[amber] {w}");
    }
    // Always a shell, so the status bar applies (it is suppressed for the
    // full-screen TUI a claude session runs).
    attach::attach(socket, &name, res.prefix, true)
}

/// Every session name the daemon holds — the pool `next_session_name` avoids.
fn list_session_names(socket: &Path) -> anyhow::Result<Vec<String>> {
    let mut stream = connect_daemon(socket)?;
    stream.write_all(&proto::encode(&Frame::Control(ControlMsg::ListSessions)))?;

    let mut decoder = Decoder::new();
    let mut buf = [0u8; 8192];
    loop {
        if let Some(Frame::Control(ControlMsg::SessionList { names })) = decoder.next_frame()? {
            return Ok(names);
        }
        let n = stream.read(&mut buf)?;
        if n == 0 {
            anyhow::bail!("daemon closed the connection before replying");
        }
        decoder.feed(&buf[..n]);
    }
}

/// Resolve the attach target and whether it is a shell session. With a name,
/// looks that session up (an unknown name is left for the daemon to reject, and
/// assumed shell); with no name, picks the most-recently-updated live session.
fn resolve_target(socket: &Path, name: Option<String>) -> anyhow::Result<(String, bool)> {
    let mut stream = connect_daemon(socket)?;
    stream.write_all(&proto::encode(&Frame::Control(ControlMsg::ListSessionsDetailed)))?;

    let mut decoder = Decoder::new();
    let mut buf = [0u8; 8192];
    loop {
        if let Some(Frame::Control(ControlMsg::Sessions { sessions })) = decoder.next_frame()? {
            return match name {
                // A pure-integer arg is a SLOT — the stable number `amber ls`
                // prints; anything else is a literal session name. amber session
                // names are `amber-…`, never bare integers, so there's no
                // practical ambiguity.
                Some(n) if n.parse::<u32>().is_ok() => {
                    let slot = n.parse::<u32>().unwrap();
                    match attach::pick_by_slot(&sessions, slot) {
                        Some(s) => Ok((s.name.clone(), s.kind == "shell")),
                        None => anyhow::bail!("no session with slot {slot} (see `amber ls`)"),
                    }
                }
                Some(n) => {
                    let is_shell =
                        sessions.iter().find(|s| s.name == n).is_none_or(|s| s.kind == "shell");
                    Ok((n, is_shell))
                }
                None => match attach::pick_newest(&sessions) {
                    Some(s) => Ok((s.name.clone(), s.kind == "shell")),
                    None => anyhow::bail!("no live sessions to attach"),
                },
            };
        }
        let n = stream.read(&mut buf)?;
        if n == 0 {
            anyhow::bail!("daemon closed the connection before replying");
        }
        decoder.feed(&buf[..n]);
    }
}

/// List every session the daemon currently holds (dead-but-unreaped included).
fn list_detailed(socket: &Path) -> anyhow::Result<Vec<amber_core::proto::SessionInfo>> {
    let mut stream = connect_daemon(socket)?;
    stream.write_all(&proto::encode(&Frame::Control(ControlMsg::ListSessionsDetailed)))?;

    let mut decoder = Decoder::new();
    let mut buf = [0u8; 8192];
    loop {
        if let Some(Frame::Control(ControlMsg::Sessions { sessions })) = decoder.next_frame()? {
            return Ok(sessions);
        }
        let n = stream.read(&mut buf)?;
        if n == 0 {
            anyhow::bail!("daemon closed the connection before replying");
        }
        decoder.feed(&buf[..n]);
    }
}

/// Resolve a CLI name-or-slot against the daemon's current listing. Missing
/// names and missing slots are both errors (see `amber ls`).
fn resolve_existing(socket: &Path, arg: &str) -> anyhow::Result<String> {
    let sessions = list_detailed(socket)?;
    attach::resolve_name_or_slot(arg, &sessions).map_err(|e| anyhow::anyhow!("{e}"))
}

/// `amber kill <name|slot>`: ask the daemon to destroy a session. The daemon
/// sends no reply to Kill (it only broadcasts to watchers), so we confirm
/// removal with a follow-up ListSessions on the same connection — the daemon
/// services frames in order, so the session is already gone by the time it
/// replies. A name or slot the daemon does not currently list is an error.
fn run_kill(socket: &Path, arg: &str) -> anyhow::Result<()> {
    let name = resolve_existing(socket, arg)?;
    let mut stream = transport::connect(socket)?;
    stream.write_all(&proto::encode(&Frame::Control(ControlMsg::Kill {
        name: name.clone(),
    })))?;
    stream.write_all(&proto::encode(&Frame::Control(ControlMsg::ListSessions)))?;

    let mut decoder = Decoder::new();
    let mut buf = [0u8; 8192];
    loop {
        if let Some(Frame::Control(ControlMsg::SessionList { names })) = decoder.next_frame()? {
            if names.iter().any(|n| n == &name) {
                anyhow::bail!("kill failed: session {name} still present");
            }
            println!("killed {name}");
            return Ok(());
        }
        let n = stream.read(&mut buf)?;
        if n == 0 {
            anyhow::bail!("daemon closed the connection before replying");
        }
        decoder.feed(&buf[..n]);
    }
}

/// `amber freeze` / `amber unfreeze`: send Suspend/Resume. Success is
/// fire-and-forget (no ack); a failure comes back as `Error` before the
/// follow-up listing. A missing name/slot is refused before we send anything.
fn run_suspend(socket: &Path, arg: &str, freeze: bool) -> anyhow::Result<()> {
    let name = resolve_existing(socket, arg)?;
    let verb = if freeze { "freeze" } else { "unfreeze" };
    let ok = if freeze { "froze" } else { "unfroze" };
    let msg = if freeze {
        ControlMsg::Suspend { name: name.clone() }
    } else {
        ControlMsg::Resume { name: name.clone() }
    };
    let mut stream = transport::connect(socket)?;
    stream.write_all(&proto::encode(&Frame::Control(msg)))?;
    stream.write_all(&proto::encode(&Frame::Control(ControlMsg::ListSessionsDetailed)))?;

    let mut decoder = Decoder::new();
    let mut buf = [0u8; 8192];
    let mut err = None;
    loop {
        match decoder.next_frame()? {
            Some(Frame::Control(ControlMsg::Error { msg })) => {
                err = Some(msg);
            }
            Some(Frame::Control(ControlMsg::Sessions { sessions })) => {
                if let Some(msg) = err {
                    anyhow::bail!("{verb} failed: {msg}");
                }
                if !sessions.iter().any(|s| s.name == name) {
                    anyhow::bail!("no such session: {name}");
                }
                println!("{ok} {name}");
                return Ok(());
            }
            Some(Frame::Control(_)) => {}
            _ => {}
        }
        let n = stream.read(&mut buf)?;
        if n == 0 {
            if let Some(msg) = err {
                anyhow::bail!("{verb} failed: {msg}");
            }
            anyhow::bail!("daemon closed the connection before replying");
        }
        decoder.feed(&buf[..n]);
    }
}

/// `amber rename <from> <to>`: send Rename and surface the daemon's reply. The
/// daemon acks with `Created { name: to }`; a refusal (unknown `from`, a `to`
/// that already exists, an invalid name) comes back as `Error` and exits
/// nonzero.
fn run_rename(socket: &Path, from: &str, to: &str) -> anyhow::Result<()> {
    let mut stream = transport::connect(socket)?;
    stream.write_all(&proto::encode(&Frame::Control(ControlMsg::Rename {
        from: from.to_string(),
        to: to.to_string(),
    })))?;

    let mut decoder = Decoder::new();
    let mut buf = [0u8; 8192];
    loop {
        match decoder.next_frame()? {
            Some(Frame::Control(ControlMsg::Error { msg })) => {
                anyhow::bail!("rename failed: {msg}");
            }
            // The ack is `Created { name: to }`; any non-error reply counts.
            Some(Frame::Control(_)) => {
                println!("renamed {from} -> {to}");
                return Ok(());
            }
            _ => {}
        }
        let n = stream.read(&mut buf)?;
        if n == 0 {
            anyhow::bail!("daemon closed the connection before replying");
        }
        decoder.feed(&buf[..n]);
    }
}

fn run_create(socket: &Path, name: &str, cwd: &Path, kind: &str) -> anyhow::Result<()> {
    println!("created {}", create_session(socket, name, cwd, kind)?);
    Ok(())
}

/// Create a session and return the name the daemon acked. Silent, because bare
/// `amber` hands straight off to the raw client — a "created" line would just
/// be scribbled over by the attach decoration.
fn create_session(socket: &Path, name: &str, cwd: &Path, kind: &str) -> anyhow::Result<String> {
    let mut stream = connect_daemon(socket)?;
    let request = Frame::Control(ControlMsg::Create {
        name: name.to_string(),
        cwd: cwd.to_string_lossy().to_string(),
        kind: kind.to_string(),
    });
    stream.write_all(&proto::encode(&request))?;

    let mut decoder = Decoder::new();
    let mut buf = [0u8; 8192];
    loop {
        match decoder.next_frame()? {
            Some(Frame::Control(ControlMsg::Created { name })) => return Ok(name),
            Some(Frame::Control(ControlMsg::Error { msg })) => {
                anyhow::bail!("create failed: {msg}");
            }
            _ => {}
        }
        let n = stream.read(&mut buf)?;
        if n == 0 {
            anyhow::bail!("daemon closed the connection before replying");
        }
        decoder.feed(&buf[..n]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_budget_sizes_in_binary_units() {
        assert_eq!(parse_size_mb("20G").unwrap(), Some(20 * 1024));
        assert_eq!(parse_size_mb("1536M").unwrap(), Some(1536));
        assert_eq!(parse_size_mb("20480").unwrap(), Some(20_480)); // bare = MiB
        assert_eq!(parse_size_mb("512K").unwrap(), Some(1)); // rounds up to 1 MiB
        assert_eq!(parse_size_mb(" 2t ").unwrap(), Some(2 * 1024 * 1024));
        assert_eq!(parse_size_mb("auto").unwrap(), None);
        assert_eq!(parse_size_mb("AUTO").unwrap(), None);
        assert!(parse_size_mb("12X").is_err());
        assert!(parse_size_mb("G").is_err());
        assert!(parse_size_mb("-5G").is_err());
        assert!(parse_size_mb("").is_err());
    }

    #[test]
    fn formats_whole_gibibytes_for_systemctl() {
        assert_eq!(format_mb_for_systemctl(20 * 1024), "20G");
        assert_eq!(format_mb_for_systemctl(1536), "1536M");
        assert_eq!(format_mb_for_systemctl(1024 * 1024), "1T");
    }

    #[test]
    fn budget_view_renders_the_clamp_note_only_when_actually_clamped() {
        let clamped = render_budget(Some(20_480), Some(8_388_608), Some(8_388_608), 4_194_304, Some(33_554_432));
        assert!(clamped.contains("clamped by the service cap"), "{clamped}");
        assert!(clamped.contains("configured budget : 20480 MiB"), "{clamped}");

        let headroom = render_budget(Some(4_096), Some(4_194_304), Some(8_388_608), 4_194_304, None);
        assert!(!headroom.contains("clamped"), "{headroom}");

        let disabled = render_budget(None, None, None, 0, None);
        assert!(disabled.contains("automatic parking disabled"), "{disabled}");
    }

    #[test]
    fn parses_hidden_cgroup_launcher_without_rewriting_agent_flags() {
        let cli = Cli::try_parse_from([
            "amber",
            "__cgroup-exec",
            "--slot",
            "7",
            "--role",
            "workload",
            "--",
            "/bin/sh",
            "-l",
        ])
        .unwrap();
        let Some(Command::CgroupExec { slot, role, command }) = cli.command else {
            panic!("expected hidden cgroup launcher");
        };
        assert_eq!(slot, 7);
        assert_eq!(role, CgroupRoleArg::Workload);
        assert_eq!(command, [std::ffi::OsString::from("/bin/sh"), std::ffi::OsString::from("-l")]);
    }

    #[test]
    fn hidden_cgroup_launcher_rejects_zero_unknown_role_and_empty_command() {
        assert!(Cli::try_parse_from([
            "amber",
            "__cgroup-exec",
            "--slot",
            "0",
            "--role",
            "workload",
            "--",
            "/bin/sh",
        ])
        .is_err());
        assert!(Cli::try_parse_from([
            "amber",
            "__cgroup-exec",
            "--slot",
            "7",
            "--role",
            "other",
            "--",
            "/bin/sh",
        ])
        .is_err());
        assert!(Cli::try_parse_from([
            "amber",
            "__cgroup-exec",
            "--slot",
            "7",
            "--role",
            "supervisor",
        ])
        .is_err());
    }

    #[test]
    fn internal_run_accepts_explicit_slot_and_legacy_invocation() {
        let cli = Cli::try_parse_from([
            "amber", "run", "name", "--kind", "claude", "--slot", "7",
        ])
        .unwrap();
        let Some(Command::Run { name, kind, slot }) = cli.command else {
            panic!("expected internal run command");
        };
        assert_eq!((name.as_str(), kind.as_str(), slot), ("name", "claude", Some(7)));

        let legacy = Cli::try_parse_from(["amber", "run", "name"]).unwrap();
        let Some(Command::Run { slot, .. }) = legacy.command else {
            panic!("expected legacy internal run command");
        };
        assert_eq!(slot, None);
    }

    fn info(kind: &str, alive: bool, run_state: Option<&str>) -> proto::SessionInfo {
        proto::SessionInfo {
            name: "amber-1-1-0-abc".to_string(),
            cwd: "/home/me/proj".to_string(),
            kind: kind.to_string(),
            alive,
            updated: 0,
            run_state: run_state.map(str::to_string),
            claude_id: None,
            cols: 80,
            rows: 24,
            slot: 1,
        }
    }

    #[test]
    fn shorten_home_rewrites_only_real_home_prefixes() {
        assert_eq!(shorten_home("/home/me/proj", "/home/me"), "~/proj");
        assert_eq!(shorten_home("/home/me", "/home/me"), "~");
        // Not a path-component boundary — must not become `~ta/x`.
        assert_eq!(shorten_home("/home/meta/x", "/home/me"), "/home/meta/x");
        assert_eq!(shorten_home("/tmp", "/home/me"), "/tmp");
        assert_eq!(shorten_home("/home/me/proj", ""), "/home/me/proj");
    }

    #[test]
    fn ls_status_flags_dead_and_off_kind_run_states() {
        assert_eq!(ls_status(&info("shell", false, None)), "  (exited)");
        // Dead wins: a run_state is stale once the child is gone.
        assert_eq!(ls_status(&info("claude", false, Some("claude"))), "  (exited)");
        assert_eq!(ls_status(&info("shell", true, None)), "");
        // Redundant with the kind column.
        assert_eq!(ls_status(&info("claude", true, Some("claude"))), "");
        assert_eq!(ls_status(&info("claude", true, Some("suspended"))), "  (suspended)");
        assert_eq!(ls_status(&info("grok", true, Some("shell-fallback"))), "  (shell-fallback)");
    }
}
