//! Windows lifecycle: deliver a "snapshot now" callback before the process is
//! force-killed at logoff/shutdown — the SIGTERM analog (spec §D3).
//!
//! Two mechanisms, both registered:
//! - A **hidden message-only window** handling `WM_QUERYENDSESSION` (allow) and
//!   `WM_ENDSESSION` (snapshot). This is the reliable path for a windowless
//!   background daemon: `SetConsoleCtrlHandler`'s `CTRL_SHUTDOWN/LOGOFF` events
//!   are silently dropped once a process links user32/gdi32, which a
//!   pty-owning daemon can do transitively.
//! - `SetConsoleCtrlHandler` for `CTRL_C_EVENT`/`CTRL_CLOSE_EVENT` (the
//!   interactive `SIGINT` cases).
//!
//! Time budget: ~5 s (`HungAppTimeout`) before Windows force-terminates. The
//! daemon already snapshots on a timer, so the shutdown handler flushes only a
//! small final delta.

use std::sync::OnceLock;

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::Console::{
    SetConsoleCtrlHandler, CTRL_CLOSE_EVENT, CTRL_C_EVENT, CTRL_LOGOFF_EVENT, CTRL_SHUTDOWN_EVENT,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
    TranslateMessage, MSG, WM_ENDSESSION, WM_QUERYENDSESSION, WNDCLASSW, WS_EX_TOOLWINDOW,
    WS_OVERLAPPED,
};

type Callback = Box<dyn Fn() + Send + Sync + 'static>;

/// The snapshot callback. Set once; fired from the window proc / console
/// handler at shutdown. A global because Win32 callbacks carry no user data.
static SHUTDOWN_CB: OnceLock<Callback> = OnceLock::new();

fn fire() {
    if let Some(cb) = SHUTDOWN_CB.get() {
        cb();
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Register the shutdown handlers and start the message pump on a dedicated
/// thread. Idempotent-ish: only the first callback is retained. Best-effort —
/// a registration failure is logged, not fatal (a missed final snapshot only
/// loses the delta since the last periodic snapshot).
pub fn install_shutdown_handler<F: Fn() + Send + Sync + 'static>(cb: F) {
    // Store the callback; if one is already set, keep it.
    let _ = SHUTDOWN_CB.set(Box::new(cb));

    std::thread::spawn(|| unsafe {
        // Console handler for the interactive SIGINT-class events.
        SetConsoleCtrlHandler(Some(ctrl_handler), 1);

        let hinstance = GetModuleHandleW(std::ptr::null());
        let class_name = wide("AmberDaemonLifecycle");

        let mut wc: WNDCLASSW = std::mem::zeroed();
        wc.lpfnWndProc = Some(window_proc);
        wc.hInstance = hinstance;
        wc.lpszClassName = class_name.as_ptr();
        RegisterClassW(&wc);

        // A hidden TOP-LEVEL window (parent = null). It is never shown
        // (no ShowWindow) and WS_EX_TOOLWINDOW keeps it out of the taskbar/
        // alt-tab, but — unlike a message-only HWND_MESSAGE window — it DOES
        // receive the broadcast WM_QUERYENDSESSION/WM_ENDSESSION at logoff/
        // shutdown, which message-only windows are excluded from. That is the
        // whole point of this window (the SIGTERM-analog snapshot trigger).
        let hwnd = CreateWindowExW(
            WS_EX_TOOLWINDOW,
            class_name.as_ptr(),
            wide("amber").as_ptr(),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            hinstance,
            std::ptr::null(),
        );
        if hwnd.is_null() {
            eprintln!("amber daemon: could not create lifecycle window; shutdown snapshot may be missed");
            return;
        }

        // Standard message pump. GetMessageW returns 0 on WM_QUIT, -1 on error.
        let mut msg: MSG = std::mem::zeroed();
        loop {
            let r = GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0);
            if r <= 0 {
                break;
            }
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
}

/// Console control handler: fire the snapshot on any shutdown-class or
/// interactive-close event. Returns TRUE (handled).
unsafe extern "system" fn ctrl_handler(ctrl_type: u32) -> i32 {
    match ctrl_type {
        CTRL_C_EVENT | CTRL_CLOSE_EVENT | CTRL_LOGOFF_EVENT | CTRL_SHUTDOWN_EVENT => {
            fire();
            1 // handled
        }
        _ => 0, // not handled -> default (e.g. CTRL_BREAK)
    }
}

/// Window proc for the hidden lifecycle window.
unsafe extern "system" fn window_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        // Allow the session to end.
        WM_QUERYENDSESSION => 1,
        // The session is ending: snapshot now (within the ~5 s budget).
        WM_ENDSESSION => {
            fire();
            0
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}
