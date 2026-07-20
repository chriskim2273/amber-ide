# Project: Persistent Terminal Workspace

An Electron terminal workspace app (Warp/iTerm2-style) for **macOS and Linux**
whose defining feature is total session persistence: every pane, tab,
workspace, and running Claude Code conversation survives app crashes AND
machine reboots, restored exactly as they were.

This file is the project constitution. Keep it in the repo root, keep the
status checklist at the bottom updated, and re-read it at the start of every
session.

> **History (2026-07-13):** the original spine was tmux + tmux-resurrect +
> tmux-continuum. It was replaced by an **owned Rust session daemon** because,
> for a distributable cross-platform product, an external tmux dependency +
> double terminal emulation + the control-mode tax were long-term liabilities,
> and tmux gives almost nothing on the reboot problem (reboot kills processes
> regardless; "restore" is just save-metadata → re-run). Full rationale and
> design: `docs/superpowers/specs/2026-07-12-amber-session-daemon-design.md`.

## Core architecture (never violate without asking first)

1. **The `amber` daemon is the single source of truth** for session existence,
   naming, cwd, scrollback, and process supervision. It owns the ptys directly
   (`portable-pty`; ConPTY-ready for a future Windows port). One long-lived
   daemon; the app is a **disposable client** holding zero authoritative state.
   Any client (the app, or the `amber attach` CLI) connects over the daemon's
   unix socket.
2. **Every app pane is its own daemon session** — one pty running exactly one
   process (`$SHELL`, or `amber run <name>` which supervises `claude`). Tabs and
   workspaces are app-level groupings encoded in the **session name**
   (`amber-<ws>-<tab>-<ord>-<id>`), so grouping survives reboot with no app
   persistence.
3. **One-way data flow.** User gestures → socket control messages
   (`Create`/`Attach`/`Kill`/`Rename`/`Resize`/`Input`); daemon events
   (`Output`/`SessionList`/`Exit`/…) are the only thing that mutates
   pane-existence/grouping state in the UI. Never optimistically
   create/destroy/rename locally. Split geometry is the one app-owned bit — a
   small atomic-write sidecar JSON; grouping must still be reconstructable from
   session names alone if the sidecar is missing (geometry falls back to equal
   splits).
4. **Raw bytes, one emulator.** The daemon streams raw pty bytes over the socket
   (length-prefixed frames, no escaping) straight to **xterm.js**. There is no
   second terminal emulator and no control-mode layer. Terminal bytes never
   touch the Electron main process — a dedicated client `utilityProcess` talks
   to the daemon socket and forwards to the renderer via MessagePort; the main
   process does window management only.
5. **Rendering:** xterm.js + `@xterm/addon-webgl` (never the DOM renderer;
   on WebGL context loss dispose the addon and fall back to xterm's built-in
   DOM renderer — xterm 5+ ships no separate canvas addon). xterm instances live
   outside React reconciliation — imperative writes via refs. React renders
   chrome only. Never a React state update per output chunk.
6. **Persistence is the daemon's job, not the app's.** Crash survival: the
   daemon outlives every client. Reboot survival: the daemon snapshots session
   metadata + capped raw-byte scrollback to a state store
   (`$XDG_STATE_HOME/amber-ide/`) on a config-driven timer **and** on `SIGTERM`
   (the pre-reboot final snapshot), and restores every session on start —
   deterministically, with **no send-keys**. There is no tmux, resurrect, or
   continuum.
7. **Claude is supervised, resumed precisely.** A `claude` session's pty runs
   `amber run <name>`, which loops `claude --dangerously-skip-permissions
   --resume <recorded-id>` (falling back to a fresh start; on a user quit —
   Ctrl-C / clean exit — or after bounded retries on crashes it drops to a
   shell so a pane never silently dies). The recorded id comes from a
   generated per-session `SessionStart` hook (`amber hook`) that rewrites it on
   every fire (ids rotate on resume/clear/compaction). Claude is resolved via
   the **login shell** and cached in config — never the daemon's own PATH (the
   original bug).
8. **Languages:** **Rust** for the daemon and all infra binaries (one
   dependency-free `amber` binary, static musl on Linux / universal on macOS);
   **TypeScript strict** for the Electron app. No native Node addons.

## Out of scope — do not build

