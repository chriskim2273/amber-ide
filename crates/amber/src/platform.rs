//! Small cross-platform helpers that paper over Unix/Windows differences in
//! home-directory and default-shell resolution. Kept tiny and pure-ish so the
//! `#[cfg]` split lives in one place instead of scattered across manager /
//! supervisor / claude.

use std::path::PathBuf;

/// The user's home directory (`$HOME` on Unix, `%USERPROFILE%` on Windows),
/// via the `directories` crate so both platforms resolve consistently.
pub fn home_dir() -> Option<PathBuf> {
    directories::UserDirs::new().map(|u| u.home_dir().to_path_buf())
}

/// The default interactive shell to spawn in a pty.
/// - Unix: `$SHELL`, falling back to `/bin/sh`.
#[cfg(unix)]
pub fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
}

/// - Windows: `pwsh.exe` (PowerShell 7) if on PATH, else `powershell.exe`
///   (5.1, always present). Never `cmd.exe` for an interactive TTY — Claude
///   Code's CLI needs real raw-mode, which PowerShell over ConPTY provides and
///   `cmd`/Git-Bash do not.
#[cfg(windows)]
pub fn default_shell() -> String {
    if which::which("pwsh").is_ok() {
        "pwsh.exe".to_string()
    } else {
        "powershell.exe".to_string()
    }
}
