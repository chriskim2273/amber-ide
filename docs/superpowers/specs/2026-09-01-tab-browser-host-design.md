# Tab Browser Host — Design

**Status:** approved for implementation after design review
**Date:** 2026-09-01  
**Supersedes for new browsers:** `2026-07-18-browser-pane-design.md`  
**Scope:** desktop Amber IDE and supervised Pi panes on macOS and Linux. Windows compiles with the feature disabled until its native-view, ACL, launcher, and lifecycle gates pass.

## 1. Executive summary

Amber will replace its basic app-local browser split leaf with one durable, tab-owned browser rail that the user and one designated Pi pane can operate together.

The browser rail is not a daemon PTY session and does not pretend to be one. A resident Electron main process becomes the browser host and the source of truth for browser runtime state. It owns one stable `BrowserRecord` per Amber tab, a global persistent Electron browser profile, up to four live browser renderers, the native `WebContentsView` surfaces, Playwright/CDP automation, browser security policy, and a local broker used by Amber's Pi extension. The React renderer remains disposable presentation.

A tab has at most one browser record and at most one designated Pi controller. The user must explicitly share that tab's browser with Pi. User and Pi input may overlap by product decision; Amber does not impose a long-lived control lease. It does impose page-generation checks, a per-browser Pi mutation queue, bounded observations, and confirmation before consequential actions. Generation checks detect stale agent actions but cannot roll back actions already accepted by a site or prevent character-level interleaving when the user and Pi type simultaneously.

Closing the Amber window leaves the resident browser host and browser pages alive. Explicit Quit stops the browser host. A host crash, explicit Quit, or machine reboot cannot preserve arbitrary in-memory JavaScript state; restoration recreates pages from durable URL/profile/viewport metadata. This is intentionally weaker than Amber's PTY process continuity and must be presented honestly.

## 2. User decisions locked by this design

The following decisions were made after reviewing the current implementation and current Electron, Playwright, VS Code, Cursor, Windsurf, Replit, Browserbase, Browser Use, Stagehand, Chrome DevTools Protocol, MCP, and Pi extension guidance.

1. **Cardinality:** one browser record per Amber tab.
2. **Placement:** a dedicated, resizable and collapsible right-side rail, outside the binary terminal split tree.
3. **Agent ownership:** one explicitly designated Pi pane per tab may control the browser.
4. **Initial agent scope:** Pi only. Broker contracts remain agent-neutral enough for future adapters.
5. **Creation:** the first Pi browser request creates and reveals the rail visibly; no hidden first navigation.
6. **Interaction:** user and Pi may interact concurrently.
7. **Staleness policy:** Pi actions carry a page generation and fail closed when stale.
8. **Browser modes:** both local-development Preview and general Browse.
9. **Profile:** one global persistent Amber browser profile.
10. **Sharing:** authenticated browser state is private from Pi until the user enables Share with Pi for that tab.
11. **Approvals:** consequential actions require user confirmation.
12. **Capacity:** at most four browser renderers are live; eligible background renderers freeze by LRU.
13. **Window lifecycle:** closing the GUI leaves the host running; explicit Quit stops it.
14. **Tool surface:** include everything needed for normal development workflows, but do not expose unrestricted raw CDP or arbitrary Playwright code by default.
15. **Implementation boundary:** Electron main is the resident native browser host; no final `<webview>` or detached-window substitute.
16. **Platform rollout:** macOS and Linux first. Windows keeps browser-host creation and broker startup behind a fail-closed feature gate.

## 3. Goals

1. Put one useful browser beside every Amber tab without consuming a terminal split leaf.
2. Let the user and that tab's designated Pi pane observe and operate the exact same live page.
3. Preserve browser pages across ordinary GUI-window closure.
4. Restore durable intent after host crash/restart/reboot: URL, mode, profile, viewport, title metadata, and rail presentation.
5. Reuse Playwright's locators, actionability, waits, accessibility snapshots, console/network instrumentation, and screenshots instead of reimplementing browser automation semantics.
6. Make logged-in browser state an explicit, visible, revocable capability.
7. Bound Chromium memory with a deterministic four-live-renderer policy.
8. Keep remote content outside React, preload, filesystem, daemon protocol, and terminal data paths.
9. Keep the implementation testable with pure state machines, broker contract tests, Electron integration tests, and bounded live GUI verification.
10. Migrate existing browser panes without silently losing their last URL.

## 4. Non-goals

1. Exact restoration of arbitrary page JavaScript heaps, WebSockets, unsaved form fields, media playback, or full session history after Electron process death or reboot.
2. Exposing the user's normal Chrome/Firefox profile. “Global” means global to Amber's dedicated profile.
3. Multiple Amber browser rails or browser panes in one tab.
4. Multiple controlling Pi sessions in one tab.
5. General browser tabs/bookmarks/sync/password-manager replacement.
6. Hidden autonomous browser creation or navigation.
7. A network-accessible browser-control endpoint.
8. Browser control for Claude, Codex, Grok, OpenCode, Hermes, or shell panes in the first release.
9. Allowing a page, page preload, or renderer IPC call to issue arbitrary Electron, filesystem, shell, daemon, or CDP operations.
10. Treating the Electron browser host as the source of truth for daemon sessions.
11. Replacing Playwright with a model-driven computer-use loop.
12. Persisting traces, videos, screenshots, response bodies, or accessibility trees by default.
13. Running test/build workloads on the slow source drive; tests are authored in the worktree and executed only from a fast validation mirror when allowed.

## 5. Existing implementation and reasons to replace it

### 5.1 Current data flow

The current browser is a synthetic app-local pane:

- `app/src/shared/browserName.ts` formats `browser-<ws>-<tab>-<ord>-<id>`.
- `LayoutFile.browsers` stores `{ws, tab, ord, url}`.
- `mergeBrowsers()` injects those entries into daemon-derived workspace/tab models.
- `SplitView` renders `Browser.tsx` for `kind === 'browser'`.
- `Browser.tsx` creates an Electron `<webview partition="persist:amber-browser">`.
- The renderer listens for navigation/title events and rewrites the layout sidecar.
- Browser create/close/move are renderer-local sidecar mutations.
- `.amberws` files serialize the URL and restore a fresh synthetic browser leaf.

### 5.2 Current strengths retained

- Browser content is isolated from the terminal MessagePort path.
- Remote pages do not receive Node integration or an Amber preload.
- Navigation and popup policy live in Electron main.
- Browser URL and layout survive normal restarts.
- Browser IDs do not collide with daemon session names.
- Workspace save/load does not manufacture fake PTY sessions.

### 5.3 Current defects and limits addressed

1. Electron's official docs recommend against `<webview>` because Chromium architectural changes affect rendering, navigation, and event routing.
2. Browser identity encodes coordinates that become stale after cross-tab moves; current code correctly trusts the sidecar, but the ID remains misleading.
3. Browser existence and URL are owned by React/layout state, so a browser cannot serve Pi while no renderer exists.
4. All panes silently share one persistent partition without an explicit user-to-agent sharing boundary.
5. The partition has no deny-by-default permission request/check handlers.
6. There is no browser-control broker, designated Pi, generation, action queue, approval gate, or audit event stream.
7. Browser leaves participate in terminal-oriented split operations and runtime-string special cases that TypeScript does not exhaustively protect.
8. Renderer component/Electron behavior is lightly tested.
9. Remote SSH windows acknowledge layout saves without persisting them; a sidecar-only browser created there is not durable.
10. Current URL normalization accepts schemes that main navigation later rejects.

## 6. Architecture and authority

### 6.1 Components

```text
supervised Pi pane
  AMBER_SESSION + Pi session id
        │
        ▼
Amber-owned Pi extension
  typed browser tools + cancellation
        │ authenticated local request
        ▼
BrowserBroker (Electron main)
  authorization ─ policy ─ generation ─ mutation queue
        │
        ├── BrowserRegistry / BrowserStateStore
        ├── CapacityManager (4 live)
        ├── PlaywrightAdapter (CDP)
        ├── Permission/Download/Dialog policy
        └── Browser event stream
                     │
                     ▼
            one WebContentsView/webContents
                     │
           attached to active tab rail
                     │
                     ▼
             React browser chrome
```

### 6.2 Sources of truth

