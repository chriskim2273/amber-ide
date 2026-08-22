# Mobile web experience + remote-access control plane

**Date:** 2026-08-22
**Status:** design approved in chat 2026-08-22; not implemented.
**Scope:** two phases, one doc. **Phase A** = the desktop IDE's controls for
running/hosting the web server (§9). **Phase B** = making the hosted IDE
usable — specifically *agent sessions* — on a phone (§1–§8).
**Builds on:** `2026-08-01-amber-ide-as-a-webapp-design.md` (the pivot: the
browser runs the real React renderer), `2026-07-19-amber-web-mobile-design.md`
(the hand-written phone UI at `/`, now a source of proven techniques rather
than a surface we extend).

Read `CLAUDE.md` first. **§0.1 amends a rule of the webapp spec. That amendment
is the precondition for everything else here.**

## 0. The problem

`amber web` serves the real renderer at `/app`. Measured in this repo today:

- `app/src/renderer/` contains **zero** `@media` queries and **zero** touch
  handlers. Every drag path is `mousedown`/`mousemove`/`mouseup` registered on
  `window`, all in `SplitView.tsx` (`:383` outside-click, `:527` divider drag,
  `:601` grip move).
- Chrome controls are 26 px tall (e.g. `.ws-pill`, `theme.css:145`), chrome
  fonts 11–12 px.
  Both are below any touch minimum.
- On a phone the hosted IDE is therefore a shrunk desktop: readable in
  principle, operable in practice only for tapping.

Meanwhile the thing the user actually wants to do from a phone is **use an
agent session** — claude, codex, grok — and have it "look and function
perfectly". An agent session is a full-screen alt-screen TUI laid out at the
pty's real `cols`/`rows`. That makes it the hardest case, not the easiest, and
it drives most of the decisions below.

Second problem, independent: `amber web` is a manual CLI. There is no service
unit for it, no UI anywhere, and `tailscale serve --bg <port>` is a hint
printed to stderr (`crates/amber/src/main.rs:626`,
`infra/daemon/install.sh:78`). Starting the hosted IDE and getting its link
onto a phone is entirely hand-run today.

**Out of scope, explicitly:** `opencode` is not a session kind on `main` (only
in `.worktrees/opencode-kind-kill-freeze`). Nothing here adds it. Where this
doc says "agent session" it means `SessionKind::is_agent()` — claude, grok,
codex — and any kind that predicate later admits.

## 0.1 Amendment to the webapp spec §2.1

The webapp spec says:

> **The renderer is not modified.** If a change to `app/src/renderer/` turns
> out to be required, that is a signal the shim is wrong — fix the shim.

Mobile cannot be built under that rule: media queries, pointer-event drag,
tap-target sizing, an on-screen key bar and touch scrolling all live in
renderer components and `theme.css`. The shim has no reach there.

**Amended reading (user decision, 2026-08-22):**

> Renderer changes that are **host-agnostic** are in scope — they improve the
> Electron app in a small or touch-capable window exactly as much as they
> improve the browser build. Renderer changes that **branch on the host**
> (`isWeb`, "are we in Electron", transport shape) remain forbidden and remain
> the signal that the shim is wrong.

§2.1's purpose — keep the transport out of the UI — is untouched. A
`@media (pointer: coarse)` block and a `pointerdown` handler are not transport.

**Enforceable form of the rule, for review:** no file under
`app/src/renderer/` may import from `app/src/web/`, read a web-only global, or
test for Electron. Mobile behaviour is gated on **capability** (viewport size,
pointer coarseness), never on **host**.

## 1. Mobile detection

`useMobile()` — a React context provider mounted in `main.tsx`, backed by a
pure, unit-tested predicate:

```
isMobileViewport(width: number, coarsePointer: boolean): boolean
  => coarsePointer && width <= 820
```

`matchMedia('(pointer: coarse)')` + a `resize`/`orientationchange` listener
feed it. **No UA sniffing** — an iPad in desktop mode, a touchscreen laptop and
a phone are all classified by what they can actually do.

