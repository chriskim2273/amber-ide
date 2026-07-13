//! `amber` CLI: busybox-style subcommands over the daemon's unix socket
//! (spec §2).

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use amber::attach;
use amber::claude;
use amber::daemon::Daemon;
use amber::manager::SessionManager;
use amber::supervisor;
use amber_core::proto::{self, ControlMsg, Decoder, Frame};
use amber_core::state::StateStore;
use clap::{Parser, Subcommand};
use signal_hook::consts::{SIGINT, SIGTERM};
use signal_hook::iterator::Signals;

#[derive(Parser)]
#[command(name = "amber", about = "amber session daemon + CLI")]
struct Cli {
    #[command(subcommand)]
    command: Command,
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
    /// Raw-mode terminal client — the `tmux attach` replacement.
    Attach {
        name: String,
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
    /// Supervise a claude/shell session inside its pty (spawned by the
    /// daemon as the Claude session's child process; not meant to be run
    /// directly by users).
    Run {
        name: String,
    },
    /// `SessionStart` hook target invoked by claude itself; records the
    /// rotating session id from stdin (`AMBER_SESSION`/`AMBER_STATE_DIR`
    /// env, spec §6.2).
    Hook,
    /// Diagnostics + lifecycle helpers.
    Ctl {
        #[command(subcommand)]
        action: CtlAction,
    },
}

#[derive(Subcommand)]
enum CtlAction {
    /// Resolve the claude binary via your login shell and record it in config
    /// (the distribution-safe path — never the daemon's own PATH; spec §8).
    Doctor {
        #[arg(long)]
        root: Option<PathBuf>,
    },
    /// Report whether the daemon is reachable and how many sessions it holds.
    Status {
        #[arg(long)]
        socket: Option<PathBuf>,
    },
    /// Ask the running daemon to flush a snapshot to the state store now.
    SnapshotNow {
        #[arg(long)]
        socket: Option<PathBuf>,
    },
    /// Build + install the amber binary and boot unit (systemd user unit on
    /// Linux, launchd agent on macOS) by running the repo's install script.
    Install {
        /// Resolve and print what would run, without running it.
        #[arg(long)]
        dry_run: bool,
    },
}

/// `$XDG_STATE_HOME/amber-ide`, falling back to `$HOME/.local/state/amber-ide`.
fn default_root() -> PathBuf {
    if let Ok(state_home) = std::env::var("XDG_STATE_HOME") {
        if !state_home.is_empty() {
            return PathBuf::from(state_home).join("amber-ide");
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".local/state/amber-ide")
}

/// `$XDG_RUNTIME_DIR/amber-ide/amberd.sock`, falling back to `<root>/amberd.sock`.
fn default_socket(root: &Path) -> PathBuf {
    if let Ok(runtime_dir) = std::env::var("XDG_RUNTIME_DIR") {
        if !runtime_dir.is_empty() {
            return PathBuf::from(runtime_dir).join("amber-ide").join("amberd.sock");
        }
    }
    root.join("amberd.sock")
}

fn resolve_socket(explicit: Option<PathBuf>) -> PathBuf {
    explicit.unwrap_or_else(|| default_socket(&default_root()))
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Daemon { root, socket } => run_daemon(root, socket),
        Command::Attach { name, socket } => attach::attach(&resolve_socket(socket), &name),
        Command::Ls { socket } => run_ls(&resolve_socket(socket)),
        Command::Create { name, cwd, kind, socket } => {
            run_create(&resolve_socket(socket), &name, &cwd, &kind)
        }
        Command::Run { name } => run_supervisor(&name),
        Command::Hook => run_hook(),
        Command::Ctl { action } => match action {
            CtlAction::Doctor { root } => run_doctor(root),
            CtlAction::Status { socket } => run_status(&resolve_socket(socket)),
            CtlAction::SnapshotNow { socket } => run_snapshot_now(&resolve_socket(socket)),
            CtlAction::Install { dry_run } => run_install(dry_run),
        },
    }
}

/// Resolve claude via the login shell and persist the path in config, so the
/// daemon (whose own PATH is stripped) always finds it. Fixes the exact class
/// of bug that motivated this rearchitecture.
fn run_doctor(root: Option<PathBuf>) -> anyhow::Result<()> {
    let root = root.unwrap_or_else(default_root);
    std::fs::create_dir_all(&root)?;
    let store = StateStore::new(&root);
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

/// Connect to the daemon and report liveness + session count.
fn run_status(socket: &Path) -> anyhow::Result<()> {
    match UnixStream::connect(socket) {
        Ok(mut stream) => {
            stream.write_all(&proto::encode(&Frame::Control(ControlMsg::ListSessions)))?;
            let mut decoder = Decoder::new();
            let mut buf = [0u8; 8192];
            loop {
                if let Some(Frame::Control(ControlMsg::SessionList { names })) =
                    decoder.next_frame()?
                {
                    println!("daemon: up ({}) — {} session(s)", socket.display(), names.len());
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
fn run_install(dry_run: bool) -> anyhow::Result<()> {
    let Some(script) = find_install_script() else {
        eprintln!(
            "amber ctl install: could not locate infra/daemon/install.sh \
             relative to this binary.\nRun it from a checkout instead:\n\n    \
             bash <amber-repo>/infra/daemon/install.sh\n"
        );
        anyhow::bail!("install script not found");
    };
    if dry_run {
        println!("would run: bash {}", script.display());
        return Ok(());
    }
    let status = std::process::Command::new("bash").arg(&script).status()?;
    if !status.success() {
        anyhow::bail!("install script failed with {status}");
    }
    Ok(())
}

/// Ask the daemon for an immediate snapshot and wait for the ack.
fn run_snapshot_now(socket: &Path) -> anyhow::Result<()> {
    let mut stream = UnixStream::connect(socket)
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

/// Root used by `run`/`hook`: `AMBER_STATE_DIR` if set (the daemon sets it
/// when spawning this binary as a session's supervisor), else the same
/// default the daemon itself uses.
fn supervisor_root() -> PathBuf {
    std::env::var("AMBER_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| default_root())
}

fn run_supervisor(name: &str) -> anyhow::Result<()> {
    supervisor::run_session(&supervisor_root(), name)
}

/// `SessionStart` hook: read the hook JSON from stdin and record the
/// rotating session id. A hook failure must never crash claude, so errors
/// are reported to stderr and swallowed (always exit 0).
fn run_hook() -> anyhow::Result<()> {
    let name = std::env::var("AMBER_SESSION").unwrap_or_default();
    let root = supervisor_root();

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

fn run_daemon(root: Option<PathBuf>, socket: Option<PathBuf>) -> anyhow::Result<()> {
    let root = root.unwrap_or_else(default_root);
    std::fs::create_dir_all(&root)?;
    let socket_path = socket.unwrap_or_else(|| default_socket(&root));
    if let Some(parent) = socket_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let manager = Arc::new(SessionManager::new(&root)?);
    manager.restore()?;
    let watchers = std::sync::Arc::new(amber::watchers::Watchers::new());

    // A stale socket file from a previous (crashed/killed) daemon run must
    // not block bind() — but a LIVE daemon's socket must never be stolen.
    let listener = amber::daemon::prepare_socket(&socket_path)?;

    // Periodic snapshot thread (cadence from config, spec §7).
    {
        let manager = Arc::clone(&manager);
        let watchers = Arc::clone(&watchers);
        let interval = manager.snapshot_interval_secs().max(1);
        thread::spawn(move || loop {
            thread::sleep(Duration::from_secs(interval));
            // Reap ended sessions first so the snapshot never re-persists a
            // dead pane ("child exits -> session ends", spec §6.1).
            match manager.reap() {
                Ok(reaped) => {
                    if !reaped.is_empty() {
                        for name in &reaped {
                            eprintln!("amber daemon: session {name} ended; reaped");
                        }
                        watchers.broadcast(&amber_core::proto::ControlMsg::SessionsChanged {
                            added: vec![],
                            removed: reaped,
                        });
                    }
                }
                Err(e) => eprintln!("amber daemon: reap failed: {e}"),
            }
            if let Err(e) = manager.snapshot() {
                eprintln!("amber daemon: periodic snapshot failed: {e}");
            }
        });
    }

    // SIGTERM/SIGINT -> final snapshot, then exit (spec §7 pre-reboot gap).
    {
        let manager = Arc::clone(&manager);
        let mut signals = Signals::new([SIGTERM, SIGINT])?;
        thread::spawn(move || {
            if signals.forever().next().is_some() {
                if let Err(e) = manager.snapshot() {
                    eprintln!("amber daemon: final snapshot failed: {e}");
                }
                std::process::exit(0);
            }
        });
    }

    eprintln!("amber daemon: listening on {}", socket_path.display());
    let daemon = Daemon::new(Arc::clone(&manager), Arc::clone(&watchers));
    daemon.serve(listener)
}

fn run_ls(socket: &Path) -> anyhow::Result<()> {
    let mut stream = UnixStream::connect(socket)?;
    stream.write_all(&proto::encode(&Frame::Control(ControlMsg::ListSessions)))?;

    let mut decoder = Decoder::new();
    let mut buf = [0u8; 8192];
    loop {
        if let Some(Frame::Control(ControlMsg::SessionList { names })) = decoder.next_frame()? {
            for n in names {
                println!("{n}");
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

fn run_create(socket: &Path, name: &str, cwd: &Path, kind: &str) -> anyhow::Result<()> {
    let mut stream = UnixStream::connect(socket)?;
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
            Some(Frame::Control(ControlMsg::Created { name })) => {
                println!("created {name}");
                return Ok(());
            }
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
