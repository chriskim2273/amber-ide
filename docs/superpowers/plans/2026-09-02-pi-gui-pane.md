# Optional Pi GUI Pane Implementation Plan

> **For agentic workers:** execute every task in order. Follow repository TDD: add the focused failing test, observe the expected failure, implement minimally, and rerun the focused test before the broader gate. Never restart the user's live Amber daemon; all live checks use private state/socket paths.

**Goal:** Add a persistent `Terminal | GUI` presentation toggle to supervised Pi panes, backed by a semantic sideband from Amber's existing Pi extension to the daemon, without starting a second Pi process or changing the raw PTY path.

**Architecture:** `amber-hook.ts` connects to the existing local Amber socket and publishes normalized public Pi extension events. The daemon capability-gates and forwards them to native/web clients. A Pi GUI uses a semantic pane MessagePort instead of attaching to PTY output. Terminal mode remains the default and unchanged.

**Design:** `docs/superpowers/specs/2026-09-02-pi-gui-pane-design.md`

## Global constraints

- Keep one daemon session, one PTY, one Pi process.
- Use only public Pi `ExtensionAPI`/`ExtensionContext`; no prototype patching.
- No direct Pi-owned HTTP/WebSocket listener.
- Additive protocol evolution: legacy clients must never receive new variants without `WatchPiEvents`.
- All queues bounded; no socket write on a connection read thread except existing bounded reply paths.
- GUI text is rendered safely as text/React nodes—no unsanitized HTML.
- Existing terminal tests and byte transport remain green.
- Update `AGENTS.md` with the approved Pi-only scope exception and final verified status.

## Task 1 — Protocol types and framing (TDD)

**Files:**

- Modify `crates/amber-core/src/proto.rs`
- Modify `app/src/shared/proto.ts`
- Modify corresponding Rust/TypeScript protocol tests

**Steps:**

- [ ] Add Rust `PiDelivery` and `PiCommand` closed enums.
- [ ] Add `WatchPiEvents`, `PiBridgeHello`, `PiBridgeCommand`, `PiEvent`, and `PiBridgeStatus` control variants.
- [ ] Add all variants to `known_control_variant`.
- [ ] Add round-trip tests covering every command and an event payload.
- [ ] Add matching strict TypeScript command types and tolerant Pi event payload types.
- [ ] Extend TS encoder/decoder and tests.
- [ ] Run focused protocol tests, then `cargo test -p amber-core` and `npm test -- proto`.

## Task 2 — Capability-gated Pi event watchers (TDD)

**Files:**

- Modify `crates/amber/src/watchers.rs`
- Modify `crates/amber/src/daemon.rs`

**Steps:**

- [ ] Write tests proving a legacy `WatchSessions` watcher receives no `PiEvent`/`PiBridgeStatus`.
- [ ] Write tests proving `WatchPiEvents {version:1}` receives them.
- [ ] Add `pi_version` to watcher entries and `register_pi`/`broadcast_pi` methods.
- [ ] Route `WatchPiEvents` in daemon control handling.
- [ ] Preserve existing pressure/session capability merging for repeated registration on one writer.
- [ ] Run watcher and daemon focused tests.

## Task 3 — Bounded daemon bridge registry and command routing (TDD)

**Files:**

- Create `crates/amber/src/pi_bridge.rs`
- Modify `crates/amber/src/lib.rs`
- Modify `crates/amber/src/daemon.rs`

**Steps:**

- [ ] Define a registry with bounded per-bridge command channels and monotonic generation tokens.
- [ ] Test register, replacement, stale-generation unregister, current-generation unregister, missing bridge, and full queue behavior.
- [ ] Give `Daemon` a default `Arc<PiBridges>` without changing callers.
- [ ] On `PiBridgeHello`, require an existing live `SessionKind::Pi`, register the connection, and spawn a bounded writer-forwarder for daemon-to-extension commands.
- [ ] Track the connection's registration and unregister it on teardown; broadcast status only when the current generation disappears.
- [ ] Validate `PiBridgeCommand` from clients: correct session kind, prompt byte cap, non-empty message, closed delivery/thinking enums.
- [ ] Forward valid commands with `try_send`; answer the requesting client with `PiBridgeStatus{available:false}` when absent rather than a global daemon error.
- [ ] Validate extension-originated `PiEvent`: registration name matches, monotonic sequence is forwarded as supplied, payload <=4 MiB and has a string `kind`; then `broadcast_pi`.
- [ ] Ignore daemon-only Pi event/status/command variants when sent by the wrong peer.
- [ ] Clear bridge registration on session kill/rename replacement through generation-safe teardown.
- [ ] Run focused daemon integration tests.

