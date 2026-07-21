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

/// Poll the pty scrollback for the `GC:<pid>` marker the child echoes.
fn read_marker(sess: &PtySession) -> Option<i32> {
    let mut found = None;
    wait_until(Duration::from_secs(5), || {
        let sb = String::from_utf8_lossy(&sess.scrollback()).to_string();
        // An interactive shell ECHOES the command, so the first "GC:" on the
        // pty is the literal `GC:$!` we typed. Take the first that is followed
        // by digits — that one is the output.
        found = sb
            .split("GC:")
            .skip(1)
            .find_map(|rest| rest.split_whitespace().next()?.trim().parse::<i32>().ok());
        found.is_some()
    });
    found
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

/// The case that actually leaked, and that the process-group signal alone does
/// NOT fix: a background job started from an INTERACTIVE shell. Job control
/// puts it in its own process group, so `killpg` on the pty child misses it,
/// and `nohup` means the pty hangup does not finish it either. Verified live in
/// the GUI before the descendant sweep existed: closing the pane left the
/// process running.
#[test]
fn kill_takes_down_a_backgrounded_job_from_an_interactive_shell() {
    let mut cmd = CommandBuilder::new("bash");
    cmd.args(["-i"]);
    cmd.cwd("/tmp");
    cmd.env("PS1", "$ ");
    let sess = PtySession::spawn(cmd, 24, 80, 64 * 1024).unwrap();
    std::thread::sleep(Duration::from_millis(400)); // let bash reach its prompt
    sess.write(b"nohup sleep 300 >/dev/null 2>&1 & echo GC:$!\n").unwrap();

    let gc = read_marker(&sess).unwrap_or_else(|| panic!(
        "no marker; pty said: {:?}", String::from_utf8_lossy(&sess.scrollback())));
    assert!(alive(gc), "backgrounded job should be running before the kill");

    sess.kill().unwrap();

    assert!(
        wait_until(Duration::from_secs(5), || !alive(gc)),
        "backgrounded job {gc} survived the session kill — it is in its own \
         process group, so only the descendant sweep can reach it"
    );
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

    let gc = read_marker(&sess).expect("grandchild pid never appeared on the pty");
    assert!(alive(gc), "grandchild should be running before the kill");

    sess.kill().unwrap();

    assert!(
        wait_until(Duration::from_secs(5), || !alive(gc)),
        "grandchild {gc} survived the session kill — killpg did not reach it"
    );
}
