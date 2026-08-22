# OpenCode as a session kind — design

**Status:** implemented (2026-08-22).

## Goal

A fourth supervised coding agent alongside claude, grok, and codex:
`kind: "opencode"`. An opencode pane behaves like the others — its pty runs
`amber run <name> --kind opencode`, its conversation resumes across crashes and
reboots, and it falls back to a shell rather than dying.

## Why it is Claude-shaped (not Grok-shaped)

OpenCode (measured against CLI 1.18.21):

| behaviour | result |
|---|---|
| Fresh interactive start | `opencode` |
| Resume exact conversation | `opencode -s ses_…` / `--session <id>` |
| Assign id on create | **not supported** (`-s` continues an existing session) |
| Continue last in cwd | `-c` / `--continue` — hijack, never used |
| Unattended approvals | `--auto` |
| SessionStart hook | no Claude-style hook; plugins get `session.created` |

Amber cannot mint the id. Capture is a global plugin that runs `amber hook` on
`session.created` and records into the existing `claude/<name>.json` store;
resume with `opencode --auto -s <id>`.

Session ids look like `ses_fd8f8accaffeTWUvgvTimbhECs` (`ses_` + alphanumerics).
A recorded id that is not that shape starts Fresh rather than being handed to
`-s`.

## Design

**Storage.** The opencode id lives in the SAME `claude/<name>.json` store.
Rename / kill / adopt already move and delete that path.

**Plugin install.** `opencode::ensure_global_opencode_plugin` writes
`~/.config/opencode/plugins/amber-hook.js` (or `$OPENCODE_CONFIG_DIR/plugins/`
/ `$XDG_CONFIG_HOME/opencode/plugins/`):

- fires on `session.created` only (resume via `-s` does not create)
- skips subagent sessions (`parentID` set) so a child cannot clobber the pane id
- shells out to `$AMBER_BIN hook` (fallback `amber`) with stdin
  `{"session_id","cwd"}` — the same recorder as claude/codex
- env-driven, so a dangling amber binary path never accumulates
- overwrite-if-drifted, leave every other plugin strictly alone

Install at daemon start / `run_session` for opencode panes (same sites as the
codex global hook).

**Resume ladder** (`supervisor::select_opencode_start`):

1. `ses_`-shaped recorded id on escalation 0 → `Resume(id)`.
2. Otherwise → `Fresh`.
3. Never `-c` / `--continue` (cwd hijack).

**Argv** (excluding the program):

- Fresh: `--auto`
- Resume: `--auto -s <id>`

**Which agent to run is passed on argv** (`amber run <name> --kind opencode`),
not read from the store — same race claude/grok/codex already solved.

**Run-state vocabulary is unchanged** (`claude` / `claude-retrying` /
`shell-fallback` / `suspended`).

**Kind-gated sites** use `SessionKind::is_agent()` / `isAgentKind()` — opencode
is an agent arm.

## CLI (same pass)

- `amber kill <name|slot>` — a pure integer is a slot (`amber kill 2`). A
  missing name or missing slot is an error (`no such session: …` /
  `no session with slot N (see amber ls)`), not a silent success.
- `amber freeze <name|slot>` / `amber unfreeze <name|slot>` — send
  `Suspend` / `Resume`. Agent-only (the daemon already refuses shells).

## Scope cuts (deliberate)

- No filesystem session-scan fallback.
- No hand-started-opencode detection (`resume_as_claude` stays claude-only).
- No permission-mode UI (always `--auto`, matching claude/grok/codex yolo).
- Cleanup dialog conversation labels stay claude-transcript-based.
- Doctor records opencode path when present; never fails on its absence.

## Verification

Unit tests for argv, id shape, plugin install, ladder, kind gates, kill-by-slot,
missing-target errors, freeze-of-shell refusal. App tests for `isAgentKind` /
dots / reload argv. Live private daemon create → plugin record → kill/resume
remains the same class of smoke as grok/codex (needs a restarted daemon to
accept `kind:"opencode"`).
