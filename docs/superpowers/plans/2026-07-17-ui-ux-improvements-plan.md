# UI/UX Improvement Pass — Implementation Plan (2026-07-17)

Status: executing (subagent-driven development)

Fifteen approved UX proposals, grouped into 9 tasks. App code: `app/` (Electron,
TS strict, React chrome + xterm.js). Daemon: `crates/` (Rust).

## Global Constraints (bind every task)

- **Core rules from CLAUDE.md are law.** Especially: one-way data flow (user
  gesture → socket control message; only daemon events mutate pane-existence
  state — never optimistically create/destroy/rename locally); xterm instances
  live outside React reconciliation (imperative writes via refs; never a React
  state update per output chunk); split geometry + app-level labels are the only
  app-owned persisted bits (sidecar JSON via `layoutFile.ts`, atomic IO);
  grouping must survive a missing sidecar.
- TypeScript strict; no new runtime deps except where a task names one.
- TDD for pure logic (layout, layoutFile, keys, store, Rust proto/manager):
  failing test first. UI wiring (JSX/CSS) needs no component tests (deferred
  project-wide), but must typecheck and not break existing tests.
- Verification gates per task: `cd app && npm run typecheck && npx vitest run`
  (app tasks); `cargo test --workspace && cargo clippy --workspace --all-targets`
  (Rust tasks; clippy must stay warning-free).
- Styling: tokens in `app/src/renderer/theme.css` (`:root` CSS custom
  properties); components carry classes, not inline hex. Single dark theme —
  do NOT add theming/settings UI (out of scope by constitution).
- Keyboard chords follow the existing platform split in
  `app/src/renderer/keys.ts`: macOS = bare Cmd, Linux/other = Ctrl+Shift.
  All new chords must be vetoed from the pty exactly like existing ones
  (`Pane.tsx` `attachCustomKeyEventHandler` calls `appChord`).
- Conventional commits, concise, NO `Co-Authored-By` lines. One or more commits
  per task, each compiling.
- Do not touch files outside the task's named scope without reporting why.

## Task 1: Empty/loading states + actionable dead overlay

Scope: `app/src/renderer/main.tsx`, `app/src/renderer/SplitView.tsx`,
`app/src/renderer/theme.css`.

1. **`+ Pane` always available.** Today the toolbar `+ Pane` button renders only
   when a `tab` exists (`main.tsx` `{tab && <button …>+ Pane</button>}`), yet the
   empty state says "press + Pane". Render it unconditionally: when no tab
   exists, clicking creates the first session in the displayed workspace at
   tab 1, ord 0 (use existing `newPane`-style `createSession` with
   `formatName({ ws: currentWs, tab: 1, ord: 0, id: makeId() })`, then
   `setActiveTab(1)`).
2. **Empty state is a button.** Replace the `<p className="empty-hint">` with a
   centered clickable card (`<button class="empty-cta">`): primary line
   "Start a pane", secondary line showing the platform chord for new-pane (reuse
   the platform branch from `keys.ts` — export a small helper like
   `chordLabel(action)` from `keys.ts` if useful, unit-tested). Clicking it
   creates a pane exactly like `+ Pane`.
3. **Loading ≠ empty.** Add renderer state tracking whether the first `Sessions`
   event has arrived (e.g. `sawSessions`, set when a `Sessions` event is
   dispatched). Until (`loaded && sawSessions`), the pane stage shows a quiet
   "connecting to daemon…" placeholder (class `stage-loading`, muted text,
   no spinner dependency) instead of the empty CTA. The disconnect banner
   behavior is unchanged.
4. **Dead overlay actionable.** In `SplitView.tsx`'s dead overlay, replace the
   static "session ended — close to remove" hint with a real button
   ("close pane", class `dead-close`) that calls `props.onClose(paneId)`.
   Keep the exit-code badge as is.

Style all new elements with existing tokens. No new deps.

## Task 2: Keyboard pane navigation, shortcut cheatsheet, a11y pass

Scope: `app/src/renderer/keys.ts` (+ its test), `app/src/renderer/SplitView.tsx`,
`app/src/renderer/main.tsx`, `app/src/renderer/theme.css`.

1. **Directional focus.** New chords `focus-left|right|up|down` =
   Cmd/Ctrl+Shift+Arrow (platform split as existing). Unit-test in
   `keys.test.ts` both platforms. Handle in `SplitView` (it owns `focused` +
   `paneRects`): from the focused pane's rect center, move focus to the nearest
   pane whose center lies in that direction (primary-axis distance first,
   tie-break by secondary-axis distance); no-op at an edge. After deciding,
   focus the target pane's xterm: dispatch focus by calling `.focus()` on the
   pane container's contained textarea — acceptable approach: keep a
   `Map<paneId, HTMLElement>` of pane body elements via ref callback and call
   `element.querySelector('textarea')?.focus()`; `focusin` bubbling then updates
   `focused` via the existing handler. Extract the pure "pick next pane in
   direction from rect list" function into `layout.ts` (or a new small module)
   and unit-test it.
