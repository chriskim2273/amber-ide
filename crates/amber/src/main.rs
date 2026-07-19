//! `amber` CLI: busybox-style subcommands over the daemon's unix socket
//! (spec §2).

use std::io::{IsTerminal, Read, Write};
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
    /// Raw-mode terminal client — the `tmux attach` replacement. Detach with
    /// the prefix key then `d` (default `Ctrl-b`; remap via `AMBER_PREFIX=C-a`,
    /// or disable interception with `--no-prefix`). With no <name>, attaches
    /// the most-recently-updated live session.
    Attach {
        /// Session to attach: a name, or a 1-based index from `amber ls`. Omit
        /// to attach the newest live session.
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
        Command::Attach { name, no_prefix, no_status, force, socket } => {
            run_attach(&resolve_socket(socket), name, no_prefix, no_status, force)
        }
        Command::Ls { socket } => run_ls(&resolve_socket(socket)),
        Command::Create { name, cwd, kind, socket } => {
            run_create(&resolve_socket(socket), &name, &cwd, &kind)
        }
        Command::Kill { name, socket } => run_kill(&resolve_socket(socket), &name),
        Command::Rename { from, to, socket } => run_rename(&resolve_socket(socket), &from, &to),
        Command::Web { port, new_token, print_url, root, socket } => {
            run_web(root, socket, port, new_token, print_url)
        }
        Command::Run { name } => run_supervisor(&name),
        Command::Hook => run_hook(),
        Command::Ctl { action } => match action {
            CtlAction::Doctor { root } => run_doctor(root),
            CtlAction::Status { socket } => run_status(&resolve_socket(socket)),
            CtlAction::SnapshotNow { socket } => run_snapshot_now(&resolve_socket(socket)),
            CtlAction::Install { dry_run, web } => run_install(dry_run, web),
            CtlAction::Uninstall { dry_run, purge_binary, purge_state, web } => {
                run_uninstall(dry_run, purge_binary, purge_state, web)
            }
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

/// Socket the supervisor reports its run-state to. The daemon passes its actual
/// socket via `AMBER_SOCK` when spawning `amber run`; absent that (a
/// hand-started supervisor), fall back to the same default the daemon derives
/// from the state root.
fn supervisor_socket() -> PathBuf {
    let root = supervisor_root();
    std::env::var("AMBER_SOCK")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| default_socket(&root))
}

fn run_supervisor(name: &str) -> anyhow::Result<()> {
    supervisor::run_session(&supervisor_root(), name, &supervisor_socket())
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
    let root = root.unwrap_or_else(default_root);
    std::fs::create_dir_all(&root)?;
    let token = amber::web::load_or_create_token(&root, new_token)?;
    let url = format!("http://127.0.0.1:{port}/#t={token}");
    if print_url {
        println!("{url}");
        return Ok(());
    }
    let socket = socket.unwrap_or_else(|| default_socket(&root));
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
    amber::web::serve(listener, socket, token)
}

fn run_daemon(root: Option<PathBuf>, socket: Option<PathBuf>) -> anyhow::Result<()> {
    let root = root.unwrap_or_else(default_root);
    std::fs::create_dir_all(&root)?;
    let socket_path = socket.unwrap_or_else(|| default_socket(&root));
    if let Some(parent) = socket_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    // Created before the manager so restored sessions get their output-activity
    // hook wired (a restored pane that produces output must light its tab dot).
    let watchers = std::sync::Arc::new(amber::watchers::Watchers::new());
    let manager = Arc::new(
        SessionManager::new(&root)?
            .with_socket(socket_path.clone())
            .with_watchers(Arc::clone(&watchers)),
    );
    // Global claude SessionStart hook: lets a hand-started claude in a shell
    // record its resume id too (best-effort; the per-session hook covers
    // amber-launched claude).
    if let Ok(exe) = std::env::current_exe() {
        claude::ensure_global_claude_hook(&format!("{} hook", exe.display()));
    }
    manager.restore()?;

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

    // Periodic memory monitor (Slice 1). Every MEM_POLL_SECS, take ONE /proc
    // snapshot and sum each live session's child-process-tree RSS, tracking a
    // small per-session ring to flag a sustained-growth (leak) signature. Each
    // reading is broadcast as MemoryStat over the SAME bounded watcher channel as
    // Activity, so a wedged client can never stall the monitor or the daemon.
    // Degrades to a silent no-op where process_table() is empty (non-Linux, or an
    // unreadable /proc). Read-only: it never touches session lifecycle.
    {
        use std::collections::{HashMap, HashSet, VecDeque};
        let manager = Arc::clone(&manager);
        let watchers = Arc::clone(&watchers);
        const MEM_POLL_SECS: u64 = 3;
        const WINDOW: usize = 5;
        const MIN_GROWTH_KB: u64 = 100_000; // ~100 MiB sustained rise over the window
        const NOISE_KB: u64 = 20_000;
        thread::spawn(move || {
            let mut samples: HashMap<String, VecDeque<u64>> = HashMap::new();
            loop {
                thread::sleep(Duration::from_secs(MEM_POLL_SECS));
                let table = amber::procinfo::process_table();
                if table.is_empty() {
                    continue; // unsupported OS / unreadable /proc — nothing to report
                }
                let pids = manager.live_pids();
                let live: HashSet<&str> = pids.iter().map(|(n, _)| n.as_str()).collect();
                samples.retain(|name, _| live.contains(name.as_str()));
                for (name, pid) in &pids {
                    let rss = amber::procinfo::subtree_rss_kb(&table, *pid);
                    let ring = samples.entry(name.clone()).or_default();
                    ring.push_back(rss);
                    while ring.len() > WINDOW {
                        ring.pop_front();
                    }
                    let series: Vec<u64> = ring.iter().copied().collect();
                    let growing = amber::procinfo::is_growing(&series, MIN_GROWTH_KB, NOISE_KB);
                    watchers.broadcast(&amber_core::proto::ControlMsg::MemoryStat {
                        name: name.clone(),
                        rss_kb: rss,
                        growing,
                    });
                }
            }
        });
    }

    // SIGTERM/SIGINT -> final snapshot, then exit (spec §7 pre-reboot gap).
    {
        let manager = Arc::clone(&manager);
        let mut signals = Signals::new([SIGTERM, SIGINT])?;
        thread::spawn(move || {
            if signals.forever().next().is_some() {
                // Final snapshot PRESERVES resume_as_claude (claude is being
                // cgroup-killed alongside us; re-detecting would clobber it).
                if let Err(e) = manager.snapshot_final() {
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
        if let Some(Frame::Control(ControlMsg::SessionList { mut names })) = decoder.next_frame()? {
            // Sort by name so the 1-based index printed here is the SAME order
            // `amber attach <n>` resolves against (attach::pick_by_index sorts by
            // name too). Width-pad the index so columns line up past 9 sessions.
            names.sort();
            let w = names.len().to_string().len();
            for (i, n) in names.iter().enumerate() {
                println!("{:>w$}  {n}", i + 1, w = w);
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

/// `amber attach [name|index]`: resolve the detach prefix (from `--no-prefix` and
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

/// Resolve the attach target and whether it is a shell session. With a name,
/// looks that session up (an unknown name is left for the daemon to reject, and
/// assumed shell); with no name, picks the most-recently-updated live session.
fn resolve_target(socket: &Path, name: Option<String>) -> anyhow::Result<(String, bool)> {
    let mut stream = UnixStream::connect(socket).map_err(|e| {
        anyhow::anyhow!(
            "cannot reach the amber daemon at {} ({e}) — is it running? \
             start it with `amber daemon` or the systemd/launchd service",
            socket.display()
        )
    })?;
    stream.write_all(&proto::encode(&Frame::Control(ControlMsg::ListSessionsDetailed)))?;

    let mut decoder = Decoder::new();
    let mut buf = [0u8; 8192];
    loop {
        if let Some(Frame::Control(ControlMsg::Sessions { sessions })) = decoder.next_frame()? {
            return match name {
                // A pure-integer arg is a 1-based index into the by-name sort
                // (what `amber ls` prints); anything else is a literal session
                // name. amber session names are `amber-…`, never bare integers,
                // so there's no practical ambiguity.
                Some(n) if n.parse::<usize>().is_ok() => {
                    let idx = n.parse::<usize>().unwrap();
                    match attach::pick_by_index(&sessions, idx) {
                        Some(s) => Ok((s.name.clone(), s.kind == "shell")),
                        None => anyhow::bail!("no session at index {idx} (see `amber ls`)"),
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

/// `amber kill <name>`: ask the daemon to destroy a session. The daemon sends
/// no reply to Kill (it only broadcasts to watchers), so we confirm removal
/// with a follow-up ListSessions on the same connection — the daemon services
/// frames in order, so the session is already gone by the time it replies.
/// Killing a name that never existed is a success (idempotent).
fn run_kill(socket: &Path, name: &str) -> anyhow::Result<()> {
    let mut stream = UnixStream::connect(socket)?;
    stream.write_all(&proto::encode(&Frame::Control(ControlMsg::Kill {
        name: name.to_string(),
    })))?;
    stream.write_all(&proto::encode(&Frame::Control(ControlMsg::ListSessions)))?;

    let mut decoder = Decoder::new();
    let mut buf = [0u8; 8192];
    loop {
        if let Some(Frame::Control(ControlMsg::SessionList { names })) = decoder.next_frame()? {
            if names.iter().any(|n| n == name) {
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

/// `amber rename <from> <to>`: send Rename and surface the daemon's reply. The
/// daemon acks with `Created { name: to }`; a refusal (unknown `from`, a `to`
/// that already exists, an invalid name) comes back as `Error` and exits
/// nonzero.
fn run_rename(socket: &Path, from: &str, to: &str) -> anyhow::Result<()> {
    let mut stream = UnixStream::connect(socket)?;
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
