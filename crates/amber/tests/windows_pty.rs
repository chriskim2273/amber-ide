use std::time::Duration;

use amber::pty::PtySession;
use amber::platform;
use amber::supervisor::{SupervisorCommand, SupervisorControl};
use portable_pty::CommandBuilder;

fn command(script: &str) -> CommandBuilder {
    let mut command = CommandBuilder::new(platform::default_shell());
    #[cfg(unix)]
    command.args(["-c", script]);
    #[cfg(windows)]
    command.args(["/C", script]);
    command
}

#[test]
fn child_wait_closes_subscriptions_without_reader_eof() {
    let session = PtySession::session_with_non_eof_reader_for_test(command("exit 7"));
    let (_id, _backlog, receiver) = session.subscribe();

    assert_eq!(session.wait_exit().unwrap(), 7);
    assert!(receiver.recv_timeout(Duration::from_secs(1)).is_err());
}

#[test]
fn supervisor_command_parks_then_resumes_agent() {
    let control = SupervisorControl::default();

    control.apply(SupervisorCommand::Suspend);
    assert!(control.take_suspend());

    control.apply(SupervisorCommand::Resume);
    assert!(control.take_resume());
}
