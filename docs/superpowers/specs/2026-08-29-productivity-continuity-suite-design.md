# Amber Productivity & Continuity Suite — Design Specification

**Status:** reviewed and ready for implementation  
**Date:** 2026-08-29  
**Scope:** desktop Electron client plus additive daemon protocol and state-store support  
**Motivation:** make a large, long-lived Amber installation searchable, navigable, explainable, reusable, and portable without weakening daemon authority or pretending arbitrary Unix processes can be checkpointed.

## 1. Goals

This suite delivers the ten product capabilities selected for Amber:

1. command palette / universal session switcher;
2. global persisted-scrollback search;
3. durable recovery center;
4. reusable workspace templates;
5. actionable desktop notifications;
6. durable session bookmarks;
7. workspace activity overview;
8. project-local `.amber.toml` profiles;
9. named workspace restore points;
10. single-session handoff export.

The suite MUST preserve Amber’s constitution:

- the daemon remains authoritative for terminal session existence, metadata, process supervision, and scrollback;
- clients never optimistically create, kill, rename, suspend, or resume daemon sessions;
- terminal output remains raw bytes and never passes through Electron main;
- app-owned files may store only presentation metadata, reusable recipes, exports, and recovery-point documents;
- grouping remains reconstructable from daemon session names if app-owned files disappear;
- no feature claims to restore arbitrary in-memory process state after reboot.

## 2. Non-goals

- No cloud account, cloud synchronization, collaboration service, or hosted index.
- No SSH connection manager.
- No AI chat sidebar.
- No plugin runtime.
- No indexing outside daemon-owned scrollback or user-selected workspace files.
- No automatic execution of commands from an untrusted repository.
- No CRIU/process-memory checkpointing.
- No browser/editor content embedding in handoffs; editor files remain references and browser panes remain URLs.
- No remote-web exposure of search, recovery history, templates, bookmarks, checkpoints, project profiles, or handoff export in this pass.

## 3. Product model

The suite has three authority classes.

### 3.1 Daemon-owned truth

- current sessions and their metadata;
- current raw scrollback rings;
- recovery/lifecycle event journal;
- global scrollback search results computed from a point-in-time copy of each ring.

### 3.2 Desktop-owned productivity metadata

Stored at `<state>/productivity.json`, independently of `ui-layout.json`:

- templates;
- bookmarks;
- notification preferences.

This file MUST NOT contain pane grouping required for restore. It is optional augmentation. A missing or malformed file produces safe defaults.

### 3.3 Desktop-owned recovery documents

Stored under `<state>/checkpoints/<id>.amberws`:

- named `.amberws`-compatible documents containing structure and capped scrollback;
- metadata sufficient to list, inspect, restore, and delete each point.

These restore exactly the same class of state as manual `.amberws` import: structure, raw retained scrollback, referenced browser/editor locations, and **fresh** PTYs. Supervised-agent panes start fresh because imported names are newly minted and `.amberws` deliberately carries no conversation identity. They do not restore conversations, a shell process’s heap, file descriptors, or job tree.

## 4. Additive daemon protocol

### 4.1 Search

New request:

```text
SearchScrollback {
  request_id: u32,
  query: String,
  names: Vec<String>,
  limit: u16
}
```

New reply:

```text
SearchResults {
  request_id: u32,
  query: String,
  results: Vec<SearchResult>
}

SearchResult {
  name: String,
  line: u32,
  preview: String
}
```

Rules:

- Query length: 1–256 Unicode scalar values after trimming.
- Limit: clamped to 1–200; `0` means the default 100.
- `names=[]` searches all currently listed sessions; otherwise only exact currently listed names are considered.
- Search is case-insensitive Unicode lowercase matching.
- Search operates on a copy of each ring taken with no daemon-wide session lock held during text processing.
- Search strips ANSI/OSC/DCS control sequences and non-newline C0 controls before line matching.
- Preview is one logical line, whitespace-normalized and capped at 240 characters.
- `line` is one-based within the sanitized retained ring, not a stable absolute terminal row.
- Results are ordered by session name, then line, and stop at the requested global limit.
- Search executes on a worker thread. The per-connection read thread MUST never perform ring scanning or a potentially large result write.
- Search responses are small control frames and use the existing bounded writer.
- The browser whitelist does not map this message.