`theme.css` gains one `@media (pointer: coarse)` block for sizing. Components
read the hook only where *behaviour* differs (key bar, sheets, tap-to-zoom).

**Branch discipline:** `Pane.tsx` takes exactly one capability-gated change,
named and justified in §3, and no other. Mobile
behaviour lives in chrome (`SplitView.tsx` chrome, `main.tsx` toolbar) and in
new mobile-only components. This is a review gate, not a preference: the
2026-08-01 entry records `Pane.tsx` being restored to byte-identical after the
`fitFont` workaround, and §3 below is the one place this doc knowingly spends
that property.

## 2. Grid borrowing — how an agent pane fits a phone

### 2.1 The conflict

A phone at 390 px CSS width fits ~46–54 columns depending on font size. A
desktop agent pane is commonly 100–160 columns. Two bad options and one good
one:

- *Follow the desktop grid and scale:* a 120-col TUI inside 390 px is ~3 px
  glyphs. Unreadable — fails the bar outright.
- *Fit and leave it:* the phone reflows the pty to ~46 cols and the desktop
  stays there until something re-fits it. A claude TUI at 46 cols on a 32"
  monitor is a wrecked workspace.
- **Borrow and restore** (chosen): the phone reflows the pty while it is
  actually looking at that pane, and hands the grid back when it stops.

### 2.2 Mechanism

The existing path is untouched: `Pane.tsx`'s `FitAddon` fits the pane
(`Pane.tsx:186`), emits `{resize:{cols,rows}}` on its port
(`Pane.tsx:230`/`:375`/`:405`), `PaneLink` debounces 300 ms and sends
`{"t":"resize",...}` (`app/src/web/amber.ts`), `web.rs`'s `map_browser_msg`
validates against `RESIZE_MIN_COLS..=RESIZE_MAX_COLS` /
`RESIZE_MIN_ROWS..=RESIZE_MAX_ROWS` and constructs `ControlMsg::Resize`.

**Bookkeeping lives server-side in `Hub`, not in the shim.** Only the server
survives a phone that walks out of Wi-Fi range mid-session. `HubInner` gains:

```
borrows: HashMap<String /*session*/, Borrow>
struct Borrow { client: u64, prior: (u16, u16), set: (u16, u16) }
```

- **`prior` is captured in the `Open` handler, never in the `Resize`
  handler.** This is load-bearing, not a style choice — see §2.2.1. At `Open`
  the Hub records the session's current `cols`/`rows` from `HubInner::sessions`
  (`SessionInfo.cols`/`.rows`, which the daemon fills from the live pty winsize
  — `manager.rs:1524`ff reads `PtySession::size()`, `pty.rs:593`, so it tracks
  every `Resize` rather than reporting spawn geometry). The record becomes a
  *borrow* only when the first web-originated `Resize` for `S` from `C`
  arrives, at which point `set` = what we are about to apply. Later resizes
  from the same client move `set` only; `prior` never moves.
- **Release** fires on: an explicit release from the client, the client's
  socket closing, or the client changing which session it has open (`Client`
  holds exactly one `open` session — `web.rs:557`).
- On release, send `Resize{prior}` **only if the session's current grid still
  equals `set`**. If the desktop re-fit in the meantime, the desktop is the
  newer writer and we leave it alone. Last writer wins; a restore never
  clobbers.
- A borrow whose session disappears is dropped silently.

### 2.2.1 Why `prior` cannot be captured on `Resize`

