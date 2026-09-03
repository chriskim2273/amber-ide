# Optional Pi graphical pane — design

**Date:** 2026-09-02

**Status:** approved for implementation

**Scope decision:** The user explicitly approved a Pi-only exception to the repository constitution's previous “AI chat UI” exclusion. This does not authorize a generic cross-agent chat layer. Existing shell and agent terminal paths remain supported and unchanged.

**Builds on:**

- `2026-08-24-pi-session-kind-design.md`
- `2026-08-29-amber-pocket-mobile-product-design.md`
- Pi extension documentation and the public `ExtensionAPI`

## 1. Goal

Let any supervised `kind:"pi"` pane switch between two optional presentations of the same live Pi process:

1. **Terminal** — the existing Pi TUI rendered by xterm.
2. **GUI** — an Amber-native semantic conversation view optimized for desktop and phone.

The GUI must preserve the defining Amber contract: the daemon owns the session and PTY, the Pi process stays alive when clients disappear, the browser is disposable, and there is never a second writer opening the same Pi JSONL conversation.

## 2. Product contract

- Existing Pi panes default to Terminal.
- A Pi pane's action menu offers `Open graphical view` / `Open terminal view`.
- The preference is app-owned display metadata and survives app/browser restarts in the layout sidecar.
- Switching views does not restart Pi, mutate the conversation, resize the PTY, or create another session.
- The GUI renders submitted user messages, assistant streaming text/thinking, tool calls/results, current model/thinking level, busy/idle state, and errors.
- The GUI can send an ordinary prompt, steer or queue a message while Pi is running, abort the active turn, and change the thinking level.
- Terminal-only or unsupported extension interactions remain available by switching back to Terminal. The GUI must say this honestly instead of pretending complete TUI parity.
- Mobile uses the same Pi GUI component and the same daemon-owned session; no mobile-only conversation store exists.

## 3. Architecture decision

### 3.1 Rejected: second RPC process

`pi --mode rpc --session <same-id>` would create another `AgentSession` owner and cannot safely coexist with the existing interactive Pi TUI. Replacing the PTY with a pipe-backed RPC process would violate Amber's current core architecture: every daemon pane is one PTY and terminal bytes stay raw.

### 3.2 Rejected: embedded third-party server

Standalone Pi GUIs own their own process, session registry, HTTP/auth boundary, and often their own filesystem/terminal workspace. Embedding one would create a second lifecycle authority and remote-access surface.

### 3.3 Selected: public-extension semantic sideband

Amber already installs `amber-hook.ts` into Pi and scopes it to children carrying `AMBER_SESSION`. Extend that owned hook into a semantic bridge using only public Pi extension APIs:

```text
Pi GUI (React)
  | pane MessagePort / authenticated amber-web pane socket
  v
Amber utility client or amber web
  | versioned Amber control frames
  v
Amber daemon
  | private, local Amber protocol connection
  v
amber-hook.ts inside the existing Pi TUI process
  | public ExtensionAPI events + actions
  v
The same live Pi AgentSession and JSONL session
```

The TUI remains the only Pi process. Its PTY and raw output path are unchanged. The semantic bridge is an additive sideband, not terminal scraping.

## 4. Bridge protocol

Add additive, externally tagged Amber control variants:

- `WatchPiEvents { version }` — explicit capability opt-in. Older strict clients never receive unknown Pi events.
- `PiBridgeHello { name }` — trusted local Pi extension registers itself for one daemon session.
- `PiBridgeCommand { name, command }` — daemon to the registered extension only.
- `PiEvent { name, seq, event }` — extension to daemon; daemon broadcasts only to `WatchPiEvents` clients.
- `PiBridgeStatus { name, available }` — daemon to opted-in clients when a bridge appears/disappears or a request has no bridge.

Commands are a strict Rust enum:

- `Snapshot`
- `Prompt { message, delivery }`, where delivery is `now | steer | follow_up`
- `Abort`
- `SetThinkingLevel { level }`

Browser-originated commands are accepted only when:

