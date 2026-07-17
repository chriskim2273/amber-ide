# Design: Draggable panels + claude ^C falls to shell

Date: 2026-07-14
Status: **shipped / implemented** (see CLAUDE.md build status — UX pass 2026-07-14)

Two independent changes:

1. **Draggable panels** — drag a whole pane onto another pane to re-place it in
   the split layout (renderer only).
2. **Claude ^C → shell** — exiting `claude` (Ctrl-C / Ctrl-D / clean quit) drops
   the pane to a plain shell instead of closing it (daemon only).

They share no code (TypeScript renderer vs Rust daemon) and land as two
separate commits.

---

## Task 2 — claude exit falls to shell

### Problem

`crates/amber/src/supervisor.rs::run_session` early-returns `Ok(())` on
`SuperviseOutcome::CleanExit`. That exits the `amber run <name>` process, whose
pty is the pane, so the pane closes. Ctrl-C'ing out of `claude` therefore kills
the pane. Desired: the pane becomes a plain login shell; exiting *that* shell
closes the pane normally.

### Behavior

- A **user quit** of claude — clean exit (code 0), exit **code 130** (claude
  catches ^C in raw mode with ISIG off, so it exits normally by the shell "^C"
  convention rather than dying by signal), **or** death by SIGINT — must NOT
  retry and must fall through to `shell_fallback`. All three are covered so the
  fix is correct regardless of which one ^C actually produces.
- A **genuine crash** — other non-zero exit, other signals, or launch failure —
  keeps the existing bounded 3-attempt resume ladder, then falls to shell when
  exhausted (unchanged).
- After either path the pane runs `exec $SHELL -l` in the recorded cwd. Typing
  `exit` there ends `amber run` and the pane closes normally (spec §7 lifecycle).

This is robust to whatever exit status Ctrl-C actually produces: both 0 and
SIGINT route straight to the shell, so we never relaunch claude on a user quit.

### Changes (`supervisor.rs`)

- `RunClass`: add a `UserInterrupt` variant for a ^C quit — death by signal
  `SIGINT` (2) or a normal exit with code `130` — distinct from generic
  `Signaled`/`Nonzero`.
- `classify_run`: return `UserInterrupt` for SIGINT-signal death and for exit
  code 130; other signals → `Signaled`, other non-zero → `Nonzero`.
- Add `RunClass::is_user_quit(self) -> bool` = `Success | UserInterrupt`.
- `supervise_claude` loop: `if class.is_user_quit() { return Ok(CleanExit) }`
  (replaces `if class.is_success()`). Everything else counts against the retry
  budget as today.
- `run_session`: remove the `CleanExit => return Ok(())` early return. Both
  `CleanExit` and `Exhausted` fall through to `shell_fallback(&cwd)`; keep the
  "exhausted retries … falling back to shell" warning only on `Exhausted`.

### Tests (`supervisor.rs` unit tests)

- `classify_run` on a SIGINT wait-status (`ExitStatus::from_raw(2)`) →
  `UserInterrupt`; on a code-130 exit (`from_raw(130 << 8)`) → `UserInterrupt`.
- `classify_run` on another signal (e.g. 9) → `Signaled` (unchanged).
- `is_user_quit` true for `Success` and `UserInterrupt`, false otherwise.
- Existing classify/select_start/retry/backoff tests stay green.

`run_session` itself `exec`s a real shell and stays out of unit tests, as today.

### Docs to update

- `CLAUDE.md` §7 wording and the build-status line that say claude "falls back
  to a shell after bounded retries" — now also on user quit.
- Spec §6.2 in `docs/superpowers/specs/2026-07-12-amber-session-daemon-design.md`
  if it states the same.

---

## Task 1 — draggable panels

Split *dividers* already drag to resize (`SplitView.startDrag`). This adds
dragging a whole pane to a new position in the tree.

### Interaction

- Each pane's existing control strip (top-right: ⬌ ⬍ ×) gains a **grip** handle
  (`⠿`). Drag starts only from the grip — never the terminal body, which xterm
  needs for selection and pty mouse-reporting.
- While dragging, the cursor is hit-tested against the live `paneRects` to find
  the target pane and which **zone** it is over:
  - left / right third (horizontal) or top / bottom third (vertical) → edge zone,
  - center → swap zone.
- A highlight overlay marks the target zone (`pointerEvents: 'none'`, zIndex
  above the dividers). On mouseup the move is applied; dropping on the source
  pane or outside any pane is a no-op.

Mirrors the divider drag exactly: `onMouseDown` on the grip sets drag state and
attaches window-level `mousemove`/`mouseup`; no per-terminal event wiring.

### Layout op (`app/src/renderer/layout.ts`)

```
type Zone = 'left' | 'right' | 'top' | 'bottom' | 'center'
moveLeaf(tree: Node, sourceId: string, targetId: string, zone: Zone): Node
```

- `sourceId === targetId` → return `tree` unchanged.
- `center` → swap the two leaves' `paneId`s. Tree shape is invariant.
- edge → `removeLeaf(tree, sourceId)`, then find the `targetId` leaf (by paneId,
  so the path shift from removal is irrelevant) and replace it with a split:
  - `left`/`right` → `dir:'h'`; `top`/`bottom` → `dir:'v'`; `ratio: 0.5`.
  - source on the near side: `left`/`top` → `a:source, b:target`;
    `right`/`bottom` → `a:target, b:source`.
- The **set of leaves is invariant** across every move, so `reconcile` remains a
  no-op afterward and will not fight the persist effect in `main.tsx`.

### UI (`app/src/renderer/SplitView.tsx`)

- Add `onMove(sourceId, targetId, zone)` to props.
- Add the grip button; `startPaneDrag(paneId)` sets `dragSource` and window
  listeners; mousemove computes hover target+zone from `paneRects`; render the
  zone overlay; mouseup calls `onMove` and clears.
- Wrap `Pane` in `React.memo` so drag-hover re-renders of `SplitView` do not
  reconcile every terminal (honors "xterm outside React reconciliation").

### Wiring (`app/src/renderer/main.tsx`)

- Pass `onMove={(s, t, z) => putTree(moveLeaf(tree, s, t, z))}`. Persistence
  flows through the existing debounced `saveLayout` effect — no new IO.

### Tests (`app/src/renderer/layout.test.ts`)

- drop-on-self → identical tree.
- center → paneIds swapped, structure unchanged.
- each edge zone → correct split dir + source/target side, searched by paneId.
- leaf set unchanged by every move (so `reconcile` is a no-op).

Drag UI (grip, overlay, hit-testing) is verified manually in the running app —
consistent with the deferred renderer-component tests noted in `CLAUDE.md`.

---

## Out of scope

Dragging panes across tabs or workspaces; tear-off windows; touch drag;
animated transitions. Zones are fixed thirds; no configurable drop targets.
