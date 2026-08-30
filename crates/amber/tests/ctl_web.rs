//! `amber ctl web` surface tests.
//!
//! These drive the BINARY, because the point of the subcommand is its
//! argv/JSON contract with the Electron app — a unit test of the helpers would
//! not catch a clap wiring mistake, which is the likeliest way this breaks.

use std::process::Command;

fn amber() -> Command {
    Command::new(env!("CARGO_BIN_EXE_amber"))
}

#[test]
fn status_json_is_json_even_when_nothing_is_running() {
    let dir = tempfile::tempdir().expect("tmp");
    let out = amber()
        .args(["ctl", "web", "status", "--json", "--port", "7919", "--root"])
        .arg(dir.path())
        .output()
        .expect("runs");
    let body = String::from_utf8_lossy(&out.stdout);
    let v: serde_json::Value =
        serde_json::from_str(&body).unwrap_or_else(|e| panic!("valid json, got {body:?}: {e}"));
    assert!(v.get("unit").is_some(), "{body}");
    assert!(v.get("tailscale").is_some(), "{body}");
    // Nothing is serving in a fresh root, and that is a REPORT, not a failure:
    // exit 0 so the app can tell "off" apart from "the CLI broke".
    assert!(out.status.success(), "{body}");
}

#[test]
fn status_does_not_mint_a_token() {
    let dir = tempfile::tempdir().expect("tmp");
    amber()
        .args(["ctl", "web", "status", "--json", "--port", "7919", "--root"])
        .arg(dir.path())
        .output()
        .expect("runs");
    // A read-only query that manufactures a full-authority credential as a
    // side effect is the bug this test exists for.
    assert!(!dir.path().join("web-token").exists());
}

#[test]
fn status_never_contains_the_token_in_any_field() {
    let dir = tempfile::tempdir().expect("tmp");
    let url_out = amber()
        .args(["ctl", "web", "url", "--port", "7919", "--root"])
        .arg(dir.path())
        .output()
        .expect("runs");
    let url = String::from_utf8_lossy(&url_out.stdout).trim().to_string();
    assert!(url.contains("#t="), "{url}");
    // Everything before the '#' reaches the server and its logs.
    let (before, _frag) = url.split_once('#').expect("fragment");
    let token = url.split("#t=").nth(1).expect("token").to_string();
    assert!(!before.contains(&token), "{url}");

    let status_out = amber()
        .args(["ctl", "web", "status", "--json", "--port", "7919", "--root"])
        .arg(dir.path())
        .output()
        .expect("runs");
    let status = String::from_utf8_lossy(&status_out.stdout);
    let v: serde_json::Value = serde_json::from_str(&status).expect("json");
    // `status` is polled every 3 s by the dialog: no field may carry it.
    for (k, val) in v.as_object().expect("object") {
        assert!(!val.to_string().contains(&token), "token leaked in field {k}: {status}");
    }
    assert_eq!(v["has_token"], true, "{status}");
    // The url points at the web build and carries no fragment at all. Which
    // host it names depends on whether this machine has a tailnet, so assert
    // the SHAPE, not the host — a machine-dependent literal would make this
    // test pass or fail on the developer's network config.
    let reported = v["url"].as_str().expect("url is a string");
    assert!(reported.ends_with("/app"), "{status}");
    assert!(!reported.contains('#'), "{status}");
}

#[cfg(windows)]
#[test]
fn managed_lifecycle_is_explicitly_unsupported_on_windows() {
    let dir = tempfile::tempdir().expect("tmp");
    let out = amber()
        .args(["ctl", "web", "start", "--root"])
        .arg(dir.path())
        .output()
        .expect("runs");

    assert!(!out.status.success());
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("managed amber web lifecycle is not supported on Windows"),
        "{stderr}"
    );
}
