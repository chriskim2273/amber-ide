# Codex as a session kind — design

**Status:** implemented (2026-08-10). Unit + typecheck gates green. Live on
codex-cli 0.147.0: doctor records `codex_path`, create spawns
`codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust`,
global SessionStart hook installs, and directory trust is pre-accepted via
`[projects."<cwd>"] trust_level = "trusted"` (without that, codex blocks forever
on the trust dialog and SessionStart never fires). Hook-driven id write after a
real user turn still needs manual confirmation in the GUI.

## Goal

A third supervised coding agent alongside claude and grok: `kind: "codex"`. A
codex pane behaves like the others — its pty runs `amber run <name> --kind
codex`, its conversation resumes across crashes and reboots, and it falls back
to a shell rather than dying.

## Why it is Claude-shaped (not Grok-shaped)

Claude's resume id is reported by a `SessionStart` hook. Grok inverts that:
`grok --session-id <uuid>` *assigns* the id of a NEW conversation.

OpenAI Codex CLI (measured against current upstream):

| behaviour | result |
|---|---|
| Fresh interactive start | `codex` |
| Resume exact conversation | `codex resume <SESSION_ID>` (UUID or session name) |
| Assign id on create | **not supported** |
| Unattended approvals | `--dangerously-bypass-approvals-and-sandbox` |
| SessionStart hook | yes — stdin has `session_id` + `cwd` |
| Hook install | `$CODEX_HOME/hooks.json` (default `~/.codex/hooks.json`) |
| Hook trust | untrusted hooks can block; amber passes `--dangerously-bypass-hook-trust` |

So amber cannot mint the id. Capture is a global SessionStart hook that runs
`amber hook` (same command as claude); record into the existing
`claude/<name>.json` store; resume with `codex resume <id>`.

## Design

**Storage.** The codex id lives in the SAME `claude/<name>.json` store. Rename /
kill / adopt already move and delete that path.

**Hook install.** `codex::ensure_global_codex_hook` merges a SessionStart command
into `$CODEX_HOME/hooks.json` (else `~/.codex/hooks.json`):

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "<amber-exe> hook" }] }
    ]
  }
}
```

Root-level `SessionStart` is rejected by Codex — must nest under `"hooks"`.
Merge-preserving: wrong shape → warn and skip; exact-command dedupe; GC dangling
`<path> hook` entries whose amber binary is gone. Install at daemon start /
doctor (same sites as the claude global hook). There is no per-session settings
file (Codex has no Claude-style `--settings` for hooks).

**Resume ladder** (`supervisor::select_codex_start`):

1. Non-empty recorded id on escalation 0 → `Resume(id)`.
2. Otherwise → `Fresh`.
3. Never `codex resume --last` (cwd hijack).

**Argv** (excluding the program):

- Fresh: `--dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust`
- Resume: `resume <id> --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust`

**Which agent to run is passed on argv** (`amber run <name> --kind codex`), not
read from the store — same race claude/grok already solved.

**Run-state vocabulary is unchanged** (`claude` / `claude-retrying` /
`shell-fallback` / `suspended`).

**Kind-gated sites** use `SessionKind::is_agent()` / `isAgentKind()` — codex is
an agent arm.

## Scope cuts (deliberate)

- No filesystem session-scan fallback.
- No hand-started-codex detection (`resume_as_claude` stays claude-only).
- No permission-mode UI (always yolo, matching claude/grok).
- Cleanup dialog conversation labels stay claude-transcript-based.
- Doctor records codex path when present; never fails on its absence.

## Verification

See implementation plan / CLAUDE.md entry after ship: unit tests for argv, hook
install, ladder, kind gates; app tests for `isAgentKind` / dots; live private
daemon create → hook record → kill/resume → daemon restart → freeze/unfreeze →
GUI picker.