- **Daemon:** unchanged source of truth for PTY sessions, their kind, name, cwd, liveness, scrollback, process supervision, and memory lifecycle.
- **BrowserHost/BrowserRegistry:** source of truth for browser-record existence, live/frozen state, URL/title/loading state, page generation, controller authorization, in-flight operation, and renderer ownership.
- **`ui-layout.json`:** app-owned presentation association: which browser ID is linked to a tab, rail width/collapse state, designated daemon session name, and Share with Pi state.
- **`browser-state.json`:** main-owned durable browser runtime intent and LRU metadata.
- **React:** presentation only; browser events are the only path that updates browser runtime display state.

No browser page or React optimistic mutation may claim that a navigation/action/close succeeded before BrowserHost emits the corresponding event.

### 6.3 Why BrowserHost lives in Electron main

`WebContentsView`, session partitions, permission handlers, download handling, native child-view bounds, and `webContents` lifecycle are main-process APIs. Keeping the broker in main ensures remote content never receives privileged browser-control IPC. It also lets a window close while BrowserHost keeps detached web contents alive.

### 6.4 Narrow constitutional exception

Core architecture rule 4 ordinarily limits Electron main to window management. This feature requires a narrow, explicit amendment: Electron main may own **native browser presentation and its local browser-control policy only** (`WebContentsView`, the dedicated browser session, BrowserHost state, broker, approval mediation, and Playwright/debugger adapter). It still may not handle terminal bytes, own daemon-session state, emulate a terminal, or become a second path for PTY control. Browser records are app-local and never enter the amber daemon protocol. Any broader main-process product authority requires a new approved design.

### 6.5 Window command and authorization seam

All renderer-originated browser commands use one typed `browser:command` IPC handler. It derives the `WindowCtx` from `event.sender`; callers never supply a trusted window, workspace, tab, browser, or remote/local identity. Main resolves the active association from its own window registry and rejects destroyed, remote, stale, or mismatched senders. Geometry, occlusion, navigation, share/designation, approval, close, and profile commands all pass through this seam. No parallel convenience IPC may bypass it.

Pi authorization uses a metadata-only daemon watcher owned by main. It consumes `SessionInfo`/`SessionsChanged` (name, kind, liveness, rename/removal) and never attaches to PTYs or observes terminal bytes. Broker calls fail closed while the watcher is disconnected, has not completed an initial full list, or is older than a short bounded freshness window. A reconnect must obtain a new full list before authorization resumes; cached membership never authorizes a mutation.

### 6.6 Resident does not mean immortal

The Electron main process survives ordinary window closure. Explicit Quit, process crash, OOM, package upgrade restart, logout, and reboot terminate it. BrowserHost restores durable intent on next start but cannot restore arbitrary volatile page state. If future requirements demand continuous browser execution through Electron process death, this design must move the browser owner to a separate service and accept a streamed/remote view; that is explicitly outside this version.

## 7. Data model

### 7.1 Layout version migration

Increment `LAYOUT_VERSION` to `2` and parse both versions. Version 1 is migrated in memory and written as version 2 on the next successful save. Unknown future versions still fail closed to an empty/fallback layout rather than being rewritten.

```ts
export interface BrowserRailLayout {
  browserId: string
  width: number
  collapsed: boolean
  designatedPi?: string
  sharedWithPi: boolean
  associationRevision: number
}

export interface TabLayout {
  tree: Node | null
  label?: string
  browser?: BrowserRailLayout
}

export interface LayoutFileV2 {
  version: 2
  activeWorkspace: number
  browserRevision?: number
  workspaces: Record<string, WsLayout>
  fontSize?: number
  frozen?: Record<string, FrozenEntry>
  editors?: Record<string, EditorEntry>
  recentFiles?: string[]
}
```

The old top-level `browsers` map is removed from version 2 after migration. Browser runtime records live in `browser-state.json`.

### 7.2 Stable browser identity

New IDs are opaque and coordinate-free:

```text
browser-<128-bit random lowercase hex or UUID>
```

Parser rules:

- exact prefix;
- conservative ASCII token;
- bounded length;
- no slash, whitespace, control bytes, `..`, shell syntax, or option shape;
- IDs are never interpreted as filesystem paths.

### 7.3 Browser runtime state

```ts
export const BROWSER_STATE_VERSION = 1

export interface ProfileDescriptor {
  id: 'global'
  partition: string
  createdAt: number
  migratedFrom?: string
}

export interface BrowserRecord {
  id: string
  profileId: 'global'
  mode: 'preview' | 'browse'
  safeRestoreUrl: string
  title: string
  viewport: { width: number; height: number }
  lifecycle: 'live' | 'frozen'
  pageIncarnation: string
  generation: number
  stateRevision: number
  lastUsedAt: number
  lastFocusedAt: number
  restoreError?: string
}

export interface BrowserStateFile {
  version: 1
  revision: number
  layoutRevision: number
  profiles: Record<'global', ProfileDescriptor>
  records: Record<string, BrowserRecord>
  migrationRecovery: MigrationRecoveryItem[]
  pendingTransaction?: BrowserStateTransaction
}
```

Rules:

- Main is the only writer.
- `pageIncarnation` is a random process-page identity and changes on every create/thaw/crash replacement; `generation` is monotonic only within that incarnation. Both are required on mutations and snapshot references.
- `safeRestoreUrl` is the only URL used after process death. Persistence strips user-info, query, and fragment unconditionally; v1 persists at most a validated HTTP(S) origin plus path. This deliberately loses query-driven application state rather than guessing which query keys are credentials. When even origin/path cannot be made safely restorable, retain a neutral origin/home URL and disclose the loss. Raw current URLs may be shown transiently in user-only chrome but are not automatically durable, logged, or model-visible.
- `profiles.global` is the one durable `ProfileDescriptor`. Its `partition` is the Phase-0-proven canonical persistent partition; every v1 record references it through `profileId: 'global'`. Unknown profile IDs fail closed. This makes partition/profile migration explicit rather than an implied string constant.
- Atomic unique-temp-file + file fsync + replace + parent-directory fsync discipline matches the strongest existing state stores.
- Malformed records are dropped individually and logged; one bad record does not lose all browsers.
- A record absent from every current tab association is garbage-collected after a bounded grace, not immediately, so a crash between layout and state writes does not destroy recoverable browser intent.
- No cookie, local-storage, IndexedDB, history body, screenshot, accessibility tree, network body, or trace appears in this JSON.

### 7.4 Controller identity

`designatedPi` stores the current daemon session name, not the Pi conversation UUID. Grouping is encoded in daemon names, and moving a pane performs a real daemon Rename/respawn. A designation must therefore be cleared when:

- the named daemon session disappears;
- its kind is no longer `pi`;
- it no longer parses into the owning `{workspace, tab}`;
- the browser association moves to another tab;
- the user designates another Pi;
- the user explicitly revokes it.

The Pi conversation UUID may be included in requests and logs for attribution but never substitutes for tab membership authorization.

### 7.5 Crash-consistent two-store transactions

`ui-layout.json` (whose other writers must preserve unknown v2 browser fields and `browserRevision`) and `browser-state.json` cannot be atomically renamed together. BrowserHost therefore owns a small transaction journal in `browser-state.json` and uses monotonic `layoutRevision`/`stateRevision` values:

1. write `pendingTransaction` containing transaction ID, before/after associations, and intended revisions; fsync;
2. CAS-write layout v2 with the new `browserRevision`;
3. write browser state with matching `layoutRevision`, records, and recovery items; fsync;
4. clear the journal in a final atomic write.

Startup compares revisions and replays or rolls back the idempotent journal. It never deletes an orphan until both stores agree plus the GC grace has elapsed. A conflicted layout CAS aborts and leaves the prior association authoritative. Migration uses the same transaction path and first creates a timestamped v1 backup. Recovery outcomes are durable and shown in a bounded Browser Recovery surface (attach, copy safe URL, or delete), not only logged.

## 8. Version-1 browser migration

For each old `LayoutFile.browsers` entry:

1. Validate the entry and use its sidecar `ws/tab/ord`, never coordinates parsed from its ID.
2. Find the corresponding tab and all legacy browser leaves in its tree.
3. Sort candidates by active/visible status if known, then `ord`, then stable ID.
4. Promote the first candidate to `TabLayout.browser` with a new opaque ID or a validated retained ID.
5. Create a `BrowserRecord` carrying a redacted `safeRestoreUrl` and default viewport.
6. Remove every **recognized legacy browser leaf** from the split tree, including non-promoted extras, and collapse each parent using existing `removeLeaf` semantics. Never remove an unrecognized app-local or terminal leaf merely because its sidecar entry is malformed.
7. Preserve every non-promoted recognized browser candidate in durable `migrationRecovery` entries with their source workspace/tab and redacted safe URL; surface a bounded recovery notice allowing the user to attach, copy the safe URL, or delete them.
8. Never silently discard an extra URL.
9. Browser-only legacy tabs remain tabs: their terminal tree becomes `null`, and the rail provides the tab's content.
10. `.amberws` version-1 browser panes load as the target tab's rail. If a document contains more than one browser in a target tab, import the first and persist the extras as recovery items.
11. Remove Browser from every split/pane creation picker and move it to a tab-level **Open browser** action before v2 is enabled; no code path may mint a legacy browser leaf after migration.

