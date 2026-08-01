# Spike: `amber-ide` as a web app — does `Pane.tsx` need zero changes?

Date: 2026-08-01. Spec: `docs/superpowers/specs/2026-08-01-amber-ide-as-a-webapp-design.md` §2.2/§8.

## Verdict: **YES**

`app/src/renderer/Pane.tsx` is byte-for-byte unmodified. A real daemon session
(a bash shell, e.g. `amber-1-1-0-cc`) rendered live in a real Chromium tab via
the real React renderer, and a keystroke typed in the browser reached the real
pty, was evaluated by the real shell, and its output came back into the same
xterm instance. The §2.2 MessageChannel claim holds.

## What was built

1. **`app/src/web/amber.ts`** — installs `window.amber` off one WebSocket to
   `amber web`'s `/ws`, implementing the mount-critical surface for real
   (`onDaemonEvent`, `openPane`/`closePane` + the MessageChannel bridge,
   `loadLayout`/`saveLayout` as benign no-ops, `homeDir`/`softwareGl`,
   `clipboardWrite`/`clipboardRead` via `navigator.clipboard`) and every other
   method (`createSession`, editor/browser dialogs, workspace files, …) as a
   visible-throw stub. Nothing under `app/src/renderer/` was touched.
2. **`app/src/web/main.ts`** — entry point. Reproduces `assets/app.js`'s
   fragment-token → `/api/auth` → cookie bootstrap (the renderer has no
   equivalent of its own — this file supplies it), then installs the shim,
   then imports `../renderer/main` (unmodified).
3. **`app/vite.config.web.ts`** — a second, independent vite build target
   (existing `@vitejs/plugin-react`/`vite` devDependencies only — no new
   runtime deps). `npm run build:web` → `app/out/web/` (~1.35 MB JS, no
   `require(`, no `from 'electron'`, no Node builtins — confirmed by grep).
4. **`crates/amber/src/web.rs`** — a **SPIKE-ONLY**, clearly-commented
   temporary route: `GET /app` and `GET /assets/*` read `app/out/web/` off
   disk at request time (relative to CWD) and serve it same-origin with
   everything else `amber web` already serves. This is explicitly NOT the
   real bundle-serving design (spec §2.3's `build.rs`-generated
   `include_bytes!` table, proving-order item 4) — that's still unbuilt.
   `cargo clippy --workspace --all-targets` clean, existing `web::` tests
   (17) still pass unmodified.

## The binary-frame routing mechanism (the detail the task warned about)

Read `crates/amber/src/web.rs`'s `Hub`/`Client`/`on_frame`/`queue` and the
mobile `assets/app.js`'s `connect()`. **A binary frame carries no session id
on the wire at all.** `Client.open: Option<String>` is a single slot per
WebSocket connection; `Frame::Data{session, bytes}` from the daemon is
delivered to whichever clients currently have `open == Some(session)`, and
what reaches the browser is just the raw bytes — the routing key is which
session *this connection* has open, not anything in the frame. That's why the
existing mobile UI only ever shows one pane at a time: it's the only routing
the protocol supports today.

Consequence for the shim: it uses **one shared WebSocket with one
"currently-open" session**, exactly mirroring the existing protocol.
`openPane` records the last-opened session as canonical and routes every
binary frame to that pane's `MessagePort`; opening a second pane while a
first is open would cause the server to `Detach` the first (see
`map_browser_msg`'s `Open` arm) — there is no way to hold two panes live on
one connection without a server change. This was sufficient for the spike
(one pane proves the claim) but **is not yet a multi-pane transport** — see
"what's next."

## Evidence

- `npx tsc --noEmit` (full `app/` program, `src/web` added to `tsconfig.json`
  include) — clean.
- `npm run build:web` — clean build, no electron/Node references in the
  output bundle (`grep -c "require(" assets/*.js` → 0; no `from 'electron'`).
- Private, isolated daemon + `amber web` on port 7799 (never the user's
  daemon/port 7717). `POST /api/auth` with the real token → `204` +
  `Set-Cookie`; `GET /api/sessions` (with cookie) → real session JSON;
  `GET /app` → `200`; `GET /assets/<hash>.js` → `200`.
- **Live, driven with the Playwright MCP browser** (real Chromium, not a
  headless stub): navigated to
  `http://127.0.0.1:7799/app#t=<token>`, screenshot showed the full real IDE
  chrome (workspace pill, tab bar, `+ Pane`/`+ ws`/save/load/sessions
  buttons — none of that is hand-rolled, it's `main.tsx`'s actual JSX) with
  the pane header `#1 poyto@teapot-dev:/tmp · shell` and a live shell prompt.
  Clicked into the pane, typed `echo hello_from_web_spike_$((21+21))`,
  pressed Enter: the terminal showed `hello_from_web_spike_42` — the
  arithmetic was evaluated by the real shell, not echoed literally, so this
  is a genuine pty round trip, not a rendering artifact. **Independently
  confirmed server-side**: the daemon's own scrollback ring file
  (`<state>/scrollback/<session>.bin`) contains the exact same transcript
  including the evaluated result, proving the bytes really went through the
  daemon's pty, not just the browser's local echo.
- **Reconnect exercised live, with a real severed connection — not
  `page.context().setOffline()`.** First pass used `setOffline()`, but that
  turned out not to actually close an already-established Chromium
  WebSocket (confirmed: the app's own "disconnected" banner never appeared,
  and after re-enabling network the console showed zero connection-error
  entries — i.e. the socket plausibly never dropped, which would have made
  "no duplication" a vacuous pass). Redone properly: killed the `amber web`
  **process** (a genuine TCP close), waited for the app's real
  `daemon disconnected — reconnecting…` banner to appear (confirmed present),
  restarted `amber web`, re-exchanged the token for a fresh cookie (a process
  restart invalidates the in-memory auth session — expected, unrelated to the
  shim), and waited for the banner to clear (confirmed gone — genuinely
  reconnected). Typed a marker before, during-the-gap, and after; every
  marker appears **exactly once** in both the rendered terminal and the
  daemon's own scrollback file (`grep -c` of all three names → 6 = 3 × echo+
  output, no duplicates) — see "what fought me" below for the two real bugs
  this exercise caught and fixed, and "what's next" for a related gap it
  surfaced but did not fix.
