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
fn ctl_install_web_flag_reaches_the_install_script() {
    // `--web` opts into the `amber web` boot unit (systemd user unit /
    // launchd agent). Dry-run proves the flag is plumbed through.
    let out = Command::new(env!("CARGO_BIN_EXE_amber"))
        .args(["ctl", "install", "--dry-run", "--web"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains(" install --web"), "{stdout}");

    let out = Command::new(env!("CARGO_BIN_EXE_amber"))
        .args(["ctl", "uninstall", "--dry-run", "--web"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("uninstall") && stdout.contains("--web"), "{stdout}");
}

#[test]
fn install_script_passes_bash_syntax_check() {
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/../../infra/daemon/install.sh");
    let status = Command::new("bash").args(["-n", script]).status().unwrap();
    assert!(status.success(), "bash -n rejected {script}");
}

#[test]
fn codex_skill_maintenance_commands_respect_ownership() {
    let home = tempfile::tempdir().unwrap();
    let amber = env!("CARGO_BIN_EXE_amber");
    let install = Command::new(amber)
        .args(["ctl", "install-codex-skill"])
        .env("HOME", home.path())
        .output()
        .unwrap();
    assert!(
        install.status.success(),
        "{}",
        String::from_utf8_lossy(&install.stderr)
    );
    let file = home.path().join(".agents/skills/claude-handoff/SKILL.md");
    assert!(std::fs::read_to_string(&file)
        .unwrap()
        .contains("<!-- amber-owned-skill -->"));

    std::fs::write(&file, "user-owned\n").unwrap();
    let conflict = Command::new(amber)
        .args(["ctl", "purge-codex-skill"])
        .env("HOME", home.path())
        .output()
        .unwrap();
    assert!(conflict.status.success());
    assert_eq!(std::fs::read_to_string(file).unwrap(), "user-owned\n");
    assert!(String::from_utf8_lossy(&conflict.stderr).contains("not Amber-owned"));
}

#[test]
fn codex_skill_invalid_utf8_conflict_exits_cleanly() {
    let home = tempfile::tempdir().unwrap();
    let file = home.path().join(".agents/skills/claude-handoff/SKILL.md");
    let bytes = b"user-owned\xff\n";
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, bytes).unwrap();

    let conflict = Command::new(env!("CARGO_BIN_EXE_amber"))
        .args(["ctl", "install-codex-skill"])
        .env("HOME", home.path())
        .output()
        .unwrap();

    assert!(conflict.status.success());
    assert_eq!(std::fs::read(file).unwrap(), bytes);
    assert_eq!(
        String::from_utf8_lossy(&conflict.stderr).trim(),
        "amber: ~/.agents/skills/claude-handoff exists but is not Amber-owned; leaving it unchanged"
    );
}

#[test]
fn codex_skill_marker_bearing_invalid_utf8_conflicts_cleanly() {
    let home = tempfile::tempdir().unwrap();
    let file = home.path().join(".agents/skills/claude-handoff/SKILL.md");
    let bytes = b"<!-- amber-owned-skill -->\n\xff";
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, bytes).unwrap();

    for action in ["install-codex-skill", "purge-codex-skill"] {
        let conflict = Command::new(env!("CARGO_BIN_EXE_amber"))
            .args(["ctl", action])
            .env("HOME", home.path())
            .output()
            .unwrap();

        assert!(conflict.status.success());
        assert_eq!(std::fs::read(&file).unwrap(), bytes);
        assert_eq!(
            String::from_utf8_lossy(&conflict.stderr).trim(),
            "amber: ~/.agents/skills/claude-handoff exists but is not Amber-owned; leaving it unchanged"
        );
    }
}
