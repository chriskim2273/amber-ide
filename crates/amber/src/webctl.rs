//! Lifecycle control for the `amber web` boot unit.
//!
//! The units themselves already ship in `infra/daemon/` and are installed by
//! `install.sh --web`. That path needs a git checkout, which a packaged
//! AppImage does not have (its cargo-free first-run install writes only the
//! DAEMON unit), so the templates are embedded here and Rust owns writing
//! them. One implementation serves the repo install, the packaged install and
//! the app's Remote access dialog.

use std::path::{Path, PathBuf};

/// systemd user unit file name (matches `infra/daemon/amber-web.service`).
pub const SYSTEMD_UNIT_NAME: &str = "amber-web.service";
/// launchd label (matches `infra/daemon/com.amber-ide.web.plist.in`).
pub const LAUNCHD_LABEL: &str = "com.amber-ide.web";

const SYSTEMD_TEMPLATE: &str = include_str!("../../../infra/daemon/amber-web.service");
const LAUNCHD_TEMPLATE: &str = include_str!("../../../infra/daemon/com.amber-ide.web.plist.in");

/// One command to run. Mirrors the app's `serviceManager.ts` `Argv` shape so
/// both sides of the boundary describe a process the same way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Argv {
    pub cmd: String,
    pub args: Vec<String>,
}

fn argv(cmd: &str, args: &[&str]) -> Argv {
    Argv { cmd: cmd.to_string(), args: args.iter().map(|s| s.to_string()).collect() }
}

/// The systemd unit with an ABSOLUTE binary path substituted for the shipped
/// `%h/.local/bin/amber`: the packaged app may install `amber` elsewhere, and
/// `%h` would silently point at a binary that is not the one we control.
///
/// STRUCTURAL, not textual: an exact-string replace of the whole
/// `ExecStart=%h/.local/bin/amber web --port 7717` line silently no-ops the
/// day someone reformats the shipped unit, and the packaged app would then
/// enable a service pointing at `%h/.local/bin/amber` on port 7717 regardless
/// of its arguments. Rewrite the line by prefix instead.
pub fn render_systemd_unit(bin: &Path, port: u16) -> String {
    let mut out: String = SYSTEMD_TEMPLATE
        .lines()
        .map(|l| {
            if l.starts_with("ExecStart=") {
                format!("ExecStart={} web --port {port}", bin.display())
            } else {
                l.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    out.push('\n');
    out
}

/// The launchd agent with the binary path and port substituted.
///
/// Same reasoning as the systemd path, and the plist is worse: a bare
/// `<string>7717</string>` could appear for an unrelated reason in a future
/// template. Rewrite the argument that FOLLOWS `--port`, positionally.
pub fn render_launchd_plist(bin: &Path, port: u16) -> String {
    render_launchd_plist_with_home(bin, port, &std::env::var("HOME").unwrap_or_else(|_| "/".into()))
}

/// Split out so the substitution is testable without touching the process
/// environment.
pub fn render_launchd_plist_with_home(bin: &Path, port: u16, home: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut after_port_flag = false;
    for line in LAUNCHD_TEMPLATE.lines() {
        let replaced = line
            .replace("__AMBER_BIN__", &bin.display().to_string())
            // The log path the app's log panel reads — launchd has no journal.
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

/// Install-and-start. `__UNIT__` / `__UID__` are substituted by the caller,
/// which is the only party that knows the home dir and uid — keeping these
/// builders pure is what makes them testable.
pub fn enable_argv() -> Vec<Argv> {
    if cfg!(target_os = "macos") {
        vec![argv("launchctl", &["load", "-w", "__UNIT__"])]
    } else {
        vec![
            argv("systemctl", &["--user", "daemon-reload"]),
            argv("systemctl", &["--user", "enable", SYSTEMD_UNIT_NAME]),
            // `enable --now` does not restart an already-running unit, so an
            // upgrade could leave the old binary resident indefinitely (the
            // same reasoning install.sh records).
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
    use std::path::Path;

    #[test]
    fn systemd_unit_carries_bin_and_port() {
        let bin = if cfg!(windows) {
            Path::new(r"C:\Users\u\.local\bin\amber.exe")
        } else {
            Path::new("/home/u/.local/bin/amber")
        };
        let u = render_systemd_unit(bin, 7717);
        assert!(
            u.contains(&format!("ExecStart={} web --port 7717", bin.display())),
            "{u}"
        );
        assert!(u.contains("WantedBy=default.target"));
        assert!(u.contains("Wants=amber.service"));
        // %h expansion must be GONE — we write an absolute path, because the
        // packaged app may install the binary somewhere else entirely.
        assert!(!u.contains("%h/.local/bin/amber"), "{u}");
    }

    #[test]
    fn systemd_rewrite_survives_a_reformatted_template() {
        // The regression the structural rewrite exists for: exactly one
        // ExecStart line, and it is OURS, whatever the shipped file looks like.
        let u = render_systemd_unit(Path::new("/x/amber"), 9999);
        assert_eq!(u.lines().filter(|l| l.starts_with("ExecStart=")).count(), 1, "{u}");
        assert!(u.contains("--port 9999"), "{u}");
    }

    #[test]
    fn launchd_plist_carries_bin_and_port() {
        let p = render_launchd_plist(Path::new("/opt/amber"), 9001);
        assert!(p.contains("<string>/opt/amber</string>"), "{p}");
        assert!(p.contains("<string>9001</string>"), "{p}");
        assert!(p.contains("<string>com.amber-ide.web</string>"), "{p}");
        assert!(!p.contains("__AMBER_BIN__"), "{p}");
    }

    #[test]
    fn plist_log_path_is_absolute_under_the_home() {
        let p = render_launchd_plist_with_home(Path::new("/x/amber"), 7717, "/Users/u");
        assert!(p.contains("<string>/Users/u/Library/Logs/amber-web.log</string>"), "{p}");
        assert!(!p.contains("__HOME__"), "{p}");
    }

    #[test]
    fn plist_port_is_rewritten_positionally_after_the_flag() {
        let p = render_launchd_plist(Path::new("/x/amber"), 9999);
        assert!(p.contains("<string>--port</string>"), "{p}");
        assert!(p.contains("<string>9999</string>"), "{p}");
        assert!(!p.contains("<string>7717</string>"), "{p}");
    }

    #[test]
    fn unit_path_is_under_the_users_home() {
        let home = if cfg!(windows) {
            Path::new(r"C:\Users\u")
        } else {
            Path::new("/home/u")
        };
        let p = unit_path(home);
        let s = p.to_string_lossy();
        assert!(p.starts_with(home), "{s}");
        if cfg!(target_os = "macos") {
            assert!(s.ends_with("Library/LaunchAgents/com.amber-ide.web.plist"), "{s}");
        } else {
            assert!(
                p.ends_with(
                    Path::new(".config")
                        .join("systemd")
                        .join("user")
                        .join("amber-web.service")
                ),
                "{s}"
            );
        }
    }

    #[test]
    fn lifecycle_argv_names_the_web_unit_only() {
        for argv in [start_argv(), stop_argv(), restart_argv(), is_active_argv()] {
            let joined = format!("{} {}", argv.cmd, argv.args.join(" "));
            assert!(
                joined.contains("amber-web") || joined.contains("com.amber-ide.web"),
                "lifecycle argv must never target the daemon unit: {joined}"
            );
            // `amber-web.service` contains `amber.service` as a substring, so
            // the daemon-unit check has to be word-accurate.
            assert!(!joined.split_whitespace().any(|w| w == "amber.service"), "{joined}");
        }
    }
}
