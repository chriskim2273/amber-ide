# Mobile UX (Phase B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [x]`) syntax.

**Goal:** Make the hosted IDE — above all an *agent* session (claude/codex/grok) — usable and correct on a phone.

**Architecture:** Host-agnostic changes inside `app/src/renderer/` (spec §0.1's amended rule): a capability hook (`pointer: coarse` + width), a `@media` sizing layer, pointer-events instead of mouse-events, and mobile-only chrome components. Plus one Rust change: `Hub` tracks a borrowed pty grid so a phone can reflow an agent pane and hand the grid back when it leaves.

**Tech Stack:** TypeScript strict, React, xterm.js, vitest; Rust (`crates/amber/src/web.rs`) for the borrow bookkeeping.

**Spec:** `docs/superpowers/specs/2026-08-22-mobile-web-experience-design.md` §1–§8.

**Status: implemented** (2026-08-22/23). Report: `.reports/mobile-ux.md`;
column measurement: `.reports/mobile-agent-cols.md`. Task 9's device pass did
NOT happen — emulation only — and the report says which rules that leaves
untested.

## Global Constraints

- **Capability-gated, never host-gated.** No file under `app/src/renderer/` may import from `app/src/web/`, read a web-only global, or test for Electron. Mobile behaviour keys off viewport size + pointer coarseness, so a touch laptop gets it too.
- `Pane.tsx` takes exactly ONE capability-gated change (the soft-keyboard row pinning, §3) and no other.
- The deleted `fitFont`/`serverGeomRef`/letterboxing machinery does **not** return. Font-size pinch reflows; it does not letterbox.
- No new npm dependency.
- Rust: no daemon change, no new browser message reaching `Create`/`Kill`/`Snapshot`/`ReportRunState`.
- Gates: `cargo test --workspace` + `cargo clippy --workspace --all-targets -- -D warnings`; `npm run typecheck`, `npx vitest run`, `npm run build`, `npm run build:web`.

---

### Task 1: `useMobile` — capability detection

**Files:** Create `app/src/renderer/mobile.ts`, `app/src/renderer/mobile.test.ts`; modify `app/src/renderer/main.tsx`.

**Produces:**
- `isMobileViewport(width: number, coarsePointer: boolean): boolean`
- `useMobile(): boolean` — subscribes to `resize`/`orientationchange` + the `(pointer: coarse)` media query.
- `MOBILE_MAX_WIDTH = 820`

- [x] **Step 1: failing test** — `isMobileViewport(390, true) === true`; `(390, false) === false` (a narrow desktop window is not a phone); `(1200, true) === false` (a large touchscreen is not a phone); boundary `(820, true) === true`, `(821, true) === false`.
- [x] **Step 2:** run `npx vitest run src/renderer/mobile.test.ts` → FAIL (module missing).
- [x] **Step 3:** implement both; `useMobile` reads `window.matchMedia('(pointer: coarse)')` and `window.innerWidth`.
- [x] **Step 4:** tests PASS.
- [x] **Step 5:** `@media (pointer: coarse)` block in `theme.css`: `.btn`/`.icon-btn`/`.ws-pill`/`.tab` min-height 44px, chrome font 13–14px.
- [x] **Step 6:** commit `feat(mobile): capability detection and touch sizing`.

---

### Task 2: `touchInput.ts` — key bytes and scroll math (pure)

**Files:** Create `app/src/renderer/touchInput.ts`, `app/src/renderer/touchInput.test.ts`.

Ported from `crates/amber/assets/app.js:600-720`, which is proven on a real phone. Do not re-derive.

**Produces:**
- `arrowSeq(dir: 'up'|'down'|'left'|'right', appMode: boolean): string`
- `keyBytes(key: string, appMode: boolean, ctrl: boolean): string`
- `KEY_BAR: { key: string; label: string }[]`
- `flickStep(velocity: number): number`

- [x] **Step 1: failing test**
  - `arrowSeq('up', false) === '\x1b[A'`, `arrowSeq('up', true) === '\x1bOA'` — application cursor mode is what a TUI actually sets; getting it wrong sends literal junk into claude's prompt.
  - `keyBytes('esc', false, false) === '\x1b'`, `keyBytes('tab', …) === '\t'`, `keyBytes('shift-tab', …) === '\x1b[Z'` (claude's mode cycle — non-negotiable), `keyBytes('enter', …) === '\r'`, `keyBytes('c', false, true) === '\x03'` (sticky Ctrl), `keyBytes('slash', …) === '/'`.
  - `KEY_BAR` contains `esc`, `tab`, `shift-tab`, `ctrl`, four arrows, `enter`, `slash`.
- [x] **Step 2:** FAIL.
- [x] **Step 3:** implement.
- [x] **Step 4:** PASS.
- [x] **Step 5:** commit `feat(mobile): key-bar byte sequences ported from the phone UI`.

---

### Task 3: `KeyBar.tsx` + touch scrolling in the terminal

**Files:** Create `app/src/renderer/KeyBar.tsx`; modify `app/src/renderer/Pane.tsx` (touch handlers + the §3 row pinning), `app/src/renderer/SplitView.tsx` (render the bar under a focused pane on mobile), `theme.css`.

- [x] **Step 1:** `KeyBar` renders `KEY_BAR` as ≥44px buttons; sticky Ctrl is component state; `onMouseDown={e => e.preventDefault()}` so a tap never blurs xterm's textarea (that closes the phone keyboard between keys — `app.js:626`).
- [x] **Step 2:** Pane gains `onKeyBytes` → existing `onData` path. No new transport.
- [x] **Step 3:** touch scrolling in `Pane.tsx`, gated on `pointer: coarse`:
  - one-finger vertical drag, axis locked after 6px;
  - normal screen → `term.scrollLines(n)`;
  - **alt screen → arrow keys** (`term.buffer.active.type === 'alternate'`), capped at 24 per gesture;
  - flick momentum with `FLICK_DECAY = 0.94`;
  - horizontal drags untouched (they pan a scaled pane);
  - two-finger untouched (pinch).
- [x] **Step 4:** soft keyboard: `visualViewport` resize does **not** re-fit the pty. Rows stay pinned; the terminal viewport translates so the cursor row clears the keyboard. Only orientation change / zoom transition re-fits.
- [x] **Step 5:** gates; commit `feat(mobile): on-screen key bar and terminal touch scrolling`.

---

### Task 4: Pointer events for every drag

**Files:** modify `app/src/renderer/SplitView.tsx` (`:383` outside-click, `:527` divider, `:601` grip).

- [x] **Step 1:** convert `mousedown`/`mousemove`/`mouseup` → `pointerdown`/`pointermove`/`pointerup` + `setPointerCapture`. Desktop behaviour is identical (mice fire pointer events).
- [x] **Step 2:** on touch, a drag arms only after a **400 ms long-press**; before that a move scrolls. Escape / a second pointer cancels, matching today's Escape-aborts.
- [x] **Step 3:** gates; commit `feat(mobile): pointer-event drags with long-press arming`.

---

### Task 5: Mosaic, drawer, sheets

**Files:** create `app/src/renderer/Sheet.tsx`; modify `SplitView.tsx`, `main.tsx`, `theme.css`.

- [x] **Step 1:** on mobile a tap on a pane tile sets the **existing** zoom state (`zoomedPane`, keyed `ws:tab`). No new layout state.
- [x] **Step 2:** zoom pushes `history.pushState`; `popstate` un-zooms. Popping the last entry must not exit the app.
- [x] **Step 3:** toolbar collapses to `ws · tab · ☰`; the drawer is a `Sheet` listing workspaces and tabs with the existing activity/run-state dots.
- [x] **Step 4:** long-press on a pane header/tile opens a `Sheet` reusing the existing context-menu state (split picker, kill, freeze, rename, copy cwd, move to tab, grid override).
- [x] **Step 5:** gates; commit `feat(mobile): tap-to-zoom mosaic, drawer and long-press sheets`.

---

### Task 6: Grid borrowing (Rust + shim)

**Files:** modify `crates/amber/src/web.rs`; `app/src/web/amber.ts`.

**Produces:** `HubInner.borrows: HashMap<String, Borrow>`, `struct Borrow { client: u64, prior: (u16, u16), set: (u16, u16) }`.

- [x] **Step 1: failing tests** in `web.rs`:
  - `prior` is captured in the **`Open`** handler, never on `Resize` (spec §2.2.1 — capturing on `Resize` can record the phone's own grid, since `HubInner::sessions` refreshes on a 1 s poll while `PaneLink` debounces at 300 ms);
  - release restores `prior`;
  - release is **suppressed** when the current grid no longer equals `set` (the desktop re-fit; last writer wins);
  - a borrow is released on socket close and on `open` change;
  - a vanished session drops its borrow silently.
- [x] **Step 2:** FAIL.
- [x] **Step 3:** implement, plus a `{"t":"release"}` browser message that maps to no daemon control message of its own — it only triggers the Hub's own restore `Resize` through the existing validated construction.
- [x] **Step 4:** PASS; assert `Snapshot`/`ReportRunState` remain unreachable.
- [x] **Step 5:** shim sends `release` on un-zoom, `visibilitychange:hidden` and `pagehide`.
- [x] **Step 6:** gates; commit `feat(web): borrow a pty grid for a phone and hand it back`.

---

### Task 7: Agent column measurement

**Files:** create `.reports/mobile-agent-cols.md`.

- [x] **Step 1:** run each installed agent in a pty at 40, 46 and 54 columns; capture output.
- [x] **Step 2:** record which are usable and fix the mobile default font size from that, per spec §2.5 (the spec deliberately leaves the number unset until measured).
- [x] **Step 3:** commit the report and the chosen default.

---

### Task 8: PWA, safe areas, copy/paste

**Files:** modify `app/src/web/index.html`, `crates/amber/src/web.rs` (serve the manifest), `theme.css`, `Pane.tsx`/`Sheet.tsx`.

- [x] **Step 1:** `manifest.webmanifest` + `apple-mobile-web-app-capable`, icons from `app/build/icon.png`; served as an embedded asset. **No service worker** (deliberate: the app is useless without a live socket, and SW cache invalidation across redeploys is a footgun).
- [x] **Step 2:** `viewport-fit=cover` + `env(safe-area-inset-*)` on the top bar, key bar and sheets.
- [x] **Step 3:** long-press in the terminal opens a selection sheet (select word/line/all, copy, paste) driven by `term.select()`; copy via `navigator.clipboard.writeText` with a hidden-textarea fallback on plain http; paste through `term.paste()`.
- [x] **Step 4:** gates; commit `feat(mobile): installable PWA, safe areas and touch copy/paste`.

---

### Task 9: Verification

- [x] CDP at a 390x844 phone viewport with touch emulation, against a private daemon + private `amber web`: mobile chrome swaps in on capability alone, all eleven key-bar keys at 44px, manifest + icon served, and **tile 80x24 -> zoomed 44x41 -> un-zoomed 80x24**.
- [x] Write `.reports/mobile-ux.md`; add the CLAUDE.md build-status entry.
- [ ] **NOT DONE — a real device on either platform.** Emulation gives touch events and a coarse pointer, not a soft keyboard: §3's rule (opening the keyboard must not re-fit the pty) is implemented and unit-tested but has never actually run. Long-press drag arming, real-finger touch scrolling with momentum, clipboard gestures and PWA install are likewise unexercised.
- [ ] **NOT DONE — a Pixel-sized profile.** Only the 390x844 iPhone-class viewport was driven.
