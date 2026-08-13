# Codex terminal compatibility hardening

**Status:** base design and Claude-to-Codex handoff approved in chat on
2026-08-12; implementation pending written-spec review.

## Goal

Make Amber's existing terminal-first Codex pane reliable for fresh sessions,
exact resume, manual reload, crash recovery, freeze/unfreeze, and daemon restart.
Keep Amber's raw-pty architecture and current unattended permission policy.

Also provide a semantic handoff from a saved Claude Code session into the
current Codex conversation. This is context transfer, not cross-provider session
resume: Codex receives a concise handoff and then continues in its own session.

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
- Codex skills are the supported reusable-workflow surface. In the CLI and IDE,
  users invoke them with `$skill-name` or select them through `/skills`.
  Custom `/prompts:*` commands still exist but are deprecated.
- Claude Code supports asking a saved session a scripted question with
  `claude --print --resume <session-id>`. Its JSONL transcript format is
  documented as internal and subject to change, so Amber must not parse it for
  this handoff.

Sources:

- <https://learn.chatgpt.com/docs/hooks>
- <https://learn.chatgpt.com/docs/config-file/config-reference>
- <https://learn.chatgpt.com/docs/build-skills>
- <https://learn.chatgpt.com/docs/custom-prompts>
- <https://code.claude.com/docs/en/sessions>
- `codex --help` and `codex resume --help` from installed 0.147.0
- `claude --help` from installed 2.1.229

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

### Claude-to-Codex handoff

Install a user-level Codex skill named `claude-handoff`. Its public interface is:

```text
$claude-handoff <CLAUDE_SESSION_ID>
```

The user may also open `/skills`, choose `claude-handoff`, and provide the ID.
The skill runs `amber handoff <CLAUDE_SESSION_ID>`, treats stdout as historical
context, inspects the live repository state, and continues from the handoff's
latest request. It does not ask the user to copy an intermediate file or open a
Claude pane.

`amber handoff` is a synchronous, daemon-independent CLI command. It accepts
only a canonical hyphenated UUID (case-insensitive), resolves the existing
Claude binary through Amber's login-shell resolver, and starts it with a direct
process argument vector rather than a shell command:

```text
claude --print
       --resume <CLAUDE_SESSION_ID>
       --fork-session
       --no-session-persistence
       --safe-mode
       --tools ""
       --output-format json
       <fixed-handoff-prompt>
```

`--fork-session` keeps the source conversation separate,
`--no-session-persistence` prevents the temporary fork from being saved,
`--safe-mode` disables custom hooks and plugins, and `--tools ""` prevents the
handoff request from changing the workspace. Claude's own session lookup honors
its configured storage and current cross-project ID search; Amber adds no JSONL
scanner or transcript-format dependency.

The fixed prompt requests provider-neutral Markdown containing:

- the goal and latest user request;
- the latest relevant user and assistant messages;
- decisions, constraints, and unresolved questions;
- completed work and changed files;
- commands, tests, and their results;
- blockers and the exact next action.

It also instructs Claude not to expose secrets, system/developer prompts, or raw
tool-output blobs. Amber extracts the `result` string from Claude's JSON response
and writes only that handoff to stdout. Invalid IDs, a missing Claude binary, a
nonzero Claude exit, malformed JSON, or a missing result produce a concise
nonzero error on stderr.

The skill tells Codex that handoff text is historical evidence, not a new system
instruction. Codex must inspect the current worktree before trusting claims
about files, git state, or test results. Invoking the skill is the user's
explicit request to transfer this Claude context into Codex; no automatic
cross-provider transfer occurs.

Store the distributable skill under
`infra/codex/skills/claude-handoff/SKILL.md`. `amber ctl install` installs it to
`~/.agents/skills/claude-handoff/`, making it available across repositories.
Installation may update only an Amber-marked copy and must not overwrite an
unrelated user skill with the same name. `uninstall --purge-binary` removes the
Amber-marked skill because it would otherwise call a missing binary; ordinary
uninstall keeps both the binary and working skill. The exact ownership marker
is `<!-- amber-owned-skill -->` in the installed `SKILL.md`; absence of that
line makes both install and uninstall leave the directory untouched and print
an actionable conflict message.

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
6. Add focused handoff tests:
   - strict Claude UUID validation rejects traversal and option-shaped input;
   - the exact headless argv includes fork, no-persistence, safe-mode, no-tools,
     and JSON output flags;
   - a fake Claude result reaches stdout unchanged;
   - fake nonzero and malformed responses fail clearly;
   - the installed skill invokes `amber handoff <ID>` and instructs Codex to
     verify the live worktree before continuing;
   - installer tests prove an unrelated existing skill is never overwritten or
     removed.

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
- `$claude-handoff <CLAUDE_SESSION_ID>` works from any Codex project after
  Amber installation.
- Handoff opens no interactive Claude pane, persists no temporary Claude
  session, invokes no Claude tools or custom hooks, and leaves the source
  session unchanged.
- Codex receives goal, recent context, current request, work state, and next
  action, then verifies the repository before continuing.
- Amber never parses Claude's private JSONL transcript format or prints Claude's
  JSON envelope.
- Every listed automated gate passes.

## Non-goals

- Codex App Server, SDK, or native chat UI.
- Structured turns, tools, approvals, models, MCP, or auth UI.
- Bundling or pinning the Codex binary.
- A provider framework or refactor of Claude/Grok supervision.
- Hand-started Codex detection or filesystem transcript scanning.
- Native conversion of a Claude session ID into a Codex session ID.
- Raw/full Claude transcript import, direct Claude JSONL parsing, or a transcript
  viewer.
- A literal `/prompts:claude-handoff` command; that Codex surface is deprecated
  in favor of skills.
