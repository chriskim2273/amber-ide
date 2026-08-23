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
  with a note (sidecar `frozen` map — input blocked + blurred, activity
  suppressed; superseded for claude panes by the freeze grace below, which
  suspends the child after 30 s). Daemon: `ReportRunState`
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
  fit addon and scales/pans in CSS instead). **As of this writing (2026-07-19)**
  — `Create`/`Kill`/`Rename`/`Suspend`/`Resume`/`DumpBacklog` were widened onto
  this same whitelist by the 2026-07-31 "Remote mosaic" entry below, and
  `Resize` by the 2026-08-01 "Browser pty resize" entry below (bounded, not
  unconditional); `Snapshot`/`ReportRunState` remain unreachable to this day.
  `SessionInfo` gained `cols`/`rows`
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

- [x] Wedged-client freeze fix (2026-07-20) — **the daemon froze while idle**,
  twice, taking every session AND the CLI with it; only a manual restart
  recovered it. Root cause (the ticket CLAUDE.md had left open since the
  2026-07-16 audit): `write_frame` did an UNTIMED `write_all` to a client. The
  app is the sole subscriber of every pane, so one app connection that stopped
  draining its socket permanently backpressured EVERY pty — and a fresh
  `amber attach` hung too, because the pty reader sits in `deliver_chunk`'s
  all-saturated retry over a pre-join subscriber snapshot and never picks up the
  new subscriber. Fix: `CLIENT_WRITE_TIMEOUT` (8 s — the watcher path's 1 s is
  right for control frames but this socket also carries a multi-MiB backlog
  replay to a renderer) + `set_write_timeout` on the accepted stream + a new
  `write_bounded`. **`SO_SNDTIMEO` alone is NOT enough and `write_all` is the
  trap**: a timed-out unix write that queued part of its buffer returns a SHORT
  COUNT, not an error, so `write_all` loops and restarts the kernel's clock
  (measured: 8.97 s blocked on one 184 KB frame, then success). `write_bounded`
  adds a wall-clock deadline so the bound is exactly one timeout. On timeout the
  client is logged, `shutdown(Both)`, and dropped; the existing cleanup releases
  its subscriptions, which is what un-sticks the pty (the reader's next
  `try_send` sees `Disconnected` and prunes it). Also fixed a LATENT clobber:
  `watchers.rs` reset `set_write_timeout(None)` after every broadcast, which
  would have wiped the connection-level timeout on the first `SessionsChanged`
  and silently defeated the whole fix — it now saves/restores the previous
  value. Lock audit found NO daemon-wide lock-held blocking write (`broadcast`
  is `try_send`-only; `manager` holds `sessions` across disk IO but never socket
  IO; `pty` fan-out writes with both locks released) — the only lock-held client
  write is the per-connection `SharedWriter`, now bounded. Gates: Rust 225 tests
  ×2 + clippy clean. Regression test `crates/amber/tests/wedged_client.rs`
  (verified to FAIL with the fix reverted): a victim that attaches and never
  reads gets dropped, a healthy client keeps getting replies throughout, and a
  third client then sees output produced AFTER the wedge — proving the pty
  resumed.

- [x] Dangling global-hook GC (2026-07-19) — `ensure_global_claude_hook` dedupes
  by exact command string, so every distinct amber binary path installed its OWN
  `SessionStart` entry in `~/.claude/settings.json`. Dev builds run out of git
  worktrees therefore accumulated entries, and deleting a worktree left claude
  failing that hook on EVERY session start ("hook error … not found") until the
  user hand-edited the file. Installing now first prunes `<path> hook` entries
  whose `<path>` is an amber binary no longer on disk (narrow match: exactly two
  words, second is `hook`, first basename is `amber`, and the path is missing),
  drops a group emptied by that sweep, and leaves every non-amber hook and every
  still-existing amber binary strictly alone. TDD'd both ways (prunes the
  dangling one + keeps a live one). Rust 223 tests, clippy clean.