- the browser connection currently has that pane open in semantic mode;
- the daemon session exists and is `kind:"pi"`;
- the message is non-empty and at most 64 KiB UTF-8;
- delivery and thinking values decode through closed enums.

Events use a bounded `serde_json::Value` payload because Pi's public event shape evolves faster than Amber's daemon needs to understand. The bridge is trusted local code, but the daemon still rejects payloads over 4 MiB and requires a string `kind` field.

## 5. Extension behavior

The generated Amber-owned extension:

- keeps exact-session recording unchanged;
- connects only when both `AMBER_SESSION` and `AMBER_SOCK` are present;
- speaks Amber's length-prefixed control framing directly over Node `net`;
- retries a dropped daemon link with a bounded delay;
- registers with `PiBridgeHello` after each connect;
- stores the latest public `ExtensionContext` for commands;
- emits a normalized snapshot on connect, on explicit request, and after final message/session events;
- emits throttled `message_update` records at no more than one every 80 ms;
- emits agent, message, tool-execution, model, and thinking events;
- closes the bridge on `session_shutdown` and recreates it after the replacement session's extension reload.

Snapshots include only the active branch and UI-safe fields. They:

- cap history to the newest 200 entries;
- cap any individual text field to 64 KiB;
- omit reasoning signatures, encrypted reasoning, raw image bodies, and provider credential/config fields;
- represent omitted images as metadata rather than base64;
- include session id/file/name, cwd, model identity, thinking level, idle state, queue state, and context usage.

The bridge never monkey-patches `AgentSession.prototype` and never accesses private Pi internals.

## 6. Daemon lifecycle and backpressure

A new `PiBridges` registry is daemon-local and non-authoritative. It maps a session name to one bounded command sender and a generation token.

- A newer registration replaces an older one.
- Registration is accepted only for a live Pi session.
- Connection teardown removes only its own generation, so an old connection cannot delete a replacement.
- Killing a session clears its bridge entry.
- Commands use `try_send`; a full bridge queue is an error, never a daemon-thread block.
- Pi events use the existing bounded watcher-forwarder discipline and only reach Pi-capable watchers.
- The extension throttles streaming updates before they reach the daemon.
- GUI clients recover from dropped events by requesting a fresh snapshot; events carry a monotonic per-extension sequence so stale duplicates can be ignored.

No client read thread performs a blocking write.

## 7. Desktop transport

The utility process advertises `WatchPiEvents { version:1 }` on every daemon connection.

A pane port is opened in one of two modes:

- `terminal`: existing `Attach`, raw `Data`, resize, and `Detach` behavior.
- `pi`: no PTY subscription and no resize. The port carries only `{piEvent}`, `{piStatus}`, and outbound `{piCommand}` messages.

Switching the React view replaces the port registration. Router replacement explicitly detaches the prior terminal subscription before installing semantic mode, avoiding duplicate raw subscriptions and wasted backlog replay.

On utility-process or daemon reconnect, semantic registrations request a new `Snapshot`.

## 8. Browser/mobile transport

`amber web` advertises `WatchPiEvents { version:1 }` on its single daemon link.

A pane WebSocket gains semantic mode:

- `{t:"piOpen",name}` selects a Pi pane without daemon `Attach` or PTY grid borrowing.
- `{t:"piCommand",name,command}` routes through the strict browser mapping.
- server `{t:"piEvent",name,seq,event}` and `{t:"piStatus",...}` go only to clients whose semantic pane is open for that name.

Terminal mode and binary frames remain byte-for-byte unchanged. Semantic mode never borrows/resizes PTY geometry, so opening the GUI on a phone cannot reflow the desktop TUI.

The existing fragment-token to HttpOnly-cookie login, same-origin WebSocket, queue bounds, and Tailscale exposure remain the sole network security boundary. Pi never opens a TCP listener.

## 9. Renderer state and UI

The layout sidecar adds:

```ts
piViews?: Record<string, 'gui'>
```

Only non-default GUI choices are stored; absence means Terminal. Parsing drops non-`gui` values. Removed daemon sessions are pruned after the first authoritative session snapshot.