Migration is idempotent. Tests cover interrupted write ordering in both directions.

## 9. Browser modes

### 9.1 Preview mode

Preview is optimized for local development:

- localhost, loopback, and explicitly selected development origins;
- reload and cache-disabled reload;
- viewport presets;
- console exceptions and warnings;
- failed-request and network summaries;
- DOM/accessibility inspection;
- screenshot;
- element metadata suitable for reporting back to Pi;
- optional local service discovery supplied by explicit URL/port, not broad process scanning in v1.

Preview uses the same global Amber profile by user decision. It does not bypass Share with Pi, permission, or consequential-action policy.

### 9.2 Browse mode

Browse supports arbitrary HTTP(S) sites in Amber's dedicated profile. It adds ordinary address navigation and persistent logged-in state. It is not a complete replacement for a system browser: unsupported OAuth/popups, external protocols, DRM, extension-dependent flows, or permission-heavy sites may need “Open in system browser.”

### 9.3 Mode transition

Mode is metadata/policy, not a different renderer or profile. Switching mode does not copy credentials or recreate the page. It changes chrome defaults and applicable origin checks. The user may switch explicitly; Pi cannot silently promote Preview to Browse.

## 10. Global persistent browser profile

Reuse the existing `persist:amber-browser` partition if a Phase-0 profile-compatibility probe proves it can be opened safely with the hardened session policy; this preserves existing logins. Only move to a new partition if the probe detects an incompatible/corrupt profile, and then disclose the profile reset. The canonical partition name is therefore discovered/migrated once and recorded, rather than casually version-bumped. Example fallback:

```text
persist:amber-browser-v2
```

All Amber browser records share cookies, cache, local storage, IndexedDB, service workers, certificate decisions, and proxy settings in this partition.

Consequences accepted by the user:

- Sign in once across Amber workspaces/tabs.
- Cross-project web identity and tracking are shared.
- A shared Pi-controlled tab may navigate to another origin where this profile is already authenticated.
- Compromise/corruption has a larger blast radius than workspace- or tab-scoped profiles.

Required controls:

- clear all Amber browser data;
- display profile disk usage;
- revoke Share with Pi independently per tab;
- never expose cookie/storage values through normal tools;
- password fields are redacted from observations;
- authorization and action policy are enforced in BrowserBroker, never by prompt text;
- future migration to workspace-scoped profiles remains possible by storing a `profileId` in `BrowserRecord`, even though v1 always uses `global`.

## 11. WebContentsView presentation

### 11.1 Rail geometry

The renderer reports, at animation-frame/debounced cadence:

```ts
interface BrowserRailGeometry {
  browserId: string
  windowId: number
  visible: boolean
  x: number
  y: number
  width: number
  height: number
  deviceScaleFactor: number
  revision: number
}
```

Main validates finite integer bounds, owning window, browser/tab association, and monotonic revision before calling `view.setBounds()` or attaching/removing the child view.

### 11.2 Right rail behavior

- Width is clamped to a product minimum/maximum and available stage width.
- Terminal stage keeps a usable minimum width; the rail cannot crush PTYs to pathological geometry.
- Collapsing detaches/hides the view but does not immediately freeze it.
- Only the sender-derived active tab’s rail is attached and visible; main ignores renderer-supplied ownership claims.
- Background browsers may remain live but detached, subject to capacity.
- Opening overlays, modal dialogs, menus, or approvals must not allow the native child view to cover them; main receives an occlusion state and detaches/hides the view when necessary.
- Dragging the rail divider updates DOM chrome immediately and sends settled bounds to main; avoid one IPC per pointer pixel when possible.
- Full-screen/zoomed terminal behavior defines whether the rail remains visible; default is collapsed while a terminal pane is zoomed, restoring prior rail state afterward.

### 11.3 Focus and input

- Clicking the native view focuses its `webContents`.
- Keyboard shortcuts reserved by Amber are handled before page input where Electron permits; ordinary page input reaches the browser.
- The rail chrome remains keyboard reachable.
- A visible focus indicator distinguishes browser chrome focus from page focus.
- IME, composition, drag/drop, selection, context menus, and accessibility must be verified on Linux and macOS because native child views bypass React's event tree.

### 11.4 Explicit destruction

Removing a view from a window does not mean closing the page. Closing a browser record, LRU freezing it, or quitting the host explicitly closes/destroys the associated `webContents`, detaches Playwright/CDP listeners, cancels in-flight broker work, and releases registry references. Window teardown alone must not leak child contents.

## 12. Resident process lifecycle

### 12.1 Single-instance behavior

The existing single-instance lock remains. All launch modes converge on one resident singleton. A second launch sends a validated activation request to the resident process, which creates or shows the local window instead of quitting silently. `--browser-host` never creates a competing owner. Startup holds readiness until state recovery, broker token/socket setup, permission policy, and daemon metadata watcher initialization complete.

Startup compatibility mode is a hard browser-host gate: the current compat switches relax Chromium sandbox/GPU posture and must not host authenticated remote pages. In compat mode Amber shows browser rails unavailable with repair guidance; it does not silently fall back to `<webview>`.

### 12.2 Window close

- Ordinary close hides or destroys the BrowserWindow presentation but keeps Electron main and BrowserHost running. Per-window daemon utility clients/tunnels are drained and closed unless the metadata-only local watcher still needs its dedicated connection; no terminal client is retained merely for the browser.
- Browser views detach from the closed window and remain registry-owned.
- The app must provide an obvious background-running indication appropriate to the platform (tray/menu-bar item or documented launcher behavior) and a way to reopen the window.

### 12.3 Explicit Quit

- Explicit Quit is distinct from close.
- If a Pi action, approval, download/upload, dialog, or page load is active, show a concise warning and offer Cancel or Quit anyway.
- Quit enters a coordinated drain state: stop accepting broker/renderer commands, reject queued work, cancel cancellable work, resolve/deny approvals, stop downloads/dialogs, persist the two-store journal to completion, close browser contents and adapters, close broker/watchers/utility clients/tunnels, then exit. A bounded timeout offers Cancel or force quit with an explicit persistence warning.
- Quitting the Amber daemon remains a separate, more destructive command.

### 12.4 Host startup when Pi calls it

Pi tools first connect to the browser IPC endpoint. If absent:

1. The adapter invokes a bounded `amber ctl browser-host ensure` helper or equivalent installed launcher.
2. The helper resolves a previously registered stable app executable, starts `--browser-host` detached, and waits for a readiness handshake.
3. If no stable app path is registered, the tool returns an actionable “open Amber once/install desktop app” error.
4. Browser creation requested by Pi raises/reopens the GUI because creation must be visible.
5. Registration stores canonical executable identity and install generation in a user-private file. Upgrades repair it atomically. A durable explicit-stop inhibit prevents Pi auto-start after the user chose Quit; only a normal app launch or explicit “Enable browser host” clears the inhibit.
6. Windows returns a typed unsupported error until its native pipe ACL, launcher, resident lifecycle, sandbox, and packaged smoke gates pass.

No shell string interpolation is used; executable and arguments are separate validated values.

### 12.5 Crash/restart/reboot

- Existing browser records restore frozen first; the active/explicitly requested record thaws on demand.
- The global profile restores site storage.
- URL/viewport/title metadata restore.
- Volatile page state is lost and the UI says “restored page” rather than “continued exactly.”
- A browser-dependent Pi tool waits for readiness up to a bounded timeout, then returns a retryable host-unavailable error.
- Pi supervision itself does not crash or fall to shell because the optional browser host is unavailable.

## 13. Four-live-renderer capacity manager

### 13.1 Definitions

- **Record:** durable browser intent; records may exceed four.
- **Live renderer:** a non-destroyed `webContents`/Playwright page.
- **Frozen record:** durable record without a live renderer.
- **Protected renderer:** visible, executing a Pi mutation, awaiting approval, handling a permission/dialog/download/upload, or explicitly pinned during a bounded load.

### 13.2 Activation

To activate a frozen browser:

1. If fewer than four renderers are live, create it.
2. Otherwise select the least-recently-used non-protected, non-visible renderer.
3. Persist its current URL/viewport/title and increment generation.
4. Cancel observations and close its web contents.
5. Mark it frozen and emit lifecycle events.
6. Create/thaw the requested renderer and navigate to the durable URL.

If all four are protected, do not silently exceed the bound or kill active work. Use one global FIFO activation queue, maximum 8 entries, one pending activation per browser, with a 10-second deadline. Overflow or timeout returns `BROWSER_CAPACITY_BUSY`; queued requests are cancellable. The invariant is at most four live **browser-record renderers**. Temporary Chromium process count and explicitly approved transient download/dialog machinery are not claimed to be four OS processes.

### 13.3 LRU updates

Update `lastUsedAt` on visible focus, user input, successful Pi observation/action, navigation, or explicit activation. Background network noise does not make a browser recent.

### 13.4 Freeze semantics

Freezing preserves global-profile storage and durable metadata, not:

- JS heap;
- DOM state not reflected in URL/storage;
- scroll/form state unless separately captured best-effort;
- WebSockets;
- media playback;
- unsaved browser-generated data.

The browser rail surfaces “Reloaded after background freeze” on thaw.

## 14. BrowserBroker protocol

### 14.1 Transport

- Unix-domain socket under the user's runtime directory on Unix; named pipe on Windows-compatible builds.
- User-only permissions/ACL.
- Length-prefixed bounded frames.
- No TCP listener.
- Wall-clock read/write/operation deadlines.
- Per-connection and global in-flight limits.
- Malformed clients are disconnected without affecting BrowserHost.

### 14.2 Authentication and attribution

The initial release treats same-user local processes as trusted code, matching Pi extensions' full user authority, but still uses an unguessable host token stored in a race-safely-created user-only file to prevent accidental/ambient connections. It never appears in argv, environment, renderer IPC, URLs, diagnostics, or logs; clients read it directly, compare through the authenticated handshake, and rotation closes existing connections. Requests additionally carry:

- `AMBER_SESSION` daemon session name;
- Pi session UUID;
- extension version;
- request ID.

Authorization is based on a fresh daemon session listing, current tab membership, designated Pi, and Share with Pi state. A claimed Pi UUID does not grant access. There is exactly one narrowly scoped pre-share exception: an authenticated `open` request from a currently live `kind: pi` session that parses into an existing tab may ensure a browser record for that same tab, reveal/reopen the local GUI, and create or refresh a bounded user solicitation naming that session. It may not navigate (a proposed URL is displayed only as untrusted intent), inspect, mutate, designate itself, enable sharing, or operate on another browser. Duplicate solicitations are rate-limited and coalesced. All other requests require designation and Share with Pi. Future per-daemon-session capabilities may tighten local attribution without changing tool schemas.

### 14.3 Request envelope

```ts
interface BrowserRequest {
  version: 1
  requestId: string
  clientInstanceId: string
  sequence: number
  amberSession: string
  piSessionId: string
  browserId?: string
  pageIncarnation?: string
  expectedGeneration?: number
  action: BrowserAction
}

type BrowserAction =
  | { type: 'status' }
  | { type: 'open'; proposedUrl?: string; mode?: BrowserMode }
  | { type: 'navigate'; url: string }
  | { type: 'reload'; ignoreCache?: boolean }
  | { type: 'history'; direction: 'back' | 'forward' }
  | { type: 'stop' }
  | { type: 'wait'; condition: WaitCondition; timeoutMs?: number }
  | { type: 'snapshot'; limits?: SnapshotLimits }
  | { type: 'find'; query: FindQuery }
  | { type: 'screenshot'; target?: ElementRef; fullPage?: boolean }
  | { type: 'inspect'; target: ElementRef | TypedLocator }
  | { type: 'console'; cursor?: string; levels?: ConsoleLevel[] }
  | { type: 'network'; cursor?: string; filter?: NetworkFilter }
  | { type: 'interact'; operation: Interaction }
  | { type: 'setViewport'; viewport: Viewport }
  | { type: 'cancel'; targetRequestId: string }

type Interaction =
  | { kind: 'click' | 'doubleClick' | 'hover' | 'check' | 'uncheck'; target: ElementRef | TypedLocator }
  | { kind: 'fill' | 'type'; target: ElementRef | TypedLocator; text: string }
  | { kind: 'press'; target?: ElementRef | TypedLocator; key: string }
  | { kind: 'select'; target: ElementRef | TypedLocator; values: string[] }
  | { kind: 'scroll'; target?: ElementRef | TypedLocator; deltaX: number; deltaY: number }
  | { kind: 'drag'; source: ElementRef | TypedLocator; target: ElementRef | TypedLocator }
```

Every nested union has a strict parser, bounded strings/arrays, and unknown-key rejection at the broker boundary. `clientInstanceId` is a random per-extension-process nonce and `sequence` strictly increases; the host retains a high-water mark for each authenticated connection/client incarnation, so an evicted result can never make an old mutation executable again. `cancel` is authorized like its target and may cancel only a request owned by the same connection/controller. Unknown protocol versions receive `UNSUPPORTED_VERSION` with the supported range; they never partially decode.

### 14.4 Response envelope

```ts
type BrowserResponse =
  | { version: 1; requestId: string; ok: true; browserId: string; pageIncarnation: string; generation: number; result: BrowserResult }
  | { version: 1; requestId: string; ok: false; code: BrowserErrorCode; retryable: boolean; message: string; pageIncarnation?: string; generation?: number; snapshotHint?: boolean }

type BrowserResult = BrowserStatus | NavigationResult | WaitResult | SnapshotResult |
  FindResult | ScreenshotResult | InspectResult | ConsoleResult | NetworkResult |
  InteractionResult | ViewportResult | CancelResult
```

### 14.5 Error taxonomy

At minimum:

- `HOST_UNAVAILABLE`
- `NO_BROWSER_FOR_TAB`
- `CREATION_AWAITING_USER`
- `NOT_DESIGNATED_CONTROLLER`
- `NOT_SHARED`
- `STALE_GENERATION`
- `BROWSER_FROZEN`
- `BROWSER_CAPACITY_BUSY`
- `NAVIGATION_BLOCKED`
- `APPROVAL_REQUIRED`
- `APPROVAL_DENIED`
- `ACTION_TIMEOUT`
- `ACTION_CANCELLED`
- `ACTION_FAILED_NO_ROLLBACK`
- `PAGE_CLOSED`
- `UNSUPPORTED_PAGE`
- `POLICY_BLOCKED`
- `INVALID_REQUEST`
- `UNSUPPORTED_VERSION`
- `DAEMON_STATE_STALE`
- `REQUEST_LIMIT`
- `INTERNAL_ERROR`

Messages are actionable but never include credentials, cookies, authorization headers, raw response bodies, or filesystem secrets.

### 14.6 Events to renderer

BrowserHost emits typed events for:

- record created/closed;
- live/frozen/thawing;
- URL/title/loading;
- page incarnation/generation changed;
- designated controller changed/revoked;
- Share with Pi changed;
- Pi observation/action started/completed/failed;
- approval requested/resolved;
- permission/dialog/download/upload requested/resolved;
- console/network counters;
- restore failure;
- capacity wait.

Events are the only runtime-state mutation path for React.

## 15. Pi extension

### 15.1 Packaging

Amber already owns and repairs `~/.pi/agent/extensions/amber-hook.ts`. The browser integration should avoid embedding a large implementation into one Rust raw string. Preferred package layout:

```text
~/.pi/agent/extensions/amber/
  index.ts           # session-id hook + tool registration
  browser-client.ts  # framed local IPC client
  schemas.ts         # TypeBox tool schemas
  render.ts          # compact optional tool renderers
  VERSION            # ownership/version marker
```

Migration preserves the existing hook behavior and removes/replaces the old owned `amber-hook.ts` only when ownership is proven. Unrelated extensions are untouched. Installation remains atomic, idempotent, drift-repairing, and best-effort for Pi launch; browser-extension failure must not stop Pi from starting.

### 15.2 Identity and lifecycle

- `session_start` continues recording the exact Pi session ID through `amber hook`.
- Browser tools read `AMBER_SESSION` at execution time.
- `ctx.signal` sends a protocol `cancel` for the exact request ID and closes the request locally if the host does not acknowledge before the cancellation deadline.
- `session_shutdown` closes pooled IPC resources.
- Tools register globally but return an explicit unavailable message outside Amber instead of operating on an unbound browser.
- Tool output is bounded to Pi's 50 KB/2,000-line limits; large snapshots/network details use focused queries or artifact files outside model context.

