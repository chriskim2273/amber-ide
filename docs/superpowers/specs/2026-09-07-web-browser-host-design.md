# Web Amber browser host — design

**Status:** approved for implementation (2026-09-07)
**Date:** 2026-09-07

**Amends:** `2026-09-01-tab-browser-host-design.md` §4.7, §23.2, §32.9
**Related:** `2026-08-01-amber-ide-as-a-webapp-design.md`, `2026-09-01-token-router-design.md` (cookie-gated loopback proxy pattern)

## 1. Problem

Hosted `/app` (the web Amber client) currently stubs every browser API:

```ts
browserCommand: async () => ({ ok: false, error: 'BROWSER_HOST_UNAVAILABLE' })
```

`BrowserRail` still mounts in the desktop web viewport (`remoteHost` is empty), so Open Browser fails with that error. A native `WebContentsView` cannot attach inside Chrome/Safari. Pi on the daemon machine already talks to the resident Electron browser host over a local unix socket; the web UI cannot.

The user requirement: when using web Amber, the browser runs on the machine that runs the amber daemon, agents on that machine can drive it, and the web client can use the same live page.

## 2. Locked decisions

1. **Chromium stays in the resident Electron browser host** on the daemon machine. The web client never creates a second browser, iframe, or CDP endpoint.
2. **`amber web` is a cookie-gated proxy**, same class as `/api/router/*`: loopback only, session cookie, `browser-host-token` never enters the browser.
3. **Pi is unchanged.** Supervised agents keep using `browser-host.sock` with `BrokerRequest` + designation/share. This pass adds a **UI role** on that same socket for human web chrome, not a second broker.
4. **Remote presentation is screenshot-grounded.** Web `BrowserRail` paints JPEG/PNG frames from the host and maps pointer/keyboard onto existing generation-checked commands. No WebRTC in this pass.
5. **First command ensures the host** via existing `amber ctl browser-host ensure` (spawn registered `--browser-host`, wait for a proven socket).
6. **Scope is hosted `/app` desktop viewport.** Pocket/mobile (`pointer: coarse` / `!mobile` hide) and SSH remote Electron windows stay out of this pass.
7. **Windows remains fail-closed** (`BROWSER_HOST_UNAVAILABLE` / unsupported).

## 3. Non-goals

- Pocket/mobile rail, Mosaic tiles of live pages, SSH remote Electron overlay
- WebRTC / CDP screencast
- A public or tailnet-raw CDP/debug port
- Moving browser ownership into the daemon or a new Chromium service
- Letting the web client write browser association into `ui-layout.json` itself (the host still commits association; the web client applies `browserAssociation` events, same as desktop)

## 4. Architecture

```text
web /app (BrowserRail)
  cookie fetch / control WS JSON
        │
        ▼
amber web (127.0.0.1)
  ensure host · load 0600 token · UI-role unix socket
        │  never forwards the token
        ▼
Electron browser host (resident)
  WebContentsView + TabBrowserService + existing Pi broker
        ▲
        │ BrokerRequest (unchanged)
supervised Pi on the daemon machine
```

Sources of truth are unchanged from the tab-browser spec: daemon for PTYs, Electron host for browser runtime, sidecar for rail association. `amber web` holds zero browser authority of its own.

## 5. UI-role protocol (same unix socket)

Length-prefixed JSON, same 1 MiB cap, same token hello `{token}`. After `{ok:true}`:

1. `{version:1, role:"ui"}` — exact keys. Host replies `{ok:true}`. The connection is now UI-mode for its life.
2. Any other first post-auth message is a `BrokerRequest` (Pi path, unchanged). `{version:1, role:"ui"}` is not a valid `BrokerRequest`.

UI-mode requests (exact keys, `requestId` 1–128 chars):

| kind | body | result |
|---|---|---|
| `context` | `workspace:u32`, `tab:u32`, `collapsed:boolean` | `{ok:true, ...resolved context}` |
| `command` | `command` — `parseTabBrowserCommand` | same `{ok, result\|error}` as IPC |
| `recovery` | `recovery` — existing recovery request shape | same as `browser:recovery` |
| `snapshot` | (none) | workspace snapshot |
| `import` | `mode`, `text` | workspace import |
| `frame` | `id` opaque browser id | binary PNG/JPEG attachment |
| `subscribe` | (none) | `{ok:true}`; connection receives push events |

Pushes on a subscribed UI connection (no `requestId`):

- `{version:1, kind:"event", event}` — today’s `tab-browser-event` payloads
- `{version:1, kind:"association", ws, tab, browser?}` — today’s `tab-browser-association`

`show` arriving on a UI connection is **remote presentation**: the host uses width/height as the page viewport, attaches the view to the (possibly hidden) host window at `{x:0,y:0}` so Chromium still composites, and does **not** interpret client `x/y` as overlay coordinates in some other process’s window. Local Electron IPC `show` is unchanged (native overlay).

