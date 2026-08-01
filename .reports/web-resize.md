# Web resize — reversing the "browser can never resize a pty" rule

**Status:** done. Gates green, live-verified.

**Commit:** `78d488c254b98df18cc809a573795bf80f901d7` (branch `feat/web-resize`)

## Summary

Reversed the deliberate design constraint from
`docs/superpowers/specs/2026-08-01-amber-ide-as-a-webapp-design.md` §4 ("the
browser can never resize a pty") on the user's explicit decision, and deleted
the workaround it forced (`.reports/fix-geometry.md`'s `fitFont` font-shrink
mechanism). The web build now takes the exact same `FitAddon` path as
Electron: `Pane.tsx` needed **zero** web-specific branching once the
workaround was removed — a diff against the commit immediately before the
workaround landed (`84aeade`, i.e. before `07f668f`/`4359243`/`a9cf01c`) shows
`app/src/renderer/Pane.tsx` is now **byte-identical** to that pre-workaround
version.

## Changes

- **`app/src/renderer/Pane.tsx`** — deleted `MIN_FONT_SIZE`, `serverGeomRef`,
  `fitFontRef`, the `fitFont`/`applyServerGeom` functions, all
  `serverGeomRef.current ? ... : ...` branches (mount, port-wire, reconnect
  nudge, tab-reactivate, font-size-change effects), the `m.geom` handling in
  the port message handler, and the flex/`safe center`/`overflow:hidden`
  letterboxing container styles. `ResizeObserver` observes `host` again
  (unconditionally, matching Electron).
- **`app/src/web/amber.ts`** — deleted `findSessionGeom`, `PaneLink.lastGeom`,
  and the `sessions`-push geom-forwarding branch. `PaneLink` now forwards
  `Pane.tsx`'s `{resize:{cols,rows}}` port message as a `{"t":"resize",...}`
  JSON send on the pane's own socket, debounced 300 ms (`RESIZE_DEBOUNCE_MS`,
  a new timer field cleared in `close()`) — matches `main.tsx`'s existing
  layout-write debounce policy ("only the settled value matters"), reused
  rather than inventing a second number, so a divider drag collapses to one
  network resize per pane instead of one per animation frame.
- **`crates/amber/src/web.rs`** — new `BrowserMsg::Resize { name, cols, rows }`,
  parsed by `parse_browser_msg`'s new `"resize"` arm (rejects non-numeric or
  out-of-`u16`-range cols/rows at parse time, not just at the bounds gate).
  `map_browser_msg`'s new `Resize` arm constructs `ControlMsg::Resize` only
  when the session is live AND cols/rows are within
  `RESIZE_MIN_COLS..=RESIZE_MAX_COLS` (10..=1000) /
  `RESIZE_MIN_ROWS..=RESIZE_MAX_ROWS` (4..=300) — same "every arm constructs
  from validated parts" discipline as every other arm. Module doc, the
  browser⇄server protocol comment block, and `handle_browser`'s exhaustive
  `open`-tracking match were all updated.
- **Tests, converted not deleted** (per instruction): the Rust
  `is_forbidden`/exhaustive-whitelist tests now assert `Resize` is reachable
  but only within bounds (new
  `map_browser_msg_resize_validates_session_and_bounds` test: live+in-bounds
  passes through unchanged, dead session empty, below-floor/above-ceiling
  empty, exact floor/ceiling accepted), while `Snapshot`/`ReportRunState` stay
  categorically unreachable (renamed
  `snapshot_and_reportrunstate_remain_unreachable`). The integration test
  `a_forged_resize_from_the_browser_never_reaches_the_pty` became two tests:
  `a_valid_browser_resize_reaches_the_pty_within_bounds` (asserts the pty's
  cols/rows actually change) and `an_out_of_bounds_browser_resize_is_rejected`
  (cols=1,rows=1 — asserts unchanged, session still alive). TypeScript:
  `amber.test.ts`'s "never sends a resize" test became three (forwards +
  debounces, collapses a burst into one settled send, a pending debounce is
  dropped on `close()`); the five geom-specific `PaneLink` tests were deleted
  (the mechanism they tested no longer exists) — the pre-existing "ignores
  broadcast-class messages" test already covers `sessions` pushes having zero
  effect on a pane, which is now even more true.
- **Docs**: spec §4 rewritten (was: "Resize remains unreachable... one place
  the shim must deliberately diverge" — duplicated twice in the file, a
  pre-existing glitch, now a single corrected paragraph); §9 testing section
  updated to match. `CLAUDE.md` build-status gained a new dated entry, and a
  now-stale "still never reaches Resize" claim inside the older "Remote
  mosaic" entry (a different, still-true feature for the hand-written mobile
  UI's own whitelist) was annotated as superseded rather than left
  contradicting.

## Bounds chosen and why

`RESIZE_MIN_COLS = 10`, `RESIZE_MIN_ROWS = 4`, `RESIZE_MAX_COLS = 1000`,
`RESIZE_MAX_ROWS = 300`.