2. **Cheatsheet overlay.** New chord `help` = Cmd/Ctrl+Shift+/ plus a `?`
   icon button at the toolbar's right edge. Renders a modal overlay (class
   `help-overlay`) listing every chord with its platform-correct label
   (derive from one exported table in `keys.ts` — single source of truth:
   `CHORD_TABLE: Array<{ action, label, keys }>` consumed by both `appChord`
   and the overlay; refactor `appChord` onto the table, keep all existing
   behavior and tests green, add tests for the table lookup). Esc or click
   outside closes. No focus trap needed beyond Esc close (single-window app).
3. **A11y.** `aria-label` on every icon-only button (pane grip/split/close,
   banner dismiss, tab close if present, help button); `role="status"
   aria-live="polite"` on the disconnect banner; visible `:focus-visible`
   outline token (`--focus-ring`) applied to `.btn`, `.icon-btn`, `.tab`,
   `.ws-pill`; pane action cluster must become visible when any of its buttons
   has keyboard focus (`:focus-within` alongside the existing hover/focused
   reveal).

## Task 3: Drag polish (threshold, Escape cancel, tokenized overlay)

Scope: `app/src/renderer/SplitView.tsx`, `app/src/renderer/theme.css`,
`app/src/renderer/Pane.tsx`.

1. **Move threshold.** Pane drag (`startPaneDrag`) currently enters drag state on
   grip mousedown. Only enter visual drag state (setDrag + dimming) after the
   cursor moves ≥4 px from mousedown; a plain click on the grip does nothing.
2. **Escape cancels.** While a pane drag or a divider drag is active, Escape
   aborts it: remove listeners, clear drag state, no `onMove`/ratio change
   beyond those already applied (divider drag applies live — Escape restores the
   ratio captured at drag start; capture it in `startDrag`).
3. **Tokenize overlay + stray hexes.** Replace the drop-zone overlay's inline
   `rgba(80,140,255,.35)` / `rgba(120,170,255,.9)` with theme tokens
   (`--drop-zone-bg`, `--drop-zone-border`) applied via a `.drop-zone` class
   (geometry may stay inline — position is data, color is theme). Replace
   `Pane.tsx`'s hardcoded `#0c0c0f` host background with `var(--bg)` (a class
   is fine). Do NOT touch `XTERM_THEME` (xterm cannot read CSS vars — the
   comment there explains the duplication; leave it).

Pure-logic bits (threshold math is trivial — no test needed); keep existing
tests green.

## Task 4: Tab/workspace rename + tab close/reorder

Scope: `app/src/shared/layoutFile.ts` (+ test), `app/src/renderer/main.tsx`,
`app/src/renderer/theme.css`.

1. **Sidecar labels.** Extend the layout sidecar schema with OPTIONAL fields —
   parse must remain tolerant of old files (missing fields → defaults), and
   old apps reading new files must not crash (additive only):
   - per-workspace `label?: string`
   - per-tab `label?: string`
   - per-workspace `tabOrder?: number[]` (display order of tab ids)
   Unit-test round-trip + old-file tolerance in the existing layoutFile test.
   Labels are app-owned display metadata ONLY — session names / daemon state
   are untouched (daemon Rename stays unsupported; do not call it).
2. **Rename UI.** Double-click a workspace pill or tab → inline `<input>`
   replacing the label (Enter commits to the sidecar via the layout state,
   Escape cancels, blur commits). Display `label ?? String(ws)` /
   `label ?? 'tab ' + tab`. Keep pill/tab click-to-switch working (double-click
   must not double-fire switch weirdly — switching on first click is fine).
3. **Tab close.** Hover ✕ on each tab (aria-label "close tab") and middle-click
   on the tab both close it: request `killSession` for EVERY pane in that tab
   (one-way rule: no local tab removal — the tab disappears when the daemon's
   removal events empty it). If the active tab was closed, selection falls back
   naturally (existing `?? tabs[0]` fallback).
4. **Tab reorder.** Drag a tab horizontally to reorder (HTML5 drag events on the
   tab buttons are fine). Order persists as `tabOrder` in the sidecar; tabs not
   listed in `tabOrder` append in numeric order (reconcile in a pure helper,
   unit-tested — e.g. `orderTabs(ids: number[], order?: number[]): number[]`).

## Task 5: Live pane titles + font-size chords

Scope: `app/src/renderer/Pane.tsx`, `app/src/renderer/SplitView.tsx`,
`app/src/renderer/main.tsx`, `app/src/renderer/keys.ts` (+ test),
`app/src/shared/layoutFile.ts` (+ test).