### 15.3 Tool naming

Use a consistent `browser_*` namespace and avoid conflicting with installed third-party tools. Initial tools may be grouped to limit schema bloat, but tool names remain stable once released.

## 16. Development browser tool surface

### 16.1 Lifecycle and navigation

- `browser_open` — ensure/show the tab browser and optionally propose a URL/mode. First creation requires visible GUI completion.
- `browser_status` — record, mode, URL/title/loading/lifecycle/share/controller/generation.
- `browser_navigate` — HTTP(S)/allowed about URL, generation checked.
- `browser_reload` — normal or cache-disabled.
- `browser_back` / `browser_forward`.
- `browser_stop` — cancel current page load or cancellable Pi operation.
- `browser_wait` — bounded wait for URL, text, role, network idle, or timeout.

### 16.2 Observation

- `browser_snapshot` — accessibility-first snapshot with bounded depth/text and ephemeral element references.
- `browser_find` — search current snapshot by text/regex/role/name without returning the whole tree.
- `browser_screenshot` — viewport or selected element; returns a bounded binary image attachment (never a filesystem path). The host captures to memory, the Pi extension forwards it through Pi's typed image-result channel, and both sides release it after the response/cancellation deadline.
- `browser_inspect` — selected element's tag, role, accessible name, attributes allowlist, bounding box, computed-style allowlist, and concise DOM ancestry.
- `browser_console` — bounded console/error entries since cursor/timestamp.
- `browser_network` — bounded request summary, failed requests, status/type/timing; focused details exclude credentials and default to no bodies.

### 16.3 Interaction

- `browser_click` / double click.
- `browser_hover`.
- `browser_fill` and `browser_type` (distinct replace versus keystroke semantics).
- `browser_press`.
- `browser_select`.
- `browser_check` / uncheck.
- `browser_scroll`.
- `browser_drag`.
- `browser_set_viewport` with bounded desktop/mobile presets or dimensions.

All element actions prefer current snapshot references or role/name locators, retain Playwright actionability checks, and reject stale generations. CSS/XPath escape hatches may be accepted for development but are explicitly typed and bounded; model-generated JavaScript is not the normal selector path.

### 16.4 Development diagnostics

- Capture uncaught exceptions, console errors/warnings, failed resources, and failed HTTP statuses.
- Optional request-detail lookup returns headers through an allowlist/redaction layer and bodies only behind explicit advanced approval.
- DOM/CSS inspection supports diagnosing layout and accessibility.
- Responsive viewport presets support common phone/tablet/desktop dimensions.
- Cache-disabled reload supports local build verification.
- Offline and bounded network-throttle emulation may be included after the core substrate is proven.

### 16.5 Advanced capabilities gated separately

- upload file;
- accept download and choose destination;
- clipboard read/write;
- geolocation/media/notification permission;
- arbitrary cookie/storage changes;
- response body capture;
- arbitrary JavaScript or Playwright program execution;
- browser-level tracing.

These are not silently available just because Share with Pi is enabled.

## 17. Snapshot references and page generation

### 17.1 Generation

Every live page has a random `pageIncarnation` and a monotonically increasing generation within that incarnation. A request or element reference matches only when both values match; process restart, crash replacement, freeze/thaw, or target remap always changes the incarnation, so a persisted/old generation can never replay against a new page. Increment before emitting any event that invalidates an agent's view, including:

- top-level or frame navigation relevant to the target;
- user pointer/keyboard/composition input;
- successful Pi mutation;
- dialog/popup/page switch;
- thaw/recreate;
- reload/back/forward;
- explicit mode or viewport change;
- substantial lifecycle reset.

Dynamic DOM mutation may invalidate a locator without a generation signal. Playwright actionability and locator resolution remain the second line of defense; such a failure returns a retryable stale/not-found result and prompts a fresh snapshot.

### 17.2 Ephemeral references

Snapshot element references are scoped to `{browserId, pageIncarnation, generation, snapshotId}`. They are opaque, bounded, never persisted, and rejected after generation changes. Broker maps them to Playwright locators/backend nodes without returning arbitrary object handles to Pi.

### 17.3 Concurrent user and Pi behavior

- User input is never blocked merely because Pi is acting.
- Pi reads may run concurrently.
- Pi mutations serialize per browser in a FIFO queue (maximum 16 including the active item); overflow fails with `REQUEST_LIMIT`. Observations are bounded separately and never jump ahead of an earlier mutation when they could expose a misleading post-action state.
- A page-incarnation/generation mismatch at enqueue **and again immediately before dispatch** rejects the mutation.
- Each `{clientInstanceId, sequence, requestId}` is accepted once per live host epoch. Completed IDs in the result cache return the original response; a duplicate still active joins the original result; a duplicate with a changed payload fails closed. A sequence at or below the connection/client high-water mark whose result was evicted returns `ACTION_CANCELLED`, never executes again. Requests are never automatically replayed across host restart.
- Approval binds a digest of request ID, controller, browser ID, page incarnation, generation, origin, action, target, and redacted arguments. Any change invalidates it. Approval expiry, navigation, controller loss, revoke, cancellation, or host drain denies the action.
- Cancellation removes queued work or aborts adapter work where supported. Once dispatch crosses a documented non-cancellable boundary, the result reports that cancellation cannot imply rollback.
- A user action during a dispatched mutation may still interleave; completion reports the observed final generation and any Playwright failure.
- If any irreversible input dispatch succeeds and the mutation later fails or is cancelled, the result is `ACTION_FAILED_NO_ROLLBACK` with `retryable: false`, the current page incarnation/generation when available, and a fresh-snapshot instruction. A failure before the first accepted dispatch remains a safe ordinary error.
- Browser chrome displays Pi activity and the last action.
- `Stop Pi` cancels cancellable broker work but cannot undo site-side effects.
- Consequential actions require approval before dispatch because cancellation is not rollback.

## 18. Sharing, designation, and approvals

### 18.1 Designating Pi

The browser rail lists Pi panes currently in that tab. The user chooses one. If exactly one Pi exists, Amber may suggest it but does not silently share authenticated state.

### 18.2 Share with Pi

- Off by default for migrated and user-created browsers.
- A first Pi `open` request may use only the §14.2 solicitation exception: after fresh daemon membership validation it creates/reveals the rail and asks the user to designate/share. Its proposed URL is shown as untrusted intent and is not loaded until the user explicitly accepts; no other navigation, observation, or action proceeds.
- Sharing is a persistent tab presentation preference but is revalidated against the live daemon session on every broker call.
- Visible rail badge names the designated pane/session.
- Stop Sharing immediately blocks new calls, cancels cancellable work, clears pending approvals, increments generation, and leaves a visible revoked audit line. The toggle confirmation explains that sharing grants the designated Pi cross-origin access to the same logged-in Amber profile, not merely the current site.
- Closing/moving/renaming the designated Pi revokes sharing until explicitly reassigned.

### 18.3 Consequential action classifier

BrowserBroker, not Pi, classifies proposed operations. Confirmation is required for at least:

- credential or password submission;
- file upload or download;
- purchase, payment, subscription, financial transfer;
- sending messages, publishing posts/comments, submitting forms with external side effects;
- destructive delete/disable/revoke operations;
- granting browser permissions;
- opening external applications/protocols;
- exposing response bodies or sensitive storage;
- bypassing TLS/certificate errors;
- arbitrary code execution capability.

Classification combines action type, target role/name, form metadata, URL/origin, file operation, and explicit tool capability. It is conservative but cannot infer every site's semantics; the approval UI shows exact origin, target, entered non-secret arguments, and effect category.

### 18.4 Approval UI

- Native/renderer modal occludes the child view correctly.
- Approve once, Reject, and where safe “allow this action class for this origin until tab closes.”
- No permanent blanket allow for credential, financial, destructive, permission, or external-protocol actions in v1.
- Pending approval times out and fails closed.
- Host can service approvals only with a visible local window; headless requests return `APPROVAL_REQUIRED` and raise the GUI. Approval surfaces show controller, origin, action category, target, non-secret argument summary, expiry, and whether dispatch has started; secrets are never echoed.

## 19. Security and privacy

### 19.1 Remote-content boundary

Every browser web contents explicitly uses:

- `nodeIntegration: false`;
- `contextIsolation: true`;
- `sandbox: true`;
- `webSecurity: true`;
- no guest preload unless a later narrowly audited input-attribution bridge is proven necessary;
- no `allowRunningInsecureContent`;
- no experimental Blink features;
- no page-accessible Amber IPC.

### 19.2 Creation hardening