- **Floor (10×4):** the failure mode named in the task is a browser window
  crushed to nothing (minimized, a backgrounded/`display:none` tab, a
  mid-layout transient) sending something degenerate. `Pane.tsx`'s FitAddon
  itself floors at 2×1 cols/rows for a truly collapsed container — and
  Electron's own `sendResize` deliberately treats that as "not real" and skips
  sending it at all. 10×4 sits comfortably above that degenerate floor (a 1×1
  or 2×1 pty SIGWINCHes every full-screen program — the desktop's claude TUI
  included — into repainting garbage) while staying well below any real
  split: the layout's own minimum ratio is 0.05, which on a normal viewport
  still leaves far more than 10 columns / 4 rows, so no legitimate narrow
  split is ever rejected.
- **Ceiling (1000×300):** far beyond any real display (a 1000-column terminal
  is wider than any physical monitor renders at a legible font), so it only
  rejects a broken or hostile client, never a legitimate huge monitor.

Both bounds are enforced as a hard reject (empty result from
`map_browser_msg`), not a clamp — an out-of-bounds request is dropped, never
silently coerced into a different, possibly still-wrong size.

## Gates

- `cargo test --workspace` — 315 passed.
- `cargo clippy --workspace --all-targets -- -D warnings` — clean.
- `cd app && npm run typecheck` — clean.
- `npm test` — 449 passed, 1 pre-existing skip (`test/realDaemon.test.ts`,
  unrelated).
- `npm run build:web` — builds clean (same pre-existing >500 KB chunk
  warning, unrelated).

## Live verification

Isolated private daemon + `amber web` at `/tmp/wrz-state` / socket
`/tmp/wrz.sock`, port 7799 (never the user's real daemon/`amber web --port
7717`, confirmed alive with all 17 sessions before and after via `amber ls`).
Three shell sessions, hand-written `ui-layout.json` sidecar: root `dir:"h"
ratio:0.28` (narrow pane A vs. the rest), nested `dir:"v" ratio:0.22` splitting
the remainder into a short pane B (top) and a tall pane C (bottom). Pane B's
pty was forced to a tall 80×58 grid via a real controlling pty
(`pty.fork()` + `TIOCSWINSZ` ioctl + `SIGWINCH`, driving a real `amber
attach`) — reproducing the reported case: a tall pty crammed into a short
pane box. Verified in a real browser at 1400×900 (Playwright).

**Before → after** (measured live):

| Pane | pane box (px) | pty cols×rows before | pty cols×rows after | `.xterm-screen` box after | font after |
|---|---|---|---|---|---|
| A (narrow, tall) | 390×792 | 80×24 (default) | **48×44** | 376×792 (fits, ~96% width used) | 13px |
| B (wide, short — forced tall pty) | 1006×152 | **80×58** (tall grid in a short box — the reported bug shape) | **126×8** | 986×144 (fits inside 152 box, no overflow) | 13px |
| C (wide, tall) | 1006×612 | 80×24 (default) | **126×34** | 986×612 (fits, ~98% width used) | 13px |

- Every `.xterm-screen` fits its container on **both axes** — no bottom
  overflow anywhere (pane B in particular: an 80×58 grid that would have
  rendered ~638px tall in a 152px box now renders 144px tall because the pty
  itself was reshaped to 8 rows).
- Width used is ~96–98% of the container in every pane, not ~75%.
- Font stayed at **13px** (the app's `DEFAULT_FONT_SIZE`) in all three panes —
  confirmed via `getComputedStyle(.xterm-rows).fontSize`, never shrunk.
- `/api/sessions` confirmed the daemon's real pty geometry changed to match:
  `{aaaaaa: 48×44, bbbbbb: 126×8, cccccc: 126×34}`.
- Keystroke routing after the resize: typed `echo WEBRESIZE_MARKER_42` into
  pane B; the marker appeared only in pane B's terminal (`WEBRESIZE_MARKER_42`
  echoed cleanly, no garbling), panes A and C untouched.
- Console: zero errors other than a benign `favicon.ico` 404 (notably: no
  `resolvePath` errors, no exceptions from the deleted code paths).
- Cleaned up: killed the private daemon (pid) and `amber web --port 7799`
  (pid), removed `/tmp/wrz-state` and `/tmp/wrz.sock`. Confirmed via
  `amber ls` against the real daemon afterward: 17 sessions, all listed,
  untouched throughout.

## Concerns

- The out-of-bounds rejection path (`cols:1,rows:1` etc.) is covered by the
  Rust unit/integration tests but was not separately re-verified against the
  live browser in this pass (no reason to expect a different result than the
  automated `an_out_of_bounds_browser_resize_is_rejected` test, which drives
  the identical code path over a real WebSocket).
- Bundle size warning (`main-*.js` > 500 KB) is pre-existing and unrelated.
- The hand-written mobile UI (`assets/app.js`, spec
  `2026-07-19-amber-web-mobile-design.md`) still never sends a resize of its
  own — untouched, out of scope. The protocol-level capability is now shared
  infrastructure, but only the new React-renderer web build exercises it.