1. **Live titles.** Wire xterm `term.onTitleChange` in `Pane.tsx` to a new
   optional prop `onTitle?: (title: string) => void`. `Pane` is `memo`-wrapped —
   the prop must be referentially stable (hold the latest callback in a ref
   inside `Pane`, or pass a stable dispatcher from above). Collect titles in
   `main.tsx` state (`Record<sessionName, string>`) and prefer them in
   `paneMeta` titles: `osc title · kind` when a title exists, else the current
   `shortCwd(cwd) · kind`. Cap stored title length (e.g. 120 chars). The
   focused pane's title also becomes the window-ish context: append it to the
   pane header only (no Electron window title changes in this task).
2. **Font-size chords.** New chords `font-bigger` (Cmd/Ctrl+Shift+=),
   `font-smaller` (Cmd/Ctrl+Shift+-), `font-reset` (Cmd/Ctrl+Shift+0); add to
   the chord table + tests. Global font size state in `main.tsx`
   (default 13, clamp 8–32), passed as a `fontSize` prop through `SplitView`
   to every `Pane`; `Pane` applies `term.options.fontSize = fontSize` and
   refits on change (existing FitAddon). Persist as optional top-level
   `fontSize?: number` in the layout sidecar (tolerant parse, round-trip
   tested). Handle the chords in `main.tsx`'s chord dispatcher.

## Task 6: Scrollback search

Scope: `app/package.json` (new dep `@xterm/addon-search`),
`app/src/renderer/Pane.tsx`, `app/src/renderer/SplitView.tsx`,
`app/src/renderer/keys.ts` (+ test), `app/src/renderer/theme.css`.

1. Add `@xterm/addon-search` (version compatible with the project's xterm 5.x;
   check `app/package.json`) and load it per terminal in `Pane.tsx` alongside
   the fit addon.
2. New chord `find` = Cmd/Ctrl+Shift+F (table + tests). When fired, open a find
   bar in the FOCUSED pane (SplitView knows focus; render the bar in that
   pane's chrome, class `find-bar`: text input + next/prev buttons + match
   ordinal if cheaply available + close ✕).
3. Bar behavior: type → incremental `findNext` on input (debounced ~150 ms);
   Enter = next, Shift+Enter = previous, Escape closes and returns focus to the
   terminal. Highlight via the addon's decoration options using theme accent
   tokens. Closing clears decorations.
4. Expose the addon to the chrome without violating the xterm-outside-React
   rule: `Pane` may accept a ref-ish `searchApi` callback prop
   (`onSearchReady?: (api: { findNext(q): boolean; findPrevious(q): boolean;
   clear(): void }) => void`) — stable-prop rules as in Task 5.

## Task 7: Pane zoom + context menu

Scope: `app/src/renderer/SplitView.tsx`, `app/src/renderer/main.tsx`,
`app/src/renderer/keys.ts` (+ test), `app/src/renderer/theme.css`.

1. **Zoom.** New chord `zoom` = Cmd/Ctrl+Shift+M (table + tests; M avoids
   Z=undo collisions) toggles zoom of the focused pane; double-clicking a pane
   header also toggles. Zoomed: that pane's rect becomes the full stage; other
   panes stay MOUNTED but hidden (`display:none` wrapper or zero-opacity +
   `visibility:hidden`; xterm instances must not unmount). Layout tree
   untouched; zoom state is transient renderer state (per tab, e.g.
   `Record<tabKey, paneId>`; NOT persisted to the sidecar). A zoom badge in the
   pane header (class `zoom-badge`, "zoomed — Cmd/Ctrl+Shift+M to restore")
   makes the state legible. Any structural change to the tab's pane set
   (split/close/move) clears that tab's zoom. Splitting/resizing while zoomed
   is not required to work — clearing zoom on those gestures is the required
   behavior.
