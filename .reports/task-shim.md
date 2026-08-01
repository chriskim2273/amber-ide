# Task — full web transport shim

**Status:** done.

**Commits:**
- `78df081` — fix(web): tag the daemon-reconnect backlog replay + widen dumpBacklog (Rust, `crates/amber/src/web.rs`)
- `7e4b646` — feat(web): full window.amber shim over one WebSocket per pane (TypeScript, `app/src/web/*`)

**Tests:** `cargo test --workspace` 301 passed (19 suites); `cargo clippy
--workspace --all-targets -- -D warnings` clean. `app`: `npm run typecheck`
clean; `npm test` 432 passed / 1 pre-existing skip (30 files, 22 new in
`amber.test.ts`). `npm run build:web` still produces a clean bundle (grep for
`require(`/`from 'electron'` in the output: 0 hits).

## What changed, by task item

1. **Untagged-backlog fix.** `run_daemon_link`'s reconnect re-attach and
   `handle_browser`'s browser-initiated `Open` now both route through one
   `Hub::write_daemon_tracking` helper, which is the only place an `Attach`
   is ever sent. It records the session name in a new `pending_backlog` set;
   `on_frame`'s `Frame::Data` arm tags the first following frame for that
   session with a `{"t":"backlog","name":...}` marker before forwarding the
   bytes — same mechanism the Electron client's `router.ts::sendAttach`
   already uses, just moved server-side so it covers a reconnect the
   Electron client never has to (it doesn't proxy a second hop). New Rust
   test `daemon_reconnect_reattach_tags_its_backlog_reply` drives a
   hand-controlled fake `UnixListener` standing in for the daemon, forces a
   real disconnect/reconnect, and asserts the marker survives both the
   browser-initiated and the daemon-reconnect-initiated attach.

2. **One WebSocket per pane.** Turned out to need **no server-side change**:
   `Client.open` was already a per-connection `Option<String>`, so N browser
   WebSocket connections each with their own `open` already route
   correctly today. All the work is client-side: `PaneLink` (one per open
   pane, sends `{t:"open"}` on connect/reconnect, forwards pty bytes to its
   `MessageChannel` port, forwards keystrokes back, drops anything
   resize-shaped) plus a single `ControlLink` (session lifecycle +
   `onDaemonEvent` stream + `dumpBacklog`, never opens a pane). Only
   `ControlLink` dispatches broadcast-class messages (sessions/error/
   activity/memory) — if every `PaneLink` also dispatched them, N open
   panes would produce N duplicate app-level events, and worse, would
   double-consume an `Error` the renderer's dump-resolver logic expects
   exactly once.

3. **Rest of `window.amber`.** Session lifecycle
   (create/kill/rename/suspend/resume) sends the existing
   `map_browser_msg` JSON shapes over `ControlLink`. `dumpBacklog` required
   a whitelist addition (`BrowserMsg::DumpBacklog`, gated on `live(name)`
   like `Kill`) plus a `Frame::Backlog` arm in `on_frame` that routes the
   one-shot reply back to the requesting client id (tracked in a new
   `dump_pending` map, since a `Frame::Backlog` carries no client id).
   `clipboardRead`/`clipboardWrite` go straight to `navigator.clipboard`.
   `homeDir` comes from a new authenticated `GET /api/bootstrap`, fetched
   and installed *before* `window.amber` exists — `main.tsx` reads
   `homeDir` via a lazy `useState` initializer that runs exactly once, so
   patching it in later would permanently stick every new pane's default
   cwd at whatever placeholder ran first. `softwareGl` is a native
   canvas/WebGL probe in `install.ts` rather than a server value (the GL
   support lives in the browser, not the daemon's host — a deviation from
   spec §3's literal "bootstrap JSON" placement, noted in `install.ts`).
   `loadLayout`/`saveLayout` stay the spike's inert no-ops, with a TODO
   naming the CAS follow-up (spec §6) and its constraint: the eventual
   `saveLayout` must preserve the sidecar's `browsers`/`editors` maps or
   the first web-side write silently prunes every desktop-only pane.

4. **Loud stubs.** `editorRead`, `editorSave`, `editorDraftWrite/Read/Clear`,
   `editorOpenDialog`, `editorSaveDialog`, `editorInlineImages`,
   `pickFolder`, `revealPath`, `resolvePath`, `claudeNames`,
   `saveWorkspaceFile`, `openWorkspaceFile` all throw
   `"window.amber.<name>: not available in the web build"` synchronously —
   covered by a single parameterized vitest case over all thirteen.

5. **Editor/browser panes desktop-only.** New `app/src/web/desktop-only.css`
   (imported only by the web entry point) hides `.browser-pane`/
   `.editor-pane`'s real children via `> *` and paints an explanatory
   `::after` overlay — zero renderer changes, and the pane's own DOM node
   (and therefore its layout-tree leaf) is never removed, so nothing here
   can trigger the pruning spec §7 warns about. Confirmed by grep (not
   assumed) that nothing in the shim or the renderer's existing
   `newPane`/`doSave` paths ever calls `createSession`/`dumpBacklog` for a
   browser/editor name — `newPane` returns before reaching `createSession`
   for both kinds, and `doSave`'s dump-target filter is already an
   allowlist (`kind === 'shell' || isAgentKind(kind)`).

6. **Resize stays unreachable.** `PaneLink`'s port handler only ever
   forwards a message that has a `.data` field; there is no branch that
   could turn a `{resize:{...}}` port message into a socket send. Covered
   by an explicit vitest case (`'never sends a resize, no matter what the
   port receives'`) plus a whitelist-shape assertion over every outgoing
   `t` the shim ever produces. The Rust side already had
   `a_forged_resize_from_the_browser_never_reaches_the_pty` from an earlier
   pass; unchanged, still green.

## Files

- `crates/amber/src/web.rs` — backlog tagging, `DumpBacklog` widening,
  `Activity`/`MemoryStat` broadcast, `/api/bootstrap`, new tests.
- `app/src/web/amber.ts` — pure shim: `parseServerMsg`, `toDaemonEvent`,
  `ControlLink`, `PaneLink`, `createAmber`.
- `app/src/web/install.ts` — real WebSocket/MessageChannel/clipboard/
  `window.postMessage` glue; never imported by a test.
- `app/src/web/main.ts` — bootstrap sequencing (auth cookie → `/api/bootstrap`
  → install shim → import renderer).
- `app/src/web/desktop-only.css` — new, CSS-only placeholder.
- `app/src/web/amber.test.ts` — new, 22 cases.

## Verification beyond the gate

- **Mutation-checked task 1's headline claim.** Temporarily reverted the one
  `write_daemon_tracking` call inside `run_daemon_link`'s reattach loop back
  to plain `write_daemon` and re-ran
  `daemon_reconnect_reattach_tags_its_backlog_reply`: it failed exactly as
  predicted, panicking in `recv_out`'s 5 s "browser client queue starved"
  timeout (the untagged reconnect never sends a `backlog` marker, so
  `expect_backlog` blocks forever) rather than tripping its own deadline
  assert — confirms the test is exercising the fix, not passing vacuously.
  Reverted back; `git diff` on the file is clean again.
- **`softwareGl` corrected after review**, not left as the initial draft:
  the first pass had `install.ts` probe real WebGL support and pass `false`
  through on any capable browser — a regression the spike deliberately
  avoided (it hardcoded `true` and said outright that WebGL was "never
  exercised in a browser"). `Pane.tsx` opens one WebGL context per pane, and
  browsers cap concurrent contexts (~16 in Chrome, oldest evicted past the
  cap); a busy workspace would have silently exercised the context-loss/
  DOM-fallback path for the first time ever, transport-scope work having no
  business flipping that on. `probeSoftwareGl()` now always returns `true`
  (DOM renderer, correctness-neutral per the spike) with a comment naming
  what unlocks flipping it — a real `canvas.getContext('webgl')` probe,
  once a live-GUI pass has exercised WebGL contention across many
  simultaneously open panes.
- **`/api/bootstrap` gates and content now tested**, not just added: it's in
  `unauthenticated_data_routes_and_ws_are_refused` (no cookie / forged
  cookie → 401, same as `/api/sessions`) and a new
  `bootstrap_carries_a_non_empty_home_behind_the_cookie` pins that `home` is
  never served empty. That test exists because `std::env::var("HOME")` can
  legitimately be `""` under a boot-managed `amber web` (the repo's own
  2026-07-29 display-env history), and `main.tsx`'s `?? '/'` fallback does
  **not** rescue an empty string (only null/undefined) — an empty `home`
  would have become `cwd: ""`, silently failing `map_browser_msg`'s
  `Path::new(cwd).is_dir()` gate on every `+ Pane` with no visible error.
  Fixed on both ends: the server falls back to `"/"` when `HOME` is
  unset/empty, and `fetchBootstrap` in `main.ts` additionally guards with
  `body.home || '/'` (matching preload's own `homeArg || '/'` pattern)
  in case a future server regresses this.

## Concerns

- `dump_pending`/`pending_backlog` are cleared on a daemon disconnect
  (bounded hygiene) but a `DumpBacklog` in flight when the daemon dies is
  not retried — its caller times out on its own, same class of gap as any
  other daemon-unreachable window. Not fixed; noted in a code comment.
- `PaneLink`/`ControlLink` reconnect on a fixed 1 s timer, no backoff ladder
  — matches the spike's existing behavior, ponytail-flagged in the code as
  the corner cut.
- Two browser tabs with the SAME session open both match `Hub::queue`'s
  `open == session` filter, so a `backlog` marker minted for one tab's fresh
  attach also reaches the other tab's `PaneLink`, which will `term.reset()`
  its own terminal even though nothing attached on ITS connection. Content
  repaints correctly right after (the daemon's backlog replay still lands
  correctly on the connection that actually attached), so this is a visible
  flicker, not corruption — but it's a web-only divergence from Electron
  (one port per session there, never two consumers of the same pty). Not
  fixed; a real cross-tab-same-session scenario is uncommon and out of this
  task's scope.
- Live-GUI verification (a real browser against a private daemon) was not
  re-run in this pass — the spike already proved the MessageChannel/render
  path end-to-end; this pass is transport-surface work verified by the
  Rust/vitest gates plus a clean `npm run build:web`. Flagging in case the
  next pass wants a live pass before this goes further (e.g. before wiring
  the CAS layout task, or before flipping `softwareGl`'s probe back on).
- `app/out/web/` build artifacts were produced locally to verify the bundle
  stays clean (no `require(`/electron refs) and were left in place
  (gitignored, not committed).
