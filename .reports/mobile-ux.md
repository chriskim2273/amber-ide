# Mobile UX (Phase B) — verification report

Spec: `docs/superpowers/specs/2026-08-22-mobile-web-experience-design.md` §1–§8
Plan: `docs/superpowers/plans/2026-08-22-mobile-ux-phase-b.md`

Driven with Chrome DevTools emulation at **390×844, deviceScaleFactor 3,
mobile + touch**, against an isolated daemon and an isolated `amber web` on
port 7921. The user's real daemon, sessions and tailnet config were untouched.

## What works

**Capability detection.** `.app` gains `mobile`, the desktop toolbar and tab row
go `display: none`, and the mobile bar + key bar mount — with **no reload**,
purely from the pointer/width media query flipping.

**Key bar.** All eleven keys render (`esc tab shift-tab ctrl ← ↓ ↑ → enter /
^C`), each a **44px** tap target, `shift-tab` included — claude's mode cycle,
the one key the bar could not ship without.

**Font default.** The terminal is configured at 14px, giving a 44-column grid at
this viewport (see `.reports/mobile-agent-cols.md` for why 14px, measured
against real claude/codex/grok TUIs).

**PWA surface.** `/manifest.webmanifest` serves as `application/manifest+json`
and `/icon.png` as `image/png`, both 200 from the running server.

**Grid borrowing, the whole cycle:**

```
tile:     80x24     <- unzoomed, pty untouched
zoomed:   44x41     <- phone reflows it, readable
unzoomed: 80x24     <- handed straight back
```

## Two real bugs this pass caught

**1. An unzoomed tile reflowed the shared pty to 13 columns.**
A mosaic tile at 390px is ~180px wide, and each pane's `FitAddon` fitted its
pty to the tile. Measured on a live session: **13×41**. A pty's winsize is
shared with the desktop and every other client, so this lands on whoever is
sitting at the desk — an agent TUI at 13 columns is destroyed.

Fixed with `fitMode`: a tile **scales** its rendered pixels with a CSS
transform and leaves the grid alone; only a zoomed pane earns the right to
reflow. Unit tests could not have found this — it needs a real viewport, a real
mosaic and a real pty.

**2. Two more paths resized regardless of mode.** With `fitMode` in place a
tile *still* resized, because the font-size effect (which fires on the phone's
13→14px default flip) and the reconnect nudge both called `fit()` and posted
the result unconditionally. Both now respect the mode. Found by instrumenting
the server's borrow bookkeeping and reading what actually arrived — the second
bug was invisible behind the first.

A third symptom explained by the same root cause: an early cycle restored to
`121x44` rather than `80x24`. That is the documented one-poll staleness in
`prior` (the session list refreshes on a 1s tick), and the value was still a
*desktop*-sized grid, never a phone one — the contract §2.2.1 promises. Once
the leak was fixed, a fresh session round-tripped exactly.

## Post-merge note

`main` advanced during this work (`perf/optimization-pass`: delta re-attach
watermarks on `Attach`, a memory-budget dialog, lazy CodeMirror). Merged before
gating; the conflicts were additive on both sides (SplitView imports, the web
shim's method table, two CLAUDE.md entries) and the borrow code was untouched
by the protocol change.

## Not verified

- **A real device, either platform.** Emulation gives touch events and a coarse
  pointer, not a real soft keyboard, real momentum, or Safari's behaviour.
  The soft-keyboard rule (§3: opening the keyboard must not re-fit the pty) is
  **implemented and unit-tested** (`keyboardViewport.test.ts` pins the
  discriminator, including that an orientation change — which moves BOTH
  heights — must still re-fit), but it is **not verified on a device**:
  `visualViewport` does not move under emulation, so the code path that keeps
  the cursor row above the keyboard has never run for real.
- Long-press drag arming (§6) and long-press sheets: synthetic pointer events
  were not driven through the 400ms arming path.
- Touch scrolling and its alt-screen arrow translation: the ported logic is
  unit-tested (`touchInput.test.ts`) but was not exercised by a real finger.
- Copy/paste on touch: `navigator.clipboard` needs a real user gesture.
- PWA install (`Add to Home Screen`) and safe-area insets on a notched device.