Even with main-owned `WebContentsView`, validate every creation option. If legacy `<webview>` remains during migration, `will-attach-webview` strips preload, disables Node, validates partition and source, and prevents unrecognized guests.

### 19.3 Navigation and popups

- Parse with `new URL()`; never regex alone.
- Allow `https:` and `http:`. Allow only the exact required `about:blank` internal page.
- `file:`, `data:`, `javascript:`, `blob:`, `mailto:`, custom protocols, and external apps are blocked or routed through explicit policy/approval.
- Apply policy to direct navigation, redirects, frame navigation where relevant, popup/window creation, and external protocol requests.
- Popups are denied by default. Development/auth flows that require a child page are represented as a bounded child target within the same BrowserRecord only after a dedicated design slice; until then they open in the system browser with confirmation or fail visibly.
- `shell.openExternal` receives only validated allowed URLs and never arbitrary page strings.

### 19.4 Permissions

Install both `setPermissionRequestHandler` and `setPermissionCheckHandler` on the resolved dedicated Amber browser partition. Default deny all. Camera, microphone, display capture, notifications, geolocation, MIDI, clipboard, HID, USB, serial, Bluetooth, filesystem, pointer lock, and related requests require explicit product support and user approval. Remembered grants, if any, are origin- and permission-scoped and revocable.

### 19.5 Downloads/uploads

- Downloads pause until approved, use bounded filenames and a native destination dialog, never auto-open executables, and expose progress without response bodies.
- Uploads accept only explicit user-approved absolute paths; Pi cannot glob or browse the filesystem through the browser tool.
- Paths and file contents do not enter model output unless separately read by an existing authorized filesystem tool.

### 19.6 Prompt injection

Page-derived accessibility text, console logs, DOM, network metadata, and screenshots are untrusted data. Tool results label them as such. Amber treats them as untrusted and enforces that broker-visible page data cannot directly:

- enable tools;
- change broker policy;
- grant sharing;
- approve actions;
- access cookies/secrets;
- grant the broker authority to run local commands. A model may still be socially influenced by page text and may invoke other tools it already possesses; Amber does not claim cross-tool prompt-injection prevention. Consequential browser actions therefore remain broker-enforced regardless of model reasoning.

### 19.7 Secrets, minimization, and redaction

Amber does not claim that arbitrary DOM text, accessibility names, console strings, or application-defined URLs can be perfectly classified as non-secret. The enforceable boundary is data minimization plus structural omission:

- never return cookies, browser storage values, request/response bodies, host IPC tokens, or authorization/cookie/proxy-auth headers;
- never return password, credit-card, security-code, hidden, or autocomplete-sensitive control values; sensitive controls appear only as redacted metadata;
- omit URL user-info, query, and fragment from persistence, logs, console/network summaries, snapshot link targets, and normal model-visible results; return at most validated scheme/host/port/path unless a separately approved diagnostic explicitly needs more;
- header output is an explicit benign allowlist, not a redact-known-bad denylist;
- upload/download paths remain host-private capability objects and are never model-visible filesystem strings;
- screenshots are bounded binary attachments and may visually contain secrets present on screen. Sharing and each screenshot request make that limitation explicit; Amber cannot redact arbitrary pixels reliably;
- DOM/accessibility/console text remains untrusted and may itself contain application-rendered secrets. Results are bounded, clearly labeled, and focused by explicit query, but are not advertised as secret-free.

Redaction and omission run before persistence and before model-visible formatting. Automated canary fixtures place unique secrets in cookies, storage, auth headers, query/fragment, password controls, hidden controls, DOM text, console text, and pixels. Tests assert the structural channels never leak and document the unavoidable DOM/console/pixel cases rather than making an impossible blanket guarantee. Logs use structured metadata, never raw bodies.

### 19.8 Local IPC threat model

Pi extensions run with the user's authority, so the broker is not a sandbox against malicious same-user code. The local token, socket permissions, bounded protocol, and authorization checks prevent accidental or network/page access and provide attribution. Do not claim protection from a compromised user account or malicious trusted Pi extension.

## 20. Playwright/CDP integration

### 20.1 Preferred adapter

Prototype with an **exact** Electron `43.1.0` and exact compatible `playwright-core` pin (no caret). Use `playwright-core` connected to Electron's Chromium through a random loopback CDP endpoint started before `app.ready`. The endpoint is not exposed to renderer or page code. Broker maps each browser `webContents` target ID to a Playwright `Page` and never lets Pi enumerate or control the Amber host renderer.

### 20.2 Prototype gate

Before full implementation, prove on exact locked Electron and Playwright versions:

1. `WebContentsView` pages appear as controllable targets.
2. Mapping by DevTools target ID survives navigation and detach/reattach to windows.
3. Locators, accessibility snapshots, screenshots, console, network, uploads/downloads, dialogs, and viewport changes work.
4. DevTools coexistence behavior is understood.
5. Child targets/iframes do not escape browser-record authorization.
6. Remote debugging binds only to loopback and does not permit remote-page abuse in the packaged configuration.
7. Host renderer cannot be reached through broker APIs.
8. A hostile fixture page cannot discover, connect to, or drive the CDP endpoint; command-line exposure, IPv4/IPv6 binding, token/origin behavior, and another same-user process are tested explicitly. If same-user endpoint confinement is not acceptable, CDP fails the gate and the implementation uses `webContents.debugger`.
9. The exact `WebContentsView` `webPreferences` prove sandboxed renderer process state (`process.sandboxed`/process model), no preload/Node/IPC, permission request **and check** denial, blocked schemes/redirects/popups, and behavior while Amber compatibility mode is active. Compat mode must disable the browser host.
10. Real pointer, keyboard, composition/IME, drag/drop, context menu, focus transfer, accessibility-tree traversal, overlay occlusion, device-scale-factor changes, multi-monitor/negative coordinates, maximize/fullscreen, resize, tab switch, window close/reopen, and rapid revision reordering work on Linux before Linux implementation proceeds. Repeat these platform-native checks on macOS before merge/default enablement. Synthetic-only input is insufficient for either acceptance record.
11. No raw CDP command, arbitrary script, target enumeration, or Playwright object crosses the broker API.

If this gate fails or the endpoint is judged unacceptable, implement a narrower adapter over `webContents.debugger`; do not use the unmaintained `puppeteer-in-electron` package.

### 20.3 Dependency policy

- Pin exact Electron and Playwright core versions in `package.json`/lockfile for v1; upgrades rerun Phase 0.
- Do not download a second Chromium; Electron supplies the browser.
- Record Electron/Chromium/Playwright compatibility in tests and packaging docs.
- Keep Playwright in production dependencies only if the packaged host imports it at runtime.
- Audit transitive size and license impact.

## 21. Console, network, dialogs, and child targets

- Broker subscribes only while the browser is live and bounds all buffers.
- Console ring: fixed count/bytes per browser, with level/source/timestamp and redacted arguments.
- Network ring: fixed count/bytes, metadata only by default; bodies are not retained.
- Dialogs (`alert`, `confirm`, `prompt`, `beforeunload`) pause the relevant action and surface a visible user decision; Pi cannot auto-accept consequential prompts.
- A child page/popup belongs to the same BrowserRecord and authorization context, but v1 may deny all child-page creation until the rail has a safe page-switching UI.
- Service workers and frames never become independently addressable browser records.

## 22. Renderer UX and accessibility

### 22.1 Rail chrome

- Collapse/expand control.
- Back, forward, reload, address field.
- Preview/Browse mode label.
- Share with Pi toggle and designated controller picker.
- Visible Pi activity/action status and Stop Pi.
- Loading/security/restore/frozen indicators.
- Console/network issue counters and development tools entry.
- Open in system browser.
- Close browser with explicit distinction from collapsing.

### 22.2 Empty/creation state

A tab without a browser shows a compact “Open browser” affordance. A Pi first-use request opens the rail and explains: “Pi requested a browser for this tab,” proposed URL/mode, controller, and Share action. Navigation does not occur until policy permits it.

### 22.3 Frozen/restore states

A frozen browser shows durable URL/title and “Reload to continue.” User focus or authorized Pi use starts thaw. After thaw, disclose that transient page state may have been reloaded.

### 22.4 Accessibility

- All rail chrome is keyboard operable.
- Native view focus entry/exit has documented shortcuts.
- Share/activity/approval changes use restrained live regions.
- Color is not the only indication of sharing/controller/activity.
- Rail divider is keyboard adjustable and announces width.
- Controls meet existing desktop/mobile target and contrast standards.
- Reduced motion applies to loading/activity indicators.
- Screen-reader behavior across native `WebContentsView` and host chrome is manually verified.

