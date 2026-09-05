//! End-to-end fake-Pi proof: real daemon/socket/hook/supervisor, isolated state.
//! The Python fixture is Linux-only because it sets its process name with prctl.
#[cfg(target_os = "linux")]
#[test]
fn primary_pi_survives_reboot_without_child_contamination_or_quit_resurrection() {
    let status = std::process::Command::new("python3")
        .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/pi_reboot.py"))
        .arg(env!("CARGO_BIN_EXE_amber"))
        .status()
        .expect("python3 is required for the private Pi reboot fixture");
    assert!(status.success(), "private Pi reboot proof failed");
}