## Task 4 — Extend the Amber-owned Pi hook into a semantic bridge (TDD)

**Files:**

- Modify `crates/amber/src/pi.rs`
- Add/extend Pi extension-content tests in `pi.rs`

**Steps:**

- [ ] Preserve the existing `session_start` exact-ID hook behavior byte-for-behavior.
- [ ] Add a dependency-free Node `net` client using `AMBER_SOCK` and Amber's length-prefixed control framing.
- [ ] Add incremental frame decoding for fragmented/coalesced daemon commands with the 64 MiB outer frame cap.
- [ ] Register with `PiBridgeHello` and emit an initial normalized snapshot.
- [ ] Normalize active-branch messages: remove encrypted/signature fields, cap 200 entries, cap text fields, summarize image bodies.
- [ ] Include model/thinking/idle/pending/context metadata from public context/API methods only.
- [ ] Subscribe to message, tool-execution, agent, model, thinking, session-info, and UI-prompt lifecycle events.
- [ ] Throttle `message_update` to one latest update per 80 ms; flush before `message_end`.
- [ ] Handle Snapshot, Prompt(now/steer/follow-up), Abort, and SetThinkingLevel commands with explicit error events.
- [ ] Reconnect a lost socket while the extension instance is alive; close timers/socket on `session_shutdown`.
- [ ] Tests assert public API usage, caps/throttle constants, no prototype patching, bridge env guards, framing, command cases, and retained hook behavior.
- [ ] Run `cargo test pi::tests` and clippy for the touched module.

## Task 5 — Native utility-process semantic pane transport (TDD)

**Files:**

- Modify `app/src/client/router.ts`
- Modify `app/src/client/router.test.ts`
- Modify `app/src/client/index.ts`
- Modify `app/src/main/index.ts`
- Modify `app/src/preload/index.ts`
- Modify `app/src/renderer/main.tsx` window bridge typing

**Steps:**

- [ ] Extend pane acquisition with mode `terminal | pi` while keeping one-argument terminal calls backward compatible.
- [ ] Router records each port's mode. Replacing terminal with Pi mode sends one `Detach`; Pi mode never sends `Attach` or Resize.
- [ ] Route `PiEvent`/`PiBridgeStatus` only to the matching Pi-mode pane port.
- [ ] Route outbound `piCommand` only from a Pi-mode port.
- [ ] On daemon reconnect, terminal ports reattach and Pi-mode ports request Snapshot.
- [ ] Utility client advertises `WatchPiEvents{version:1}` after each connect.
- [ ] Main/preload carry the pane mode through MessageChannel creation without inspecting event payloads.
- [ ] Test replacement, no raw attach, event isolation, command routing, reconnect snapshot, detach cleanup, and terminal regression behavior.
- [ ] Run client/router tests and typecheck.

## Task 6 — Browser/mobile semantic pane transport (TDD)

**Files:**

- Modify `crates/amber/src/web.rs`
- Modify Rust web tests
- Modify `app/src/web/amber.ts`
- Modify `app/src/web/amber.test.ts`
- Modify `app/src/web/install.ts` if the pane-opening adapter requires a mode field

**Steps:**

- [ ] Add `PiOpen` and `PiCommand` browser message shapes.
- [ ] `PiOpen` validates an existing live Pi session, marks the browser client semantic-open, and performs no daemon Attach/grid borrow.
- [ ] `PiCommand` is accepted only from the client semantic-open on that same Pi name and maps to a validated daemon `PiBridgeCommand`.
- [ ] Daemon-link startup advertises `WatchPiEvents{version:1}`.
- [ ] Forward Pi event/status frames only to semantic clients open on the matching name.
- [ ] Extend browser server text messages with `piEvent`/`piStatus`.
- [ ] Extend `PaneLink` with terminal/Pi mode: Pi mode sends `piOpen`, carries semantic messages, and never sends binary/resize/release.
- [ ] Add security regression tests: wrong kind, unopened name, cross-pane command, malformed command, oversized prompt, and legacy terminal path.
- [ ] Run Rust web tests and web-shim tests.