### 4.2 Recovery history

New requests/replies:

```text
ListRecoveryEvents { limit: u16 }
ClearRecoveryEvents
RecoveryEvents { events: Vec<RecoveryEvent> }
RecoveryEventsCleared

RecoveryEvent {
  at: u64,             // Unix seconds; safe in JS
  sequence: u32,       // tie-breaker within the journal
  level: String,       // info | warning | error
  event: String,       // stable machine-readable event name
  session: Option<String>,
  detail: String,
  code: Option<i32>
}
```

The state store persists an atomically rewritten bounded array at
`<state>/recovery-events.json`.

- Maximum retained events: 500.
- Maximum detail: 512 characters.
- Reads tolerate a missing file as an empty journal.
- A malformed journal is reported as an error to the requesting client but MUST NOT prevent daemon startup.
- Append is serialized inside `StateStore`; concurrent daemon threads cannot lose one another’s event.
- Clear atomically replaces the file with an empty array.

Events recorded in this pass:

- `daemon.restore`: restore summary, including restored and skipped counts;
- `session.restore_failed`: one per skipped session, with the error;
- `session.created`;
- `session.renamed`;
- `session.killed`;
- `session.exited`: captured before reap deletes metadata, including exit code when known;
- `session.suspended` and `session.resumed`;
- `snapshot.completed` and `snapshot.failed` for explicit protocol snapshots.

Periodic snapshots are intentionally not journaled; doing so every configured interval would drown meaningful events.

## 5. Desktop productivity store

`productivity.json` is versioned and shape-guarded:

```ts
interface ProductivityFile {
  version: 1
  templates: WorkspaceTemplate[]
  bookmarks: Record<string, SessionBookmark[]>
  notifications: NotificationPreferences
}
```

Bounds:

- 50 templates;
- 100 bookmarks per session and 2,000 total;
- names ≤80 characters;
- bookmark labels ≤120 characters;
- bookmark excerpts ≤500 characters;
- stale bookmark session keys are retained intentionally: a handoff or renamed/restored session may still need them. The UI offers deletion.

Writes use same-directory temp + fsync + rename. Renderer access is through narrow `productivity-load` / `productivity-save` IPC. Saves carry the previous exact-content version token and use compare-and-swap. On conflict the renderer re-reads, applies its mutation to the fresh document, and retries once. The renderer never writes arbitrary paths.

## 6. Command palette

### 6.1 Invocation

- macOS: `Cmd+K`.
- Linux: `Ctrl+Shift+K`.
- Available from the toolbar as an icon button.
- `Escape` closes; arrows move; Enter runs; typing filters.
- The global chord parser and xterm veto share the same `command-palette` action.

### 6.2 Entries

The palette includes:

- every daemon pane, keyed by slot/title/cwd/session/workspace/tab/kind;
- every app-local browser/editor pane;
- workspace and tab switches;
- actions: new pane, new tab, global search, recovery center, activity overview, templates, checkpoints, project profile, save/load workspace, sessions, memory, help.

### 6.3 Navigation

Selecting a pane:

1. derives workspace/tab from its daemon or app-local name;
2. updates the active workspace and tab;
3. closes the palette;
4. lets the existing mounted `SplitView` focus the pane after activation.

No state is created or renamed locally.

## 7. Global search UI

