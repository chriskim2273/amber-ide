//! Boot-unit rendering and lifecycle argv for the router service.
//!
//! Same shape and the same discipline as `webctl`: everything here is PURE —
//! it returns strings and argv and does no IO — so the substitutions are
//! testable without writing a unit into somebody's home directory.

use std::path::{Path, PathBuf};

pub use crate::webctl::Argv;

/// systemd user unit file name (matches `infra/daemon/amber-router.service`).
pub const SYSTEMD_UNIT_NAME: &str = "amber-router.service";
/// launchd label (matches `infra/daemon/com.amber-ide.router.plist.in`).
pub const LAUNCHD_LABEL: &str = "com.amber-ide.router";
/// Loopback port the shipped unit uses. Must match `amber-router`'s default.
pub const DEFAULT_PORT: u16 = 7719;

const SYSTEMD_TEMPLATE: &str = include_str!("../../../infra/daemon/amber-router.service");
const LAUNCHD_TEMPLATE: &str = include_str!("../../../infra/daemon/com.amber-ide.router.plist.in");

fn argv(cmd: &str, args: &[&str]) -> Argv {
    Argv { cmd: cmd.to_string(), args: args.iter().map(|s| s.to_string()).collect() }
}

/// The systemd unit with an absolute `amber-router` path substituted for the
/// shipped `%h/.local/bin/amber-router`.
///
/// STRUCTURAL, not textual, for the reason `webctl` records: an exact-string
/// replace of the whole `ExecStart=` line silently no-ops the day the shipped
/// unit is reformatted, and the installed service would then point at a binary
/// we do not control, on the default port, whatever was asked for.
pub fn render_systemd_unit(bin: &Path, port: u16) -> String {
    let mut out: String = SYSTEMD_TEMPLATE
        .lines()
        .map(|l| {
            if l.starts_with("ExecStart=") {
                format!("ExecStart={} serve --port {port}", bin.display())
            } else {
                l.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    out.push('\n');
    out
}

pub fn render_launchd_plist(bin: &Path, port: u16) -> String {
    render_launchd_plist_with_home(bin, port, &std::env::var("HOME").unwrap_or_else(|_| "/".into()))
}

/// Split out so the substitution is testable without touching the environment.
/// The port is the `<string>` that POSITIONALLY follows `--port`, never a
/// literal `7719` match: that number could legitimately appear elsewhere.
pub fn render_launchd_plist_with_home(bin: &Path, port: u16, home: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut after_port_flag = false;
    for line in LAUNCHD_TEMPLATE.lines() {
        let replaced = line
            .replace("__AMBER_ROUTER_BIN__", &bin.display().to_string())
            .replace("__HOME__", home);
        if after_port_flag && replaced.trim().starts_with("<string>") {
            let indent = &replaced[..replaced.len() - replaced.trim_start().len()];
            out.push(format!("{indent}<string>{port}</string>"));
            after_port_flag = false;
            continue;
        }
        after_port_flag = replaced.trim() == "<string>--port</string>";
        out.push(replaced);
    }
    let mut s = out.join("\n");
    s.push('\n');
    s
}

/// Where the unit file belongs for this platform.
pub fn unit_path(home: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        home.join("Library").join("LaunchAgents").join(format!("{LAUNCHD_LABEL}.plist"))
    } else {
        home.join(".config").join("systemd").join("user").join(SYSTEMD_UNIT_NAME)
    }
}

/// The `amber-router` that ships beside the running `amber`.
pub fn sibling_binary(amber_exe: &Path) -> PathBuf {
    let name = if cfg!(windows) { "amber-router.exe" } else { "amber-router" };
    amber_exe.parent().map(|d| d.join(name)).unwrap_or_else(|| PathBuf::from(name))
}

pub fn enable_argv() -> Vec<Argv> {
    if cfg!(target_os = "macos") {
        vec![argv("launchctl", &["load", "-w", "__UNIT__"])]
    } else {
        vec![
            argv("systemctl", &["--user", "daemon-reload"]),
            argv("systemctl", &["--user", "enable", SYSTEMD_UNIT_NAME]),
            argv("systemctl", &["--user", "restart", SYSTEMD_UNIT_NAME]),
        ]
    }
}

pub fn disable_argv() -> Vec<Argv> {
    if cfg!(target_os = "macos") {
        vec![argv("launchctl", &["unload", "-w", "__UNIT__"])]
    } else {
        vec![
            argv("systemctl", &["--user", "stop", SYSTEMD_UNIT_NAME]),
            argv("systemctl", &["--user", "disable", SYSTEMD_UNIT_NAME]),
        ]
    }
}

pub fn start_argv() -> Argv {
    if cfg!(target_os = "macos") {
        argv("launchctl", &["load", "__UNIT__"])
    } else {
        argv("systemctl", &["--user", "start", SYSTEMD_UNIT_NAME])
    }
}

pub fn stop_argv() -> Argv {
    if cfg!(target_os = "macos") {
        argv("launchctl", &["unload", "__UNIT__"])
    } else {
        argv("systemctl", &["--user", "stop", SYSTEMD_UNIT_NAME])
    }
}

pub fn restart_argv() -> Argv {
    if cfg!(target_os = "macos") {
        argv("launchctl", &["kickstart", "-k", &format!("gui/__UID__/{LAUNCHD_LABEL}")])
    } else {
        argv("systemctl", &["--user", "restart", SYSTEMD_UNIT_NAME])
    }
}

pub fn is_active_argv() -> Argv {
    if cfg!(target_os = "macos") {
        argv("launchctl", &["print", &format!("gui/__UID__/{LAUNCHD_LABEL}")])
    } else {
        argv("systemctl", &["--user", "is-active", SYSTEMD_UNIT_NAME])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn systemd_unit_carries_bin_and_port() {
        let bin = Path::new("/home/u/.local/bin/amber-router");
        let u = render_systemd_unit(bin, 7719);
        assert!(u.contains("ExecStart=/home/u/.local/bin/amber-router serve --port 7719"), "{u}");
        assert!(u.contains("WantedBy=default.target"));
        assert!(!u.contains("%h/.local/bin/amber-router"), "{u}");
    }

    #[test]
    fn systemd_rewrite_survives_a_reformatted_template() {
        let u = render_systemd_unit(Path::new("/x/amber-router"), 9999);
        assert_eq!(u.lines().filter(|l| l.starts_with("ExecStart=")).count(), 1, "{u}");
        assert!(u.contains("--port 9999"), "{u}");
    }

    #[test]
    fn plist_port_is_rewritten_positionally_after_the_flag() {
        let p = render_launchd_plist(Path::new("/x/amber-router"), 9999);
        assert!(p.contains("<string>--port</string>"), "{p}");
        assert!(p.contains("<string>9999</string>"), "{p}");
        assert!(!p.contains("<string>7719</string>"), "{p}");
        assert!(!p.contains("__AMBER_ROUTER_BIN__"), "{p}");
    }

    #[test]
    fn plist_log_path_is_absolute_under_the_home() {
        let p = render_launchd_plist_with_home(Path::new("/x/amber-router"), 7719, "/Users/u");
        assert!(p.contains("<string>/Users/u/Library/Logs/amber-router.log</string>"), "{p}");
        assert!(!p.contains("__HOME__"), "{p}");
    }

    #[test]
    fn the_router_binary_is_looked_for_beside_amber() {
        let sib = sibling_binary(Path::new("/opt/amber-ide/amber"));
        assert_eq!(sib.parent().unwrap(), Path::new("/opt/amber-ide"));
        assert!(sib.file_name().unwrap().to_string_lossy().starts_with("amber-router"));
    }

    #[test]
    fn lifecycle_argv_never_targets_the_daemon_or_the_web_unit() {
        for a in [start_argv(), stop_argv(), restart_argv(), is_active_argv()] {
            let joined = format!("{} {}", a.cmd, a.args.join(" "));
            assert!(
                joined.contains("amber-router") || joined.contains("com.amber-ide.router"),
                "{joined}"
            );
            assert!(!joined.contains("amber-web"), "{joined}");
            assert!(!joined.split_whitespace().any(|w| w == "amber.service"), "{joined}");
        }
    }
}