Frame capture: while any UI connection has the page shown, the host captures at most 5 fps, ≤1 MiB, `contentTrust: untrusted-browser-content`. `fromSurface` may be false when the host window is hidden so a resident `--browser-host` still yields pixels. `hide` / unsubscribe / socket close stops capture for that connection.

UI-mode has **no Pi replay cache**. Web retries are user-initiated.

## 6. `amber web` HTTP surface

Same cookie as `/api/sessions`. Same origin check as `/api/usage`. Token never in bodies, headers, or logs.

| method | path | purpose |
|---|---|---|
| `POST` | `/api/browser/context` | JSON `{workspace,tab,collapsed}` |
| `POST` | `/api/browser/command` | JSON TabBrowserCommand |
| `POST` | `/api/browser/recovery` | existing recovery request |
| `GET` | `/api/browser/snapshot` | workspace snapshot JSON |
| `POST` | `/api/browser/import` | `{mode,text}` |
| `GET` | `/api/browser/frame?id=` | `image/png` or `image/jpeg`; headers `X-Amber-Screenshot-Id`, `X-Amber-Generation`, `X-Amber-Page-Incarnation` |

Unauthenticated → 401. Host down after ensure → 503 `{ok:false, error:"BROWSER_HOST_UNAVAILABLE"}` with no token leak.

Control WebSocket JSON (never binary — ControlLink treats binary as backlog):

- `{t:"browserEvent", event}`
- `{t:"browserAssociation", ws, tab, browser?}`
- `{t:"browserFrame", id, screenshotId, generation, pageIncarnation}` — rail then GETs the frame

Hub holds **one** UI-role connection. First browser HTTP call runs `ensure` (10s, existing ctl), then connects. A reader thread fans events to every authenticated WS client. Commands serialize on that connection.

## 7. Web client

`createAmber` gains an injected `browserApi` (fetch-free file, same as `routerApi`). Stubs go away:

- `setBrowserContext` / `browserCommand` / `browserRecovery` / import / snapshot call the HTTP API and return `{ok, result\|error}`
- `onTabBrowserEvent` / `onBrowserAssociation` subscribe to control-WS `browserEvent` / `browserAssociation`
- `browserPresentation: 'remote'` is **not** added to `Window['amber']`. `BrowserRail` detects remote presentation from a `show` result `{presentation:'remote'}` or from `window.amber.browserCommand` succeeding with a frame hint. Practical rule: if `show` returns `presentation:'remote'` (web shim always requests it by rewriting show bounds through the proxy), the rail paints an `<img>` in `.tab-browser-page-slot`.

Pointer: click/move/drag/wheel on the image map into existing grounded `automation` mouse ops using the current `screenshotId`. Typing while the slot is focused uses `typeFocused`. Approvals/dialogs already live in `BrowserRail` and ride `onTabBrowserEvent`.

`main.tsx` keeps `!mobile && remoteHost.length === 0` for mounting the rail. Web has `remoteHost === ''`, so `/app` shows the rail. SSH windows stay on the existing unavailable aside.

## 8. Security

- Cookie boundary identical to `/api/router/*` and `/api/usage`
- Token file still 0600, owner-only, no-symlink, 43-char base64url
- Commands still pass `parseTabBrowserCommand` (no raw CDP)
- Frames labeled untrusted browser content
- Ensure cannot launch an unregistered/unsafe executable (existing launcher checks)
- Web client cannot designate a Pi it does not own; host keeps the existing controller eligibility checks
- LAN proxy continues to strip spoofable Serve headers

## 9. Testing

- Pure parse tests for UI hello/requests (reject extra keys, BrokerRequest-shaped smuggling, missing requestId)
- Broker integration: UI role does not enter the Pi handler; Pi path still works on a sibling connection
- `show` on UI connection rewrites bounds to `{x:0,y:0,width,height}` and reports `presentation:'remote'`
- Rust `browser_ops` against a fake unix host: token never in HTTP JSON; 401 without cookie; ensure-then-command
- Web shim: `browserCommand` uses injected API, control WS `browserEvent` reaches `onTabBrowserEvent`, binary WS frames are still backlog-only
- BrowserRail: remote slot renders an img with accessible name; click uses current screenshotId
- Live: private daemon + `--browser-host` + private `amber web` — Open Browser in `/app`, navigate, Pi screenshot/click on the same page

## 10. Spec amendments (tab-browser host)

Replace §4 non-goal 7 “A network-accessible browser-control endpoint” with: no **unauthenticated** or **non-loopback** browser-control endpoint. Authenticated `amber web` `/api/browser/*` on 127.0.0.1 (Tailscale Serve in front) is in scope as of 2026-09-07.

Replace §23.2 “Streaming/interacting with the desktop BrowserHost from mobile is out of scope” with: hosted `/app` desktop viewport streams screenshot frames and forwards chrome/input through `amber web`. Pocket/mobile and SSH remote windows remain out of scope.

§32.9 remote gap narrows to Pocket/mobile and SSH remote windows.
