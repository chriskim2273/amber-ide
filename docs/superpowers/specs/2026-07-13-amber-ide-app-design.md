# amber-ide Electron app — design

**Date:** 2026-07-13
**Status:** approved design, pre-implementation
**Depends on:** the amber session daemon (`docs/superpowers/specs/2026-07-12-amber-session-daemon-design.md`, shipped). This app is a **disposable client** over the daemon's unix socket. It consumes the daemon; it does not reimplement it.

Read the project constitution (`CLAUDE.md`) first. This spec obeys it and never contradicts it. Where the constitution states a rule (one-way flow, raw bytes / one emulator, bytes never touch main, daemon owns state), this document only refines *how*.

---

## 1. Goal & scope

Build the Electron IDE the user actually sees: a single-window terminal workspace (Warp/iTerm2-style) whose panes, tabs, workspaces, and running Claude sessions are all daemon sessions, so they survive app crashes and machine reboots with no app-side authoritative state.

**In scope (this spec):** full single-window IDE — workspaces, tabs, binary-split panes, shell + claude panes, create/kill, geometry persistence, self-healing daemon launch, distributable packaging. Plus one bounded Rust daemon change (§5) the app needs.

**Out of scope:** everything the constitution lists (Windows, floating panes, in-session multiplexing, SSH manager, AI chat UI, themes beyond minimal). Also deferred: multi-window, Playwright E2E (addable later without redesign), `Rename` (daemon still returns an explicit error).

---

## 2. Process topology (decision: one multiplexed utilityProcess)

Three OS processes, strict roles. The chosen client topology is **one multiplexed `utilityProcess`** holding a *single* socket connection that attaches every visible pane and demuxes by session name. Rationale: mirrors the daemon's own model (many subscriptions per connection), one reconnect/backpressure path, footprint flat in pane count. Rejected alternatives: one process per pane (N connections/FDs/reconnect loops, no gain — the daemon already isolates subscribers); connection in the main process (violates "bytes never touch main").

```
┌─────────────── main process ───────────────┐
│ window.ts       BrowserWindow, menu, quit    │
│ daemon-boot.ts  ensure daemon, own uProc     │
│ port-broker.ts  mint MessageChannel per pane │   control plane only
└───────┬─────────────────────────┬────────────┘
        │ postMessage(port)        │ control channel
        ▼                          ▼
┌── renderer ──────────┐   ┌── client utilityProcess ──┐
│ React chrome         │   │ connection.ts  net.Socket │
│ Pane.tsx  xterm+webgl│◄──┤ router.ts      demux/mux  │──► daemon unix socket
│ store/layout/name/…  │   │ proto.ts       wire codec │
└──────────────────────┘   └───────────────────────────┘
        MessagePort (raw bytes, never through main/React)
```

**Invariant:** the raw-byte path is `renderer pane port ↔ utilityProcess router ↔ socket`. The main process and React state never sit in it.

---

## 3. Components

### Main process (`electron/main/`) — window & lifecycle only, never sees terminal bytes
- **`daemon-boot.ts`** — on launch, connect-probe the socket (§6). If refused, exec the bundled `amber ctl install` then start, retry with backoff. Spawns and owns the single `utilityProcess`. Never stops the daemon on quit.
- **`port-broker.ts`** — per pane, mint a `MessageChannel`; hand one port to the renderer (`webContents.postMessage`), one to the utilityProcess. Never reads the ports' traffic.
- **`window.ts`** — BrowserWindow, application menu (incl. explicit "Quit amber daemon"), quit.

### Client utilityProcess (`electron/client/`) — the only holder of the socket
- **`proto.ts`** — TS port of the wire codec: `[u32 BE body_len][u8 tag][body]`, tag 0 = Control (JSON), tag 1 = Data (`[u16 BE name_len][name][raw bytes]`). **Pure, unit-tested to byte-parity with the Rust suite.**
- **`connection.ts`** — one `net.Socket` to the daemon; feeds a streaming `Decoder`; owns the reconnect loop (§7).
- **`router.ts`** — demux inbound `Data` by session name → the matching pane's `MessagePort`; mux outbound keystroke/resize frames from each port → socket; forward control events (`Sessions`/`SessionsChanged`/`Exit`/`Error`) to the main control channel.

### Renderer (`electron/renderer/`) — React chrome + xterm instances
**Pure modules (vitest, TDD):**
- **`name.ts`** — parse/format `amber-<ws>-<tab>-<ord>-<id>`; reject malformed.
- **`layout.ts`** — binary split tree + geometry (§4).
- **`sidecar.ts`** — geometry read/write, atomic, fallback (§4).
- **`store.ts`** — reducer: daemon events → workspace/tab/pane tree. The sole owner of the one-way-flow invariant (§4 data flow, below).

