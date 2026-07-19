# Cross-Tab Pane Move (Session Rename) — Design

**Date:** 2026-07-18
**Status:** Implemented 2026-07-19 (daemon Rename + app pane-drop move). Deviation: the settings file carries no session name, so it moves unchanged.
**Scope:** Let a pane be moved to another tab (or workspace) by dragging it onto
a tab header. Because a session's tab is encoded in its name
(`amber-<ws>-<tab>-<ord>-<id>`, core rule #2), a cross-tab move **is** a session
rename. This implements the daemon `Rename` that today returns "unsupported".

## 1. Why this needs the daemon (not app-only)

Grouping is derived one-way from the session name (core rules #2/#3). Faking a
tab move in the app (a sidecar override) would violate "grouping reconstructable
from session names alone". So the name must actually change — a rename — and the
daemon owns names (core rule #1). Browser panes are the exception: they have no
daemon session (their grouping lives in the sidecar already), so they move by a
pure sidecar edit.

## 2. Settled decisions

- **Approach: real daemon rename + supervisor rebind** (not sidecar override,
  not kill+recreate). Chosen by the user.
- **Live claude move = restart + resume.** A running claude session's supervisor
  is env-bound to its name (`amber run <name>`, `AMBER_SESSION=<name>` — fixed at
  spawn; the daemon cannot mutate a live child's env). So renaming a live claude
  session respawns its supervisor under the new name, which relaunches
  `claude --resume <recorded-id>` — the **same conversation** resumes (brief
  redraw). Chosen by the user. Claude is a full-screen alt-screen TUI, so the
  pty-scrollback reset from respawning is invisible.
- **Shell move = in place, no respawn.** A shell session is re-keyed and its
  store files moved, but its pty/process/scrollback are preserved. Its already
  running shell keeps a now-stale `AMBER_SESSION` env; this only matters to a
  *hand-started* claude inside that shell (its SessionStart hook would record
  under the old name until the shell restarts) — an accepted edge-case, noted in
  the daemon rename doc-comment.

## 3. Daemon changes (Rust)

### 3.1 `StateStore::rename_session(from, to)` — `amber-core/src/state.rs`
Move all name-keyed artifacts and rewrite the embedded name, atomically enough
that a crash mid-rename never corrupts restore:
- `sessions/<from>.json` → `sessions/<to>.json`, rewriting `SessionMeta.name` to
  `to` (read → edit → `atomic_write` new → remove old).
- `claude/<from>.json` → `claude/<to>.json` (if present).
- `claude/<from>.settings.json` → `claude/<to>.settings.json` (if present) — the
  per-session hook settings; the hook command inside references the name and
  must be rewritten too (`claude::write_settings` for `to`).
- `scrollback/<from>.bin` → `scrollback/<to>.bin` (if present).
Order: write the new `sessions/<to>.json` LAST-but-one and remove
`sessions/<from>.json` LAST, so a crash leaves either the old fully-restorable
session or the new one — never a half-session. TDD: unit test the file moves +
name-field rewrite + missing-optional-files case.

### 3.2 `SessionManager::rename(from, to)` — `amber/src/manager.rs`
- Validate: `to` passes `validate_name`; `from` exists; `to` does not.
- Re-key `sessions: HashMap` and `claude_absent: HashMap` from `from`→`to`.
- Update the `PtySession`'s stored name (add a setter or a `name: Mutex<String>`
  — it must stay `Send+Sync`).
- `store.rename_session(from, to)`.
- **If the session is claude-supervised** (kind == claude, i.e. runs
  `amber run`): respawn it under `to` — kill the current pty child, spawn a fresh
  `PtySession` with `command_for(to, …)` (which sets `amber run to`), preserving
  cwd + pty size. The migrated `claude/<to>.json` makes the supervisor resume the
  same conversation. (Reuse the restore path — this is effectively `restore_one`
  under the new name.)
- **If shell**: no respawn; the re-key + store move is the whole change.
- Return the new `SessionInfo` (via `session_infos`/`read_claude(to)`).
TDD: manager test with a fake pty stub — rename re-keys the map, moves store
files, shell keeps its child, claude gets a fresh child.

### 3.3 Daemon `Rename` handler — `amber/src/daemon.rs`
Replace the unsupported-error arm:
- Call `manager.rename(from, to)`.
- Re-key live pane `Subscriptions` entries (`Vec<(name, sess, id)>`) from
  `from`→`to` so an attached client's byte stream keeps flowing under the new
  name (or, simpler and consistent with kill/reap: rely on the client
  re-subscribing on the `SessionsChanged` — the app already re-attaches on
  session changes; pick whichever the app's reattach logic supports).
- Broadcast `SessionsChanged { added: [new_info], removed: [from] }` to watchers.
- Reply `Renamed`/`Error` (CLI already treats any non-`Error` as success).
- Update the two existing socket tests (`rename_gets_an_explicit_unsupported_error`,
  `rename_via_cli_surfaces_daemon_error`) to assert success + the delta.

### 3.4 Proto — `amber-core/src/proto.rs`
`Rename { from, to }` already exists. Add a `Renamed { name }` reply (or reuse
`Created`) — pick the minimal addition; keep `SessionsChanged` as the grouping
signal. No change to `SessionInfo`.

## 4. App changes (TypeScript)

### 4.1 Drop a pane on a tab header
The pane-drag gesture already exists (the ⠿ grip, window-listener hit-tested
against `paneRects`). Extend the drop hit-test to also consider **tab headers**
(`.tab` rects). Dropping a pane on tab T (of workspace W):
- **Daemon pane:** compute the new name
  `formatName({ ws: W, tab: T, ord: nextOrdIn(W,T), id: <same id> })` (keep the
  stable `id`; change ws/tab/ord) and call a new `window.amber.renameSession(from, to)`
  (preload passthrough → daemon `Rename`). Do NOT optimistically move the leaf —
  one-way flow: the resulting `SessionsChanged` removes the old name and adds the
  new, and `groupSessions` places it in tab T; `reconcile` prunes the old-tab
  leaf and appends the new-tab leaf. (Optionally pre-seed a `pending`-style
  target position so the landed leaf keeps intended placement, mirroring split.)
- **Browser pane:** update the sidecar `browsers[id]` `ws/tab/ord` to W/T and let
  `mergeBrowsers`/`reconcile` remap the leaf (pure sidecar edit — its id prefix
  stays `browser-`; only ws/tab/ord change, so also rewrite the id to
  `browser-W-T-ord-<id>` for consistency, or keep the id and store ws/tab in the
  entry — the entry already carries ws/tab/ord, so **keep the id, update the
  entry**, and move the leaf between tab trees directly).

### 4.2 Preload + types
Add `renameSession: (from, to) => ipcRenderer.send('daemon-command', { cmd: 'rename', from, to })`
to preload + the `window.amber` type + the control-message serialization in the
utilityProcess router (mirror `killSession`).

### 4.3 Sidecar leaf remap
On a daemon-pane rename the layout tree leaf id must follow the rename. Because
the tree is keyed by session name, the source-tab tree's old-name leaf is pruned
by reconcile and the target-tab tree gains the new-name leaf. The source tab's
stored tree (sidecar) is rewritten by the existing tree-persist effect. No new
sidecar schema. (Browser panes: move the leaf node between the two tabs' stored
trees explicitly, since reconcile keys on the browser id which we keep.)

## 5. Out of scope

Reordering panes *within* a tab (already covered by `moveLeaf`); moving a pane by
keyboard; multi-select move. Renaming for any purpose other than a tab/ws move
(no rename UI in the pane header).

## 6. Testing

- **Rust unit:** `StateStore::rename_session` (file moves + name rewrite +
  missing-optionals); `SessionManager::rename` (re-key, shell-keeps-child,
  claude-respawns) with a fake pty; update the two socket rename tests to assert
  success + `SessionsChanged`.
- **Rust integration:** a live-daemon test — create a shell session in tab 1,
  rename to tab 2, assert `ls` shows the new name and the old is gone and the pty
  is still alive (shell); a claude-supervised rename asserts the claude store
  file moved and the supervisor relaunched.
- **App unit:** the drop-on-tab-header target computation (pure: given pane +
  target tab → new name / sidecar edit); browser vs daemon branch.
- **Live GUI (isolated private daemon):** drag a shell pane onto another tab →
  it appears there, still alive; drag a browser pane across tabs → URL preserved;
  restart → grouping restored (name-encoded, survives sidecar loss for daemon
  panes).

## 7. Risk notes

- The live-claude respawn is the only behaviorally-visible cost (brief redraw,
  same conversation) — accepted.
- Rename must be atomic w.r.t. the snapshot timer: hold the manager lock across
  the re-key + store move so a concurrent snapshot can't observe a half-rename.
- A rename whose target name already exists must be refused (validate), never
  clobber another session.
