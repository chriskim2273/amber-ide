# Browser Pane — Design

**Date:** 2026-07-18
**Status:** Approved (design); implementation plan pending.
**Scope:** Add a **web-viewer** pane kind to the amber-ide app. Renderer-only
(Electron `<webview>`); **zero daemon/Rust changes, zero protocol changes.**

## 1. Goal & non-goals

Let a pane host a lightweight embedded web viewer — localhost dev previews,
docs, dashboards — alongside shell and claude panes. One address bar,
back/forward, reload. The URL survives app crash, machine reboot, and
`.amberws` workspace save/load.

**Non-goals (YAGNI):** in-pane browser tabs, history, bookmarks, find-in-page,
devtools, a real multi-tab Chrome. Deferred unless a concrete need appears.

## 2. Architectural context & the chosen tradeoff

Today **every app pane is its own daemon pty session** (core rule #2). Pane
existence is derived one-way from daemon `SessionInfo` via `groupSessions` →
`deriveTab` → the layout tree; `reconcile` **prunes any leaf whose paneId is
not a live daemon session**.

A browser pane has **no backing process** — it is an Electron `<webview>`, a
pure renderer concern. Two ways to give it an identity were considered:

- **Approach 1 (chosen) — App-local browser leaf.** The browser pane lives
  entirely in the app-owned sidecar (`layoutFile`): its grouping (ws/tab/ord)
  and URL. The daemon never learns it exists. Renderer-only.
- **Approach 2 (rejected) — Carrier pty.** Daemon gains `kind=browser` backed
  by an idle holder process so the pane rides all existing machinery. Rejected:
  it pushes a fake pty into the Rust daemon to model a webview, coupling an
  unrelated subsystem and spawning junk processes.

**Accepted tradeoff (Approach 1):** a browser pane is sidecar-owned only, so it
falls **outside** the "grouping must be reconstructable from session names
alone" rule (core rule #3) — because there is no session name to reconstruct
from. If the sidecar is lost, browser panes do not come back. This is the same
degradation class as geometry (sidecar loss → equal-splits fallback) and is
honest: a pane with no backing process has nowhere else to live. Surfaced to
and accepted by the user.

## 3. Data model

Browser pane id: `browser-<ws>-<tab>-<ord>-<id>` — a distinct prefix so it can
never collide with an `amber-<ws>-<tab>-<ord>-<id>` daemon session name, and so
`parseName` branches/rejects on it cleanly.

Sidecar (`layoutFile`) gains one map — the browser pane's **entire** existence:

```ts
browsers: Record<string /* paneId */, { ws: number; tab: number; ord: number; url: string }>
```

Written with the existing atomic-write path. No daemon session, no pty, no
MessagePort subscription is ever created for a browser pane.

## 4. Merge into the pane machinery

- After `groupSessions(state)` builds `WorkspaceModel[]` from daemon sessions,
  **inject** the sidecar browser panes into their `{ws,tab}` (creating a tab/ws
  entry when a tab holds only browser panes). They then flow through
  `deriveTab` as `PaneModel`s with `kind:'browser'`.
- `reconcile` prunes leaves lacking a live session. Browser ids are **added to
  `liveIds`** (always-live from the app's view) so they are never pruned.
  `splitLeaf`/`moveLeaf`/`removeLeaf` already walk the tree by paneId
  generically — no change.
- `paneDot` / `tabDot` gain a `browser` case (globe dot, label "browser").

## 5. Rendering

- `SplitView`'s leaf branch: when `meta.kind === 'browser'`, render a new
  `<Browser>` component instead of `<Pane>`, inside the same `.pane-body`.
- `<Browser>` = an Electron `<webview>` tag + a slim URL bar (back ‹,
  forward ›, reload ⟳, editable address input) as the first child of the body.
  The page title flows to the pane header via the webview `page-title-updated`
  event — mirroring the existing OSC-2 title path (`onPaneTitle`).
- Requires `webviewTag: true` in the `BrowserWindow` `webPreferences` (see §8).
- Persistent partition `persist:amber-browser` so cookies/logins survive
  restarts.

The pane **header** stays as-is (kind-dot + title + close/split/move actions);
terminal-only actions (refresh, ↺claude, xterm find) are hidden for browser
panes. The URL bar lives in the body, not the header.

## 6. Create gesture

- Extend the existing new-pane `kind` selector `'shell' | 'claude'` →
  `'shell' | 'claude' | 'browser'`. Also add `browser` to the split
  context-menu kind-override.
- Choosing `browser` writes a sidecar `browsers` entry (a local code path —
  **not** `createSession`; browser panes never touch the daemon). A new browser
  pane opens with an editable blank address bar (no default site — YAGNI; the
  user types or pastes a URL).

## 7. Persistence & workspace save/load

- **Reboot/crash survival of the URL:** free, via the sidecar — already
  persisted and restored on load. The URL is rewritten to the sidecar on
  navigation (debounced, reusing the existing sidecar write path).
- **`.amberws` files:** a browser pane serializes as
  `{ id, kind: 'browser', url, ord }` (no scrollback, no cwd). `workspaceFile.ts`
  parse/serialize + placeholder-rewrite handle `kind:'browser'`; load recreates
  the sidecar `browsers` entry and does **no** daemon create.

## 8. Security

`<webview>` may load arbitrary URLs, so it is sandboxed: `nodeIntegration:false`,
`contextIsolation:true`, the dedicated `persist:amber-browser` partition, and
popups (`target=_blank` / `window.open`) routed to the system browser via
`shell.openExternal` — never spawning new webviews. Navigation is restricted to
`http`/`https`/`about`.

Enabling `webviewTag: true` widens the renderer's surface slightly. Accepted:
this is a local developer tool, the toggle is called out here explicitly, and
the webview itself runs unprivileged.

## 9. URL normalization

A pure function normalizes address-bar input:
- `localhost:3000` / `127.0.0.1:8080` → `http://…`
- `example.com` / `foo.dev/path` → `https://…`
- already-schemed (`http://`, `https://`, `about:`) → unchanged
- anything not URL-shaped is treated as a URL attempt (no search-engine
  fallback — YAGNI).

## 10. Features in / out

**In:** back/forward/reload, editable URL + normalization, page-title in header,
cookie/login persistence, reboot + `.amberws` survival.

**Out (YAGNI):** in-pane tabs, history, bookmarks, find-in-page, devtools,
search-engine address bar.

**N/A for browser panes** (silently skipped): xterm scrollback search, font-size
chords, memory/activity dots (no session), OSC title (replaced by
`page-title-updated`). **Freeze** just blurs the webview + blocks input, same as
a terminal pane.

## 11. What is NOT touched

The Rust daemon, the wire protocol (`proto`), the utilityProcess/MessagePort
data path, and `amber` CLI — all unchanged. This feature is entirely within the
Electron renderer + shared sidecar code.

## 12. Testing (TDD)

Pure parts only (renderer components stay test-deferred, consistent with the
existing `Pane`/`SplitView` deferral):

- `layoutFile` parse/serialize round-trip including a `browsers` map (shape
  guards: drop malformed entries, keep valid ones).
- `workspaceFile` parse/serialize round-trip including `kind:'browser'` panes +
  placeholder rewrite.
- The merge: a sidecar browser pane is injected into the correct `{ws,tab}`, and
  `reconcile` keeps a browser leaf (does not prune it).
- URL normalization function (table of inputs → expected).

## 13. Touched files (estimate)

New: `src/renderer/Browser.tsx` (+ its wiring). Edited (bounded):
`layoutFile.ts`, `workspaceFile.ts`, `store.ts` (`paneDot`/`tabDot`/merge),
`tabView.ts` (`deriveTab` liveIds), `SplitView.tsx` (leaf branch + kind
selector / context menu), `main.tsx` (browser create path + sidecar wiring),
`main/index.ts` (`webviewTag`). Zero daemon/Rust, zero protocol.
