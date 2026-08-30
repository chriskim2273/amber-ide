use std::time::Duration;
use std::sync::mpsc::RecvTimeoutError;

use amber::pty::PtySession;
use amber::supervisor::{SupervisorCommand, SupervisorControl};
use portable_pty::CommandBuilder;

const EXIT_CHILD_ENV: &str = "AMBER_WINDOWS_PTY_EXIT_CHILD";
const EXIT_CHILD_CODE: i32 = 7;

fn immediate_exit() -> (CommandBuilder, i32) {
    let mut command = CommandBuilder::new(std::env::current_exe().unwrap());
    command.args([
        "--exact",
        "pty_fixture_child_exits_immediately",
        "--nocapture",
    ]);
    command.env(EXIT_CHILD_ENV, EXIT_CHILD_CODE.to_string());
    (command, EXIT_CHILD_CODE)
}

#[test]
fn pty_fixture_child_exits_immediately() {
    if std::env::var_os(EXIT_CHILD_ENV).is_some() {
        std::process::exit(EXIT_CHILD_CODE);
    }
}

#[test]
fn child_wait_closes_subscriptions_without_reader_eof() {
    let (command, code) = immediate_exit();
    let session = PtySession::session_with_non_eof_reader_for_test(command);
    let (_id, _backlog, receiver) = session.subscribe();

    assert_eq!(session.wait_exit().unwrap(), code);
    loop {
        match receiver.recv_timeout(Duration::from_secs(1)) {
            Ok(_) => {}
            Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => panic!("subscription stayed open after child exit"),
        }
    }
}

#[test]
fn supervisor_command_parks_then_resumes_agent() {
    let control = SupervisorControl::default();

    control.apply(SupervisorCommand::Suspend);
    assert!(control.take_suspend());

    control.apply(SupervisorCommand::Resume);
    assert!(control.take_resume());
}
