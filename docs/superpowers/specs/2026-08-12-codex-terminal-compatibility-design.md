# Codex terminal compatibility hardening

**Status:** approved 2026-08-12; implementation pending.

## Goal

Make Amber's existing terminal-first Codex pane reliable for fresh sessions,
exact resume, manual reload, crash recovery, freeze/unfreeze, and daemon restart.
Keep Amber's raw-pty architecture and current unattended permission policy.

“Complete compatibility” here means compatibility with the installed Codex CLI
surface that Amber uses. It does not mean recreating Codex's native IDE client.

## Upstream contract

Current official Codex documentation establishes the pieces Amber depends on:

- A command hook receives `session_id` and `cwd` on stdin. The ID is specified
  as a string, not as a UUID.
- User hooks can live in `~/.codex/hooks.json` and require trust unless the
  invocation passes `--dangerously-bypass-hook-trust`.
- `projects.<path>.trust_level = "trusted"` marks a working directory trusted.
- The installed `codex-cli 0.147.0` opens the session picker for `codex resume`
  with no ID; `--last` selects a session implicitly and must not be used by
  Amber.
- The user chose to keep
  `--dangerously-bypass-approvals-and-sandbox` for parity with Amber's other
  supervised agents.

Sources:

- <https://learn.chatgpt.com/docs/hooks>
- <https://learn.chatgpt.com/docs/config-file/config-reference>
- `codex --help` and `codex resume --help` from installed 0.147.0

## Design

### Supervision stays unchanged

Codex remains a `SessionKind::Codex` pty running `amber run <name> --kind
codex`. `supervisor::Agent::Codex` continues to share Amber's existing retry,
suspend/resume, run-state, and shell-fallback behavior.

Fresh launch remains:

```text
codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust
```

Exact resume remains:

```text
codex resume <recorded-id> --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust
```

The global `SessionStart` hook remains the source of the ID. Amber continues to
store it in `claude/<pane>.json`; changing that compatible storage format adds
no value.

### Manual reload mirrors supervision

Move renderer command construction into one pure helper and test it directly.
Its Codex behavior is:

- Recorded ID: run `codex resume <quoted-id>` with both required bypass flags.
- No ID: run `codex resume` with both flags, opening Codex's picker.
- Never add `--last`.

Codex documents `session_id` only as a string. The renderer must not apply
Claude's UUID-only validator to it. Because manual reload inserts a shell
command into the pane, the helper rejects control characters and shell-quotes
the remaining ID. Claude and Grok keep their existing UUID validation.

The prompt copy says “Pick session…” and describes the picker accurately.

### Hook, trust, and errors

Keep the existing merge-preserving hook installer and cwd trust preparation.
Both remain best-effort so malformed user configuration never prevents Amber's
daemon from starting. Failures stay visible on stderr, and the supervised pane
still falls back to its normal interactive behavior or shell fallback.

Fix the existing Clippy failure in `merge_project_trust` without changing its
behavior. No new config parser, lock service, or dependency is justified by a
reported failure.

### Documentation

Update README Codex sections so public claims match implemented behavior:

- Codex is a supported supervised pane kind.
- Exact conversations resume after Amber/agent restart.
- Codex CLI remains a user-installed dependency resolved through the login
  shell.
- Amber runs supervised agent panes unattended with approval/sandbox bypass.

Update the existing Codex status note after verification. Do not rewrite old
plans or historical test counts unrelated to this change.

## Verification

Follow TDD.

1. Add renderer tests that fail on current behavior:
   - exact Codex ID uses exact resume and both flags;
   - a non-UUID Codex string ID is quoted safely;
   - control characters are rejected;
   - picker command has no ID and never contains `--last`;
   - Claude/Grok UUID guards remain unchanged.
2. Add one Rust integration test using a fake Codex executable. It records argv,
   invokes the real `amber hook` with a Codex-shaped `SessionStart` payload,
   crashes once, and then exits cleanly. Assert fresh launch, ID persistence,
   exact-ID retry/resume, and both bypass flags.
3. Keep focused unit tests for argv, hook merge, trust merge, and resume ladder.
4. Run full gates:

```text
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cd app && npm run typecheck && npx vitest run && npm run build && npm run build:web
```

5. Run a real installed-CLI smoke check only if it can use isolated Amber state
   without changing or deleting existing Codex conversations. Confirm create,
   hook capture, kill/resume, and daemon restart. If safe isolation is not
   possible, report this manual check as outstanding rather than claiming it.

## Acceptance criteria

- Fresh Codex panes start with both approved bypass flags.
- `SessionStart` records the current Codex session ID.
- Crash, unfreeze, and daemon restart resume that exact ID, never `--last`.
- Manual exact reload supports Codex's string ID contract without command
  injection.
- “Pick session…” opens Codex's picker and never silently chooses the most
  recent session.
- Missing Codex or exhausted retries still fall back to a shell.
- Public documentation describes Codex support and security behavior.
- Every listed automated gate passes.

## Non-goals

- Codex App Server, SDK, or native chat UI.
- Structured turns, tools, approvals, models, MCP, or auth UI.
- Bundling or pinning the Codex binary.
- A provider framework or refactor of Claude/Grok supervision.
- Hand-started Codex detection or filesystem transcript scanning.