## 23. Remote windows and mobile/web

### 23.1 SSH remote Electron windows

The current remote window is read-only for remote layout persistence. This version does not pretend a local Electron BrowserHost is the remote machine's durable browser. Options are explicitly bounded:

- local-only browser rail in local windows;
- remote window shows browser rail unavailable with explanation;
- future remote browser broker over authenticated SSH is a separate design.

Do not create non-durable local browser records in a remote read-only window.

### 23.2 `amber web` and web build

App-local browser pages are not daemon sessions and remain omitted from remote mosaic, consistent with current pruning. Streaming/interacting with the desktop BrowserHost from mobile is out of scope. The sidecar schema reader in Rust must tolerate version 2 and ignore browser-rail fields without leaking browser profile data.

## 24. Workspace save/load

### 24.1 Versioned schema and save

Version 2 makes a browser tab-owned intent rather than a pane placeholder:

```ts
export const WORKSPACE_VERSION = 2

interface WorkspaceDocV2 {
  version: 2
  scope: 'one' | 'all'
  workspaces: WsWorkspaceV2[]
}
interface WsWorkspaceV2 { label?: string; tabOrder?: number[]; tabs: WsTabV2[] }
interface WsTabV2 {
  tab: number
  label?: string
  tree: Node | null
  panes: WsPaneV2[] // daemon + editor only; kind:'browser' is invalid in v2
  browser?: WsBrowserV2
}
interface WsBrowserV2 {
  mode: 'preview' | 'browse'
  safeRestoreUrl: string
  viewport?: { width: number; height: number }
  collapsed?: boolean
  width?: number
}
```

The parser reads v1 and v2. V1 browser pane placeholders migrate through the same deterministic first-plus-recovery rule as layout migration. V2 rejects browser pane leaves, duplicate tab browsers, malformed URLs, invalid dimensions, duplicate pane placeholders, and trees referencing unknown placeholders. Size/count/depth limits apply before allocation. Serialization never includes cookies, local storage, controller designation, Share with Pi, generation/incarnation, console/network buffers, history bodies, raw credential-bearing URLs, or profile credentials.

### 24.2 Load

- Mint a new browser ID.
- Create frozen browser intent and attach it to the target tab through the two-store transaction.
- `sharedWithPi` defaults false and `designatedPi` is unset.
- Thaw only when the tab is visible or explicitly requested.
- Multiple browser intents in one legacy tab become durable recovery items with a visible notice.
- A non-restorable URL loads a neutral page and reports why; it is never silently persisted with credentials.

### 24.3 Replace current workspace

Browser records being replaced enter the garbage-collection grace until the layout/state transaction commits. A destructive-close confirmation names live browser pages that will lose volatile state. Unsaved editor guards and daemon session confirmation remain unchanged.

## 25. Failure handling

### 25.1 Host unavailable

Pi receives retryable structured errors. Pi itself remains usable. Renderer shows host restart status only when a browser rail is relevant.

### 25.2 Browser crash

- Mark record frozen/restore-failed.
- Increment generation and cancel broker requests.
- Recreate with bounded backoff if visible/requested.
- After bounded failures, require user Retry and preserve URL/profile.

### 25.3 Playwright disconnect

- BrowserHost remains alive and user browsing remains available.
- Pi tools fail closed while adapter reconnects.
- Re-enumerate and remap targets before accepting actions.
- Never reuse stale `Page` objects or snapshot references.

### 25.4 State-write failure

- Keep live browser running, but mark the affected association/runtime intent as not durably saved.
- Surface a persistent warning and entry in Browser Recovery diagnostics.
- Retry with bounded backoff.
- Do not claim durable restore.
- Explicit Quit warns if final flush fails.

### 25.5 Layout/browser-state mismatch

- Layout references a missing record: consult/replay the journal; if unrecoverable, create a frozen blank/error record and surface durable recovery.
- Orphan record: retain through grace and show in recovery list.
- Duplicate browser ID associations: deterministically keep the first valid tab and clear/report the rest.
- Duplicate browser records for one tab: keep the associated ID and orphan/recover the extras.

### 25.6 Controller disappears mid-action

Revoke sharing, increment generation, cancel cancellable work, and allow any already-dispatched site action to finish without claiming rollback. Completion is logged as controller-lost.

## 26. Performance and bounded resources

- Maximum four live browser web contents.
- Fixed-size console/network/action rings.
- One serialized Pi mutation per browser; bounded global mutation concurrency.
- Snapshot depth/node/text/byte limits; focused find preferred over full repeated trees.
- Screenshot dimensions/bytes bounded and temporary artifacts cleaned.
- Debounce geometry and durable metadata writes.
- Do not update React state for every network/console event; batch summaries.
- Detached/background pages remain subject to Chromium activity; freeze policy is the primary bound.
- Profile disk usage is monitored and clearable but not silently truncated.
- Remote debugging and Playwright reconnection loops use capped backoff.

## 27. Testing strategy

Tests are written first for each pure/protocol slice. Per user instruction, do not execute test/build workloads on the slow source drive. Use a fast `/tmp`/local mirror with dependencies and build outputs located there; record any intentionally unrun gates.

### 27.1 Pure TypeScript tests

- v1→v2 layout migration, including multiple browser leaves and interrupted ordering.
- browser ID validation.
- tab association and designated-Pi reconciliation.
- Share/revoke state machine.
- generation and stale-action transitions.
- action risk classifier.
- URL/origin/scheme policy.
- redaction.
- browser-state parser and orphan reconciliation.
- four-live LRU selection/protection/capacity queue.
- workspace save/load browser intent.
- rail width clamping and visibility/occlusion model.

### 27.2 Main-process unit/integration tests

- atomic browser-state writes and recovery.
- BrowserBroker request validation, auth, deadlines, cancellation, malformed frames, response bounds.
- controller/tab authorization against fake daemon/layout snapshots.
- permission request/check default deny and scoped allow.
- popup/external-navigation policy.
- download/upload approval boundaries.
- Playwright adapter target mapping with fakes at the adapter boundary.
- host lifecycle state machine and explicit Quit behavior.

### 27.3 Rust tests

Only if `amber ctl browser-host ensure` and Pi-extension installer change require Rust:

- stable app-path registration/validation;
- detached argv without shell interpolation;
- readiness timeout/error text;
- extension package install/idempotence/drift/ownership/unrelated-file preservation;
- generated tool schemas/client version marker where represented in Rust assets.

No daemon browser protocol variant is added.

### 27.4 Electron integration tests

Against a local fixture server and exact packaged/development Electron:

- `WebContentsView` attach/bounds/focus/hide/show/occlusion.
- close window leaves host/page alive; second launch reopens it.
- explicit Quit destroys browser contents.
- Playwright controls the exact visible page.
- user input increments generation; stale Pi action rejects.
- Pi action and user input can coexist without host crash.
- Share/designation enforcement.
- permission denial.
- popup/navigation scheme blocking.
- console/network/screenshot/inspect.
- LRU fifth-browser freeze and thaw disclosure.
- host crash/restart restores URL/profile but not falsely claims exact continuation.
- no control of Amber host renderer through broker.

### 27.5 Live verification

Use an isolated daemon/state/profile and the project's `verify` workflow:

- create tab rail from user and from Pi request;
- designate/share/revoke;
- authenticated profile persists across tabs and host restart;
- Preview localhost diagnostics;
- general Browse navigation;
- concurrent user/Pi interaction and stale retry;
- consequential approval;
- close/reopen resident host behavior;
- explicit Quit behavior;
- four-live cap;
- app restart and reboot-restore wording;
- memory sampling;
- Linux/macOS focus, IME, overlays, and keyboard navigation.

Never restart or disrupt the user's production daemon during verification.

## 28. Rollout and compatibility

1. **Land Rust `mosaic.rs` layout-v2 read compatibility first**, with fixtures proving v1 and v2 trees/labels still render and browser-rail/private fields are ignored. No desktop writer may emit v2 before that compatible reader ships.
2. Land permission/navigation hardening independently where possible.
3. Gate the new rail/host behind an internal feature flag until all Phase-0 prototypes pass.
4. Parse old layout/workspace files throughout the rollout.
5. Keep one release capable of reading version 1 and version 2 layouts; do not silently downgrade version 2.
6. Backup the v1 layout before first migration.
7. If rollback occurs after migration, preserve `browser-state.json` and a migration report so URLs are recoverable.
8. Add clear release notes: close now leaves Amber resident; explicit Quit stops browser tooling; global Amber browser profile; four-live bound; page restoration limitation.
9. Measure resident idle CPU/RSS and four-live browser RSS before enabling by default.