**Shell (imperative, thin):**
- **`Pane.tsx`** — mounts an xterm instance + `@xterm/addon-webgl` held in a ref (outside React reconciliation); wires its `MessagePort` straight to `term.write()` (inbound) and `term.onData` (outbound). No React state update per output chunk.

**Chrome (React, renders structure only):** workspace switcher, tab bar, split container (absolute-positioned pane rects), reconnect banner, exit/restart overlays.

---

## 4. Data flow, reducer, layout, sidecar

### One-way data flow — two planes, never crossed

**Control plane (low rate, routed through main so React can update):**
```
user gesture (new tab / split / kill / create-claude)
  → renderer intent → main control channel
  → utilityProcess sends ControlMsg (Create/Kill/Resize/Attach/Detach)
  → daemon acts → emits Sessions / SessionsChanged / Exit / Error
  → utilityProcess → main → renderer store.reduce(event)
  → React re-renders chrome
```

**Data plane (high rate, never touches main or React):**
```
pty bytes → daemon Data frame → router → pane MessagePort → term.write(bytes)
keystroke → term.onData → pane MessagePort → router → Data frame → daemon
```

### The reducer (`store.ts`) — heart of one-way flow

State `= { activeWorkspace, workspaces: { [ws]: { activeTab, tabs: { [tab]: { tree: Node, title? } } } } }`, derived **only** from daemon events — never from optimistic local mutation.

- **`Sessions [{name,cwd,kind,alive}]`** (initial + on every reconnect) → full rebuild: parse each name → bucket into workspace/tab/`ord`; overlay the sidecar tree, else equal-columns fallback.
- **`SessionsChanged {added, removed}`** (pushed) → incremental insert/remove. A pane the *user* asked to create appears only when its `added` arrives — no local pre-insert.
- **`Exit {name, code}`** → mark the pane dead (overlay); drop from tree on next tick / user dismiss.
- **`Error {msg}`** → toast; no state mutation.

**No-optimism consequence:** "new pane" sends `Create` and waits; the pane materializes on the daemon's echo. Identical path whether this client, a second window, an `amber attach` CLI, or a reboot restore created it — so all clients stay consistent for free. **Resize:** each pane reports xterm cols/rows via a `Resize` frame; the daemon is authoritative on pty size (it already guards the 0×0 detached-TUI-at-boot trap).

### Layout model — binary split tree

Hierarchy: workspace → tab → **split tree of panes**, encoded in the name `amber-<ws>-<tab>-<ord>-<id>` (`ord` = stable pane index within a tab, assignment order, drives fallback ordering; `id` = collision-free suffix).

```ts
type Node =
  | { kind: 'leaf'; paneId: string }                      // paneId = full session name
  | { kind: 'split'; dir: 'h' | 'v'; ratio: number;       // 0..1, first child's share
      a: Node; b: Node }
```
`layout.ts` ops — all total, pure, DOM-free, tested: `splitLeaf(tree, paneId, dir)`, `removeLeaf(tree, paneId)` (collapse parent, promote sibling), `setRatio(tree, path, r)`, `leaves(tree)` (in-order, matches `ord` for fallback), `paneRects(tree, W, H)` → absolute px.

### Geometry sidecar — the one app-owned bit

