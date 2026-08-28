# Pi as a session kind — design

**Status:** implemented (2026-08-27).

## Goal

Add Pi as a supervised coding-agent pane: `kind: "pi"`. Pi panes must match
existing Claude, Grok, Codex, and OpenCode panes: exact-conversation resume
after agent crash, app crash, daemon restart, and machine reboot; bounded retry;
memory suspension; rename; workspace save/load; desktop and mobile creation;
and shell fallback instead of silent pane death.

The running user daemon must not be stopped or restarted during implementation
or verification. Live tests use an isolated state root and socket.

## Confirmed Pi contract

Current upstream Pi documentation and source provide these stable surfaces:

- Fresh interactive start: `pi`.
- Exact resume: `pi --session <path|id>`; a partial session UUID is accepted.
- `pi -c` continues the newest session and `pi -r` opens a picker. Neither is
  safe for automatic pane restore because several Amber panes may share a cwd.
- Sessions persist automatically under `~/.pi/agent/sessions/` as JSONL.
- Global extensions load from `~/.pi/agent/extensions/*.ts`.
- `session_start` fires for startup, reload, new, resume, and fork.
- Extension context exposes `ctx.sessionManager.getSessionId()` and `ctx.cwd`.

Therefore Pi is Claude-shaped: Amber cannot choose Pi's fresh session UUID, so
a global extension records it after Pi starts. Resume always uses the recorded
UUID, never cwd-relative “continue.”

Primary references:

- <https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/usage.md>
- <https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md>
- <https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/session-manager.ts>

## Daemon and persistence

Add `SessionKind::Pi`, wire spelling `"pi"`, and include it in `is_agent()`.
Add optional `pi_path` to backward-compatible daemon config. Resolve `pi` via
the user's login shell and cache it through `amber ctl doctor`, never through
the daemon service's PATH.

Pi session IDs use the existing agent recording store
`claude/<amber-name>.json`. This is deliberately not renamed in this pass:
rename, kill, adopt, snapshot, and restore already operate on this common
recording path for every supervised agent. Persisted metadata remains backward
compatible because new enum and optional config values are additive.

`amber run <name> --kind pi` selects Pi on argv, avoiding the existing
create/store race. Pi uses the generic supervisor's retry, run-state reporting,
cgroup containment, suspend/resume, and terminal shell fallback.

## Pi start and resume

Add a focused `pi` module with pure argv and session-ID validation helpers.

- Fresh argv: no arguments.
- Resume argv: `--session <recorded-id>`.
- Valid recorded ID: Pi's UUID-like session identifier accepted only as a
  conservative ASCII alphanumeric/hyphen token. Option-shaped, whitespace,
  path, empty, and malformed values fall back to Fresh.
- Escalation 0 with valid recording: Resume.
- Any later retry without a newer recording: Fresh.
- A changed recording resets escalation and resumes that new ID.
- Never use `--continue` or `--resume` picker.

No unsupported “skip permissions” flag is invented. Pi's normal interactive
TUI owns its approval behavior and user configuration.

## Automatic extension installation

Amber owns exactly `~/.pi/agent/extensions/amber-hook.ts`. Installer creates
the directory, writes atomically, is idempotent, refreshes drifted Amber-owned
content, and never touches other extensions.

Generated extension:

1. Registers `session_start`.
2. Does nothing outside Amber (`AMBER_SESSION` absent).
3. Reads `ctx.sessionManager.getSessionId()` and `ctx.cwd`.
4. Spawns `$AMBER_BIN hook` with fallback `amber`.
5. Writes `{ "session_id": id, "cwd": cwd }` to child stdin. Extension type
   imports use Pi's current `@earendil-works/pi-coding-agent` package scope.
6. Swallows child spawn errors so Pi startup remains usable if Amber install is
   temporarily broken.

Install/refresh occurs before every supervised Pi launch, making packaged and
CLI-created panes self-healing without daemon restart. App setup also invokes a
dedicated idempotent `amber ctl install-pi-extension`, matching automatic Codex
skill setup and giving users an explicit repair command. `$PI_CODING_AGENT_DIR`
is honored if current upstream source confirms it as Pi's agent-directory
override; otherwise path is derived from `$HOME/.pi/agent` only. Tests control
the destination through a private helper, never the user's actual home.

## App, web, and workspace surfaces

Treat Pi as a terminal agent everywhere agent kinds are enumerated:

- daemon protocol decoder/type unions;
- desktop `+ Pane`, split picker, context menu, workspace creation, labels,
  run-state dots, freeze controls, and agent reload action;
- mobile web kind picker, badges, colors, and create whitelist;
- `.amberws` parse/serialize and load planning;
- session lists and human-facing docs.

Reload behavior follows Pi's CLI contract:

- recorded ID: `pi --session <quoted-id>` after strict validation. Pi's current
  parser consumes the value immediately after `--session`; inserting `--`
  there would pass the wrong value;
- no ID: `pi -r`, opening Pi's session picker rather than guessing latest.

Shell quoting remains centralized in `reloadAgent.ts`.

Cleanup-dialog transcript labels remain Claude-only because Pi's JSONL format
and names are outside this feature's correctness path. Generic session rows
still show Pi sessions normally.

## Error handling

- Missing Pi binary: create/restore reports actionable error through existing
  daemon error paths; `doctor` records Pi when present but does not fail because
  Pi is absent.
- Extension install failure: log exact path/error; launch Pi anyway so extension
  filesystem problems do not destroy a pane.
- Invalid/stale recorded ID: Fresh start after one failed resume escalation.
- Pi clean exit or Ctrl-C: existing user-quit classification falls to shell.
- Pi crash: existing bounded retry and run-state reporting apply unchanged.

## Verification

Rust tests:

- Pi kind serde, wire spelling, and `is_agent()` gates;
- config backward compatibility and `pi_path` persistence;
- fresh/resume argv and hostile/malformed ID rejection;
- resume ladder, recording rotation, retry, suspend, and shell fallback;
- extension content, event coverage, idempotence, drift refresh, atomic write,
  and preservation of unrelated extensions;
- create, rename, restore, and protocol round trips for `kind: "pi"`.

App tests:

- protocol/workspace kind acceptance;
- picker and agent-kind membership;
- run-state dot behavior;
- reload command quoting and malformed-ID refusal;
- workspace save/load planning with Pi panes.

Gates: direct stable `cargo clippy --all-targets -- -D warnings`, full Rust
tests, app typecheck, app unit tests, app bundle, and `git diff --check` all
passed. `cargo fmt --check` is an explicit, auditable exception: the installed
formatter reports broad repository-wide version drift in unrelated committed
files, so it cannot be used as a feature gate without a separate whole-repo
formatting migration. Feature-scope hygiene is instead evidenced by review of
the owned diff, a focused mobile-kind regression test, and passing
`git diff --check`; no bulk reformat was applied or claimed. If Pi is installed,
run an isolated private-daemon smoke: create Pi pane, observe extension record,
terminate only isolated child/daemon, restore exact ID, rename, and restore
again. Never contact, stop, or restart user's running Amber daemon.

## Deliberate exclusions

- No Pi SDK or RPC integration; Amber remains a raw PTY client.
- No session-directory scan or “continue newest” fallback.
- No Pi package installation; user installs/authenticates Pi itself.
- No migration of common `claude/` recording directory in this feature.
- No Pi transcript parsing for cleanup labels.
- No changes to Pi provider/model/settings UI.