`HubInner::sessions` refreshes on the **1 s** daemon poll (the 2026-07-19
decision: poll rather than make the daemon broadcast on every `Resize`).
`PaneLink` debounces resizes by **300 ms**. So inside one poll window a phone
can emit two resizes, and if the borrow were created on the *second* one,
`prior` would capture **the phone's own grid**. Restore would then be a no-op
that silently leaves the desktop at ~46 columns — the exact failure "borrow and
restore" exists to prevent, and it would present as a Playwright test that
passes or fails on poll timing. This repo has been bitten by timing-dependent
intermittents before (the backlog head-of-line fix: *never conclude "not
reproducible" from one green run*).

Capturing at `Open` removes the race by construction: a socket declares its one
`open` session before any `Resize` can arrive on it, and `Client.open`
(`web.rs:557`) is already the borrow key.

Residual staleness is bounded and benign: `prior` can be up to one poll
interval old, so a desktop resize in that last second is missed. The value is
still a *desktop-sized* grid, never a phone-sized one, and the desktop's own
`FitAddon` re-asserts on its next layout event.

### 2.3 Client side

The shim sends an explicit release so the common case restores immediately
rather than waiting on socket death:

- un-zoom (leaving full-screen),
- `visibilitychange` → `hidden`,
- `pagehide`.

Release is a new browser message `{"t":"release"}` carrying no arguments — it
acts on whatever session that socket has open. It maps onto **no**
`ControlMsg` by itself; it only triggers the Hub's own restore `Resize`, which
goes through the same validated construction path. The browser whitelist gains
nothing that reaches the daemon directly. `Snapshot`, `ReportRunState` remain
categorically unreachable, as the 2026-07-31 and 2026-08-01 entries require.

### 2.4 Shell panes

Unchanged and deliberately different: a shell pane on a phone **follows** the
desktop grid — CSS scale + pan, no `Resize`. Reflowing a shell costs the
desktop something for no gain; a shell's output is not laid out to the grid the
way a TUI is.

The mode is **derived by default**, never stored on the common path:
`isAgentKind(kind) && mobile && zoomed` ⇒ borrow; anything else on mobile ⇒
follow. Only an explicit user override
("fit to my screen" / "follow desktop") is persisted — it lives in the pane's
long-press sheet (§6) and is stored in the layout sidecar next to
`frozen`/`fontSize`, keyed by pane id. Absent an override, nothing is written.

### 2.5 Readability, and what must be measured not guessed

At 390 px CSS width, xterm's cell width is ≈0.6 em: 12 px font ⇒ ~54 cols,
14 px ⇒ ~46 cols. What a real claude/codex/grok TUI needs is **not settled by
this spec** — Phase B's first task is to measure the three agents at 40/46/54
columns on a real emulated phone and record the floor. The mobile default font
size is fixed after that measurement, not before it.

**Pinch semantics differ by mode, and this must be documented in the UI:**

| Mode | Pinch does | Result |
|---|---|---|
| Borrowed (agent, zoomed) | changes **font size** | real reflow, crisp text, new cols → `Resize` |
| Following (shell) | changes **CSS scale** | no reflow, no `Resize`, pan to reach the rest |

Font size reuses the existing per-pane `fontSize` sidecar entry and its chords.

## 3. The soft keyboard

The naive implementation — bind pane height to `visualViewport.height` — makes
the pty grid flap every time the keyboard opens or closes. On an agent TUI that
is a full repaint each way, and with §2's borrow it is also two `Resize`
messages.

**Rule: opening the keyboard never re-fits the pty.** Rows stay pinned to what
they were when the pane was fitted. Instead:

- the terminal's viewport translates up so the cursor row sits above the
  keyboard,
- the key bar (§5) docks to the `visualViewport` bottom,
- only a genuine orientation change, or leaving/entering zoom, re-fits.

This is the one place §1's "no mobile branch in `Pane.tsx`" is spent: pinning
rows against a shrinking container needs a size source that is not the
container. It is a **capability**-gated change (coarse pointer + a
`visualViewport` that differs from `innerHeight`), not a host-gated one, so it
stays inside §0.1's amendment — and a touch laptop with an on-screen keyboard
gets the same correct behaviour.

`Pane.tsx` therefore stops being byte-identical to its pre-2026-08-01 state.
Named here so it is a decision, not a rediscovery: the deleted `fitFont` /
`serverGeomRef` / letterboxing machinery is **not** coming back. Font-size
pinch (§2.5) reflows; it does not letterbox a pinned server grid.

## 4. Layout on a phone

The split tree renders as a **mosaic**: the real tree, real ratios, live panes,
at phone width, with every tile given a ≥44 px hit area.

- **Tap a tile → zoom.** This is the *existing* pane-zoom state (keyed
  `ws:tab`, today bound to `Cmd/Ctrl+Shift+M`), driven by a tap. No new layout
  state, and the desktop's zoom is the same feature.
- Zooming pushes a history entry, so the **platform back gesture un-zooms**.
  Popping the last entry does not leave the app.
- Un-zoom releases a borrow (§2.3).

## 5. Key bar and touch input for TUIs

A mobile-only `KeyBar` component, docked above the soft keyboard:

`Esc · Tab · ⇧Tab · Ctrl (sticky) · ↑ ↓ ← → · Enter · / · ^C`

- **⇧Tab is non-negotiable** — it is claude's mode cycle. A key bar without it
  fails the "functions perfectly" bar on the primary use case.
- Cursor keys honour `applicationCursorKeysMode`. `crates/amber/assets/app.js`
  already implements this correctly (`app.js:613`–`:626`); port that logic
  rather than re-deriving it.
- The bar swallows `mousedown` so tapping it never blurs the terminal's hidden
  textarea (the same `preventDefault` the old UI does at `app.js:626`).

**Touch scrolling** (xterm ships none), also ported from the proven
implementation at `app.js:634`–`:689`:

- normal screen ⇒ one-finger vertical drag scrolls scrollback, with flick
  momentum;
- **alt screen** ⇒ one-finger vertical drag sends arrow keys, because a TUI
  owns its own paging;
- horizontal drag pans a scaled (following-mode) pane.

**Mouse-reporting TUIs** (agents enable SGR tracking) need an explicit rule or
every scroll becomes a drag-select inside claude:

| Gesture | With mouse reporting on |
|---|---|
| tap | forwarded as a click at that cell |
| one-finger drag | **ours** — scroll/arrows, never forwarded |
| two-finger drag | pan (following mode) |
| long-press | selection sheet (§8) |

## 6. Chrome: drawer, sheets, pointer events

- **Drawer.** Workspace pills + tab bar collapse into one top bar
  (`current ws · tab · ☰`). The hamburger opens a bottom sheet listing
  workspaces and tabs, carrying the existing activity dots and agent run-state
  dots unchanged.
- **Sheets.** Long-press a pane header or mosaic tile → bottom sheet: split
  (kind picker), kill, freeze/unfreeze, rename, copy cwd, move to tab, and the
  §2.4 grid override. This reuses the **existing** context-menu state — the
  repo already routes the split picker through it, so dismissal, clamping and
  pruning come free.
- **Pointer events.** Convert the `window` `mouse*` listeners (`SplitView.tsx`
  outside-click `:383`, divider drag `:527`, grip move `:601`, plus tab
  reorder) to `pointer*`. Desktop behaviour is identical — pointer events fire
  for mice. On touch, a drag arms only after a **400 ms long-press**, so a
  scroll is never stolen; a second finger or Escape cancels, matching the
  existing Escape-cancels-drag behaviour.
- **Sizing.** `@media (pointer: coarse)`: control heights 26 → 44 px, chrome
  fonts 11–12 → 13–14 px, spacing scaled with the existing `--sp-*` tokens.

## 7. PWA and viewport

- `manifest.webmanifest` + `apple-mobile-web-app-capable` meta, served as
  embedded assets alongside the `/app` bundle. Icons derive from
  `app/build/icon.png`.
- `viewport-fit=cover`, and `env(safe-area-inset-*)` padding on the top bar,
  the key bar and the sheets.
- **No service worker in v1.** Deliberate cut: the app is useless without a
  live WebSocket, so offline caching buys nothing, and SW cache invalidation
  across redeploys is a known footgun. "Add to Home Screen" gives a standalone
  window on both platforms without one.

## 8. Copy and paste on touch

Long-press inside the terminal opens a selection sheet: *select word · select
line · select all · copy · paste*.

- Selection is driven by `term.select()` from the tapped cell — xterm's own
  touch selection is not good enough to build on.
- Copy uses `navigator.clipboard.writeText` (https, which `tailscale serve`
  provides), falling back to a hidden textarea when the page is plain http.
- Paste goes through `term.paste()` → the existing `onData` path, so bracketed
  paste is already handled.

## 9. Phase A — remote-access control plane

### 9.1 Service

`amber web` becomes boot-managed, like the daemon (core rule #6: persistence is
not the app's job). A second unit pair ships alongside the existing one:

- Linux: `amber-web.service` (systemd user unit),
- macOS: `com.amber.web.plist` (launchd agent).

Installed by `infra/daemon/install.sh` and `amber ctl install`, **opt-in** —
it opens a local port, and the existing spec language already treats that as
opt-in. The desktop app is a *controller*, never the owner: closing the IDE
must not kill phone access, since being away from the desk is the entire use
case.

### 9.2 CLI

```
amber ctl web status | start | stop | restart | enable | disable | url | rotate-token
```

All support `--json`. **The app parses only `--json`** — never human text.

### 9.3 `GET /api/status`

A new authenticated endpoint on `amber web` itself, behind the **same cookie
boundary** as `/api/sessions`. It reports: port, uptime, connected clients
(peer, the one session each has open, whether it holds a borrow per §2.2), and
the tailscale mapping as last verified.

`amber ctl web status` is its client, and it is a **two-step** client — there
is no single authenticated GET. A CLI has no URL fragment and no cookie jar, so
it must:

1. read `<state>/web-token` directly (mode 0600, same uid — that *is* the
   security model; the CLI is not a remote party),
2. `POST /api/auth` with it and keep the `Set-Cookie`,
3. `GET /api/status` with that cookie.

**The CLI must not retry a failed `/api/auth`.** `Auth::throttled` buckets by
peer IP, and behind `tailscale serve` every peer is 127.0.0.1 (recorded
2026-07-19), so a status poll looping on a stale token — after a rotate, say —
would burn the 8-failure budget and lock **the phone** out. One attempt, then
report "token rejected — rotate or restart" and stop.

Rationale for an endpoint rather than a status file: it reuses the existing
auth surface and cannot go stale.

### 9.4 Tailscale

amber manages it, and shells out — the same class of call as the existing
`systemctl --user show-environment` (2026-07-29) and `login_path()`, and rule
#8 governs linking, not invoking.

- `tailscale status --json` → the tailnet DNS name,
- `tailscale serve --bg <port>` on enable,
- `tailscale serve status --json` to verify the mapping.

Four named failure states, each surfaced as text plus the command to fix it,
never a dead button: **not-installed**, **not-logged-in**, **not-running**,
**serve-not-mapped**.

### 9.5 Desktop UI

- **Toolbar pill** — dot + label: `off` / `starting` / `serving` / `error`.
  Polls only while the dialog is open; otherwise refreshed on demand and on
  window focus.
- **"Remote access" dialog** — follows the existing dialog pattern (sessions /
  save / load):
  - on/off toggle, enable-at-boot toggle, port,
  - the tailnet URL with a copy button,
  - **Show QR** — hidden until clicked (§9.6),
  - restart,
  - **rotate token** — behind a confirm; it logs out every device,
  - connected clients (from §9.3), with borrow markers so "why did my desktop
    reflow" is answerable,
  - diagnostics rows (binary present, port free, unit enabled, tailscale up,
    serve mapped, token file mode 0600) in the spirit of `amber ctl doctor`,
    plus a log tail (`journalctl --user -u amber-web -n 200 --no-pager` on
    Linux; the launchd stderr file on macOS),
  - **Open on this machine** — opens the local `/app` URL in the desktop
    browser, for testing the mobile UI without a phone.
- **App code**: `app/src/main/webService.ts` — pure argv builders and `--json`
  parsers, unit-tested, mirroring how `serviceManager.ts` is structured today —
  plus IPC and the renderer dialog.

### 9.6 Security

The URL and QR grant **full session control** — the same authority as sitting
at the machine. Therefore:

- the token stays in the URL **fragment**, never a query string, never a log
  line, never the pill tooltip, never a window title;
- the QR is render-on-demand, hidden by default, so a screen share does not
  leak it incidentally;
- the dialog says this in plain words next to the reveal control;
- rotate-token regenerates `<state>/web-token` (0600) and invalidates every
  existing cookie and link; it is confirm-gated.

## 10. Testing

**Rust**
- `Hub` borrow/restore state machine: restore fires on release; restore is
  **suppressed** when the desktop re-fit after the borrow; borrow released on
  socket close and on `open` change; a vanished session drops its borrow.
- **`prior` is never the borrower's own grid** (§2.2.1): drive two resizes from
  one client inside a single poll window with the Hub's session list
  deliberately stale, and assert the restore targets the pre-`Open` geometry.
  This is the regression test for the intermittent, so it must fail if `prior`
  capture is moved back into the `Resize` handler.
- `amber ctl web status` performs the token → cookie exchange and does **not**
  retry on a rejected token (the throttle-lockout guard, §9.3).
- `{"t":"release"}` reaches no daemon control message except the constructed
  restore `Resize`; `Snapshot`/`ReportRunState` still unreachable.
- `/api/status` requires the cookie; unauthenticated ⇒ 401.
- Unit-file templates; tailscale JSON parsing against recorded fixtures for all
  four failure states.

**App (vitest)**
- `isMobileViewport`, key-bar chord map (including `applicationCursorKeysMode`
  branches), selection/paste helpers, `webService` argv + JSON parse.
- URL builder: assert the token never appears outside the fragment.

**Playwright, device emulation (iPhone 13 + Pixel 7 profiles)**, against a
private daemon + private `amber web`:
- agent pane: tap-to-zoom → grid borrowed → un-zoom → **grid restored**;
- ⇧Tab from the key bar reaching the pty;
- alt-screen one-finger drag → arrow keys, not scrollback;
- opening the soft keyboard does **not** change `rows`;
- long-press sheet opens and its actions reach the daemon;
- divider drag by touch after long-press; a plain drag scrolls instead.

**Recorded as open, not done:** a real-device pass on both platforms, and real
tailnet reach. Emulation cannot answer either. This mirrors the existing
open items (real-Mac verification, live mobile gestures).

## 11. Phases

**Phase A — §9.** Independently useful, smaller, and it gives a running hosted
server plus a link before any mobile work exists. Nothing in it depends on
Phase B.

**Phase B — §1–§8.** Ordered: measurement (§2.5) → detection + CSS layer (§1,
§6 sizing) → key bar + touch scrolling (§5) → borrow/restore (§2, §3) →
mosaic/zoom + drawer + sheets (§4, §6) → PWA (§7) → copy/paste (§8).

Each phase gets its own implementation plan.

## 12. Open questions

1. The mobile font-size default is unset until §2.5's measurement. Everything
   downstream (cols floor, whether 46 cols is usable for codex) waits on it.
2. macOS log tail: launchd has no `journalctl`. The unit must declare a
   `StandardErrorPath`, which the Linux path does not need — a small asymmetry
   in §9.5's diagnostics.
3. Two phones open on the same agent session both want to borrow. The current
   design gives the borrow to the first and lets the second resize on top of it
   (`set` moves, `prior` does not), which restores correctly but means the two
   phones fight over the grid. Acceptable; recorded rather than solved.