- **Path:** `$XDG_STATE_HOME/amber-ide/ui-layout.json` (same dir as daemon state, distinct app-owned file; the daemon ignores it).
- **Schema:** `{ version, activeWorkspace, workspaces: { [ws]: { activeTab, tabs: { [tab]: { tree: Node, title? } } } } }`.
- **Write:** debounced, atomic (temp + rename, mirroring the daemon's discipline) on split/resize/close/tab-switch/workspace-switch.
- **Read is advisory, never authoritative.** On start the reducer builds the pane set from the daemon's `Sessions`, then overlays the sidecar tree and reconciles:
  - sidecar leaf whose session no longer exists → pruned (collapse).
  - live session absent from the sidecar tree (created by another client / older app) → appended as a column split in `ord` order.
  - sidecar missing / corrupt / version-mismatch → **equal-columns fallback**: `leaves` sorted by `ord`, one horizontal row.

Loss of the sidecar degrades gracefully — pane existence & grouping always reconstruct from names alone (constitution rule 3). **Focus** (which leaf has the keyboard) is app-local ephemeral state, not persisted, restored to the first leaf on launch.

---

## 5. Daemon protocol slice (the only backend change)

Additive and TDD'd; the existing `attach`/`ls` CLI path is untouched.

**New wire types (`amber-core::proto`):**
```rust
struct SessionInfo { name: String, cwd: String, kind: String, alive: bool }

enum ControlMsg {
    // ...existing variants unchanged...
    WatchSessions,                                     // client -> daemon: opt in to pushes
    ListSessionsDetailed,                              // client -> daemon: request full set
    Sessions { sessions: Vec<SessionInfo> },           // daemon -> client: full set
    SessionsChanged { added: Vec<SessionInfo>,         // daemon -> watchers: pushed delta
                      removed: Vec<String> },
}
```
`ListSessions` / `SessionList { names }` stay as-is (CLI `ls` keeps working); the app uses the richer pair. `SessionInfo` is a plain serde struct → roundtrip test. `MAX_FRAME_LEN` already caps a full `Sessions` list.

**Push mechanism (`daemon` + `manager`):**
- Per-connection `watching: bool`, flipped by `WatchSessions`. A watcher's `SharedWriter` is registered in a daemon-owned `Watchers` registry (`Vec<Weak<Mutex<UnixStream>>>`, pruned on send failure — the same laggard discipline as pty subscribers).
- The manager emits an event on exactly the three transitions it already owns: `create` (added), `remove`/`Kill` (removed), child-exit reaper (removed, alongside the existing `Exit`). Each fans a `SessionsChanged` to all live watchers.
- **No polling.** The app connects → `WatchSessions` + `ListSessionsDetailed` → full set once, then deltas forever. On reconnect it re-requests the full set (authoritative resync).

**Metadata source:** `SessionMeta` already stores `name`, `cwd`, `kind`; `SessionInfo` is a direct projection, `alive` = child not yet reaped. Zero new persistence.

**Concurrency:** the watcher registry is guarded like the subscriber list; a broadcast holds the registry lock only to snapshot writers, then locks each writer individually. Reuse the existing lock-ordering rule (registry before writer; never nested the other way). New integration test: two connections, one watching; create/kill on one → the watcher sees `SessionsChanged`, the non-watcher sees nothing.

**Scope guard:** this is the *only* daemon change the app requires. No new binary, no new persistence, `Rename` still unsupported.

---

## 6. Daemon lifecycle (self-healing launch)

- **Socket path (verified against `crates/amber/src/main.rs` `default_socket`/`default_root`):** `$XDG_RUNTIME_DIR/amber-ide/amberd.sock`; if `XDG_RUNTIME_DIR` is unset/empty, the daemon falls back to `<root>/amberd.sock` where `root` = `$XDG_STATE_HOME/amber-ide` (else `$HOME/.local/state/amber-ide`). The app MUST replicate this exact resolution, or accept an explicit path, so it connects to the same socket the daemon binds. A daemon started with a non-default `--socket` is out of scope for auto-detect (the app assumes the default resolution).
- **On app launch (`daemon-boot.ts`):** connect-probe. If it answers → proceed. If refused → exec the **bundled** `amber` binary to install + start the boot unit (`ctl install`, which sets up the systemd user unit / launchd agent per the daemon spec), then retry connect with backoff (cap ~5 s, surfaced as a first-run splash).
- The daemon **outlives the app**: window close never stops it (reboot survival). An explicit menu item "Quit amber daemon" is the only app path that stops it.
- The bundled `amber` binary is the same static-musl / universal artifact `scripts/dist.sh` already produces; §9 packaging ships it inside the app bundle.

---

## 7. Reconnect, errors, lifecycle edges

- **Connection drop (crash / restart / upgrade):** `connection.ts` detects socket close → reconnect loop with exponential backoff (100 ms → 2 s cap), re-running daemon-ensure if connect is refused. On reconnect: re-send `WatchSessions` + `ListSessionsDetailed`, re-`Attach` every visible pane; the daemon replays each pane's scrollback backlog on attach → xterm `write()`s it and repaints. **No app-side scrollback storage.** Renderer shows a non-blocking reconnect banner; panes freeze on their last frame, xterm instances are not torn down.
- **Pane child exits (`Exit` or `SessionsChanged.removed`):** xterm stays mounted, dimmed, with an `[exited N — enter to close / r to restart]` overlay. Shell restart = `Create` same name+cwd+kind. A *removed* claude pane means the daemon's supervisor already gave up (it restarts claude itself up to its bounded retries) → treat as dead.
- **Foreign session appears (other client / CLI / reboot restore):** `SessionsChanged.added` → reducer appends it (column split per §4). Full IDE and `amber attach` coexist.
- **Pane teardown:** closing a pane → `Detach` (or `Kill` if the user chose kill), close the `MessageChannel`, dispose xterm, prune tree, debounced sidecar write. The daemon releases that subscription (already implemented).
- **WebGL context loss:** the webgl addon's `onContextLoss` → swap to the canvas renderer, log, keep bytes flowing (constitution rule 5).
- **Backpressure toward the renderer:** the router forwards bytes as they arrive and never unbounded-buffers; it relies on the daemon's bounded per-subscriber queue — a starved (hidden) pane is dropped daemon-side after grace, surfaced as reconnect-needed, and re-attached on focus.
- **Quit:** window close → `Detach` all, close the utilityProcess, **never** stop the daemon.

---

## 8. Testing strategy (pure-core + in-memory fake daemon)

- **Pure TS modules, vitest, TDD** (the bulk of logic): `proto.ts` (roundtrip incl. raw-byte / NUL / split-chunk parity with the Rust suite), `name.ts` (parse/format/malformed), `layout.ts` (split/remove/collapse/setRatio/paneRects/leaves-order), `sidecar.ts` (atomic write; corrupt / version-mismatch → fallback), `store.ts` (each daemon event → tree; reconnect resync; no-optimism invariants).
- **Fake daemon (`test/fake-daemon.ts`):** in-memory socket server speaking the real `proto`, scripting `Sessions` / `SessionsChanged` / `Data` / `Exit`. Drives `connection.ts` + `router.ts` end-to-end **without Electron** — asserts demux routing, reconnect + resync, backlog replay.
- **Rust:** `SessionInfo` + new-variant proto roundtrip; the watcher-vs-non-watcher daemon integration test (§5).
- **Electron/xterm shell:** thin imperative wire — one manual smoke checklist in this spec (below). Playwright-Electron E2E explicitly deferred.

**Manual smoke checklist (per shell milestone):** launch with no daemon → self-heal installs+connects; one pane echoes typing; split H/V resizes live; kill pane → gone; create-claude pane resumes; `reboot` → workspace/tabs/panes/geometry restored with scrollback; kill the daemon under the app → reconnect banner → restart daemon → panes re-attach and repaint.

---

## 9. Build slices

Each slice: red→green TDD, conventional commit, `cargo clippy` / `tsc --noEmit` + `eslint` clean.

1. **Daemon protocol** — `SessionInfo`; `WatchSessions` / `ListSessionsDetailed` / `Sessions` / `SessionsChanged`; watcher registry + broadcast. Pure Rust, no app. *Proves: two clients, watcher sees deltas, non-watcher silent.*
2. **App scaffold** — electron-vite + TS strict + vitest; main/client/renderer skeleton; `daemon-boot` self-heal; blank window connects and logs `Sessions`. *Proves: window ↔ daemon handshake.*
3. **One live pane (walking skeleton)** — utilityProcess `connection` + `router`, `port-broker`, `Pane.tsx` xterm+webgl; attach one existing session, bytes both ways, resize. *Proves: the risky data-plane spine.*
4. **Reducer + multi-pane tabs** — `name` + `store`, tab bar; session set → tabs; create/kill shell panes; `SessionsChanged` live. *Proves: one-way control plane.*
5. **Split tree + geometry** — `layout` + `sidecar`; split/resize/close; reconstruct on relaunch; all fallbacks. *Proves: layout survives restart.*
6. **Workspaces + claude panes** — workspace switcher; create-claude (`kind=claude`); exit/restart overlays; reconnect banner. *Proves: full IDE surface.*
7. **Packaging** — electron-builder (dmg / AppImage); bundle the `amber` binary; first-run install-daemon flow. *Proves: distributable.*

Slice 1 unblocks everything; slice 3 is the walking skeleton; slice 7 is the distribution gate.

---

## 10. Stack (from the constitution, restated for this app)

- Electron (current stable) + electron-vite, TypeScript strict, React (chrome only), xterm.js + `@xterm/addon-webgl`, vitest. No native Node addons. Terminal bytes never touch the main process.
- Protocol: the daemon's length-prefixed binary frames over a unix socket (`amber-core::proto`), TS-ported in `proto.ts`.

---

## 11. Open risks

- **electron-vite + utilityProcess + MessagePort transfer** wiring is the least-trodden path; slice 3 de-risks it first, before any breadth.
- **xterm webgl** context-loss handling differs across GPUs; canvas fallback is mandatory, tested by forced context loss where feasible.
- **First-run privilege** for `ctl install` (systemd `--user` needs no root; launchd agent none either) — verify the bundled-binary exec path has the right working dir and env on both OSes.
- **Reducer/sidecar reconciliation** is the subtlest logic; it carries the heaviest unit-test burden (§8).
