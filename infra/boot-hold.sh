#!/bin/sh
# Runs inside the _amber-boot bootstrap session's only pane. Keeps the tmux
# server alive until any real session exists, then exits — which closes the
# pane and takes the bootstrap session with it. Deterministic replacement for
# the race-prone post-restore-all kill hook (which stays as a fallback): the
# restore may finish before the bootstrap session is even registered, in
# which case a one-shot kill hook fires into thin air and the session leaks.
while [ "$(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -cv '^_amber-boot$')" -eq 0 ]; do
	sleep 2
done