2. **Context menu.** `onContextMenu` on the pane HEADER ONLY (never the
   terminal body — xterm owns body mouse events): a custom positioned menu
   (class `ctx-menu`) with items: "split right", "split down",
   "new claude pane right" (calls a kind-overriding split — extend
   `onSplit(paneId, dir)` to `onSplit(paneId, dir, kind?: 'shell'|'claude')`
   and thread the optional kind through `main.tsx`'s handler into
   `createSession`, defaulting to the toolbar kind), "zoom/restore",
   "copy cwd" (clipboard write of the pane's cwd — plumb cwd into `PaneMeta`),
   "close". Esc/click-elsewhere dismisses. Position clamped to the stage.

## Task 8: Claude supervision state surfaced end-to-end

Scope (Rust): `crates/amber-core/src/proto.rs` (+ tests),
`crates/amber/src/supervisor.rs`, `crates/amber/src/claude.rs` (only if
needed), `crates/amber/src/daemon.rs`, `crates/amber/src/manager.rs`
(+ tests). Scope (app): `app/src/client` or `app/src/shared/proto.ts`
(decode side), `app/src/renderer/store.ts` (+ test),
`app/src/renderer/main.tsx`, `app/src/renderer/SplitView.tsx`,
`app/src/renderer/theme.css`.

Problem: `amber run` supervises claude and silently drops to a shell on user
quit; the UI keeps showing a claude pane. Surface supervisor phase to clients.

1. **Protocol.** New client→daemon control message
   `ReportRunState { name: String, state: String }` and a new OPTIONAL field on
   `SessionInfo`: `run_state: Option<String>` (serde default `None` — wire
   compat both directions; follow the existing `updated` field's
   serde-default precedent). Allowed states: `"claude"`, `"claude-retrying"`,
   `"shell-fallback"`. Round-trip proto tests for both.
2. **Supervisor reporting.** `amber run` (supervisor) connects to the daemon
   socket (it already knows the socket path conventions; reuse the client
   connect helper) and sends `ReportRunState` at: claude (re)start → `claude`;
   bounded-retry loop → `claude-retrying`; fall-through to shell →
   `shell-fallback`. Fire-and-forget with a short connect timeout: report
   failures must NEVER affect supervision (log to stderr and continue).
   A session pty must never block on this.
3. **Daemon.** Handle `ReportRunState`: validate the session exists and
   `kind == claude` (else reply `Error`), store the state on the session
   (mutex/atomic-guarded — `PtySession` stays `Send + Sync`), include it in
   `SessionInfo`, and notify watchers via the EXISTING non-blocking watcher
   broadcast (bounded queue + forwarder, same path as create/kill — never a
   new blocking write). Persist `run_state` in snapshots as optional (tolerant
   load of old snapshots); on restore, a claude session's state resets to
   `claude` (the supervisor will re-report).
4. **App.** Decode the new field in `proto.ts` (additive, decode-only like
   `updated`); `store.ts` keeps `runState` per session (+ reducer test);
   UI: pane header kind-dot for claude panes reflects state — amber = claude,
   pulsing amber = claude-retrying, gray + title suffix `· shell (claude
   exited)` = shell-fallback; tab kind-dot uses the same downgrade (a tab with
   only fallen-back claude panes shows the gray state). Tooltip (`title`/aria)
   on the dot names the state.
5. Integration test (Rust): fake-stub style like existing daemon tests —
   create claude-kind session, send `ReportRunState`, assert
   `ListSessionsDetailed` reflects it and a watcher receives an update.

Constraints reminder: daemon is source of truth; the report is a daemon-state
mutation flowing back out as events — the app never locally infers state.
Watcher path must remain non-blocking (audit-pass discipline).

## Task 9: Background activity indicators

Scope (Rust): `crates/amber-core/src/proto.rs` (+ tests),
`crates/amber/src/pty.rs` or `daemon.rs` (wherever output fan-out lives),
`crates/amber/src/daemon.rs` (+ integration test). Scope (app):
`app/src/shared/proto.ts`, `app/src/renderer/store.ts` (+ test),
`app/src/renderer/main.tsx`, `app/src/renderer/theme.css`.

1. **Protocol.** New daemon→watcher control message
   `Activity { name: String }`. Proto round-trip test.
2. **Daemon.** On pty output for a session, send `Activity` to WATCHERS
   (the `WatchSessions` registry) rate-limited per session to at most one per
   500 ms (monotonic clock guard on the session; a cheap atomic timestamp —
   never block the pty reader or output fan-out). Delivery rides the existing
   bounded non-blocking watcher queue. No activity events for sessions with
   zero output. Integration test: watched session, write through the pty,
   assert one Activity arrives and a burst does not exceed the rate limit
   (allow timing slack; assert on daemon state/counts, not sleeps, where
   possible).
3. **App.** Decode `Activity`; `store.ts` records `lastActivity` (event
   arrival order — a counter is fine, no wall clock needed) per session and
   `lastSeen` per session set when its tab is active in the UI (reducer action
   from `main.tsx` when the active tab/ws changes or on any activity for the
   visible tab). A NON-active tab whose panes have activity newer than
   `lastSeen` shows an activity dot (class `activity-dot`, small accent dot on
   the tab, distinct from the kind-dot; aria-label "activity"). Switching to
   the tab clears it. Reducer logic unit-tested.
4. UI must not re-render per event beyond the tab bar (activity state lives in
   the reducer; Pane/xterm untouched — rule #5).

## Task 10: Final gates

Run in the worktree root: `cargo test --workspace`,
`cargo clippy --workspace --all-targets` (zero warnings),
`cd app && npm run typecheck && npx vitest run`, and `npm run build` (renderer
bundle builds). Fix anything red. Update `CLAUDE.md` build-status checklist
with one new entry describing this pass (concise, follow the existing style).
