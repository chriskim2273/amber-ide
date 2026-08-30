#![cfg_attr(windows, windows_subsystem = "windows")]

//! Windowless Windows daemon entrypoint.
//!
//! Keep this separate from `amber.exe`: the CLI must remain a console program
//! for `amber attach`, while the long-lived daemon must not create a console
//! window when it is launched from HKCU Run.

fn main() -> anyhow::Result<()> {
    #[cfg(all(windows, feature = "test-support"))]
    if std::env::var_os("AMBER_TEST_NO_STD_HANDLES").is_some() {
        use windows_sys::Win32::System::Console::{
            SetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
        };
        unsafe {
            SetStdHandle(STD_INPUT_HANDLE, std::ptr::null_mut());
            SetStdHandle(STD_OUTPUT_HANDLE, std::ptr::null_mut());
            SetStdHandle(STD_ERROR_HANDLE, std::ptr::null_mut());
        }
    }
    amber::platform::redirect_standard_handles_to_null()?;
    let root = std::env::var_os("AMBER_STATE_DIR").map(std::path::PathBuf::from);
    let socket = std::env::var_os("AMBER_SOCK").map(std::path::PathBuf::from);
    amber::daemon_main(root, socket)
}
