//! amber daemon internals (Slice 0): pty session ownership, and later the
//! socket server + attach client. Kept as a lib so the pieces are testable.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use amber_core::proto::ControlMsg;
use amber_core::state::StateStore;

#[cfg(unix)]
use signal_hook::consts::{SIGINT, SIGTERM};
#[cfg(unix)]
use signal_hook::iterator::Signals;

pub mod attach;
pub mod claude;
pub mod codex;
pub mod codex_skill;
pub mod cgroup;
pub mod daemon;
pub mod grok;
pub mod host_pressure;
pub mod hermes;
pub mod layout_cas;
pub mod manager;
pub mod memory_guardian;
pub mod mosaic;
pub mod opencode;
pub mod pi;
pub mod procinfo;
pub mod pty;
pub mod search;
pub mod platform;
pub mod supervisor;
pub mod web;
pub mod tailscale;
pub mod transport;
pub mod webctl;
pub mod watchers;

/// Start the long-lived Amber session daemon.
///
/// This shared entry point is used by the CLI and platform-specific daemon
/// binaries. Supplying neither path preserves the CLI's platform defaults.
pub fn daemon_main(root: Option<PathBuf>, socket: Option<PathBuf>) -> anyhow::Result<()> {
    let root = match root {
        Some(root) => root,
        None => default_daemon_root()?,
    };
    std::fs::create_dir_all(&root)?;
    let socket_path = match socket {
        Some(socket) => socket,
        None => default_daemon_socket(&root)?,
    };
    #[cfg(unix)]
    if let Some(parent) = socket_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let watchers = Arc::new(watchers::Watchers::new());
    let (config, pressure_was_normalized) =
        StateStore::new(&root).load_config_with_diagnostics()?;
    if pressure_was_normalized {
        eprintln!(
            "amber daemon: warning: configured [pressure] values were normalized to safe limits/defaults"
        );
    }
    let cgroups = cgroup::CgroupManager::activate();
    let cgroup_limit_kb = match cgroups.lowest_finite_limit_kb() {
        Ok(limit) => limit,
        Err(error) => {
            eprintln!("amber daemon: could not read cgroup memory limits: {error}");
            None
        }
    };
    let budget_kb = config.memory.budget_kb(procinfo::total_memory_kb(), cgroup_limit_kb);
    cgroups.set_session_high_kb(config.memory.session_high_kb(budget_kb));
    let memory_config = config.memory.clone();
    let pressure_config = config.pressure.clone();
    let refresh_pi_extension = config.pi_path.as_ref().is_some_and(|path| path.exists())
        || pi::resolve_pi().is_some()
        || StateStore::new(&root)
            .list_sessions()?
            .iter()
            .any(|meta| meta.kind == amber_core::state::SessionKind::Pi);
    let manager = Arc::new(
        manager::SessionManager::new_with_cgroups(&root, config, cgroups)?
            .with_socket(socket_path.clone())
            .with_watchers(Arc::clone(&watchers)),
    );
    manager.store_effective_budget_kb(budget_kb);
    if let Ok(exe) = manager::resolve_current_exe() {
        let hook = format!("{} hook", exe.display());
        claude::ensure_global_claude_hook(&hook);
        codex::ensure_global_codex_hook(&hook);
        opencode::ensure_global_opencode_plugin();
        if let Some(path) = hermes::resolve_hermes() {
            hermes::ensure_global_hermes_plugin(&path);
        }
    }
    if refresh_pi_extension {
        pi::ensure_global_pi_extension();
    }
    manager.restore()?;

    let listener = daemon::prepare_socket(&socket_path)?;
    {
        let manager = Arc::clone(&manager);
        let watchers = Arc::clone(&watchers);
        let interval = manager.snapshot_interval_secs().max(1);
        thread::spawn(move || loop {
            thread::sleep(Duration::from_secs(interval));
            match manager.reap() {
                Ok(reaped) => {
                    if !reaped.is_empty() {
                        for name in &reaped {
                            eprintln!("amber daemon: session {name} ended; reaped");
                        }
                        watchers.broadcast(&ControlMsg::SessionsChanged {
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

    memory_guardian::start(
        Arc::clone(&manager),
        Arc::clone(&watchers),
        memory_config,
        pressure_config,
    );

    #[cfg(unix)]
    {
        let manager = Arc::clone(&manager);
        let mut signals = Signals::new([SIGTERM, SIGINT])?;
        thread::spawn(move || {
            if signals.forever().next().is_some() {
                if let Err(e) = manager.snapshot_final() {
                    eprintln!("amber daemon: final snapshot failed: {e}");
                }
                if let Err(e) = manager.mark_clean_shutdown() {
                    eprintln!("amber daemon: could not mark clean shutdown: {e}");
                }
                std::process::exit(0);
            }
        });
    }

    eprintln!("amber daemon: listening on {}", socket_path.display());
    let daemon = daemon::Daemon::new(Arc::clone(&manager), Arc::clone(&watchers));
    daemon.serve(listener)
}

#[cfg(unix)]
fn default_daemon_root() -> anyhow::Result<PathBuf> {
    if let Ok(state_home) = std::env::var("XDG_STATE_HOME") {
        if !state_home.is_empty() {
            return Ok(PathBuf::from(state_home).join("amber-ide"));
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    Ok(PathBuf::from(home).join(".local/state/amber-ide"))
}

#[cfg(windows)]
fn default_daemon_root() -> anyhow::Result<PathBuf> {
    platform::state_root()
}

#[cfg(unix)]
fn default_daemon_socket(root: &Path) -> anyhow::Result<PathBuf> {
    if let Ok(runtime_dir) = std::env::var("XDG_RUNTIME_DIR") {
        if !runtime_dir.is_empty() {
            return Ok(PathBuf::from(runtime_dir)
                .join("amber-ide")
                .join("amberd.sock"));
        }
    }
    Ok(root.join("amberd.sock"))
}

#[cfg(windows)]
fn default_daemon_socket(_root: &Path) -> anyhow::Result<PathBuf> {
    platform::socket_name()
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    #[test]
    fn daemon_entrypoint_is_available_to_secondary_binaries() {
        let _: fn(Option<PathBuf>, Option<PathBuf>) -> anyhow::Result<()> = super::daemon_main;
    }
}