- Invoked through palette, workspace tools, and `Cmd+Shift+G` on macOS / `Ctrl+Shift+G` on Linux. The existing pane-local find chord remains unchanged.
- Debounce: 200 ms.
- One request at a time logically; request IDs discard stale replies.
- Scope options: all sessions, current workspace, current tab.
- Empty query performs no daemon request.
- Results display pane slot/title, workspace/tab, line number, and preview.
- Selecting a result navigates to the pane and opens that pane’s existing xterm search bar with the same query. This is an honest jump to the matching retained text; the reported line number is informational because xterm rows differ after escape interpretation/reflow.
- Disconnection keeps the query visible and reports that search is unavailable.
- No raw backlog bytes enter React state.

## 8. Recovery center

- Opened from the continuity popover, tools menu, and palette.
- Requests the newest 200 daemon events on open.
- Displays newest first with severity, timestamp, session, detail, and exit code.
- Filters: all / errors / lifecycle / snapshots.
- Actions when the referenced session still exists:
  - focus pane;
  - retry agent resume when the current session kind is supervised and its state allows it;
  - open session cleanup.
- Global actions: refresh and clear history with confirmation.
- Restore failures remain visible even if the failed session is absent from the live list.

## 9. Workspace templates

### 9.1 Capture

“Save current workspace as template” converts the current live workspace into the existing `WorkspaceDoc` placeholder format with all scrollback strings empty. It preserves:

- tabs and tab order;
- split trees and ratios;
- pane kinds and cwd;
- workspace/tab labels;
- browser URLs;
- editor paths;
- frozen notes.

It never embeds terminal output, editor contents, agent conversation IDs, or session names.

### 9.2 Instantiate

- Template instantiation always creates a new workspace.
- It reuses `planLoad` and the existing one-way pending-load confirmation path.
- App-local panes are created only in the sidecar; daemon panes use `Create` and appear only after daemon confirmation.
- Templates are renameable and deletable.

### 9.3 Bounds and failure

- Empty templates are allowed but called out.
- Unsupported future pane kinds fail capture rather than silently disappear.
- A partial daemon create failure leaves confirmed sessions visible and reports which expected sessions did not arrive; it does not commit a tree naming nonexistent panes.

## 10. Notifications

### 10.1 Preferences

Defaults:

- background activity: off;
- session exit: on;
- agent retry: off;
- agent shell fallback: on;
- memory/resource pressure: on.

Per-workspace mute is supported. Preferences live in `productivity.json`.

### 10.2 Delivery

Renderer detects meaningful state transitions from daemon events and invokes a narrow main-process notification bridge:

```ts
notify({ id, title, body, session? })
```

Main validates lengths and creates an Electron `Notification`. Clicking it:

- focuses/restores the originating BrowserWindow;
- sends `notification-activate` with the session name back to that renderer;
- never executes content supplied by the terminal.

Notifications are suppressed when:

- the relevant pane is already in the visible active tab and the window is focused;
- the workspace is muted;
- the event type is disabled;
- the same `(type, session)` notified within the last 30 seconds.

Terminal output is never used verbatim as a notification body. Bodies are fixed UI copy plus trusted daemon metadata such as kind/cwd.

## 11. Session bookmarks

### 11.1 Capture

Pane context menu and palette expose “Bookmark position”. The terminal API returns:

- selected text when a non-empty selection exists; otherwise
- the current cursor line plus up to two preceding visible lines.

The renderer creates:

```ts
interface SessionBookmark {
  id: string
  createdAt: number
  label: string
  excerpt: string
}
```

The label defaults to a trimmed first excerpt line and may be edited.

### 11.2 Use

Bookmarks are listed in a dialog grouped by session. Selecting one navigates to the pane and opens pane-local search with the first useful excerpt line. Because terminal scrollback can evict or reflow, bookmarks are semantic anchors, not permanent row offsets. Missing text reports “bookmark text is no longer retained” without deleting the bookmark.

Bookmarks can be renamed/deleted and are included in a session handoff.

## 12. Activity overview

The existing Sessions dialog evolves into an “Activity” overview while retaining adoption and bulk-kill behavior.

