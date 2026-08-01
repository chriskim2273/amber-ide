# amber-ide as a web app — serve the real renderer

**Date:** 2026-08-01
**Status:** spike PASSED 2026-08-01 (commits `8d7d3b2`, `f157487`) — the real
renderer rendered a live pty and round-tripped a keystroke in a browser with
`Pane.tsx` unmodified. §4 was corrected by that spike. Full build in progress.
**Supersedes:** `2026-08-01-live-mosaic-tiles-design.md`. That spec bolted live
terminal previews onto the hand-written mobile UI. If the browser runs the real
renderer, a "tile" *is* a pane — live, focusable, draggable — and the mosaic
work becomes unnecessary. Its `Ring::tail` + `Attach{preview}` groundwork is
still useful (bounded backlog serves any client) and is kept.

Read `CLAUDE.md` first. **§6 of this spec proposes no core-rule change but comes
close to one; it is called out explicitly.**

## 0. The observation

> *"Since electron is javascript, why don't we just deploy it as a webapp?"*

Measured, not assumed:

- The renderer is **5157 lines** across `app/src/renderer/`.
- It contains **zero** `from 'electron'`, `require('electron')`, `process.*` or
  `__dirname`. The only Electron-specific construct in the whole tree is
  `<webview>` in `Browser.tsx`.
- Its entire contract with the host is `window.amber` — **84 lines of preload,
  ~30 methods**.

The renderer is already a web app. What is Electron-specific is the *transport*,
not the UI. Reimplementing those ~30 methods over HTTP + WebSocket yields the
full IDE in a browser.

This also subsumes the user's other request — panes that are manipulable
without maximizing (type into any pane, drag/split/close, drag dividers,
freeze/unfreeze). All four already exist in the renderer and are tested. Rebuilding
them in `assets/app.js` would be reimplementing the IDE in vanilla JS, badly,
in parallel forever.

## 1. Settled decisions (user, 2026-08-01)

| Question | Decision |
|---|---|
| Direction | **Pivot.** Host the real React renderer. |
| Manipulation | **All four**: type into any pane, drag/split/close, drag dividers, freeze/unfreeze. |
| Layout writes | Therefore **required** — see §6. |
| Editor + browser panes | **Disabled in the web build for v1** (§7). |

## 2. Architecture

```
browser ──HTTP──▶  amber web  ──unix socket──▶  amber daemon
   │  (vite bundle: the real renderer + web shim)
   └──WS /ws────▶  amber web  ──────────────▶  ptys
```

