//! `amber ctl install` wiring: the subcommand must resolve the repo's
//! `infra/daemon/install.sh` (dry-run proves the wiring without touching
//! systemd/launchd), and the script itself must be syntactically valid.

use std::process::Command;

#[test]
fn ctl_install_dry_run_resolves_the_install_script() {
    let out = Command::new(env!("CARGO_BIN_EXE_amber"))
        .args(["ctl", "install", "--dry-run"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "ctl install --dry-run failed; stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    let path = stdout
        .lines()
        .find_map(|l| l.strip_prefix("would run: bash "))
        .unwrap_or_else(|| panic!("no 'would run: bash <script>' line in: {stdout}"));
    assert!(path.ends_with("infra/daemon/install.sh"), "{path}");
    assert!(std::path::Path::new(path).is_file(), "{path} does not exist");
}

#[test]
fn ctl_uninstall_dry_run_resolves_the_install_script() {
    // Symmetric to install: uninstall delegates to the same install.sh, passing
    // an `uninstall` subcommand plus the purge flags. Dry-run proves the arg
    // plumbing without touching systemd/launchd or removing anything.
    let out = Command::new(env!("CARGO_BIN_EXE_amber"))
        .args(["ctl", "uninstall", "--dry-run", "--purge-binary", "--purge-state"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "ctl uninstall --dry-run failed; stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    let line = stdout
        .lines()
        .find(|l| l.starts_with("would run: bash "))
        .unwrap_or_else(|| panic!("no 'would run: bash ...' line in: {stdout}"));
    assert!(line.contains("infra/daemon/install.sh"), "{line}");
    assert!(line.contains(" uninstall"), "{line}");
    assert!(line.contains("--purge-binary"), "{line}");
    assert!(line.contains("--purge-state"), "{line}");
}

#[test]
fn install_script_passes_bash_syntax_check() {
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/../../infra/daemon/install.sh");
    let status = Command::new("bash").args(["-n", script]).status().unwrap();
    assert!(status.success(), "bash -n rejected {script}");
}
