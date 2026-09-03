#![cfg(unix)]

use std::fs;
use std::process::Command;

#[cfg(unix)]
#[test]
fn status_enable_and_inhibited_ensure_are_isolated_and_typed() {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("host.sock");
    let amber = env!("CARGO_BIN_EXE_amber");

    let status = Command::new(amber)
        .args(["ctl", "browser-host", "status", "--json", "--root"])
        .arg(dir.path())
        .args(["--socket"])
        .arg(&socket)
        .output()
        .unwrap();
    assert!(status.status.success());
    let value: serde_json::Value = serde_json::from_slice(&status.stdout).unwrap();
    assert_eq!(value["state"], "unregistered");

    fs::write(dir.path().join("browser-host-inhibit"), "explicit").unwrap();
    let ensure = Command::new(amber)
        .args(["ctl", "browser-host", "ensure", "--root"])
        .arg(dir.path())
        .args(["--socket"])
        .arg(&socket)
        .output()
        .unwrap();
    assert!(!ensure.status.success());
    assert!(String::from_utf8_lossy(&ensure.stderr).contains("BROWSER_HOST_INHIBITED"));

    let enable = Command::new(amber)
        .args(["ctl", "browser-host", "enable", "--json", "--root"])
        .arg(dir.path())
        .output()
        .unwrap();
    assert!(enable.status.success());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&enable.stdout).unwrap()["enabled"],
        true
    );
    assert!(!dir.path().join("browser-host-inhibit").exists());
}