`amber web` stays a daemon **client** (core rule #1). The daemon still binds no
network interface. Nothing in this spec changes the daemon's protocol beyond
what `2026-08-01-live-mosaic-tiles-design.md` already added.

### 2.1 The shim

New `app/src/web/amber.ts` installs a `window.amber` with the same shape the
preload exposes, backed by one WebSocket plus a few HTTP endpoints. A second
vite entry (`app/electron.vite.config.ts` gains a `web` target, or a sibling
`vite.config.web.ts`) builds `renderer + shim` into a static bundle at
`app/out/web/`.

**The renderer is not modified.** If a change to `app/src/renderer/` turns out
to be required, that is a signal the shim is wrong — fix the shim.

### 2.2 Pane data: MessageChannel, not MessagePort-from-IPC

The one structurally different method. Preload does:

```ts
ipcRenderer.on('pane-port', (e, meta) => {
  const port = e.ports[0]
  window.postMessage({ amberPanePort: true, session: meta.session }, '*', [port])
})
```

`Pane.tsx` listens for that window message and takes the port. The shim
reproduces it exactly:

- `openPane(session)` → send `{"t":"open","name":session}` on the WS, create a
  `MessageChannel`, keep `port1`, `window.postMessage({amberPanePort: true,
  session}, '*', [port2])`.
- WS binary frame for `session` → `port1.postMessage(bytes)`.
- `port1.onmessage` (the pane's keystrokes) → WS binary send for that session.
- `closePane(session)` → `{"t":"close"}`, `port1.close()`, drop the entry.

`Pane.tsx` requires **no change**. This is the load-bearing claim of the whole
pivot; it is the first thing to prove (§8).

### 2.3 Serving the bundle

Today's assets are `include_bytes!` — one `const` per file. A vite bundle is N
hash-named files not known at compile time. `crates/amber/build.rs` walks
`app/out/web/` (if present) and generates a static `&[(&str, &[u8], &str)]`
table with `include_bytes!` per file, so the binary stays self-contained,
offline, and CDN-free — the properties `2026-07-19-amber-web-mobile-design.md`
§7 chose deliberately.

**If `app/out/web/` is absent, the table is empty and the server falls back to
today's hand-written UI.** So `cargo build` never depends on `npm`, CI stays
green, and the pivot is reversible at runtime.

Route: `/app/*` serves the bundle; `/` keeps serving the existing mobile UI
until the web build is proven, then flips.

## 3. The `window.amber` surface, method by method

| Group | Methods | How |
|---|---|---|
| Daemon events | `onDaemonEvent` | WS JSON messages, already the shape the client emits |
| Panes | `openPane`, `closePane` | §2.2 |
| Sessions | `createSession`, `killSession`, `renameSession`, `suspendSession`, `resumeSession` | Existing browser whitelist — already built and validated |
| Backlog | `dumpBacklog` | Whitelist addition, binary tag-2 frame (already exists daemon-side) |
| Layout | `loadLayout`, `saveLayout` | §6 |
| Clipboard | `clipboardRead`, `clipboardWrite` | `navigator.clipboard`, no server round trip |
| Env | `homeDir`, `softwareGl` | Served in the bootstrap JSON |
| Paths | `resolvePath`, `pickFolder`, `revealPath` | §7 — stubbed in v1 |
| Editor | `editorRead`, `editorSave`, `editorDraft*`, dialogs, `editorInlineImages` | §7 — stubbed in v1 |
| Claude | `claudeNames` | Reads `~/.claude` transcripts; small read-only endpoint, or stub in v1 |
| Workspace files | `saveWorkspaceFile`, `openWorkspaceFile` | Browser download / file input |

A stubbed method must **reject visibly** (throw, or resolve to an error the UI
already handles), never silently no-op — a silent stub is how a feature looks
present and eats data.

## 4. Multiple live panes: one WebSocket per pane

**Corrected after the §8.1 spike.** An earlier draft said input would route "by
the session named in the frame". That is false: a browser-facing binary frame
carries **no session id**. Routing is entirely positional — a frame belongs to
whichever session that connection has `open`. The daemon's own wire tags data
with a session (`Frame::Data { session, bytes }`); the browser protocol dropped
it because a phone only ever had one session open.

So multi-pane needs one of:

- **(a) One WebSocket per pane. Chosen.** Each pane's `MessageChannel` is fed by
  its own `/ws` connection with exactly one `open`. Zero protocol change, zero
  risk to the existing mobile UI, and input routing is unambiguous by
  construction — the connection *is* the addressing. `Client.open` stays
  `Option<String>` and §4's proposed widening is simply not needed. The hub's
  `detach_if_unwanted` already counts subscriptions across clients, so two
  connections onto one session behave correctly today.
  Cost: N connections and ~2 server threads per pane. Bounded by the visible
  pane count (order 10), on a loopback server. Acceptable.
- **(b) Tag browser binary frames with a session id.** Cleaner on the wire and
  what the daemon itself does, but it is a breaking change to the browser
  protocol that the shipped `assets/app.js` also consumes, and it buys nothing
  at this scale. This is the upgrade path if thread count ever bites.

Because each connection carries exactly one session, **input is still gated on
that connection's single `open`** — the existing server-side guarantee is
untouched, not widened. A pane can only ever receive input for itself.

Unchanged and non-negotiable: **`Resize` remains unreachable.** The renderer
DOES call resize paths in Electron; the shim must drop them. A pty's winsize is
shared, and a browser-driven resize would reflow the user's desktop panes. This
is the one place the shim must deliberately diverge from the preload's
behaviour, and it needs its own test.

### 4.1 Known bug the spike surfaced

`amber web` re-`Attach`es to the daemon on its own reconnect, independently of
any browser event, and that path's backlog arrives **untagged** — the browser
cannot tell it is a replay, so history duplicates. Observed live: an extra
unearned prompt line after a daemon-only restart. This predates the pivot and
affects the shipped mobile UI too. Fix it before building further on the
transport.

Unchanged and non-negotiable: **`Resize` remains unreachable.** The renderer
DOES call resize paths in Electron; the shim must drop them. A pty's winsize is
shared, and a browser-driven resize would reflow the user's desktop panes. This
is the one place the shim must deliberately diverge from the preload's
behaviour, and it needs its own test.

## 5. Security

The bundle is served from the same cookie boundary as `/api/*` — but note the
existing deviation: `/` and assets serve **without** a cookie so the fragment
token can bootstrap. The renderer bundle is inert and holds no secrets, so it
serves the same way. The data surface stays gated.

What changes: the token now reaches a much larger API. §7's stubs exist partly
for that reason — file read/write over the network is a different threat model
than terminal access and gets its own design pass before it ships.

## 6. Layout: two writers, and the core-rule tension

**This is the hard part, and the reason "just host it" is not free.**

Core rule #3: *"Split geometry is the one app-owned bit — a small atomic-write
sidecar JSON."* It has exactly one writer today (the Electron app), which is
why the mosaic was made layout-read-only.

The user wants drag, split, close and divider-resize from the browser. All four
write geometry. So the sidecar gets a second writer, and atomic-write with no
generation counter means last-writer-wins clobbering: the desktop app and the
browser each hold a full in-memory tree and each write the whole file.

Two ways out:

**(a) Compare-and-swap on the file — keeps rule #3 intact. Chosen.**
`loadLayout` returns `{ text, version }` where `version` is the file's
`mtimeMs` + byte length. `saveLayout(text, version)` fails with a conflict if
the on-disk version has moved. On conflict the client re-reads, re-applies its
change to the fresh tree, and retries once; a second conflict surfaces to the
user rather than silently discarding. **Both writers must honour it** — the
Electron main process's `layout-save` handler needs the same check, or the
desktop simply wins every race and the browser's edits vanish.

**(b) Move layout into the daemon.** Architecturally cleaner and consistent
with rule #1 (daemon as source of truth), but it **changes core rule #3**, and
CLAUDE.md is explicit: stop and ask rather than deviate. Not taken here. If CAS
proves inadequate in practice, this is the escalation, and it needs the user's
sign-off first.

Divider drags fire continuously, so the browser debounces geometry writes
(~250 ms) exactly as the desktop app already does, and a drag in progress does
not write at all.

## 7. Cut from v1

- **Editor panes.** `editorRead`/`editorSave`/drafts are arbitrary file IO;
  `editorFiles.ts`'s guards were written for a local trusted caller. Needs its
  own security design.
- **Browser panes.** `<webview>` is Electron-only. `<iframe>` is blocked by
  `X-Frame-Options` on most real sites, so it would be a broken feature rather
  than a degraded one.
- Both are hidden in the web build rather than shown-and-failing. A pane of
  either kind already in the sidecar renders as a placeholder tile explaining
  it is desktop-only — it must NOT be pruned, or the web client would silently
  destroy it on the next layout write.
- Native dialogs (`pickFolder`, `revealPath`, `editorOpenDialog`).

## 8. Proving order

The pivot is only worth continuing if §2.2 holds. Prove it before anything else:

1. **Spike:** build the renderer with a shim implementing only `onDaemonEvent`,
   `openPane`, `closePane` and the MessageChannel path. Load it in a browser
   against a private daemon. If a real pane renders live pty output and accepts
   a keystroke with `Pane.tsx` unmodified, the pivot is sound. If it needs
   renderer edits, stop and re-plan.
2. Session lifecycle (create/kill/rename/suspend/resume) — reuses the shipped
   whitelist.
3. Layout CAS, both writers.
4. Bundle serving via `build.rs`.
5. Stubs + placeholders for §7.

## 9. Testing

- **Rust:** the generated asset table serves every bundle file with correct
  content types; an absent `app/out/web/` falls back cleanly; multi-open input
  routing reaches the right pty and *only* that one; `Resize` still unreachable
  from every shim-shaped message; layout CAS rejects a stale version.
- **TypeScript:** the shim is testable without a browser — pure message
  mapping. Test that `openPane` posts an `amberPanePort` message with a real
  port, that binary frames route to the right port, that input routes back, and
  that no code path emits a resize.
- **Live:** the real renderer in a browser against a private daemon — pane
  renders, accepts input, split/drag/close work, divider drag persists, a
  concurrent desktop-app edit produces a conflict that resolves rather than
  clobbers.

## 10. Honest scope

This is the largest piece of work in the project so far: a second build target,
a transport shim, a Rust asset pipeline, a concurrency fix on the sidecar, and
a feature-gated build. It is staged so §8.1 can kill it cheaply if the
MessageChannel claim fails.