- [x] Stable session slots (2026-07-19) — replaces the positional index shipped
  hours earlier: killing a session no longer renumbers the others. Spec:
  `docs/superpowers/specs/2026-07-19-stable-session-slots-design.md`. The daemon
  owns a `slot: u32` per session (`SessionMeta` + `SessionInfo`, both
  `#[serde(default)]` so the wire stays additive), assigned **lowest-free**,
  persisted, surviving a daemon restart and a `Rename`. `amber ls` prints the
  slot and `amber attach <n>` resolves by it (`pick_by_slot`, deliberately with
  NO positional fallback — a fallback would resurrect the ambiguity). The app no
  longer computes a number at all (`sessionIndex` deleted): the slot rides
  `SessionInfo` → `PaneModel` → the header, and a pane whose daemon reports slot
  0/absent shows NO prefix rather than a wrong one. **Allocation dedupes against
  every session the daemon still lists, dead-but-unreaped included** — `ls`, the
  app and `attach` all keep listing a dead session until reap (that's the
  "exited · close pane" overlay), so allocating against live-only would hand its
  number to a new session and print two `#2`s. A slot frees on REMOVAL, not on
  death. Gates: Rust 221 tests ×2 + clippy clean, app 357 tests + typecheck.
  **Live-verified**: headers matched `ls`; killing the middle of three left the
  others at #1/#3 in both CLI and app; a pane left dead-but-listed did NOT have
  its number taken by the next create (it got #3, not the dead #2); slots
  survived a daemon restart; `amber attach 3` typed into the pane whose header
  read `#3`; an unknown slot errors with "no session with slot 9 (see `amber
  ls`)". **A running daemon must be restarted to emit `slot`** — until then the
  app sees 0 and shows no prefix.

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

- [x] Freeze grace — suspend/resume claude (2026-07-19, commit 49c3d8c) —
  freezing a **claude** pane frees its RAM: the app sends `Suspend`
  immediately (the original 30 s `SUSPEND_GRACE_MS` timer was removed
  2026-07-22 at the user's request — freeze means killed now, not eventually,
  which also deleted the restart-inside-the-grace gap);
  `manager.signal_suspend` SIGUSR1s the pane's `amber run`
  supervisor, which kills claude, reports `run_state:"suspended"` (amber pane
  dot → "suspended (RAM freed)") and idles holding the pty — session record,
  pty and attachments all stay alive. Unfreeze sends `Resume` (SIGUSR2); the
  supervisor resets `escalation`/`prev_id` so the resume ladder re-reads the
  hook-recorded id and relaunches `claude --resume <id>` — the SAME
  conversation, not a fresh one. The kill is NOT counted against the crash
  budget. Non-claude/unknown sessions reply `Error`; shell panes freeze
  display-only as before. (2026-07-22) unfreeze after an APP RESTART also
  resumes: the in-memory `suspendedRef` is empty then, so `unfreezePane` falls
  back to the daemon's `run_state === 'suspended'` (rule #1) instead of
  leaving the pane parked forever. Gates: Rust 4 supervisor tests (the
  suspend one now asserts the relaunch argv carries `--resume <recorded-id>` —
  mutation-checked: it fails if the ladder escalates to Fresh) + clippy clean,
  app 389 tests + typecheck. Live claude round-trip (freeze → real claude
  killed → unfreeze → same conversation) still manual.

- [x] Adopt + bare `amber` (2026-07-23) — a CLI session and a pane are now the
  same thing from both ends. **Adopt**: the 🧹 Sessions dialog already listed
  sessions no pane can show (a name the grammar rejects belongs to no
  workspace); rows tagged `no pane` gained an **Adopt** button that renames the
  session into the current ws/tab at the next free ord. The rename IS the
  adoption — grouping is name-encoded (rule #2), so the pane lands via
  `SessionsChanged` → `groupSessions` → reconcile, the same path a
  reboot-restored session takes; no sidecar write, no optimistic tree edit, no
  daemon change. **Bare `amber`**: typing `amber` with no subcommand printed
  clap's help; it now does what typing `tmux` does — create a shell session in
  the CURRENT directory and attach to it (`command: Option<Command>` →
  `run_new`). Deliberately not "attach the newest" (that is `amber attach` with
  no name). Named `s<n>`, lowest free, holes reused: the `s` prefix keeps it out
  of `amber attach <n>`'s way, where a bare integer means a SLOT — a session
  literally named `3` would be unreachable by name. `s<n>` is outside the pane
  grammar on purpose, so a CLI session stays a CLI session until the user adopts
  it. Reuses attach's nesting refusal (`AMBER_SESSION` → refuse unless
  `AMBER_ALLOW_NEST=1`), and `create_session`/`connect_daemon` were split out of
  `run_create`/`resolve_target` so the bare path creates silently (a "created"
  line would be scribbled over by the attach decoration) and gets the friendly
  "is the daemon running?" error. Gates: Rust 226 tests + clippy clean, app 389
  tests + typecheck. **Live-verified** on a private daemon: `work` showed `no
  pane` + Adopt → click → daemon renamed it to `amber-1-1-1-<id>` (slot kept),
  pane appeared, and `echo $$` gave a pid 50 s OLDER than the adopt — the child
  was preserved, not respawned; bare `amber` created + attached `s2` in `/tmp`
  with the status bar, `Ctrl-b d` detached clean, killing `s1` made the next
  bare `amber` reuse `s1`, and running it inside a pane was refused by name.
  Claude adoption rides the already-proven cross-tab rename path (not re-tested).
  Also closed a PRE-EXISTING daemon hole the new naming made reachable:
  `SessionManager::create` inserted unconditionally, so a `Create` on a live
  name dropped that session's `Arc` out of the table and orphaned its child —
  two racing bare `amber`s can pick the same `s<n>` off the same listing. Now
  checked under the sessions lock (the loser's freshly spawned child is killed).
  **Known non-parity with tmux:** bare `tmux` starts its server; bare `amber`
  errors when the daemon is down (it is boot-managed, rule #6, so this only
  bites a stopped daemon).

- [x] Grok session kind (2026-07-26) — a second supervised agent: `kind:"grok"`
  is a pane whose pty runs `amber run <name> --kind grok`. Spec:
  `docs/superpowers/specs/2026-07-26-grok-session-kind-design.md`. Much smaller
  than claude support because grok's id does NOT rotate and amber can ASSIGN it:
  `grok --session-id <uuid>` names a NEW conversation, so there is no
  `SessionStart` hook, no per-session settings file, no global hook, nothing to
  GC. The id is recorded in the SAME `claude/<name>.json` (rename/kill/adopt
  already move that file — a `grok/` dir would have meant touching both).
  Ladder rules that are not optional: a fresh start ALWAYS mints a new uuid
  (grok errors "Session ID … is already in use", so re-passing the recorded one
  fails instantly and burns the whole retry budget), and `--resume` is only
  handed a UUID-shaped id (its value is OPTIONAL — a blank one silently resumes
  the most recent conversation in the cwd, the hijack `--continue` was avoided
  for). Resume gets **2 attempts** before minting a new conversation, unlike
  claude's one: measured, a just-killed pane can 404 ("not found locally,
  restoring from remote") on the 200 ms relaunch and resume fine right after.
  The agent is passed on argv, NOT read from the store: `create` spawns the pty
  before persisting metadata, so a supervisor that read `sessions/<name>.json`
  races it — observed live launching **claude** for a grok pane. Kind-gated
  sites now ask `SessionKind::is_agent()` / `isAgentKind()`: raw-client backlog
  suppression, run-state reporting, suspend/resume, rename respawn, pane/tab
  dots, `.amberws` dump filter (TypeScript catches none of the app ones — same
  runtime-string class as the editor pass). run_state strings stay spelled
  `claude*` for both agents (they name the phase, not the binary). Scope cuts:
  no global grok hook, no hand-started-grok detection (`resume_as_claude` is
  still claude-only), and the cleanup dialog's conversation labels read claude
  transcripts only (a grok row falls back to its cwd). Gates: Rust 245 tests +
  clippy clean, app 393 tests + typecheck + bundle. **Live-verified** on a
  private daemon: minted `--session-id` launch, real turn, `kill -9` → `--resume
  <same id>` with the conversation intact, daemon restart → restored as grok and
  still intact, SIGUSR1/USR2 freeze→unfreeze, `amber rename` respawn; and in the
  **live GUI** (xvfb+CDP): picker → pane with its own blue dot and header
  `#1 grok · grok`, grok TUI rendered, typed prompt answered, OSC title live.
  NOTE: a running daemon must be restarted before it accepts `kind:"grok"`.

- [x] Compat-mode false positive (2026-07-26) — **the "app gets laggy after a
  while" bug**. Measured on the live box: the GPU process was burning **471 %
  CPU while idle** (10 d 11 h of CPU in 22.9 h of wall clock, ~11 cores) with an
  idle RTX 3070 in the machine; the renderer was at 17 % — so it was never a
  React/xterm leak. The app was running SwiftShader. Why: at 03:55:38 an
  X-server/NVIDIA glitch took out all 16 Firefox processes, hung Discord's web
  contents, and killed amber's GPU process (`GPU process exited unexpectedly:
  exit_code=512`). The compat detector's `child-process-gone`/`render-process-gone`
  listeners were registered for the WHOLE session, so it read an unrelated
  desktop-wide event as "this machine has no GPU", wrote the sticky
  `<state>/render-compat` marker and relaunched itself into software GL —
  marker mtime 03:55:39, relaunched pid started 03:55:41, and it stayed there for
  the next 23 hours. The 2026-07-13 signature-expiry fix did NOT cover this: the
  marker was written under the CURRENT kernel+Electron, so it was honoured. Fix:
  the crash listeners are disarmed after `DETECT_WINDOW_MS` (20 s) — the failure
  they exist for (the kernel-6.17 GPU-shm trap) manifests at startup, never at
  hour 20 — and `compatWorthyReason` additionally ignores `oom`/`killed`, which
  say nothing about GL. Verified with an isolated instance (private
  `XDG_STATE_HOME` + `--user-data-dir`, real X11 — xvfb cannot answer this, it has
  no GPU): hardware GL came up, no marker was written, GPU process idled at
  **28 %** vs the stuck app's 471 %. App 397 tests + typecheck green.
  **Trigger identified (not amber's bug):** `systemd-oomd`. At 03:53:56 it killed
  processes in `amber.service` (18.6 G, memory-pressure Avg10 35.05 %); the
  cascade then took Claude Desktop (03:54:43, `Killed`), Firefox's whole scope
  and amber's GPU process (03:55:38). A first pass blamed the user's nightly
  `~/lowpower/night-mode.sh` for arming PCI runtime PM on the GPUs — **wrong**:
  `sudo` logged that script starting at 03:58:55, three minutes AFTER the crash,
  and the RTX 3070's `power/runtime_suspended_time` is `0 ms` over 25.6 h of
  uptime, so it never runtime-suspends at all (X drives it). Amber's job is only
  to not condemn itself when the GPU process dies for reasons of its own.
  **Recovery for an already-stuck machine: `rm $XDG_STATE_HOME/amber-ide/render-compat`
  (default `~/.local/state/amber-ide/render-compat`) and restart the app** — the
  code fix prevents re-entry but cannot un-write an existing marker.

- [x] Pane display env (2026-07-29) — **image paste into a claude pane did
  nothing**. Claude Code reads the clipboard ITSELF: on Linux it shells out to
  `xclip -selection clipboard -t TARGETS -o … || wl-paste -l …`, then extracts
  with `xclip -t image/png -o > <tmp>`. Those run inside the pane, so they
  inherit the DAEMON's env — and the daemon is boot-started (`WantedBy=
  default.target` + linger) BEFORE the graphical session imports `DISPLAY` into
  the systemd user manager, so it has no `DISPLAY`/`WAYLAND_DISPLAY`/
  `XAUTHORITY` at all (measured on the live box: every pane child had zero
  display vars). `xclip` then dies with `Can't open display: (null)` into
  claude's own `2>/dev/null` — a silent no-op, no error anywhere. **Why it
  "sometimes" worked:** the systemd user manager DOES have `DISPLAY=:1` after
  login, so a daemon (re)started during a graphical session — the app's
  "Restart amber daemon", or a hand-started dev daemon — spawns panes that CAN
  reach the clipboard; only the boot-started daemon can't. Fix: `spawn()` sets
  an allowlist (`DISPLAY`/`WAYLAND_DISPLAY`/`XAUTHORITY`) read from
  `systemctl --user show-environment` — same choke point and same class as the
  existing `login_path()`/`TERM` fixes (the daemon's minimal systemd env is not
  the env a pane needs). Read PER SPAWN, never cached: at boot restore the
  manager env is still empty and a cache would freeze that for the daemon's
  life; per-spawn also self-heals after an X restart for later panes. A missing
  key is left UNSET (never `DISPLAY=`, which fails differently and worse); no
  systemd / non-zero exit degrades to today's behaviour; `cfg(target_os =
  "linux")` only (macOS `pbpaste` needs no env from the Aqua-domain launchd
  agent). Shelling out to `systemctl` is deliberate — rule #8 is about linking,
  not invoking, and `login_path()` already shells out to the login shell.
  Gates: Rust 254 tests + clippy clean. **Live-verified** against a private
  daemon started with `env -u DISPLAY -u WAYLAND_DISPLAY -u XAUTHORITY` (the
  boot condition): in-pane `xclip -t TARGETS -o` succeeds with the fix and
  prints `Can't open display: (null)` with it reverted (`$DISPLAY` empty).
  **A running daemon must be restarted to pick this up** — a live pane's env is
  frozen, so `systemctl --user restart amber` (or the app menu item) is the
  immediate mitigation on an already-running machine. Ctrl-Shift-V (amber's own
  paste chord) still pastes TEXT only — an image clipboard is a no-op there;
  plain Ctrl-V is the gesture that works (it forwards `^V` to claude, which does
  its own clipboard read). Not fixed, upstream: claude's probe accepts
  jpeg/gif/webp but extraction only tries png then bmp, so a JPEG-only clipboard
  still silently fails.

