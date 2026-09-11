# Pi pane recovery tooling

Diagnostic and repair scripts written during the 2026-09-10 recovery of the
panes in `docs/pi-pane-recovery-2026-09-10.md`. They are **not** part of the app
build and nothing imports them; they exist so the same recovery can be repeated
deliberately instead of by hand.

## The problem they solve

Amber only restores panes whose session **kind** is an agent. A `pi` the user
starts by hand inside a `kind=shell` pane is merely a child of that shell, so a
daemon restart kills it and the pane comes back as a plain shell. Converting the
pane to a supervised `kind=pi` session that resumes the same conversation is the
durable fix.

## Scripts

- `match-panes.py` / `match-ngram.py` — identify which Pi conversation a shell
  pane was displaying when the daemon was killed. Both read a pane's scrollback
  ring, take the last rendered screen (the text before the replacement shell's
  first prompt) and score it against every conversation in that pane's cwd
  directory. `match-ngram.py` is the working version: it strips Pi's box-drawing
  borders and matches 5-word n-grams, because Pi wraps and pads lines so only
  short runs survive intact. `match-panes.py` (whole-message probes) was kept
  because its failures are informative: it misses every pane whose ring holds
  only the most recent screen.
- `convert-pane.py` — converts one shell pane into a supervised Pi pane that
  resumes an exact conversation. It reads a JSON plan (list of
  `{name, title, cwd, conversation}`).

## Warning: these mutate live session state

`convert-pane.py` **kills the named session** and re-creates it as `kind=pi` in
the same workspace/tab/ord slot. It is deliberately loud about ordering, because
the daemon deletes a killed session's recording:

1. back up `sessions/<name>.json` and `claude/<name>.json`;
2. `amber kill <name>`;
3. write `claude/<name>.json` pointing at the target conversation (the same
   contract `pi.rs` consumes, so the supervisor launches
   `pi --session <file>`);
4. `amber create --kind pi --cwd <cwd> [--title <title>] <name>`;
5. verify the recording still points at the target — that is what proves Pi
   resumed rather than starting a new conversation.

Never point two panes at one conversation file: Pi owns that file and must be
its only writer.

## Local assumptions

These were written against this machine and hardcode:

- state store `/home/poyto/.local/state/amber-ide`
- daemon socket `/run/user/1000/amber-ide/amberd.sock`
- CLI `/home/poyto/.local/bin/amber`
- Pi sessions `/home/poyto/.pi/agent/sessions`
- evidence output `/home/poyto/worktrees/amber-ide/pi-pane-recovery`

Adjust those constants (or set them from the environment) before using this on
another host. The identified mappings and the evidence behind them live in the
receipt, not in these scripts.
