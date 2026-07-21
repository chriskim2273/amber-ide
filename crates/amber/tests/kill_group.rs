//! Killing a session must kill what the session STARTED, not just its direct
//! child.
//!
//! A claude pane's pty child is `amber run <name>`; the `claude` it supervises
//! is a separate process. SIGKILLing only the supervisor left that claude
//! orphaned and running — the pane vanished, the work did not. This asserts the
//! whole process group dies, using a backgrounded `sleep` as the stand-in
//! grandchild (a non-interactive `sh` has no job control, so the background
//! child stays in the pty child's process group — exactly like claude under
//! `amber run`).

use amber::pty::PtySession;
use portable_pty::CommandBuilder;
use std::time::{Duration, Instant};

/// True while the pid exists (signal 0 probes without delivering).
fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

fn wait_until(deadline: Duration, mut done: impl FnMut() -> bool) -> bool {
    let end = Instant::now() + deadline;
    while Instant::now() < end {
        if done() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    done()
}

#[test]
fn kill_takes_down_the_whole_process_group() {
    let mut cmd = CommandBuilder::new("sh");
    // The grandchild IGNORES SIGHUP. Without that it proves nothing: killing
    // the pty child kills a session leader, and the kernel then SIGHUPs the
    // terminal's foreground group, which takes an ordinary background job down
    // for free. What actually leaked is the child that survives that hangup —
    // a `nohup`ed dev server, a job that traps HUP — and it kept running after
    // the pane was gone.
    cmd.args(["-c", "sh -c 'trap \"\" HUP; sleep 300' & echo GC:$!; wait"]);
    cmd.cwd("/tmp");
    let sess = PtySession::spawn(cmd, 24, 80, 64 * 1024).unwrap();

    // Read the grandchild's pid off the pty.
    let mut gc = None;
    wait_until(Duration::from_secs(5), || {
        let sb = String::from_utf8_lossy(&sess.scrollback()).to_string();
        gc = sb
            .split("GC:")
            .nth(1)
            .and_then(|rest| rest.split_whitespace().next())
            .and_then(|d| d.trim().parse::<i32>().ok());
        gc.is_some()
    });
    let gc = gc.expect("grandchild pid never appeared on the pty");
    assert!(alive(gc), "grandchild should be running before the kill");

    sess.kill().unwrap();

    assert!(
        wait_until(Duration::from_secs(5), || !alive(gc)),
        "grandchild {gc} survived the session kill — killpg did not reach it"
    );
}