Windows support (deferred, though `portable-pty` keeps the door open — do not
add a Windows target without asking); floating/overlapping panes; multiplexing
inside a session (every session stays one pty running one process); SSH
connection manager; AI chat UI; themes/settings beyond minimal.

## Stack

- **Daemon/CLI:** Rust, Cargo workspace (`amber-core` lib + `amber` bin),
  `portable-pty`, `clap`, `nix`, `signal-hook`. No external runtime deps.
- **App:** Electron (current stable) + electron-vite, TypeScript strict, React
  (chrome only), xterm.js + webgl addon, vitest.
- **Protocol:** length-prefixed binary frames over a unix socket
  (`amber-core::proto`) — control messages (serde) + raw `Data` frames.

## Repo layout

- `crates/amber-core/` — `ring` (scrollback), `proto` (wire codec), `state`
  (atomic store + config). Pure/testable.
- `crates/amber/` — `pty` (owned child + fan-out), `manager` (save/restore),
  `daemon` (socket server), `attach` (raw-mode client), `claude` + `supervisor`
  (resume/continue supervision), `main` (CLI).
- `infra/daemon/` — systemd user unit, launchd agent, `install.sh`, reboot
  torture-test doc.
- `scripts/dist.sh` — static/universal release builds.
- `docs/superpowers/specs/` — the design spec.

## Build status

- [x] Slice 0 — daemon spine: pty ownership, ring, proto, state, save/restore,
  socket daemon + `attach`/`ls`/`create`. Proven: restart → sessions restored.
- [x] Slice 1 — full control protocol + multi-client fan-out (folded into 0).
- [x] Slice 2 — claude supervision (`amber run`/`hook`, resume/continue,
  login-shell resolution).
- [x] Slice 3 — snapshot timer + SIGTERM final snapshot + systemd/launchd boot
  units + `install.sh` + reboot torture doc.
- [x] Slice 4 — subscriber backpressure (flat memory under fast producers);
  static musl / universal release builds. (True ~16 ms output batching landed
  in the gap-fix pass below.)
- [x] Slice 5 — `amber ctl doctor`/`status`/`install`/`snapshot-now`; old tmux
  infra deleted; this constitution rewritten.
- [x] Hardening pass (2026-07-13) — attach SIGWINCH + socket-close/Exit
  teardown (poll loop); per-subscriber backpressure isolation; child-exit
  lifecycle (Exit frames, subscriber close, session reaping); subscription
  release on client disconnect + `Detach`; live-socket steal guard; frame
  length cap; session-name validation; spawn-error child cleanup. `Rename`
  returns an explicit error (unsupported until supervisor rebind exists).
- [x] App Slice 1 — daemon protocol extension: `SessionInfo`,
  `WatchSessions`/`ListSessionsDetailed`/`Sessions`/`SessionsChanged`, watcher
  registry + create/kill/reap broadcast. Spec:
  `docs/superpowers/specs/2026-07-13-amber-ide-app-design.md`.
- [x] App Slices 2–3 — Electron walking skeleton: electron-vite + TS strict +
  React scaffold, byte-compatible `proto.ts`, self-healing daemon boot,
  multiplexed utilityProcess (`connection`/`router`), per-pane MessagePort
  brokered main→preload→renderer, `Pane.tsx` xterm+webgl. **Proven end-to-end on
  a live GUI**: real daemon → utilityProcess → MessagePort → xterm render, and
  keystrokes → daemon → pty, 1× each direction. Plan:
  `docs/superpowers/plans/2026-07-13-amber-ide-app-slices-1-3.md`. (Headless
  proof: `app/test/realDaemon.test.ts`. Env note: kernel 6.17 needs
  `AMBER_NO_SANDBOX=1 AMBER_SOFTWARE_GL=1` — see the design spec / env memory.)
- [x] App Slice 4 — reducer (`store`) + `names`; tabbed multi-pane UI; create/kill.
- [x] App Slice 5 — binary split tree (`layout`) + geometry sidecar
  (`layoutFile`, atomic IO); interactive split/resize/close; persist + restore.
