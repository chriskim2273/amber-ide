# Muse session kind — design

Status: implemented and live-verified (2026-09-11). `kind:"muse"` panes are
supervised Muse Code CLI (`muse`) sessions: `amber run <name>` supervises
`muse --yolo` fresh / `muse resume <id> --yolo` on relaunch, and hand-started
`muse` in a shell promotes to a supervised muse pane across reboots.

## 1. Why Muse is Claude-shaped, not Grok-shaped

Amber cannot assign the session id. The interactive TUI rejects `--session-id`
outright (`invalid TUI options: unexpected argument '--session-id'` — only the
headless `muse exec` accepts it, and a pane needs the interactive TUI). There
is also no `SessionStart` hook or plugin event amber could tap (unlike
claude/codex/opencode/hermes/pi). So the id is DISCOVERED after launch from
Muse's own session store:

- fresh: `muse --yolo` (unattended approvals + sandbox off + workspace trusted
  for the run — the same posture every other agent pane runs with). Muse mints
  a UUID session under `${XDG_DATA_HOME:-~/.local/share}/muse/sessions/…`.
- resume: `muse resume <uuid> --yolo` (root options parse on either side of
  `resume`; this order is observed on live processes).

`--yolo` is load bearing, not a shortcut: a pane runs detached in the daemon's
pty, so an approval prompt nobody is watching would hang the session, and it
is what trusts the workspace without an interactive gesture.

## 2. Discovery (no hook, no scan fallback — pid-bound instead)

`crates/amber/src/muse.rs`. The directory name IS the session id, and the head
of `session.jsonl` carries `runtime.session.metadata` (`workspace_root`) plus
`runtime.session.route_facts` (`pid` — the CLI's own pid). Matching is
(pid-set × cwd), where the pid set is the Muse processes below the pane's pty
child:

- exact: two Muse panes in one cwd still resolve to their own conversations;
- no newest-for-cwd fallback anywhere (it would steal a sibling's
  conversation — the ambiguity the opencode spec refused to add).

Details that matter: only the first 64 KiB of each log is parsed (logs can be
megabytes); the first line may be a `retained_frame` whose
`children[].record_json` strings are the real envelopes; the LAST route_facts
pid wins (a `resume` appends one for the new process); a record without a pid
never clobbers an earlier one. Recordings live in the existing
`claude/<name>.json` path (rename/kill/adopt move and delete it already),
tagged `agent_kind: "muse"` — a UUID-shaped recording from another agent
(claude ids are UUIDs too) must NOT satisfy the muse check.

## 3. Process detection (the versioned binary)

`command -v muse` finds a launcher that execs a versioned `muse-bin-<version>`
ELF, so the argv0 basename changes on every Muse update and no fixed
process-name list can match it. `muse::is_muse_process` matches `muse` plus
the `muse-bin` prefix, and `procinfo::nearest_matching_descendant` runs the
standard nearest-depth/conflict walk on a predicate (`nearest_named_descendant`
delegates to it, unchanged semantics). `pty::primary_agent_in` reports it as
`"muse"`; `pty::muse_descendant_pids` feeds the discovery binding.

## 4. Recording + promotion (mirrors claude, independent state)

- Snapshot (`manager.rs`): `persist_muse_recording` runs for `Muse`-kind panes
  (fresh TUI mints its id after launch) and for `Shell` panes with a
  hand-started muse; skipped when a usable muse-tagged recording exists, when
  no Muse process is under the pane, and on final snapshots.
  `persist_live_cwd` additionally maintains `resume_as_muse` with the same
  two-strike hysteresis as claude — but a SEPARATE streak map (`muse_absent`):
  the flags track different processes and a shared counter would let one's
  absence consume the other's presence.
- Restore (`normalize_restored_meta`): `Shell` + `resume_as_muse` relaunches as
  `Muse` with the recorded id (Fresh when the daemon died before the first
  periodic snapshot could record — the same fallback the claude path has when
  its hook never fired). The flag always clears; a non-Shell kind is kept.
- Ladder (`supervisor.rs::select_muse_start`): a UUID-shaped recorded id on the
  first un-escalated attempt resumes; everything else starts Fresh. Never
  `resume --last` (it reopens whatever ran last in the cwd). No global
  hook/plugin install exists for muse, so `run_session` has no setup step.
- Everything else is the generic agent path, verified by construction and
  existing tests: `is_agent` gating (suspend/resume, rename respawn, dots),
  backlog suppression (alt-screen TUI), rename/kill/adopt via the shared
  store, `amber ctl doctor` resolution, and an `unavailable` usage row (Muse
  publishes no quota endpoint).

## 5. Known limitation: detached Muse TUIs exit (measured, upstream behavior)

Muse 1.1.1's TUI sends terminal queries at startup (`DA`, `CPR`, kitty
keyboard) and, when the terminal never answers, exits 0 after ~6 s (two `CPR`
retries observed via strace; `terminal_probe` phase in its own session log).
Amber's daemon drains ptys but never answers (answering would be a second
terminal emulator — core rule #4). Consequences:

- attached (app open, xterm answering): the TUI renders and idles normally;
- detached (app closed/restarting, daemon reboot): the pane's muse exits 0 →
  CleanExit → shell fallback. The recorded id is retained, so the next
  supervised start resumes the same conversation; nothing is lost, but a muse
  pane does not stay warm while nobody is attached.

This is inherent to detached muse operation (tmux/screen detached behave the
same), not amber-specific. Deliberately NOT worked around daemon-side.

## 6. Verification (isolated private daemon + private `XDG_DATA_HOME`)

- Fresh `kind:"muse"` pane → TUI up, snapshot records the UUID tagged muse.
- `kill -9` the TUI → supervisor relaunches `muse resume <same-id> --yolo`;
  the session log continues under the SAME id with the new pid (three pids,
  one conversation, across a daemon restart too).
- Hand-started `muse` in a shell pane → `resume_as_muse` + muse-tagged
  recording → daemon restart promotes the pane to `kind:"muse"` resuming that
  id; the flag clears; rename moves the recording with the pane.
- Gates: Rust 563 lib + full workspace green, clippy clean except one
  `browser_ops.rs` duplicate-attribute warning in a file this change never
  touches (zero diff lines — it fails `-D warnings` with or without this
  change); app 1270 passed / 1 skipped, typecheck clean. Live GUI gesture
  (picker → pane) remains manual; the picker is data-driven
  (`PANE_KIND_OPTIONS`) and unit-covered.
