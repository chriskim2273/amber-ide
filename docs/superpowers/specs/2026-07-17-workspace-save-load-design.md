# Workspace Save/Load Design (2026-07-17)

Status: approved (user), implementing

Manually save workspaces to a portable file and load them back — structure
AND scrollback. User choices (settled): save captures structure + scrollback;
load asks new-workspace vs replace-current each time; native OS file dialogs
(no managed dir); save button asks current-workspace vs all-workspaces.

## File format — `.amberws` JSON, versioned

```json
{
  "version": 1,
  "scope": "one" | "all",
  "workspaces": [{
    "label": "optional string",
    "tabOrder": [1, 2],
    "tabs": [{
      "tab": 1,
      "label": "optional string",
      "tree": <layout Node JSON with leaf paneId placeholders>,
      "panes": [{
        "id": "p0",            // placeholder referenced by tree leaves
        "kind": "shell" | "claude",
        "cwd": "/abs/path",
        "ord": 0,
        "frozenNote": "optional string (presence = frozen)",
        "scrollback": "base64"
      }]
    }]
  }]
}
```

- Tree leaf `paneId`s are file-local placeholders (`p0`, `p1`…), NOT session
  names — names are minted fresh on load. Serializer rewrites the live tree's
  session-name leaves to placeholders; loader rewrites placeholders to the
  newly minted names.
- Parse is versioned + shape-guarded (parseFrozen precedent): wrong version →
  clear error; malformed fields dropped or rejected without throwing in render.
- Excluded deliberately: fontSize (global display pref), session ids/claude
  resume ids (dead on load), process state.

## Daemon addition (only new protocol surface)

- `ControlMsg::DumpBacklog { name }` (client→daemon): reply
  `ControlMsg::Backlog { name, data: Vec<u8> }` with the session ring's full
  contents (same bytes an Attach backlog would replay). Errors (no such
  session) reply `Error`.
- The reply MUST NOT be written inline on the connection read thread (backlog
  HOL lesson): it rides the same forwarder mechanism the Attach backlog uses.
- No chunking: ring cap (≤2 MiB) ≪ frame cap (64 MiB, proto.rs). One frame.
- No watcher-path changes. `PtySession` stays `Send + Sync`.

## Save flow (renderer → main)

1. Toolbar 💾 button → in-app mini-dialog: "This workspace" / "All workspaces".
2. App sends `DumpBacklog` per target pane over the existing multiplexed
   socket; client router correlates `Backlog { name }` replies to pending dump
   requests (name-keyed, timeout ~5s per pane → save proceeds with empty
   scrollback for stragglers, surfaced in a banner).
3. Pure assembler builds the JSON from: live session list (kind/cwd/ord/
   grouping from names), sidecar (labels, tabOrder, tree, frozen), dumps.
4. New IPC `workspace-save-file`: main opens native save dialog (default name
   `<ws-label-or-number>.amberws`), atomic-writes the JSON.

## Load flow (renderer ← main)

1. Toolbar 📂 button → IPC `workspace-open-file`: native open dialog, read,
   return text. Renderer parses + validates.
2. In-app dialog: "Load as new workspace(s)" / "Replace current workspace"
   (replace path shows a confirm naming the pane count that will be killed).
3. New: allocate next free ws numbers; Replace: `killSession` every pane in
   the current ws first (one-way — removal lands via daemon events), reuse its
   ws number.
4. Loader builds a pending-load plan (pure, tested): per pane a minted session
   name + createSession args, plus keyed-by-name sidecar entries (tree with
   real names, labels, tabOrder, frozen) and scrollback bytes.
5. `createSession` per pane; as daemon Sessions events confirm, sidecar
   entries are committed and each new Pane replays its saved scrollback into
   xterm ONCE at mount (ref-map handoff like searchApis — never a prop churn;
   fresh sessions have empty daemon backlog so replay precedes live output).
6. Claude panes spawn fresh claude (no resume); replayed history sits under
   the TUI's alt screen. Accepted.

## UI

Two ghost icon buttons in the toolbar workspace strip (💾 save, 📂 load),
aria-labeled; dialogs are small in-app overlays (help-overlay pattern).
Failures (dialog cancel → no-op; parse error / dump timeout → dismissible
error banner text).

## Testing

- Pure (TDD): file serialize/parse round-trip + tolerance + placeholder
  rewrite both directions; save assembler; load-plan builder; proto round-trip
  (Rust + proto.ts shape).
- Integration (Rust): create session, write output, DumpBacklog → Backlog
  bytes match ring; no-such-session → Error; reply not on read thread
  (assert daemon state / use the backlog_hol.rs style).
- UI wiring: typecheck + existing gates (renderer component tests remain
  deferred project-wide).
