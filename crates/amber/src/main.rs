//! `amber` CLI: busybox-style subcommands over the daemon's unix socket
//! (spec §2).

use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use amber::attach;
use amber::daemon::Daemon;
use amber::manager::SessionManager;
use amber_core::proto::{self, ControlMsg, Decoder, Frame};
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
    }
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

    // A stale socket file from a previous (crashed/killed) daemon run must
    // not block bind().
    if socket_path.exists() {
        std::fs::remove_file(&socket_path)?;
    }
    let listener = UnixListener::bind(&socket_path)?;

    // Periodic snapshot thread.
    // TODO Slice 3: read the interval from config.snapshot_interval_secs via
    // a manager getter instead of hardcoding; manager.rs is frozen for this
    // packet so 10s (the spec's own default) is inlined here.
    {
        let manager = Arc::clone(&manager);
        thread::spawn(move || loop {
            thread::sleep(Duration::from_secs(10));
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
    let daemon = Daemon::new(manager);
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