- [x] Memory audit (2026-07-31) — full-repo leak + allocation audit across the
  daemon/CLI and the app (main, client utilityProcess, renderer). Report:
  `docs/superpowers/specs/2026-07-31-memory-audit.md` (every finding classified
  unbounded-growth / bounded-overshoot / churn, with what was deliberately NOT
  changed and why). Baseline measured on the live box: daemon 106 MB RSS at 19
  sessions, cgroup `memory.current` 15.65 GB — of which ~7 GB is claude children,
  so **the child processes remain the uncontrolled memory**, as the 2026-07-17
  monitor design said. **Two real leaks, both app-side:** `Router.detach()` had
  ZERO callers, so the client's port map grew for the app's whole life (session
  names are never reused), every entry pinned a live `MessagePortMain`, and
  `reattachAll()` re-`Attach`ed long-dead names on every reconnect — each drawing
  a daemon `Error: no such session` into the red banner — while the daemon kept
  streaming closed panes into portless channels. Wired the close path (Pane
  unmount → preload → main → client → `detach`, which now closes the port);
  `attach` also closes a port it supersedes (one leaked per re-acquire). **Ring
  was not a ring:** a `Vec` + `drain(..overflow)`, so every push at cap memmoved
  the whole ~2 MiB — a cost fixed at ~cap regardless of push size, so worst for
  the trickling panes the daemon spends its life on (measured 256 B pushes:
  49 µs → 0.035 µs, **1498×**; 256 KiB: 11×). It also retained exactly **2.00×**
  cap, which is ~2 MB/session of heap ADDRESS SPACE (`VmData` 148→125 MB at 12
  full rings) — **not** RSS, which moved only ~130 KB/session; an early draft
  claimed RSS and was wrong, and the end-to-end measurement is what caught it.
  Now a true circular buffer (geometric growth `reserve_exact`-clamped to cap, so
  an idle pane still costs nothing, then in-place wrapping). **The snapshot timer
  rewrote every scrollback file every 10 s regardless of change** — 36 MiB cloned
  + 36 MiB written per tick (~3.6 MB/s forever) for idle panes; `Ring::written()`
  now gates it (bytes on disk byte-identical, so reboot survival untouched;
  counter recorded only on a successful write, so a failure retries). Verified
  live: 12/12 files rewritten per idle tick → **0/12**. **App frame decoding was
  O(n²):** `Decoder.feed` reallocated the whole buffer per socket chunk —
  instrumented at **36.70 MB copied to receive one 2.00 MB frame (17.5×)**, on
  the path every pane's output takes; a read cursor + compaction gives 5.94 MB
  (2.97×). Tests pin the two ways that fix could become a different bug (consumed
  bytes must really be reclaimed; the payload must still be COPIED out, never a
  view onto a buffer compaction rewrites). Gates: Rust **264** tests ×3 + clippy
  clean, app **410** tests + typecheck + bundle. **Live-verified** headless
  (xvfb+CDP) against an isolated private daemon — the detach wiring is the risky
  part, so: workspace switch away/back (the gesture that unmounts panes and fires
  `Detach`) restored panes with scrollback and input intact, pane kill pruned
  cleanly, and a daemon restart under the running app reconnected with **no error
  banner**. Deliberately NOT changed (see the report for the reasoning):
  `deliver_chunk`'s per-subscriber copy (the common case is ONE subscriber, and
  it sits on the backpressure invariants); `session_infos()`'s ~2 file reads per
  session under the sessions lock, on every control gesture; the memory monitor's
  full `/proc` walk every 3 s; and **xterm scrollback depth /
  background-terminal eviction — the user's explicit call to leave alone**, since
  no reading was ever taken of the real running app and they trade the defining
  keep-alive behaviour for RSS. Also newly recorded (pre-existing, not a regression): every
  reconnect replays a full backlog into a terminal that already has it, so a
  flappy daemon inflates renderer memory in 2 MiB steps per pane.
  **A running daemon must be restarted to pick up the ring + snapshot changes.**
  **Follow-ups the user then asked for (same pass):** (a) `Activity`/`MemoryStat`
  are buffered and flushed on a 250 ms timer — React 18 batches the dispatches
  inside the timeout, so N events cost ONE render instead of N (lifecycle/Exit/
  Error stay immediate); (b) a re-attach backlog now RESETS the terminal first,
  killing the duplicate-history growth — **the first attempt at this was wrong
  and live-testing caught it**: reusing the `rearmRef` "next message after a
  reconnect" heuristic made the reset land on a LATER frame and blank the pane
  (marker count 2 → 0) because the replay arrives on its own IPC task and beats
  React's reconnect effect. A reset is not safe to fire on a guess the way
  `MOUSE_RESET` was. Fixed by putting the decision where the fact lives: the
  CLIENT sends the Attach, so it tags the first following `Data` frame
  (`{data, backlog:true}`); `Pane` resets only on a tagged frame, and only after
  it has consumed one backlog (so a `.amberws` staged replay is never wiped).
  `rearmRef` deleted. (c) `DumpBacklog` replies on a new BINARY frame tag 2
  instead of `ControlMsg::Backlog`, whose serde form is a JSON numeric array
  (~8 MB of decimal text per 2 MiB ring, both ends, per pane per save);
  `ControlMsg::Backlog` kept as a decode-only path so a new client still reads an
  older daemon. Two tests caught real things here and were fixed, not worked
  around: the connection test used tag 2 as its "unknown tag", and the TS decoder
  lacked Rust's truncated-frame bounds checks — with the new reused read buffer a
  corrupt length prefix would have read past the frame into a garbage session
  name. **Live-verified**: marker count across a daemon restart 2 → 2 (was 2 → 4
  before, 2 → 0 with the broken attempt), `dumpBacklog` returned a real
  `Uint8Array`, MB labels still live, input still reaches the pty, no banner.

