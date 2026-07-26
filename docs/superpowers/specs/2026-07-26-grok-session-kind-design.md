# Grok as a session kind — design

**Status:** implemented (2026-07-26), live-verified.

## Goal

A second supervised coding agent alongside claude: `kind: "grok"`. A grok pane
behaves exactly like a claude pane — its pty runs `amber run <name>`, its
conversation resumes across crashes and reboots, and it falls back to a shell
rather than dying.

## Why it is smaller than claude support

Claude's resume id **rotates** (on resume/clear/compaction) and only claude
knows it, so amber has to generate a per-session `--settings` file with a
`SessionStart` hook, plus a global hook, and read the id back out of the store.

Grok inverts that: `grok --session-id <uuid>` **assigns** the id of a NEW
conversation. So amber mints the uuid itself, records it, and later passes
`grok --resume <uuid>`. No hook, no settings file, no writes into the user's
grok config, and nothing to garbage-collect.

Measured against grok 0.2.112:

| behaviour | result |
|---|---|
| `--session-id <uuid>` on a new conversation | assigns it |
| `--resume <uuid>` afterwards | reopens it, **id unchanged** (rotating needs `--fork-session`) |
| `--session-id <uuid>` a second time | `Error: Session ID … is already in use` |
| `--resume` from a different cwd | works — "found locally (originally in …)" |
| `--permission-mode bypassPermissions` | claude's `--dangerously-skip-permissions` equivalent |
| folder-trust dialog | none — nothing to pre-accept |

## Design

**Storage.** The grok id lives in the SAME `claude/<name>.json` store claude
uses. `StateStore::rename_session` and `remove_session` already move and delete
that path, so cross-tab move, adopt and kill keep working with no new code. A
separate `grok/` dir would have meant touching both, and missing either would
leak a file or lose a conversation on move.

**The resume ladder** (`supervisor::select_grok_start`), two rules that are not
optional:

1. A fresh start ALWAYS mints a brand-new uuid and persists it before launch.
   Re-passing the recorded id is rejected outright by grok, so every retry
   would fail instantly and burn the budget without launching anything.
2. A recorded id is resumed only if it is UUID-shaped. `--resume` takes an
   OPTIONAL value, so a blank/garbage one silently resumes the most recent
   conversation in the cwd — the same hijack the claude ladder avoids by never
   using `--continue`.

Resume is tried `GROK_RESUME_ATTEMPTS` (2) times before minting a new
conversation, unlike claude's single try. Measured on a killed pane: the first
relaunch 200 ms later can fail with `not found locally, restoring from remote …
404` while the dead process's session files settle, while the identical
`--resume` succeeds moments later. One transient miss must not cost a live
conversation.

**Which agent to run is passed on argv**, not read from the store:
`SessionManager::create` spawns the pty BEFORE it persists the metadata (the
slot is allocated under the sessions lock, which the spawn must stay outside
of), so a supervisor that read `sessions/<name>.json` races it. Observed live:
a grok pane launched claude. `command_for` therefore emits
`amber run <name> --kind grok`.

**Run-state vocabulary is unchanged.** Grok reports the same
`claude`/`claude-retrying`/`shell-fallback`/`suspended` strings — they name the
supervision phase, not the binary. Minting `grok-*` variants would mean new
vocabulary in the daemon's validation, the app's kind-dot and the tab label for
no behaviour gain.

**Kind-gated sites** now ask `SessionKind::is_agent()` (Rust) /
`isAgentKind()` (app) instead of `== Claude`: raw-client backlog suppression
(an alt-screen TUI either way), run-state reporting, suspend/resume,
rename respawn, pane/tab dots, and the `.amberws` dump filter. TypeScript does
NOT catch the app-side ones — they are runtime string comparisons, the same
class of miss the editor-pane pass recorded.

## Scope cuts (deliberate)

- No global grok hook and no hand-started-grok detection: `procinfo`'s
  `comm == "claude"` / `resume_as_claude` still only upgrades a shell pane that
  is running claude by hand.
- The session-cleanup dialog labels conversations by reading claude transcripts;
  a grok id simply resolves to nothing there and the row falls back to its cwd.
- `amber ctl doctor` records grok's path when present but never fails on its
  absence — a claude-only machine is a working amber.

## Verification

Rust 245 tests + clippy clean; app 393 tests + typecheck + bundle. Live on a
private daemon: create → `grok --permission-mode bypassPermissions --session-id
<minted>`, id recorded; a real conversation turn; `kill -9` → relaunch as
`--resume <same id>` with the conversation intact; daemon SIGTERM + restart →
restored as kind `grok`, resumed, still intact; SIGUSR1/SIGUSR2 → child killed
(RAM freed) then relaunched with `--resume`; `amber rename` → respawned under
the new name still resuming. Live GUI (xvfb + CDP): the `grok` picker option
creates the pane, header reads `#1 grok · grok` with its own blue dot, the grok
TUI renders, typing reaches it and its reply comes back, live OSC title lands
in the header, no error banner.