- Only console message throughout the final run: a harmless `favicon.ico`
  404. No renderer exceptions, no stub was hit on the mount/interaction path
  exercised.
- Rust: `cargo clippy --workspace --all-targets` clean; **`cargo test -p
  amber` (unfiltered) — 225/225 passed** (17 suites, incl.
  `crates/amber/tests/web.rs`). App: `npx tsc --noEmit` clean; **`npm test` —
  410 passed / 1 pre-existing skip** (30 files). Nothing pre-existing broke.

## What fought me (none of it was `Pane.tsx`)

- **Auth bootstrap doesn't exist in the renderer.** The renderer has no
  concept of the fragment-token → cookie exchange; that logic lives only in
  the hand-written `assets/app.js`. Solved by copying that ~10-line pattern
  into `web/main.ts` (outside the renderer tree) rather than the renderer
  needing to know about it.
- **Cross-origin genuinely doesn't work here**, confirmed rather than assumed:
  the WS upgrade's `origin_ok` check compares `Origin` against `Host`, and the
  auth cookie is `SameSite=Strict` — either one alone would kill a
  split-origin setup (e.g. `python3 -m http.server` on a different port from
  `amber web`). Same-origin serving (the temporary `/app` route in `web.rs`)
  was the only viable option, not just the "simplest" one, so I built that.
- **A startup race the shim had to fix, not the renderer**: `connect()` opens
  the WebSocket eagerly at module load, and the server pushes its first
  `sessions` message the instant the connection is accepted
  (`Hub::add_client`) — comfortably before React's mount effect calls
  `onDaemonEvent` to register a listener on localhost. Without buffering, that
  first push (the one `sawSessions` depends on to leave the "connecting…"
  placeholder) would be silently dropped. Fixed with a small pending-event
  buffer in the shim, flushed once a real listener registers.
- **Top-level `await` needed a rewrite** (esbuild's default target
  disallowed it) — wrapped `main.ts`'s bootstrap in an async IIFE instead;
  five minutes, unrelated to the load-bearing claim.
- **Two real bugs in the shim, both caught by actually exercising a reconnect
  instead of trusting the first green run** (per CLAUDE.md's own recorded
  lesson: this exact class of bug — a re-attach duplicating scrollback and
  leaving stale mouse-tracking on — blanked a live pane once already when
  inferred instead of tagged):
  1. `Pane.tsx` reads `m.backlog === true` to `term.reset()` before a
     re-attach replay and to fire `MOUSE_RESET` after any replay; the shim's
     first draft never set it, so a reconnect on the web path would have
     silently reproduced the exact history-duplication bug the 2026-07-31
     memory-audit pass fixed for the Electron client. Fixed by tagging the
     first binary frame after any `{t:'open'}` send — safe because Attach
     ordering on one pipe guarantees that next frame is the backlog reply
     (the same guarantee the Electron client's `router.ts` `awaitingBacklog`
     relies on), not a "first frame after reconnect" timing guess.
  2. Wiring that fix surfaced a second, worse bug live: `openPane` sends
     `{t:'open'}` immediately (queued if the socket isn't open yet), but
     `onopen` *also* unconditionally re-sent `{t:'open'}` for whatever
     `openSession` was already set — which fires on the pane's *very first*
     open too, since React always calls `openPane` before the WebSocket
     handshake finishes. That double-Attached the session on the daemon,
     doubling its backlog (`before_reconnect_marker` appeared twice on the
     next fresh load in testing). Fixed with an `everConnected` flag so the
     explicit resend only fires on a genuine reconnect, never the first
     connect.
- **Housekeeping note**: the Playwright MCP browser tool writes its own
  screenshot/console artifacts to a fixed `.playwright-mcp/` relative to the
  harness's original working directory (`/home/poyto/Projects/amber-ide`,
  the repo I was told never to touch), not relative to this worktree,
  regardless of the shell `cd`s used for `Bash` calls in this session. It
  wrote 5 files there (already covered by that repo's own pre-existing
  `.gitignore` entry, so nothing was ever tracked/committed) which I deleted
  immediately after use; `git status` in that repo is clean. Evidence
  screenshots for this report were re-taken with an explicit absolute path
  instead. Worth knowing for whoever runs the next live-verification pass.