`SplitView` renders `PiGuiPane` when `meta.kind === 'pi' && piViews[paneId] === 'gui'`; otherwise it renders the existing `Pane` xterm.

### 9.1 Conversation rendering

- Flat, safe React text rendering; no `dangerouslySetInnerHTML`.
- Assistant/user/tool/thinking roles have semantic labels and restrained surfaces.
- Code/text preserve whitespace and wrap without causing horizontal page overflow.
- Tool calls/results collapse by default but expose name, arguments, result, and error state.
- Streaming content replaces one transient message instead of appending token nodes.
- Auto-scroll follows only when the user is already near the bottom; reading older history is not yanked.

### 9.2 Composer

- Multiline textarea; Enter submits, Shift+Enter inserts newline.
- While idle, the primary action sends `now`.
- While busy, explicit `Steer` and `Queue` actions avoid ambiguous delivery.
- Stop aborts the active turn.
- Thinking level is a compact select populated from the supported public values.
- Disabled/unavailable states explain that the terminal view remains available.

### 9.3 Accessibility/mobile

- 44 px mobile touch targets.
- Text labels accompany state color.
- Composer remains above safe-area and software keyboard using existing viewport conventions.
- The GUI does not mount xterm or the terminal key bar.
- Pane focus and Escape handling stay local to the GUI controls.
- `aria-live` reports connection, busy, and error changes without announcing every token.

## 10. Persistence, rename, and workspace behavior

- `piViews` is display metadata only and participates in the existing layout CAS merge.
- Session removal prunes stale entries.
- A cross-tab/workspace daemon rename retargets the display preference key alongside the rename request. A daemon error may fall back to Terminal; it never affects session truth.
- `.amberws` does not persist Pi GUI mode in the first release. It restores the real Pi session as Terminal, matching the safe default and avoiding a workspace file controlling remote semantic presentation.
- Freeze/suspend remains a session operation and applies identically in either view.

## 11. Compatibility and failure behavior

- Old daemon + new app: `WatchPiEvents` is leniently skipped; the GUI reports bridge unavailable and offers Terminal.
- New daemon + old app/web: no `WatchPiEvents`, therefore no unknown Pi events are sent.
- Pi absent or old enough to reject the generated extension: the normal terminal pane still works; GUI shows unavailable.
- Bridge disconnect: Pi and its TUI keep running. The GUI retains its last snapshot, shows reconnecting, and requests a snapshot when the bridge returns.
- Unsupported blocking extension UI: GUI explains that interaction is waiting in Terminal; it does not fabricate a dialog response.
- Malformed bridge event: daemon drops the event and logs; it does not close unrelated clients.

## 12. Test contract

Rust:

- protocol round trips and known-variant list;
- capability-gated watcher delivery;
- bridge registration replacement/generation cleanup;
- command validation, queue-full behavior, wrong-kind refusal;
- browser whitelist and semantic-open routing;
- generated extension content and idempotent refresh;
- no Pi event reaches a legacy watcher.

TypeScript:

- protocol encode/decode;
- router terminal/semantic replacement, reconnect snapshot, and event routing;
- web shim semantic open/command/event behavior;
- layout `piViews` guards, CAS merge, and stale pruning helper;
- Pi event reducer, normalization, clipping indicators, message/tool extraction;
- composer delivery selection and Enter/Shift+Enter behavior as pure helpers.

Gates:

- `cargo test --workspace`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `npm test`
- `npm run typecheck`
- `npm run build`
- `npm run build:web`
- `git diff --check`

Live verification uses a private Amber state root/socket and a real installed Pi. It must not restart or interfere with the user's running daemon.

## 13. Deliberate exclusions

- No second Pi RPC/SDK process.
- No terminal-output scraping.
- No generic Claude/Codex/Grok chat UI.
- No file browser, Git client, artifacts workspace, or replacement terminal inside the Pi GUI.
- No image upload in the first release.
- No session switching/forking/tree navigation from the GUI in the first release.
- No interception or monkey-patching of other extensions' custom TUI components.
- No network listener inside Pi.