## Task 7 — Layout preference and pure Pi GUI model (TDD)

**Files:**

- Modify `app/src/shared/layoutFile.ts`
- Modify `app/src/shared/layoutFile.test.ts`
- Create `app/src/renderer/piGuiModel.ts`
- Create `app/src/renderer/piGuiModel.test.ts`

**Steps:**

- [ ] Add optional `piViews?: Record<string,'gui'>` with a parser that drops malformed keys/values.
- [ ] Test round trip, malformed input, layout CAS three-way merge, pruning, and rename-retarget helpers.
- [ ] Define bounded/tolerant Pi GUI event and snapshot guards; never trust bridge payload shapes in React.
- [ ] Define pure message extraction from normalized snapshot entries.
- [ ] Define event reducer: sequence de-duplication, snapshot replace, transient streaming replace, tool lifecycle, busy/idle, bridge status, and error state.
- [ ] Define safe content-to-text, clipping indicator, delivery-choice, and Enter/Shift+Enter helpers.
- [ ] Run focused model/layout tests.

## Task 8 — Pi graphical pane and view toggle

**Files:**

- Create `app/src/renderer/PiGuiPane.tsx`
- Modify `app/src/renderer/SplitView.tsx`
- Modify `app/src/renderer/main.tsx`
- Modify `app/src/renderer/theme.css`

**Steps:**

- [ ] Implement one-port lifecycle mirroring `Pane`: acquire Pi-mode port, request snapshot, replace port after `portEpoch`, and close on unmount.
- [ ] Render safe text conversation rows for user/assistant/thinking/tool roles.
- [ ] Replace one streaming message in React state rather than appending token fragments.
- [ ] Implement near-bottom auto-follow, manual scroll preservation, empty/loading/unavailable/error states.
- [ ] Implement multiline composer, idle Send, busy Steer/Queue, Stop, thinking selector, and accessible status.
- [ ] Make the root/composer focusable so existing directional pane navigation works.
- [ ] In `SplitView`, render `PiGuiPane` only for Pi + saved GUI preference.
- [ ] Hide terminal-only search/refresh/preset/key-bar behavior in GUI mode while preserving session freeze/close/move/zoom.
- [ ] Add context-menu `Open graphical view` / `Open terminal view` for Pi.
- [ ] In `main.tsx`, persist the toggle, prune stale Pi view entries, and retarget on cross-group rename.
- [ ] Add responsive styles that fit Amber Pocket safe areas and avoid horizontal overflow.
- [ ] Run app tests, typecheck, desktop build, and web build.

## Task 9 — Constitution/status documentation and compatibility checks

**Files:**

- Modify `AGENTS.md`
- Update the design spec status
- Update this plan's checklist during execution

**Steps:**

- [ ] Replace the broad AI-chat exclusion with a narrow recorded exception: Pi semantic GUI only; generic agent chat remains out of scope.
- [ ] Add a build-status entry with architecture, gates, live evidence, and remaining limitations.
- [ ] Confirm no generated secrets, sockets, certificates, session files, or local reports are staged.
- [ ] Run `git diff --check` and inspect the complete diff.

## Task 10 — Automated and live validation

- [ ] `cargo test --workspace`
- [ ] `cargo clippy --workspace --all-targets -- -D warnings`
- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `npm run build:web`
- [ ] Run a private-daemon fake-Pi bridge smoke for protocol registration, snapshot, prompt, event, disconnect, and reconnect.
- [ ] If a real Pi smoke is safe and authentication is already available, launch only under a private Amber state/socket, open GUI, send a harmless prompt, switch to Terminal, and prove the same live process/session continues. Otherwise record the exact manual gap.

## Task 11 — Independent review and repair

- [ ] Run parallel review across architecture/invariants, Rust concurrency/backpressure/security, TypeScript transport/state, GUI accessibility/mobile behavior, and test coverage.
- [ ] Classify findings by severity and evidence; discard speculative changes that weaken established invariants.
- [ ] Repair every verified high/medium finding and reasonable low-risk low finding.
- [ ] Rerun focused tests after each repair wave.
- [ ] Rerun every final gate and inspect `git status`, `git diff --stat`, and `git diff --check`.
- [ ] Commit milestones with concise conventional messages and no `Co-Authored-By` lines.