## 29. Normative limits

| Resource | Limit | Failure behavior |
|---|---:|---|
| Broker frame | 1 MiB | disconnect malformed client |
| Request/action string | 64 KiB total; URL 8 KiB | `INVALID_REQUEST` |
| Connections | 8 global; 2 per controller | reject/close excess |
| Active requests | 32 global; 16 per browser mutation queue | `REQUEST_LIMIT` |
| Request deadline | 30 s default; wait up to 120 s explicit | `ACTION_TIMEOUT` |
| Approval lifetime | 60 s | deny |
| Replay cache | 256 responses or 5 min, whichever first | high-water rejects an evicted duplicate |
| Live browser-record renderers | 4 | freeze eligible LRU or queue |
| Activation queue | 8 entries, 10 s | `BROWSER_CAPACITY_BUSY` |
| Snapshot | 2,000 nodes, depth 20, 256 KiB text/result | truncate with explicit marker |
| Console/network ring | 1,000 items and 1 MiB each per browser | drop oldest and report count |
| Screenshot | 4096×4096, 10 MiB encoded binary attachment | reject/scale only with caller consent; never return a path |
| Geometry | 1..32767 coordinates/dimensions; monotonic u53 revision | ignore invalid/stale update |
| Browser state | 1,000 records; 8 MiB file | recovery/error, never unbounded parse |
| Recovery items | 100 visible + bounded archived diagnostics | oldest metadata summarized, URL still redacted |
| GC grace | 24 h and two successful matching-store commits | retain orphan before grace |

These constants live in one shared policy module where TypeScript can reuse them; the protocol documents values so Pi clients can format useful errors. Security-sensitive host checks do not trust client-side copies.

## 30. Design review

A six-dimensional review (architecture, security/privacy, concurrency/persistence, product/UX, performance, and verification/operability) found the direction sound only after tightening its authority and failure boundaries. This revision adds the narrow constitutional exception, sender-derived command seam, fail-closed daemon metadata watcher, crash-consistent two-store journal, incarnation-plus-generation concurrency contract, complete versioned broker/workspace envelopes, durable recovery UX, explicit lifecycle inhibit/drain, Rust-v2-first rollout, hard Phase-0 sandbox/CDP/input/geometry gates, and normative limits. It preserves every locked product decision. With those blockers resolved, the design is coherent and **approved for implementation**, subject to every Phase-0 stop gate.

## 31. Acceptance criteria

### Product

- Every Amber tab can have zero or one dedicated right browser rail.
- Browser is not a split-tree leaf and cannot be moved as a terminal pane.
- Exactly one live Pi pane in that tab may be designated.
- Share with Pi is off by default, visible, and immediately revocable.
- Pi first-use creation is visible.
- User and Pi operate the same page.
- Four-live-renderer policy behaves deterministically.

### Lifecycle

- Closing the GUI does not stop live browsers or Pi browser tools.
- Relaunch reopens the resident process/window.
- Explicit Quit stops browser tools and destroys browser contents after warning.
- Host restart restores URL/profile/viewport and truthfully discloses reload.
- Browser failure never kills the Pi PTY session or daemon.

### Security

- No remote page receives Node, preload privilege, raw IPC, filesystem, shell, daemon, or CDP access.
- Browser partition permissions default deny through request and check handlers.
- Navigation/popups/external protocols are parsed and policy-controlled.
- Pi cannot act unless it is current designated controller and Share is enabled.
- Snapshot refs cannot be replayed across generation changes.
- Consequential actions require visible approval.
- Cookie/auth/password/credential data is excluded from normal tool output and persistence.

### Development capability

- Pi can navigate, inspect accessibility/DOM/CSS, click/type/select/scroll/drag, set viewport, screenshot, and inspect bounded console/network diagnostics.
- Playwright actionability/waits are reused rather than replaced with coordinate-only automation.
- Advanced sensitive capabilities are separately gated.

### Persistence/migration

- Existing valid browser URLs migrate without silent loss.
- Extra legacy browsers are recoverable/reported.
- `.amberws` saves browser intent without credentials/share/controller.
- Browser records survive ordinary window close and restore after process restart within documented limits.

### Quality

- Tests are authored first and cover pure, protocol, security, lifecycle, capacity, migration, and Electron boundaries.
- No test/build workload runs on the slow source drive.
- Document, plan, and implementation receive independent architecture, security, concurrency, performance, UX/accessibility, and correctness reviews.
- Full diff contains no unrelated formatting churn or staged user files.

## 32. Deliberate tradeoffs and residual risks

1. **Global profile blast radius:** explicitly chosen for convenience; Share per tab mitigates agent access but not cross-project browser identity.
2. **Concurrent input races:** explicitly chosen; generation checks reduce stale actions but do not prevent mid-action interleaving or undo committed effects.
3. **Resident Electron dependency:** window close continuity is strong; process-crash/reboot continuity restores intent, not exact page memory.
4. **CDP endpoint:** Playwright reuse may require a loopback debugging endpoint with broader same-user reach than an in-process debugger; Phase-0 security prototype is a hard gate.
5. **Native child-view complexity:** bounds, overlays, focus, IME, accessibility, and macOS/Linux behavior need live proof.
6. **Four-live cap reload loss:** freezing loses volatile state; disclosed and deterministic.
7. **Consequential classifier incompleteness:** no generic browser can perfectly infer site semantics; conservative policy and explicit user approval are required.
8. **Prompt injection:** page content remains adversarial even when accessibility-first.
9. **Remote gap:** SSH remote windows and mobile do not receive browser-host parity in v1.
10. **Package size:** Playwright core adds production weight even without downloading Chromium.

## 33. Primary sources

### Local

- `CLAUDE.md`
- `docs/superpowers/specs/2026-07-18-browser-pane-design.md`
- `docs/superpowers/plans/2026-07-18-browser-pane.md`
- `docs/superpowers/specs/2026-08-24-pi-session-kind-design.md`
- `app/src/renderer/Browser.tsx`
- `app/src/main/index.ts`
- `app/src/shared/layoutFile.ts`
- `app/src/shared/workspaceFile.ts`
- `crates/amber/src/pi.rs`

### Official/current external

- Electron `<webview>` warning: https://www.electronjs.org/docs/latest/api/webview-tag
- Electron `WebContentsView`: https://www.electronjs.org/docs/latest/api/web-contents-view
- Electron security checklist: https://www.electronjs.org/docs/latest/tutorial/security
- Electron sessions/permissions: https://www.electronjs.org/docs/latest/api/session
- Electron Debugger/CDP: https://www.electronjs.org/docs/latest/api/debugger
- Playwright `connectOverCDP`: https://playwright.dev/docs/api/class-browsertype
- Playwright browser contexts/auth/tracing: https://playwright.dev/docs/api/class-browsercontext
- Playwright MCP: https://github.com/microsoft/playwright-mcp
- VS Code Integrated Browser: https://code.visualstudio.com/docs/debugtest/integrated-browser
- VS Code browser tools: https://code.visualstudio.com/docs/agents/run/browser-tools
- Cursor browser tools: https://cursor.com/docs/agent/tools/browser
- Chrome remote-debugging security: https://developer.chrome.com/blog/remote-debugging-port
- CDP Target domain: https://chromedevtools.github.io/devtools-protocol/tot/Target/
- Pi extensions: local installed `docs/extensions.md` and `docs/environment-variables.md`

## 34. Stop conditions

Stop implementation and revisit this design if any prototype proves one of these:

1. A `WebContentsView` cannot be made to obey Amber rail geometry, occlusion, focus, or accessibility on supported platforms.
2. Playwright cannot reliably map/control the exact visible Electron page without exposing unacceptable control over the Amber host renderer.
3. Resident close/reopen semantics conflict with platform launcher/service behavior or leave unrecoverable headless processes.
4. The four-live bound cannot be maintained without silently destroying protected work.
5. Pi identity cannot be authorized against current tab membership without trusting stale renderer state.
6. A requirement would make remote page content privileged.
7. The implementation would require the Rust daemon to treat browser existence as a PTY session.
8. The hardened browser cannot remain sandboxed under the app's supported launch modes, or compatibility mode would expose authenticated pages.
9. The two-store transaction cannot recover every crash point without silent URL/association loss.
10. Physical input/IME or native geometry/occlusion cannot be proven on either Linux or macOS.
11. Windows feature gating cannot prevent partial broker/host activation before its native gates pass.