## What's next (read before building the real shim)

1. **Multi-pane transport is the real remaining risk, not `Pane.tsx`.** The
   spec's own §4 already flags widening `Client.open` to a set; this spike
   makes concrete *why* it's required — not just for input routing (§4's
   framing) but because a binary frame carries no session id at all, so
   without that widening a shared single WebSocket cannot serve two live
   panes simultaneously. The decision, priced rather than left neutral:
   - **One WebSocket connection per pane** — works *today*, zero Rust
     change (each connection gets its own `Client.open`), and this shim's
     backlog-tagging logic ports over unchanged (still "next frame after
     this connection's `open`"). Costs 2 threads per pane in `amber web`
     (reader + writer, per `ws_session`) — ~38 threads at the box's 19
     sessions, plus N auth handshakes instead of 1.
   - **Widen `Client.open` to a `HashSet` server-side** — one connection for
     the whole app, but now `Out::Binary` must carry the session id (it's
     bare bytes today, per the routing-mechanism section above), which is a
     wire-format change on both ends, not just a server-side set swap.
   Recommend deciding this before writing the full shim, not discovering it
   mid-build.
2. **`loadLayout`/`saveLayout` are no-ops here** — every gesture that
   persists layout (split, drag, close, font size, tab rename) will silently
   not survive a reload until §6's CAS design is actually implemented on both
   writers.
3. **The `/app` route in `web.rs` is temporary and reads off disk** — replace
   with the real `build.rs`-generated `include_bytes!` table (spec §2.3,
   proving-order item 4) before this goes anywhere near "real" use; don't
   build on top of the disk-read version.
4. Everything stubbed here (session lifecycle beyond the pre-existing
   whitelist, editor/browser panes, native dialogs, `claudeNames`) is
   deliberately unbuilt — proving-order items 2 and 5.
5. `softwareGl` is hardcoded `true` in the shim (skips xterm's WebGL addon),
   so WebGL rendering was never exercised in a browser by this spike — fine
   for the verdict (DOM renderer is a correctness-neutral fallback), but the
   real build needs this served from the bootstrap JSON per spec §3, probed
   for real GPU support the way the Electron main process does.
6. **A second, distinct untagged-backlog path exists and was confirmed live:
   `amber web`'s own reconnect to the *daemon*.** `run_daemon_link` (web.rs)
   re-sends `Attach` for every client's open session whenever *it* reconnects
   to the daemon — entirely independent of whether the browser's own
   WebSocket ever dropped. The shim only arms `awaitingBacklog` when the
   browser sends `{t:'open'}`, so this path's backlog reply arrives untagged.
   Reproduced by killing only the **daemon** process (not `amber web`) while
   the browser tab stayed connected throughout (its banner correctly showed
   `daemon error: daemon unreachable`, never "disconnected"): after
   restarting the daemon, the terminal gained one extra, un-reset prompt line
   it hadn't earned — real content, not a rendering artifact, but *not* the
   full-history duplication the tagged-reconnect bug would have caused,
   because a fresh child process was spawned by the daemon and only its own
   new prompt was genuinely-new bytes on this run. Whether that stays this
   mild depends on how much real output happened between the daemon's last
   snapshot and its death, and on whether a dead program had left mouse
   tracking on (`MOUSE_RESET` also doesn't fire on this path) — so treat it as
   confirmed-real, not confirmed-small. Options for the next task: have
   `amber web` emit a text frame (e.g. `{"t":"reattached","name":…}`) before
   replaying so the shim can tag it, or have the shim re-send `{t:'open'}`
   itself when it sees the `sessions` push that follows a
   `daemon unreachable` error clearing. Either way this is a shim/server fix,
   not a `Pane.tsx` fix — it doesn't touch the verdict.

## Cleanup

The private daemon (`/tmp/spike-live-tiles`) and its `amber web` instance were
both killed and the directory removed before finishing. The user's real
daemon (port 7717) and app were never touched.