- [x] App Slice 6 — workspace switcher; claude panes (`kind=claude`); reconnect
  (auto-backoff, re-subscribe + reattach, banner). **Full IDE surface working on
  a live GUI** (kernel-6.17 box needs `AMBER_SOFTWARE_GL=1 AMBER_NO_SANDBOX=1`).
  Fixes shipped: claude fresh-start for new sessions; deferred split placement;
  per-pane ResizeObserver; DOM renderer under software GL; layout-load gate.
- [x] App Slice 7 — packaging: electron-builder (AppImage/dmg), bundled `amber`
  resolver. App packaging (`npm run dist` → `app/scripts/dist.sh`) obtains the
  distributable binary by invoking repo-root `scripts/dist.sh` (static-musl on
  Linux / universal on macOS) and bundles THAT artifact — not a host glibc build
  (the Linux path asserts the staged binary is statically linked before
  bundling). **AppImage built with amber bundled.** Packaged
  first-run does a cargo-free install (copies amber to `~/.local/bin/amber` +
  writes the boot unit directly — systemd user unit on Linux, launchd agent on
  macOS — since the ephemeral AppImage mount can't back a boot unit). Running
  the installed app end-to-end on a real Mac (needs the user's normal-hardware
  machine; this box's kernel 6.17 forces the software-GL flags) remains to
  verify.
- [x] Gap-fix pass (2026-07-13) — closed the review gaps: spec §5 raw-attach
  semantics (`raw_client` Attach flag, terminal reset, claude backlog skip +
  repaint nudge); ~16 ms pty output batching (spec §9); packaged-macOS launchd
  install; app menu "Quit amber daemon" (the only app path that stops it); CLI
  `kill`/`rename` + `amber ctl uninstall` (spec §2/§10; rename still surfaces
  the daemon's unsupported error); `claude.rs` warns-and-skips wrong-shaped
  user JSON instead of clobbering/panicking; supervisor resume-ladder helpers
  extracted + unit-tested. Still open: renderer component tests (Pane/SplitView
  — deferred with Playwright E2E), aarch64 static build (needs musl-cross
  linker), real-Mac + reboot-torture verification (manual).
- [x] UX pass (2026-07-14) — draggable panels: a grip in each pane's control
  strip drags the whole pane; the cursor is hit-tested against `paneRects`
  (window-listener, mirroring the divider drag), a highlight overlay marks the
  drop zone, edge zones re-split the target (`layout::moveLeaf`) and the center
  zone swaps two panes; `Pane` memoized so drag re-renders don't reconcile
  terminals. Claude user-quit now drops to a shell: a clean exit, exit code 130
  (claude's raw-mode ^C path), OR death by SIGINT all classify as a user quit in
  `supervisor.rs`, falling through to the shell fallback instead of closing the
  pane (only genuine crashes retry).
  `moveLeaf` + SIGINT classification unit-tested; renderer typechecks and the
  bundle builds. Still open: the live drag gesture + claude ^C→shell need
  manual verification in the running GUI (renderer-component UI still deferred).
- [x] Attach detach hotkey (2026-07-14) — `amber attach` gains tmux-style
  `Ctrl-b d` detach: a prefix state machine in `run_client` (`Ctrl-b d`
  detaches via the existing `Detach` frame; `Ctrl-b Ctrl-b` sends a literal
  prefix; `Ctrl-b <other>` is dropped), armed state crossing reads.
  `AMBER_PREFIX=C-a` remaps, `--no-prefix` disables (pure-raw escape hatch,
  keeps core rule #4). `amber attach` with no name attaches the newest live
  session — adds a serde-default `SessionInfo.updated` ordering key populated
  by the daemon (app-facing `proto.ts` updated, decode-only). tty-only attach
  banner names the detach key. Pure `resolve_prefix`/`pick_newest`/`scan_prefix`
  unit-tested; verified end-to-end against a live daemon (attach-newest, detach,
  prefix remap, bad-env fallback, `--no-prefix` passthrough, sessions survive).
  Spec: `docs/superpowers/specs/2026-07-14-attach-detach-hotkey-design.md`.
- [x] Attach session indicator + nesting refusal (2026-07-14) — `amber attach`
  gains an OSC 2 terminal title (`amber: <name>`, XTPUSHTITLE/POP; always on
  for a tty, survives alt-screen, no pty-size impact) and a **best-effort**
  bottom status bar: reserves the last row by sizing the child `rows-1` +
  DECSTBM, with an `AltScreenTracker` (bounded CSI state machine, NOT an
  emulator) so the bar never paints over a full-screen TUI; self-heal redraw
  only on init/SIGWINCH/alt-exit (never per-batch — a mid-stream redraw could
  inject into a child's split escape sequence); shown only for `kind==shell`
  sessions (a claude session is a full-screen TUI already on the alt screen the
  raw client can't observe — drawing there would corrupt it); `--no-status`
  opt-out; teardown runs on all exit paths incl. errors. **Accepted tradeoff:**
  a pty has one shared winsize, so the reserved row shrinks the child for every
  client incl. the GUI, and can flap when both attach (tension with core rules
  #1/#3 — surfaced to the user, who accepted). Also refuses attaching inside an
  amber pane (`AMBER_SESSION`) unless `--force`/`AMBER_ALLOW_NEST=1`. Pure
  `render_status_line`/`AltScreenTracker`/`nest_refusal` unit-tested; real-pty
  verified: bar drawn on shell, **zero draws during alt-screen** (no TUI
  corruption), redraw + scroll-region reset on exit, clean detach, nesting
  refused. `run_client` refactored to break-with-`ClientEnd` + one cleanup
  block. Spec: `docs/superpowers/specs/2026-07-14-attach-status-nesting-design.md`.
- [x] Backlog head-of-line fix (2026-07-15) — **the app's "nothing works" bug**:
  every control gesture (close pane / new tab / split / new pane) silently did
  nothing while terminals still rendered. `Attach` wrote the up-to-2 MiB
  scrollback backlog **inline on the connection's read thread**; since the app
  multiplexes control + all pane data on ONE socket (rule #4), a client slow to
  render a large backlog froze that read thread, so every `Create`/`Kill`/
  `Resize` queued behind the `Attach` went unread (output kept flowing — it
  rides per-attach forwarder threads — which is why panes looked alive). Worsened
  as scrollback grew; intermittent because it depends on socket-buffer
  autotuning + client drain speed. Fix: the forwarder thread replays the backlog,
  so the read thread never blocks on it. Sent as ONE frame (chunking would fire
  `Pane.tsx`'s post-first-message `MOUSE_RESET` mid-replay). Regression test
  `crates/amber/tests/backlog_hol.rs` (asserts daemon state, not a reply — a
  reply would have to be written back to the stuck socket). Verified live: with a
  2 MiB-backlog pane attached, +Pane/+Tab/close all take effect (all three were
  no-ops before). **A running daemon keeps the old code — it must be restarted
  for this fix to take effect.**
- [x] Audit-fix pass (2026-07-16) — full-repo audit, findings fixed. Daemon:
  watcher `SessionsChanged` broadcast made non-blocking (bounded per-watcher
  queue + forwarder thread + 1 s `SO_SNDTIMEO` on the shared writer, laggard
  eviction — same HOL class as the backlog fix; previously one wedged GUI
  client stalled other clients' Create/Kill AND the snapshot timer);
  `restore()` log-and-skips an unrestorable session instead of aborting the
  whole daemon start; `atomic_write` tmp names unique per call (was per-pid);
  stale-session write/resize failures logged. App: utilityProcess crash
  supervision (disconnected banner + capped-backoff relaunch + `childEpoch`
  pane-port re-acquisition); frame-decode errors can no longer kill the
  utilityProcess (destroy socket → reconnect); daemon `Error` frames surface
  in a dismissible banner; pane close no longer optimistically edits the
  layout (one-way flow restored; daemon `Kill`/reap broadcasts prune the
  leaf); `keys.ts` chord parser unit-tested. Infra: GitHub Actions CI
  (clippy `-D warnings` + cargo test + app typecheck + vitest; lint omitted —
  pre-existing ESLint-v9 flat-config gap); `app/scripts/dist.sh` now bundles
  the static-musl (Linux) / universal (macOS) amber with a static-linkage
  assertion (was silently shipping the host glibc build); spec status headers
  corrected; app version synced to 0.0.1. Rust 155 tests + app 79 tests green,
  clippy clean. Still open: live-GUI verification of child-crash recovery;
  first real CI run; untimed `write_all` in `write_frame`/Output forwarders on
  a wedged client (pre-existing, ticket-worthy — apply the watcher-style
  timeout discipline).
- [x] UI/UX pass (2026-07-17) — 10 reviewed tasks (subagent-driven; plan:
  `docs/superpowers/plans/2026-07-17-ui-ux-improvements-plan.md`). App:
  actionable empty/loading states + dead-overlay close; keyboard pane
  navigation (Cmd/Ctrl+Shift+arrows), `CHORD_TABLE` single source + help
  overlay (`?`), aria/focus-ring pass; drag threshold + Escape cancel +
  tokenized drop zones; tab/workspace rename + tab close/drag-reorder
  (sidecar `label`/`tabOrder`); live OSC pane titles + font-size chords
  (sidecar `fontSize`); per-pane scrollback search (`@xterm/addon-search`,
  Cmd/Ctrl+Shift+F); pane zoom (Cmd/Ctrl+Shift+M, zoom keyed `ws:tab`) +
  header context menu (kind-override split, copy cwd); freeze/park a pane
  with a note (sidecar `frozen` map — display-only parking: input blocked +
  blurred, activity suppressed, daemon untouched). Daemon: `ReportRunState`
  (supervisor fire-and-forget) + `SessionInfo.run_state` → claude panes show
  claude/retrying/shell-fallback dots; rate-limited (500 ms) `Activity`
  events on pty output → background-tab activity dots — both ride the
  existing bounded watcher broadcast. Gates: Rust 164 tests + clippy clean,
  app 140 tests + typecheck + bundle green. Still open: live-GUI gesture
  verification (renderer components still test-deferred); running daemon
  needs restart for run-state/activity events.
- [x] Workspace save/load (2026-07-17) — manual save/restore of workspaces to
  portable `.amberws` JSON (structure + scrollback). Spec:
  `docs/superpowers/specs/2026-07-17-workspace-save-load-design.md`. Daemon:
  `DumpBacklog`/`Backlog` control msgs — ring snapshot sent as ONE frame off
  the read thread (Attach-forwarder discipline; ring ≤2 MiB ≪ 64 MiB frame
  cap). App: `workspaceFile.ts` (versioned parse/serialize, placeholder tree
  rewrites — write-clean, shape-guarded), toolbar 💾/📂 + native dialogs
  (atomic write), scope dialog (current/all ws), load dialog (new ws /
  replace current w/ confirm; multi-ws replace = first→current, rest at free
  numbers), name-keyed dump correlation (5 s timeout → empty + straggler
  banner), fresh sessions via `createSession` only (one-way flow; sidecar
  commits after daemon confirms — pending-placement pattern), saved
  scrollback replayed once into xterm at mount via staged ref-map (no Pane
  prop churn). Claude panes load as fresh claude (no resume; history under
  alt screen). Gates: Rust 167 + clippy clean, app 181 tests + typecheck +
  bundle green. Daemon restart required for DumpBacklog; live-GUI dialog/
  replay verification manual (renderer components test-deferred).

- [x] Desktop install (2026-07-17) — Linux AppImage launcher integration: app
  menu "Install desktop shortcut" (shown only when `$APPIMAGE` set) copies the
  AppImage to stable `~/Applications/amber-ide.AppImage` (self-copy guard),
  installs icon + `.desktop` (`StartupWMClass` for taskbar pin grouping),
  best-effort cache refresh; idempotent = repair/upgrade path. Custom amber
  prompt-glyph icon at `app/build/icon.png` (electron-builder embed) +
  `resources/icon.png` (extraResources, copied at install without extracting
  the AppImage). Pure `desktopInstall.ts` unit-tested (serviceManager split).
  Spec: `docs/superpowers/specs/2026-07-17-desktop-install-button-design.md`.
  Live launcher/pin verification manual (needs packaged AppImage run).

- [x] Browser pane (2026-07-18) — a web-viewer pane kind (`kind:'browser'`):
  an Electron `<webview>` leaf owned entirely by the app-local sidecar, with
  **zero daemon/Rust/protocol changes**. A browser pane has no daemon session
  (spec §2 accepted tradeoff: sidecar-owned only, outside "grouping from names
  alone" — sidecar loss loses it, same class as geometry). Id grammar
  `browser-<ws>-<tab>-<ord>-<id>` (`shared/browserName.ts`); sidecar `browsers`
  map (grouping + URL) on `LayoutFile`; `mergeBrowsers` injects them into
  `groupSessions` output and feeds their ids to `reconcile` as always-live so
  they're never pruned; `SplitView` renders `<Browser>` (webview + URL bar) for
  `kind==='browser'`, hiding terminal-only affordances. Popups + navigation
  policy live in the MAIN process (`setWindowOpenHandler` → system browser via
  `shell.openExternal`; `will-navigate` restricts to http/https/about — Electron
  43 removed the renderer `<webview>` `new-window` event). URL persists on nav
  (debounced sidecar save); reboot survival free via the sidecar; `.amberws`
  save/load routes browser panes to `LoadPlan.browsers` (never `creates`, no
  daemon session). Pure parts TDD'd (browserName/layoutFile/store/workspaceFile
  — 230 app tests + typecheck + bundle green). **Live-verified end-to-end** on
  this box against an isolated private daemon (create → navigate example.com →
  webview renders full-height → app restart → pane restored with its URL → close
  → no phantom). Spec: `docs/superpowers/specs/2026-07-18-browser-pane-design.md`,
  plan: `docs/superpowers/plans/2026-07-18-browser-pane.md`. Renderer components
  (`Browser`/`SplitView`) stay test-deferred (repo pattern).

- [x] Split kind picker + cross-tab/ws pane move (2026-07-19) — **split**: the
  pane header's ⬌/⬍ now open a shell/claude/browser picker (reuses the ctx-menu
  state, so dismissal/clamping/pruning are shared) instead of silently using the
  toolbar dropdown; the ctx-menu's "Split right…/down…" open the same picker.
  **Move**: drag a pane's ⠿ grip onto a tab header, workspace pill, `+ Tab`, or
  `+ ws` to move it there. Grouping is name-encoded (rule #2), so a daemon pane
  moves by a REAL daemon `Rename` — implemented per
  `docs/superpowers/specs/2026-07-18-cross-tab-move-design.md`:
  `StateStore::rename_session` (moves sessions/claude/settings/scrollback
  artifacts, rewrites the embedded name, ordered so a crash never leaves a
  half-session), `SessionManager::rename` (re-key under the sessions lock, shell
  renamed IN PLACE keeping its child + scrollback, claude respawned via
  `restore_one` so its env-bound supervisor `--resume`s the same conversation),
  daemon handler broadcasting `SessionsChanged{added:[to],removed:[from]}` with
  `Created{name}` as the ack (no proto change — the app's decoder throws on
  unknown keys). Spec §3.1 was wrong about the settings file (the hook command is
  `<exe> hook`, no name inside) — it moves unchanged. App: `retargetPane`
  (pure, tested), preload `renameSession` + client router + `proto.ts` `Rename`,
  DOM-hit-tested drop targets with an imperative `.drop-target` highlight (a
  React round-trip per mousemove would reconcile every terminal). Browser panes
  have no daemon session, so they move by a sidecar entry edit (id kept); the
  per-tab `reconcile` prunes the source leaf and appends the target one. Also
  fixed a PRE-EXISTING `claude_supervise` flake (~50%/run: a fork from one test
  thread inherits another's write fd to its fake-claude script → `ETXTBSY` on
  exec; serialized with a test-file mutex). Gates: Rust 195 tests + clippy clean,
  app 235 tests + typecheck + bundle green. **Live-verified** on an isolated
  private daemon: picker splits each kind, claude pane moved tab→ws (name
  `amber-1-1-2-…` → `amber-1-2-0-…` → `amber-2-1-0-…`) staying alive, shell moved
  keeping scrollback + accepting input, browser pane moved across tabs; a renamed session survives a daemon restart (restored from the store under the new name).

- [x] `amber web` — phone browser access (2026-07-19) — a mobile web UI for live
  sessions: list → tap → full-screen xterm → type (drives claude too). Spec:
  `docs/superpowers/specs/2026-07-19-amber-web-mobile-design.md`. It is a daemon
  **client** (rule #1 intact; the daemon still never binds a network interface),
  binding `127.0.0.1` in exactly one place — no flag reaches another interface —
  and fronted by `tailscale serve` for TLS + tailnet-only reach (no in-process
  TLS, no relay, no accounts; that stack stays the collab spec's job). Auth: 32
  random bytes in `<state>/web-token` (0600), carried in the URL **fragment**
  (never sent to the server / logs), POSTed for an `HttpOnly; SameSite=Strict`
  cookie, constant-time compared, failed attempts throttled → 429. Browser
  protocol is its own whitelist — `open`/`close` + raw binary input — mapping
  ONLY onto `Attach`/`Detach`/`Input`; **no browser message can reach
  Create/Kill/Rename/Suspend/Resume/DumpBacklog/Snapshot, and none can reach
  `Resize`** (a pty's winsize is shared with the desktop panes, so a phone-sized
  resize would reflow live work and corrupt a claude TUI — the front end has no
  fit addon and scales/pans in CSS instead). `SessionInfo` gained `cols`/`rows`
  (serde-default, additive) so the phone renders at the session's REAL grid and
  follows it live; `/api/sessions` polls the daemon at 1 s rather than making the
  daemon broadcast on every `Resize` (a divider drag would flood the bounded
  watcher queue and risk evicting the app). Front end is vendored xterm UMD +
  hand-written HTML/CSS/JS embedded with `include_bytes!` (offline, no CDN, no
  bundler) with an on-screen key bar (Esc/Tab/sticky Ctrl/arrows honoring
  `applicationCursorKeysMode`/^C) and touch scrolling (xterm ships none: a
  one-finger vertical drag scrolls the scrollback with flick momentum, and on
  the ALT screen it sends arrow keys instead — a TUI owns its own paging —
  while horizontal drags keep panning the zoomed view). Deviation from spec §8: `/` + assets serve
  WITHOUT a cookie — a fragment token is only readable by JS on the served page,
  so the page must bootstrap first; the boundary is `/api/sessions` + `/ws`.
  Gates: Rust 214 tests ×2 + clippy clean + musl check + no openssl/tokio in the
  tree. **Live-verified** end-to-end on a private daemon: 401 unauth / 401 forged
  cookie / 429 throttle (a good token is refused while throttled), 101 upgrade,
  backlog as exactly ONE binary frame, typing from a 390×844 browser reaching the
  real pty, forbidden control JSON ignored (session alive, geometry untouched),
  key-bar ^C interrupting a `sleep`, and a daemon-side resize to 120×40 followed
  by the phone client without it ever sending a resize. Open: real-phone touch
  behavior over a tailnet (needs the user's device); no server→browser ping, so a
  vanished phone's subscription lingers until the next write times out (10 s);
  behind `tailscale serve` every peer IP is 127.0.0.1, so the auth throttle
  buckets all clients together (a 256-bit token makes brute force moot).

- [x] Editor pane (2026-07-19) — a CodeMirror 6 file editor as a pane kind
  (`kind:'editor'`), with JSON and Markdown specializations. Spec:
  `docs/superpowers/specs/2026-07-19-editor-pane-design.md`. **Zero daemon/Rust/
  protocol change**: like a browser pane it is app-local and sidecar-owned
  (`editors` map + `recentFiles`, id grammar `editor-<ws>-<tab>-<ord>-<id>`), so
  every site that special-cases `browser` had to learn `editor` too — TypeScript
  does NOT catch those (they are runtime `isBrowserName`/`kind==='browser'`
  checks): `newPane`, `+ ws` (its own inline branch — the one that was missed
  first time), `onSplit`, `closePane`, `applyLoad`, `moveTo`, `doSave`'s dump
  filter (now an allowlist), `commitLoad`'s `liveForFix`. Unsaved work is the
  correctness-critical part: dirty dot, debounced draft to
  `<state>/drafts/<paneId>.txt`, draft-restore bar after a restart, a close guard
  (save/discard/cancel, cancel ABORTS), and mtime-conflict detection on save
  (overwrite/reload/save-as, never a silent clobber). All disk access lives in
  main (`editorFiles.ts`: atomic tmp+rename, 8 MiB cap, NUL-byte binary sniff,
  regular-file check, and paneId grammar validation + a drafts-dir containment
  assert — an unvalidated id would be a path-traversal write primitive). JSON:
  lint with real line/col, format/minify/sort-keys, folding, tree panel with
  JSONPath copy + cursor jump. Markdown: outline, editing helpers (bold/italic/
  code/link/list/checkbox/table), and a preview rendered into a **`sandbox=""`
  srcdoc iframe** — markdown can carry scripts and this renderer holds the
  file-write bridge, so the frame is the security boundary (local images are
  inlined as data: URIs by main; remote images are never fetched; split-mode
  scroll sync is therefore NOT possible and was dropped rather than relaxing the
  sandbox). Gates: app 352 tests + typecheck + bundle green (Rust untouched).
  **Live-verified**: create via `+ Pane`/split-picker/`+ ws`, restore-from-sidecar,
  JSON format/sort/tree/lint, dirty→draft→restart→restore→discard, save-to-disk,
  close guard (cancel aborts, discard closes + clears the draft), cross-tab drag
  keeping the paneId (so the draft follows), markdown preview + live update +
  bold + the link input. Three live-only bugs fixed in the pass: app-local panes
  were pruned from the `titles` map on every `Sessions` event (pre-existing for
  browser panes — their OSC title never stuck); an iframe given `srcdoc` while it
  has no layout box is PERMANENTLY inert (later assignments never retry — the
  preview now waits for a non-zero box via ResizeObserver); and a Discard close
  had its draft recreated by the pane's unmount flush (the guard now calls the
  pane's `discardDraft()` first). Still manual: the native open/save-as dialogs
  and the `.amberws` round-trip (unit-tested; a native modal can't be driven
  headlessly). NOTE: `npm install` is required after pulling this — it adds the
  CodeMirror 6 packages + `marked`.

- [x] Pane `#index` in the header (2026-07-19) — each daemon pane's title leads
  with its `amber ls` index (`#3 ~/proj · shell`) so a pane can be reached from
  any terminal with `amber attach 3`. The index is derived by mirroring the
  daemon's contract EXACTLY — by-name sort, 1-based, no alive filter (`run_ls`
  in main.rs and `attach::pick_by_index` both sort by name for this reason) — so
  it is positional and renumbers on create/kill just like `ls`. Pure
  `sessionIndex` in `store.ts` (TDD'd) feeds `deriveTab`; app-local panes
  (browser/editor) have no daemon session and so no index. Gates: app 359 tests
  + typecheck. **Live-verified** against a private daemon: headers showed #1/#2/#3
  matching `amber ls`, killing session 1 renumbered both the CLI and the headers
  identically, and `amber attach 2` typed into the pane whose header read `#2`.

- portable-pty: drop the local `slave` after `spawn_command` so the reader sees
  EOF on child exit; keep `master` alive; the reader is a **blocking**
  `std::io::Read` (dedicated thread); `take_writer()` is one-shot;
  `clone_killer()` for out-of-band kill.
- A TUI (claude) respawned **detached at boot** must get a real pty size (never
  0×0) and the reader must drain even with zero subscribers — else it can exit.
  This is the failure mode that plausibly broke the old tmux relaunch.
- Subscriber queues are **bounded** — when ALL subscribers are saturated the
  pty is backpressured (flat memory); a lone laggard among healthy subscribers
  is disconnected after a bounded grace instead of freezing the session. Bytes
  are never skipped for a live subscriber.
- Restored pane cwds fall back to `$HOME` if the dir no longer exists — keep
  torture dirs out of `/tmp` (wiped at boot).
- The per-connection **read thread must never do an unbounded blocking write to
  the client**. Control and pane data share one socket, so anything it blocks on
  stalls every control frame behind it — the client goes on rendering while every
  gesture dies silently. Big writes (backlog) belong on the forwarder thread.
  Symptom shape to recognise: output fine, control dead, worse over time.
- Socket-buffer autotuning makes this class of bug **intermittent** — the same
  2 MiB write blocks or doesn't depending on the host and the client's drain
  speed. Never conclude "not reproducible" from one green run; assert on daemon
  state, and force the block (undrained client + a ring filled to its cap).
- `PtySession` must stay `Send + Sync` (all fields mutex/atomic-guarded) — the
  daemon shares it across connection threads.

## Working agreements

- **TDD**: write the failing test first, watch it fail, then minimal code.
  Unit-test the pure parts (ring, proto, state, claude argv/hook); integration
  tests for the daemon/supervisor use fake stubs, not mocks.
- Work in a git worktree; conventional commits at each milestone; keep
  `cargo clippy --workspace --all-targets` clean.
- If anything conflicts with these core rules, **stop and ask** instead of
  deviating.
