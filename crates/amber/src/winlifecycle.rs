//! Windows shutdown delivery for the windowless daemon.
//!
//! Windows only sends end-session messages to top-level windows. A message-only
//! window (`HWND_MESSAGE`) is deliberately not used: it would not receive the
//! reliable `WM_QUERYENDSESSION` / `WM_ENDSESSION` sequence needed to flush the
//! final session snapshot before reboot or sign-out.

use std::ptr;
use std::sync::{mpsc, Arc, OnceLock};
use std::thread;

use windows_sys::Win32::Foundation::{
    GetLastError, ERROR_CLASS_ALREADY_EXISTS, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
    TranslateMessage, WM_ENDSESSION, WM_QUERYENDSESSION, WNDCLASSW, WS_EX_TOOLWINDOW,
};

use crate::manager::SessionManager;

static SESSION_MANAGER: OnceLock<Arc<SessionManager>> = OnceLock::new();
const WINDOW_CLASS: &[u16] = &[
    b'A' as u16,
    b'm' as u16,
    b'b' as u16,
    b'e' as u16,
    b'r' as u16,
    b'D' as u16,
    b'a' as u16,
    b'e' as u16,
    b'm' as u16,
    b'o' as u16,
    b'n' as u16,
    0,
];

/// Install a hidden top-level shutdown window.
///
/// The window owns no product state. It acknowledges `WM_QUERYENDSESSION` and
/// invokes [`SessionManager::snapshot_final`] only after `WM_ENDSESSION`
/// confirms that Windows is ending the session. Registration happens before
/// this function returns, so a daemon never advertises itself as started while
/// missing the reboot/shutdown snapshot hook.
pub fn install_shutdown_handler(manager: Arc<SessionManager>) -> anyhow::Result<()> {
    SESSION_MANAGER
        .set(manager)
        .map_err(|_| anyhow::anyhow!("Windows shutdown handler was installed twice"))?;

    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("amber-win-shutdown".into())
        .spawn(move || shutdown_window_thread(ready_tx))?;
    ready_rx
        .recv()
        .map_err(|_| anyhow::anyhow!("Windows shutdown handler thread exited during setup"))??;
    Ok(())
}

fn shutdown_window_thread(ready: mpsc::SyncSender<anyhow::Result<()>>) {
    let result = unsafe { create_shutdown_window() };
    match result {
        Ok(()) => {
            let _ = ready.send(Ok(()));
            unsafe { message_loop() };
        }
        Err(error) => {
            let _ = ready.send(Err(error));
        }
    }
}

unsafe fn create_shutdown_window() -> anyhow::Result<()> {
    let instance: HINSTANCE = GetModuleHandleW(ptr::null());
    if instance.is_null() {
        return Err(std::io::Error::last_os_error().into());
    }
    let class = WNDCLASSW {
        hInstance: instance,
        lpszClassName: WINDOW_CLASS.as_ptr(),
        lpfnWndProc: Some(shutdown_window_proc),
        ..Default::default()
    };
    if RegisterClassW(&class) == 0 && GetLastError() != ERROR_CLASS_ALREADY_EXISTS {
        return Err(std::io::Error::last_os_error().into());
    }

    // `hwndParent` is NULL: this is a hidden *top-level* tool window. Do not
    // replace it with HWND_MESSAGE; message-only windows miss end-session
    // notifications on the systems this daemon must survive.
    let window = CreateWindowExW(
        WS_EX_TOOLWINDOW,
        WINDOW_CLASS.as_ptr(),
        WINDOW_CLASS.as_ptr(),
        0,
        0,
        0,
        0,
        0,
        ptr::null_mut(),
        ptr::null_mut(),
        instance,
        ptr::null(),
    );
    if window.is_null() {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

unsafe fn message_loop() {
    let mut message = Default::default();
    loop {
        let result = GetMessageW(&mut message, ptr::null_mut(), 0, 0);
        if result <= 0 {
            return;
        }
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
}

unsafe extern "system" fn shutdown_window_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_QUERYENDSESSION => 1,
        WM_ENDSESSION if wparam != 0 => {
            if let Some(manager) = SESSION_MANAGER.get() {
                if let Err(error) = manager.snapshot_final() {
                    eprintln!(
                        "amber daemon: final snapshot during Windows shutdown failed: {error}"
                    );
                }
            }
            DefWindowProcW(window, message, wparam, lparam)
        }
        _ => DefWindowProcW(window, message, wparam, lparam),
    }
}