Summary metrics:

- total/live/exited sessions;
- supervised running/retrying/fallback/suspended counts;
- aggregate reported RSS;
- unseen-activity count.

Controls:

- text filter across name/cwd/kind/title;
- state filters;
- sort by slot, activity, memory, or name;
- focus/adopt, suspend/resume, bookmark list, export handoff, and guarded kill.

The view derives from current daemon `SessionInfo`, Activity, Exit, and MemoryStat state. It does not become a second authority.

## 13. Project-local `.amber.toml`

### 13.1 Location and schema

Amber reads exactly `<selected cwd>/.amber.toml` on explicit user action.

Supported deliberately-small schema:

```toml
version = 1
name = "frontend"

[[pane]]
kind = "shell"
cwd = "."
direction = "h"

[[pane]]
kind = "codex"
cwd = "packages/app"
direction = "v"
```

Fields:

- `version`: required integer `1`;
- `name`: optional string;
- `pane`: 1–32 array-of-table entries;
- `kind`: supported daemon pane kind only;
- `cwd`: relative path beneath the selected project root or `.`;
- `direction`: optional `h` or `v`, default `h`, used to append the pane to the previous leaf.

### 13.2 Security boundary

- Parsing is a strict purpose-built parser, not shell evaluation.
- Absolute paths, `..` traversal, NULs, unsupported keys, duplicate scalar keys, malformed quoting, and unsupported kinds are errors.
- Resolved cwd must remain beneath the project root and must exist as a directory.
- Reading occurs only after the user selects “Load project profile”.
- A review dialog shows every pane kind and resolved cwd before “Create workspace”.
- No `command`, `env`, hook, or executable field is accepted in v1. This is intentional: a repository-provided command is code execution and requires a separately designed trust/persistence model. The profile still delivers deterministic layout/kind/cwd setup without weakening the daemon’s restore contract.

## 14. Named restore points

### 14.1 Creation

“Create restore point” asks for a name and scope (current workspace or all), then:

1. asks the daemon for each terminal backlog using the existing off-read-thread `DumpBacklog` path;
2. assembles the existing versioned `.amberws` document;
3. embeds checkpoint metadata (`id`, display name, creation time, scope, and automatic/manual origin) in a validated wrapper around the `WorkspaceDoc`;
4. writes it atomically under `<state>/checkpoints/<id>.amberws`.

Listing reads only bounded wrapper metadata from at most 100 files; checkpoint files are capped at 128 MiB and the full workspace document is parsed only on restore.

The ID is app-generated `[a-z0-9-]{8,64}`; main validates it before any path construction.

### 14.2 Automatic preflight points

The desktop creates an automatically named restore point before:

- replacing a workspace from `.amberws`;
- bulk-killing more than one session;
- restoring another checkpoint over the current workspace.

Automatic creation failure blocks the destructive action and reports why. Closing a single pane remains guarded by its existing confirmation and does not incur a multi-pane dump.

### 14.3 Restore/delete

- Restore offers “as new workspace(s)” or “replace current” and reuses `planLoad`; daemon panes are fresh sessions, including fresh agent conversations.
- Replace itself first creates a preflight point, avoiding recursive preflight by marking the internal operation.
- Delete removes only a validated checkpoint file after confirmation.
- Retention: 20 automatic points, pruned oldest-first after successful creation; manual points are never automatically deleted.

## 15. Session handoff export

A handoff is a versioned JSON document saved by native dialog:

```ts
interface SessionHandoff {
  version: 1
  exportedAt: number
  session: {
    kind: string
    cwd: string
    slot?: number
    title?: string
    runState?: string
    conversationId?: string
  }
  scrollback: string
  bookmarks: SessionBookmark[]
}
```

