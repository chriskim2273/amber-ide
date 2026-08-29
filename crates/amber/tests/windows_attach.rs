#![cfg(windows)]

use amber::attach::{windows_console_size_from_info, ConsoleBufferInfo};

#[test]
fn windows_console_size_reads_visible_window() {
    let info = ConsoleBufferInfo {
        width: 132,
        height: 43,
    };
    assert_eq!(windows_console_size_from_info(info), (132, 43));
}
