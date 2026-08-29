#![cfg_attr(windows, windows_subsystem = "windows")]

//! Windowless Windows daemon entrypoint.
//!
//! Keep this separate from `amber.exe`: the CLI must remain a console program
//! for `amber attach`, while the long-lived daemon must not create a console
//! window when it is launched from HKCU Run.

fn main() -> anyhow::Result<()> {
    amber::daemon_main(None, None)
}
