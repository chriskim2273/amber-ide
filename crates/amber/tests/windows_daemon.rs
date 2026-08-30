#![cfg(windows)]

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use amber::transport;

#[test]
fn windowless_daemon_with_null_stdio_accepts_connections() {
    let root = tempfile::tempdir().unwrap();
    let pipe = format!(
        r"\\.\pipe\amber-windowless-test-{}-{}",
        std::process::id(),
        Instant::now().elapsed().as_nanos()
    );
    let mut daemon = Command::new(env!("CARGO_BIN_EXE_amberd"))
        .env("AMBER_STATE_DIR", root.path())
        .env("AMBER_SOCK", &pipe)
        .env("AMBER_TEST_NO_STD_HANDLES", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(10);
    let connected = loop {
        if transport::connect(std::path::Path::new(&pipe)).is_ok() {
            break true;
        }
        if Instant::now() >= deadline || daemon.try_wait().unwrap().is_some() {
            break false;
        }
        std::thread::sleep(Duration::from_millis(50));
    };

    let _ = daemon.kill();
    let _ = daemon.wait();
    assert!(connected, "windowless daemon never accepted its isolated named pipe");
}