- Scrollback is base64 raw bytes from one `DumpBacklog` reply, capped by the daemon ring.
- No daemon session name is exported as a reusable identity; imported copies must mint a new name.
- Agent conversation ID is clearly labeled as a reference and is never automatically resumed on another machine.
- Handoff export is available from a pane’s context menu, activity overview, and palette.
- Import is out of scope; `.amberws` already covers restoration. The handoff is for human/agent transfer and archival inspection.

## 16. Performance constraints

- No React update per PTY chunk.
- Search never reads scrollback through Electron main and never stores raw backlogs in React.
- Search copies are bounded by configured ring cap × currently searched sessions and released after each worker request.
- Recovery journal is bounded at 500 events.
- Productivity metadata and checkpoint indices are bounded and shape-guarded.
- Notification transition detection is O(number of changed sessions), not O(total backlog).
- Command filtering is performed over small metadata strings and debounced only where remote work occurs.
- Existing keep-alive terminal layers remain memoized.

## 17. Compatibility and migration

- All new control variants are additive.
- Rust daemon inbound decoding skips unknown future variants; old daemons receiving new requests keep the connection alive but do not reply. Desktop dialogs time out with “requires a newer daemon”.
- New desktop decoding skips unknown daemon variants as today.
- Existing `ui-layout.json`, `.amberws`, state metadata, and protocol frame tags are unchanged.
- `productivity.json`, recovery journal, checkpoints, and `.amber.toml` are new optional files.
- Request-oriented desktop surfaces use an 8-second timeout. No reply from an older daemon becomes an explicit “restart/update the Amber daemon” message, never an infinite spinner.
- No migration is required when files are absent.

## 18. Testing

### Rust

- protocol round trips and known-variant list updates;
- ANSI sanitizer including CSI, OSC BEL/ST, DCS, split controls, CR/backspace, invalid UTF-8;
- query validation, scoping, result order, line numbers, preview/limit bounds;
- recovery journal missing/malformed/append/cap/clear/concurrent append;
- manager search copies rings without holding session lock during scan;
- daemon integration: search reply arrives while another control request is processed;
- recovery event recording for create/rename/kill/reap/restore failure/snapshot.

### TypeScript

- protocol encode/decode for all new variants and malformed payloads;
- productivity parser bounds and CAS conflict merge;
- command ranking/filtering and keyboard operation;
- search request staleness and scope name selection;
- recovery filtering/action availability;
- template capture and instantiate through `planLoad`;
- notification transition/dedup/suppression policy;
- bookmark capture, bounds, rename/delete, missing-text behavior;
- activity summaries/filter/sort;
- strict `.amber.toml` parser and path containment;
- checkpoint ID validation/index retention/preflight policy;
- handoff serialization/shape guards.

### Live verification

Against an isolated daemon and state root:

- search text in multiple real PTYs and navigate to a result;
- generate an exit and a restore failure, restart daemon, confirm history remains;
- capture/instantiate a mixed-kind template;
- click a notification and land on its pane;
- create/find/delete a bookmark;
- load an accepted profile and reject traversal/unsupported keys;
- create/restore/delete a checkpoint;
- export one handoff and inspect bytes/bookmarks;
- disconnect/reconnect during each request-oriented dialog.

Tests are authored in the requested worktree but executed only from a fast local mirror, never from `/media/poyto/Teacup`.

## 19. Acceptance criteria

The suite is complete when:

- every feature in §1 has an accessible desktop entry point and keyboard path where appropriate;
- daemon authority and one-way lifecycle flow remain intact;
- search and dump work cannot block the connection read thread;
- every new persisted file is atomic, bounded, validated, and tolerant of absence;
- destructive multi-session operations are preceded by a successful restore point;
- project files cannot execute commands or escape their selected root;
- old state remains readable and old clients/daemons fail additively rather than corrupting state;
- targeted and full Rust/app test suites, typecheck, clippy, and production builds pass from the fast mirror;
- a final diff review finds no critical architecture, security, performance, accessibility, or correctness issue.