- [x] Remote mosaic (2026-07-31) — `amber web` is no longer terminal-only: it
  renders the workspace/tab/split tree, not just a flat session list. Spec:
  `docs/superpowers/specs/2026-07-31-remote-mosaic-web-design.md` (status
  header updated to match this entry). The editor-pane spec's §1 "the phone UI
  stays terminal-only" narrows to "renders no editor/browser panes" — those
  leaves are pruned and their parent split collapses onto the surviving
  sibling, same as a killed session. **No new route**: `GET /api/sessions`
  changed shape from a bare array to `{sessions, layout}`, and `session_json`
  gained `slot` (`SessionInfo.slot`, the same number `amber attach <n>`
  resolves) — one payload, one auth boundary, one poll, both the initial paint
  and every `{t:"sessions"}` push. A second reader of `<state>/ui-layout.json`
  now exists in Rust, read-only (`crates/amber/src/mosaic.rs`): parsed with
  serde (`Node` as an internally-tagged `kind`/`paneId` enum through
  `Box<Node>`), pruned and collapsed server-side so the front end (hand-written
  JS, no bundler, no test runner) only ever draws an already-correct tree —
  `LayoutFile::default()` on a missing/malformed sidecar, matching the
  desktop's own equal-splits fallback (core rule #3). **The prune rule is a
  property of the daemon's session list — "drop any leaf that is not a live
  daemon session" — never a list of known id prefixes ( `browser-*`/
  `editor-*` are pruned by construction, not by name-checking).** So a fourth
  app-local pane kind needs **zero** Rust change here — the one place this
  feature is immune to the runtime-string bug class that bit the editor pass
  (`isBrowserName`/`kind==='browser'` checks TypeScript can't catch). Only a
  new `WsLayout`/`TabLayout` field the mosaic must display, or a change to the
  `Node` shape, would need a matching Rust change; neither has happened in the
  sidecar's history. §3.1's trap: `Hub::on_frame` returns early when the
  session set is unchanged, but a divider drag/tab rename/workspace switch on
  the desktop changes only the sidecar with the session set byte-identical —
  so `HubInner` now caches both the parsed sidecar and the serialized mosaic
  JSON behind a two-field comparison (`layout_dirty`), and the push fires when
  *either* changed. Sidecar IO runs on the 1 s poll thread, never the daemon
  read thread (same discipline as the backlog/watcher fixes). Full parity from
  the browser — Create/Kill/Rename/Suspend/Resume — with **no sidecar write,
  ever**: every gesture is name-encoded (rule #2) and fire-and-forget, routing
  through the daemon so the desktop app's own reconcile draws the result; a
  pending tile covers the gap until the next 1 s push or 3 s, whichever first.
  The browser whitelist now reaches those five message types and **still**
  never reaches `Snapshot`, `DumpBacklog` or `ReportRunState` (superseded
  2026-08-01 for `Resize` — see the "browser pty resize" entry below: it is
  now reachable, validated and bounded, not forbidden). `Suspend`/`Resume` are
  gated to agent sessions both
  client-side (menu doesn't offer them for a shell) and server-side
  (`is_agent`, the real boundary). Behaviour change worth recording:
  `Open`/`Close` now validate against the daemon's **full** listed set
  including dead-but-unreaped sessions, where they previously used an
  alive-only filter — matches the desktop's "exited · close pane" overlay.
  Gates: Rust 289 tests + clippy clean (`--workspace --all-targets -D
  warnings`); **the app's TypeScript suite was NOT run — this pass touches
  zero TypeScript.** **Live-verified** on an isolated private daemon + private
  `amber web` (playwright): a stale editor leaf pruned with its split
  collapsing onto the survivor, a sidecar-unrecorded session appended at the
  documented `dir:"h"`/`ratio:0.66`, `tabOrder` honoured, ws/tab labels
  rendered, no `recentFiles`/`editors` leak into the payload, the real split
  ratio in the DOM (0.65/0.35 from 465px/248px), a **sidecar-only** change
  (label edit, session set untouched) propagating in 0.46 s (the §3.1 trap,
  proven fixed), tap-to-zoom attaching and showing real pty output, `+ pane`
  creating a real session the daemon confirms (`amber ls`), the tile menu's
  close killing it and pruning the tree, "move to tab" renaming a session on
  the real daemon with its id preserved, all four forbidden control messages
  (`resize`/`snapshot`/`dumpbacklog`/`reportrunstate`) forged down the live
  socket refused — geometry unchanged at 80×24, session alive — and the
  sidecar **deleted** outright still producing a name-derived mosaic rather
  than `null` (core rule #3 holding under total sidecar loss). **Not
  verified live:** the agent freeze/unfreeze round trip — no agent binary was
  available in the private instance; Rust-tested only (the suspend/resume
  control-message construction and the `is_agent` gate). **A running `amber
  web` must be restarted to serve the mosaic** (old code still returns the
  bare array). **Still open (two, both cosmetic):** `activeTab` is emitted as
  `0` for a workspace absent from the sidecar even though tabs are 1-based
  (observed live: the front end falls through to the first tab rather than a
  real active one); and sidecar-unknown panes append in lexicographic rather
  than numeric ord order, so `ord>=10` sorts wrong. **Closed by the
  whole-branch review's fix wave** (the review caught what the per-task ones
  structurally could not): `frozen` was parsed, tested and then never emitted
  or rendered, leaving spec §4.1/§6.1 asserting a state dot that did not
  exist — `render()` now emits `frozen` as **names only** (a note is arbitrary
  user text, same argument as `recentFiles`) and a frozen tile carries a
  marker while staying tappable; `parse_pane_name` accepted a leading `+` on
  numeric fields (`str::parse::<u32>` strips it) where the JS
  `^amber-(\d+)-…` regex does not — reachable not just via `amber create
  "amber-+1-2-3-ab"` on the CLI but from the browser via `{"t":"create"}`,
  the actual security-boundary path this function guards
  (`Create.name`/`Rename.to` validation in `web.rs`), now rejected by a
  digits-only `num()` helper; `append_leaf`'s `dir:"h"`/`ratio:0.66` and
  `node_json`'s `dir`/`ratio` keys were asserted only against the
  deserialized `Node`, never the emitted JSON, so deleting them left every
  test green while the mosaic silently degraded to `app.js`'s fallback
  (`n.dir === 'v' ? 'v' : 'h'`, `n.ratio || 0.5` — always-horizontal 50/50, a
  geometry divergence from the desktop, not a renderer break); `on_frame`'s
  `Sessions` arm pushed a layout rendered against the PREVIOUS session set,
  so the phone showed the flat list for ~1 s at every connect; `inner.layout`
  survived daemon loss, so a page loaded in that window got a stale mosaic
  against an empty session list; and a "move to tab N" while already on tab N
  passed server validation and made `manager::rename` kill and respawn a live
  agent for zero layout change.

- [x] Browser pty resize (2026-08-01) — reverses the web-renderer pivot's
  "the browser can never resize a pty" rule (spec
  `docs/superpowers/specs/2026-08-01-amber-ide-as-a-webapp-design.md` §4), on
  the user's explicit decision: their use case is working from the laptop
  *instead of* the desktop, not peeking at a desktop someone is using, so a
  desktop reflow while they're away is an accepted cost — the desktop re-fits
  its own panes on return and a running TUI repaints on the SIGWINCH the
  desktop already triggers on every divider drag. Deletes the workaround the
  old rule forced (`.reports/fix-geometry.md`): the web build no longer pins
  its xterm grid to the pty's cols/rows and shrinks the font to fit
  (`fitFont`, `serverGeomRef`, the `{geom}` port relay, `MIN_FONT_SIZE`, the
  letterboxing container styles) — all deleted rather than layered on.
  **`app/src/renderer/Pane.tsx` is now byte-identical to its pre-workaround
  version**: zero web-specific branching, confirmed with a diff against the
  commit before the workaround landed. The web build takes the exact same
  `FitAddon` path as Electron. `crates/amber/src/web.rs` gains
  `BrowserMsg::Resize` and a `map_browser_msg` arm that constructs
  `ControlMsg::Resize` only for a session the daemon currently lists and only
  for `cols`/`rows` inside `RESIZE_MIN_COLS..=RESIZE_MAX_COLS` /
  `RESIZE_MIN_ROWS..=RESIZE_MAX_ROWS` (10..=1000 / 4..=300 — the floor is
  comfortably below any real split but well above the 1x1 a crushed/
  backgrounded browser window could otherwise send, which would SIGWINCH a
  full-screen program into repainting garbage and corrupt the desktop's
  layout on return; the ceiling only rejects a broken/hostile client).
  `app/src/web/amber.ts`'s `PaneLink` forwards `Pane.tsx`'s
  `{resize:{cols,rows}}` port message as `{"t":"resize",...}` on the pane's
  own socket, debounced 300 ms to match `main.tsx`'s existing layout-write
  debounce ("only the settled size matters" — reused rather than a second
  policy) so a divider drag doesn't fire one over the wire per animation
  frame. The tests that used to assert `Resize` was categorically
  unreachable were converted, not deleted, to assert the new guarantee
  (reachable only via the validated arm, only within bounds; `Snapshot`/
  `ReportRunState` still categorically unreachable). Gates: Rust 315 tests +
  clippy clean, app 449 tests + typecheck + `build:web` green. **Live-verified**
  full report: `.reports/web-resize.md`.

- [x] Codex session kind (2026-08-10) — a third supervised agent: `kind:"codex"`
  is a pane whose pty runs `amber run <name> --kind codex`. Spec:
  `docs/superpowers/specs/2026-08-10-codex-session-kind-design.md`. Claude-shaped
  (not Grok-shaped): Codex cannot assign a session id on create, so amber
  installs a global SessionStart hook in `$CODEX_HOME/hooks.json` (default
  `~/.codex/hooks.json`) that runs `amber hook` and records into the SAME
  `claude/<name>.json` store. Fresh: `codex --dangerously-bypass-approvals-and-sandbox
  --dangerously-bypass-hook-trust`; resume: `codex resume <id> …`. Never
  `resume --last`. Kind-gated sites use `SessionKind::is_agent()` /
  `isAgentKind()` (codex included). Run-state vocabulary stays `claude*`.
  Doctor records optional `codex_path`. App picker/dots/web create kinds extended.
  Scope cuts: no hand-started-codex detection, no filesystem session scan, no
  permission UI. Gates: Rust unit + clippy clean, app tests + typecheck green.
  **A running daemon must be restarted to accept `kind:"codex"`.** Fake-Codex
  integration covers fresh launch → real `amber hook` ID capture → crash →
  exact-ID resume, including both bypass flags and the never-`--last` invariant.
  Renderer tests cover exact string IDs, shell quoting, control-byte rejection,
  and the interactive picker. `$claude-handoff <id>` is installed as a
  user-level Codex skill; fake-Claude tests cover its safe, non-persistent
  handoff command and installer ownership guards. Full Rust/app gates are green.
  A real installed-Codex create/kill/resume smoke remains manual because
  isolated Amber state does not isolate Codex authentication and conversation
  storage.

- [x] Memory containment + guardian (2026-08-13) — Linux implementation,
  review, soak, and production rollout are complete. Linux uses delegated
  cgroup-v2 slot leaves to isolate the daemon, supervisors, workloads, and
  descendants;
  `MemoryHigh=50%` and per-session `memory.high` are soft boundaries with no
  default `MemoryMax`. The daemon snapshots before parking only old recorded
  agent sessions, preserves manual suspension, and resumes memory-origin panes
  on real terminal focus/input. macOS keeps RSS-based guardian parking without
  cgroup throttling. Automated evidence: Rust 486 tests passed twice; app 481
  passed with one intentional skip; warnings-as-errors clippy,
  typecheck, bundle, systemd-unit, and lockfile gates passed. Rustfmt 1.9 still
  reports repository-wide pre-existing formatting differences, so the full
  automatic gate is not green. Private Linux proof under a 512 MiB transient
  service confirmed slot placement, reclaim without OOM, exact-id resume,
  manual-focus protection, rename/kill/restart persistence, and usable
  nondelegated fallback. A 1,820-second pressure soak completed 180/180 live
  service and CLI samples with stable tasks and zero OOM events. Production Linux
  rollout restored all six sessions, placed daemon/supervisor/workload processes
  in their delegated leaves, launched the new AppImage, and reduced Amber from a
  10.7 GiB pre-upgrade peak to about 1.4 GiB with zero cgroup OOM events. This
  host keeps a dual-mode memory split on the 32 GiB box: Codex-off default
  is Amber `MemoryHigh=20G` inside `app.slice` 24G/26G; when ChatGPT/Codex
  desktop is running, `amber-codex-mem-balance` live-lowers Amber to 10G
  (4G `MemoryLow`) and `app.slice` to 12G/14G so highs stay ≈ RAM
  (Codex 14 + app 12 + session 5) and Codex keeps its 8G protected floor.
  **Still open:**
  real-Mac verification, live mobile/banner gestures, and repository-wide
  formatting cleanup.

- [x] Optimization pass (2026-08-22) — five perf/feature items, branch
  `perf/optimization-pass`. **Delta re-attach backlog**: every re-attach
  replayed the full ≤2 MiB ring into a terminal that already had it; clients
  now present an `(epoch, offset)` watermark on `Attach`
  (`Ring::epoch` per-ring, time/pid-seeded so daemon restarts never match;
  `Ring::since` serves the missing suffix only while fully retained;
  `PtySession::subscribe_from` under the same ring→subs lock discipline).
  Wire: `Attach.resume` whose KEY PRESENCE opts in — only those clients get
  the new `AttachBacklog{name, epoch, end_offset, full}` ack, written by the
  read thread BEFORE the forwarder spawns so it strictly precedes the one
  replay `Data` frame; legacy strict decoders (`amber attach`, amber web)
  never see it. Epochs ride JSON as STRINGS (nanos u64 > JS 2^53; a rounded
  epoch would fail equality every reconnect and silently kill the feature).
  App router: `reattachAll` sends tracked watermarks (surviving terminals →
  delta), fresh mounts send `{epoch:'0'}` (full + ack establishes the
  watermark); ack'd `full` keeps the renderer reset tag, `delta` appends
  untagged, a Data frame in the awaiting window = old-daemon legacy replay.
  Daemon restart can NEVER delta (new epochs by design) — that is correct:
  growth came from same-terminal re-attach, which deltas now. Integration:
  `crates/amber/tests/resume_attach.rs`. **Parallel boot restore**:
  `restore()` split serial-prepare (slot repair/normalize/cgroup leaves) →
  scoped-thread spawn pool capped min(panes, cores, 8) → serial commit with
  identical deferred/cleanup/crash-report semantics; 6 sessions visible
  648 ms after start (live). **Stat-keyed metadata cache**
  (`amber-core::state::FileCache`, (mtime,len)-keyed): session_infos' N+1
  open/read/parse per control gesture and the mosaic's 1 s poll now cost one
  stat per file; corrupt-file tolerance preserved; adds
  `StateStore::remove_claude`. **Guardian /proc walk retired under
  containment**: MemoryStat telemetry derives from the cgroup leaf sample
  already taken for pressure (~450 ms of smaps_rollup reads per walk gone);
  pane MB labels now mean cgroup charge (`systemd-cgtop` semantics); macOS /
  non-delegated keep the walk. **Memory budgets are live-adjustable**
  (answers "the 8 GiB": a hand-written MemoryHigh drop-in over the unit's
  50% default, which caps both the guardian budget and per-session highs):
  `SetMemoryBudget{mb}/GetMemoryBudget → BudgetApplied`; manager owns the
  guardian's budget as an Arc<AtomicU64> read every tick; a set persists
  config, re-derives against the LIVE cap, moves existing session leaves'
  memory.high IN PLACE (`CgroupManager::rewrite_session_high`;
  session_high_bytes now an atomic with an unset sentinel + manual Clone),
  no restart. CLI `amber ctl budget [SIZE|auto] [--systemd]` (--systemd
  pushes amber.service MemoryHigh via systemctl --user set-property BEFORE
  the daemon re-derives so raising past the old cap lands; old-daemon silence
  surfaces a restart hint). App ⚖ dialog over the same messages (shared/
  budget.ts parsing TDD'd; web build gets visible-throw stubs).
  **Lazy editor chunk**: SplitView React.lazy's Editor — CodeMirror+marked
  (1,164 KB) out of the main bundle: 2,156 → 990 KB; source maps verified
  already absent. Gates: Rust 514 ×2 + clippy clean, app 491 tests +
  typecheck + electron/web builds green. **Live-verified** on an isolated
  private daemon + private GUI (xvfb+CDP): ctl budget view/set/auto round-
  trips config.toml and survives restart; restore of 6 sessions all present;
  utilityProcess kill -9 inside the snapshot window → reconnect with markers
  intact (2→2, no dup, no wipe); budget dialog set/auto updates config.
  **A running daemon must be restarted to gain Attach.resume /
  AttachBacklog / SetMemoryBudget.** Still open: `amber web` has no budget
  surface; delta replay for `amber attach` raw clients deliberately absent.
- [x] Remote-access control plane (2026-08-22, Phase A) — the desktop IDE can
  now run, host and share the browser build without a hand-run CLI. Spec:
  `docs/superpowers/specs/2026-08-22-mobile-web-experience-design.md` §9 (Phase
  B, §1–§8, is the mobile UX and is NOT built). **The boot units already
  existed** (`infra/daemon/amber-web.service`, `com.amber-ide.web.plist.in`,
  `amber ctl install --web`); the gap was the packaged path — `install.sh`
  needs a git checkout and the AppImage's cargo-free first-run install writes
  only the DAEMON unit — plus the absence of any UI. So **Rust owns unit
  installation now**: `crates/amber/src/webctl.rs` embeds both templates with
  `include_str!` and `amber ctl web enable` writes, enables and starts the
  service itself. The `ExecStart`/`--port` substitution is **structural** (line
  rewritten by prefix, plist argument rewritten positionally after
  `<string>--port</string>`) — an exact-string replace silently no-ops the day
  someone reformats the shipped unit, and the packaged app would then enable a
  service pointing at `%h/.local/bin/amber` regardless of its arguments.
  `crates/amber/src/tailscale.rs` classifies the tailnet into four named states
  (not-installed / not-logged-in / not-running / serve-not-mapped) so the UI
  shows which one to fix instead of a dead red row; `serve status --json` is
  matched by a recursive value walk because that payload's shape has moved
  across releases. New authenticated `GET /api/status` on `amber web` (same
  cookie boundary as `/api/sessions`) reports port/uptime/sessions/clients,
  each client carrying a `borrow` field that is `null` until Phase B §2.2 fills
  it. New `amber ctl web status|start|stop|restart|enable|disable|url|
  rotate-token`, all `--json`; the app parses **only** `--json`.
  App: `app/src/main/webService.ts` (pure argv + a never-throwing parser),
  IPC, a toolbar pill (off/local/serving/error) and a Remote access dialog
  (start/stop/restart, enable-at-boot, address, reveal/copy/QR, rotate token
  behind a confirm, connected clients, `amber ctl doctor`-style check rows, log
  tail via `journalctl --user -u amber-web` / the launchd stderr file, "open on
  this machine"). **Security shape, deliberate:** the login URL grants full
  session control, so `status` carries NO token at all — it reports
  `has_token` and a token-free url, and the tokenised one is fetched on demand
  by Reveal/Copy/QR only (a 3 s poll would otherwise park a credential in
  renderer memory and every IPC trace); `load_token()` was added because
  `load_or_create_token` would have MINTED a credential as a side effect of a
  read-only status query; the QR is hidden until pressed; and the CLI makes
  **exactly one** `/api/auth` attempt — `Auth::throttled` buckets by peer IP and
  behind `tailscale serve` every peer is 127.0.0.1, so a retry loop would burn
  the 8-failure budget and lock the PHONE out. Gates: Rust 325 lib tests + every
  integration suite green, clippy `--workspace --all-targets -D warnings`
  clean. **Live-verified** against a private daemon + private `amber web` on
  port 7919 — full report `.reports/remote-access.md`: the two-step auth
  exchange returning real `uptime_secs`/`sessions` (and the count moving when a
  session is created), 401 on a forged cookie and on no cookie, twelve status
  polls followed by a successful `204` auth (throttle not burned), a wrong
  token reported after ONE attempt with a good token still working right after,
  and zero token leakage across every field of the status payload.
  **A bug live-testing caught and fixed:** the CLI claimed
  `https://<tailnet-host>/app` whenever a tailnet existed at all, even when
  `tailscale serve` mapped a DIFFERENT port — an address reaching another
  service entirely; `public_url()` now claims the tailnet host only for
  `TailState::Serving`. **GUI-verified too** (xvfb+CDP): pill renders, dialog
  opens, check rows compute live, Reveal puts a 43-char token in the FRAGMENT
  only (nothing before the `#`) with its warning banner, QR renders as a 220x220
  data URI under Electron's CSP, the log tail returns 22 k of real
  `journalctl`, and `webAction('bogus')` is refused by the allowlist without
  spawning. That pass caught three things typecheck and vitest could not: the
  dialog used invented CSS classes (`.overlay`/`.dialog`) and rendered unstyled
  in the top-left — rewritten onto the repo's own `.help-overlay`/`.help-card`
  shell; "Rotate token" sat in the same row as "Load log" and moved to its own
  danger section; and **the web build would have shipped a permanently red
  `remote` pill** — the shim's `webStatus()` returned an `error` string, which
  `webDot` maps to the error colour, so every phone would have shown a broken
  badge over buttons that always fail. Fixed with an explicit `managed` flag
  (and `WebStatus` moved to `app/src/shared/`, where renderer and web can reach
  it without importing from `main/`). Gates after those fixes: app 495 tests +
  typecheck + `build` + `build:web` green. **Not verified:** `enable`/`disable` (they write a real
  unit into `~/.config/systemd/user/` and run `tailscale serve --bg` on the
  user's actual machine — rendering and argv are unit-tested instead), macOS
  launchd, a real phone over the tailnet, and the packaged AppImage path. Known
  limitation recorded in the plan: the port lives in three places, so
  `ctl web enable --port N` yields a service the dialog cannot see (it queries
  7717 and reports `inactive`).

- [x] Mobile UX (2026-08-22, Phase B) — the hosted IDE is usable on a phone,
  agent sessions above all. Spec:
  `docs/superpowers/specs/2026-08-22-mobile-web-experience-design.md` §1–§8;
  plan `docs/superpowers/plans/2026-08-22-mobile-ux-phase-b.md`; report
  `.reports/mobile-ux.md`. **The webapp spec's §2.1 ("the renderer is not
  modified") is amended, not broken**: renderer changes that are
  *host-agnostic* are in scope — they improve the Electron app in a small or
  touch-capable window exactly as much as the browser build — while changes
  that branch on the HOST stay forbidden and stay the signal that the shim is
  wrong. Enforceable form: nothing under `app/src/renderer/` imports from
  `app/src/web/`, reads a web-only global, or tests for Electron; mobile keys
  off `pointer: coarse` + viewport width (`mobile.ts`, unit-tested), never off
  the host. New: `touchInput.ts` (key-bar byte sequences + scroll math **ported
  from `crates/amber/assets/app.js`**, which is device-proven — re-deriving
  arrow forms is how you type escape junk into a claude prompt), `KeyBar.tsx`
  (esc/tab/**⇧tab**/sticky ctrl/arrows/enter///^C at 44 px; ⇧tab is claude's
  mode cycle and the bar could not ship without it), `Drawer.tsx` (the ws-pill
  and tab rows do not fit 390 px, so they collapse to `ws · tab · ☰`), touch
  scrolling in `Pane.tsx` (alt screen sends ARROWS — a full-screen TUI owns its
  own paging), pointer-event drags with 400 ms long-press arming (a finger on a
  4 px divider is usually the start of a scroll), tap-to-zoom reusing the
  EXISTING zoom state with a history entry so the platform back gesture
  un-zooms, long-press sheets reusing the existing context-menu state, PWA
  manifest + safe-area insets (**no service worker** — the app is useless
  without a live socket and SW cache invalidation is a footgun), and touch
  copy/paste. **Grid borrowing** (the load-bearing part): a phone reflows an
  agent pane to a readable width while it is looking at it and hands the grid
  back on un-zoom / `visibilitychange` / `pagehide` / socket death. Bookkeeping
  is server-side in `Hub` because only the server survives a phone that leaves
  Wi-Fi. **`prior` is captured in the `Open` handler, never on `Resize`** —
  `HubInner::sessions` refreshes on the 1 s poll while `PaneLink` debounces
  resizes at 300 ms, so capturing on resize can record the PHONE's own grid and
  make the restore a silent no-op; mutation-checked (the test fails if the
  capture point moves). A restore is suppressed unless the session still
  matches what this client set — last writer wins, a restore never clobbers a
  newer desktop fit. Mobile font default **14 px ≈ 46 cols**, chosen from a
  measurement, not a guess: `.reports/mobile-agent-cols.md` renders
  claude/codex/grok through a real VT emulator (pyte) at 40/46/54/80 and finds
  all three reflow correctly at 40 — a first pass that counted newlines was
  meaningless for codex and grok, which paint by absolute cursor positioning.
  Gates: Rust tests + clippy clean, app 511 tests + typecheck + `build` +
  `build:web`. **Live-verified** at 390×844 with touch emulation against a
  private daemon + private `amber web`: mobile chrome swaps in on capability
  alone with no reload, all eleven keys at 44 px, manifest + icon served, and
  the full cycle **tile 80×24 → zoomed 44×41 → un-zoomed 80×24**. **The bug
  live testing caught, which no unit test could:** an unzoomed mosaic tile is
  ~180 px wide, and its FitAddon reflowed a live session to **13 COLUMNS** —
  and a pty's winsize is shared with the desktop, so that lands on whoever is
  at the desk. Panes gained a `fitMode`: a tile SCALES its pixels with a CSS
  transform and leaves the grid alone; only a zoomed pane reflows. Two further
  paths were resizing regardless (the font-size effect, which fires on the
  phone's 13→14 px flip, and the reconnect nudge) and now respect it. §3's soft-keyboard rule is implemented
  (`keyboardViewport.ts` + `Pane.tsx`): a `visualViewport` shrink that
  `innerHeight` does not match is the keyboard, and the pane pins its rows and
  scrolls the cursor above it instead of re-fitting — an orientation change,
  which moves BOTH heights, still re-fits. Unit-tested both ways. Browser
  pinch-zoom is left ENABLED: an earlier draft set `user-scalable=no` to make
  room for app-owned pinch that was never built, which would have left a phone
  unable to zoom at all. **Not verified:** any real device on either platform —
  so the soft-keyboard path has never actually run — plus long-press arming,
  real-finger touch scrolling, clipboard gestures, and PWA install.

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
