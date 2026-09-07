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

- [x] Add Rust `PiDelivery` and `PiCommand` closed enums.
- [x] Add `WatchPiEvents`, `PiBridgeHello`, `PiBridgeCommand`, `PiEvent`, and `PiBridgeStatus` control variants.
- [x] Add all variants to `known_control_variant`.
- [x] Add round-trip tests covering every command and an event payload.
- [x] Add matching strict TypeScript command types and tolerant Pi event payload types.
- [x] Extend TS encoder/decoder and tests.
- [x] Run focused protocol tests, then `cargo test -p amber-core` and `npm test -- proto`.

## Task 2 — Capability-gated Pi event watchers (TDD)

**Files:**

- Modify `crates/amber/src/watchers.rs`
- Modify `crates/amber/src/daemon.rs`

**Steps:**

- [x] Write tests proving a legacy `WatchSessions` watcher receives no `PiEvent`/`PiBridgeStatus`.
- [x] Write tests proving `WatchPiEvents {version:1}` receives them.
- [x] Add `pi_version` to watcher entries and `register_pi`/`broadcast_pi` methods.
- [x] Route `WatchPiEvents` in daemon control handling.
- [x] Preserve existing pressure/session capability merging for repeated registration on one writer.
- [x] Run watcher and daemon focused tests.

## Task 3 — Bounded daemon bridge registry and command routing (TDD)

**Files:**

- Create `crates/amber/src/pi_bridge.rs`
- Modify `crates/amber/src/lib.rs`
- Modify `crates/amber/src/daemon.rs`

**Steps:**

- [x] Define a registry with bounded per-bridge command channels and monotonic generation tokens.
- [x] Test register, replacement, stale-generation unregister, current-generation unregister, missing bridge, and full queue behavior.
- [x] Give `Daemon` a default `Arc<PiBridges>` without changing callers.
- [x] On `PiBridgeHello`, require an existing live `SessionKind::Pi`, register the connection, and spawn a bounded writer-forwarder for daemon-to-extension commands.
- [x] Track the connection's registration and unregister it on teardown; broadcast status only when the current generation disappears.
- [x] Validate `PiBridgeCommand` from clients: correct session kind, prompt byte cap, non-empty message, closed delivery/thinking enums.
- [x] Forward valid commands with `try_send`; answer the requesting client with `PiBridgeStatus{available:false}` when absent rather than a global daemon error.
- [x] Validate extension-originated `PiEvent`: registration name matches, monotonic sequence is forwarded as supplied, payload <=4 MiB and has a string `kind`; then `broadcast_pi`.
- [x] Ignore daemon-only Pi event/status/command variants when sent by the wrong peer.
- [x] Clear bridge registration on session kill/rename replacement through generation-safe teardown.
- [x] Run focused daemon integration tests.

## Task 4 — Extend the Amber-owned Pi hook into a semantic bridge (TDD)

**Files:**

- Modify `crates/amber/src/pi.rs`
- Add/extend Pi extension-content tests in `pi.rs`

**Steps:**

- [x] Preserve the existing `session_start` exact-ID hook behavior byte-for-behavior.
- [x] Add a dependency-free Node `net` client using `AMBER_SOCK` and Amber's length-prefixed control framing.
- [x] Add incremental frame decoding for fragmented/coalesced daemon commands with the 64 MiB outer frame cap.
- [x] Register with `PiBridgeHello` and emit an initial normalized snapshot.
- [x] Normalize active-branch messages: remove encrypted/signature fields, cap 200 entries, cap text fields, summarize image bodies.
- [x] Include model/thinking/idle/pending/context metadata from public context/API methods only.
- [x] Subscribe to message, tool-execution, agent, model, thinking, session-info, and UI-prompt lifecycle events.
- [x] Throttle `message_update` to one latest update per 80 ms; flush before `message_end`.
- [x] Handle Snapshot, Prompt(now/steer/follow-up), Abort, and SetThinkingLevel commands with explicit error events.
- [x] Reconnect a lost socket while the extension instance is alive; close timers/socket on `session_shutdown`.
- [x] Tests assert public API usage, caps/throttle constants, no prototype patching, bridge env guards, framing, command cases, and retained hook behavior.
- [x] Run `cargo test pi::tests` and clippy for the touched module.

## Task 5 — Native utility-process semantic pane transport (TDD)

**Files:**

- Modify `app/src/client/router.ts`
- Modify `app/src/client/router.test.ts`
- Modify `app/src/client/index.ts`
- Modify `app/src/main/index.ts`
- Modify `app/src/preload/index.ts`
- Modify `app/src/renderer/main.tsx` window bridge typing

**Steps:**

- [x] Extend pane acquisition with mode `terminal | pi` while keeping one-argument terminal calls backward compatible.
- [x] Router records each port's mode. Replacing terminal with Pi mode sends one `Detach`; Pi mode never sends `Attach` or Resize.
- [x] Route `PiEvent`/`PiBridgeStatus` only to the matching Pi-mode pane port.
- [x] Route outbound `piCommand` only from a Pi-mode port.
- [x] On daemon reconnect, terminal ports reattach and Pi-mode ports request Snapshot.
- [x] Utility client advertises `WatchPiEvents{version:1}` after each connect.
- [x] Main/preload carry the pane mode through MessageChannel creation without inspecting event payloads.
- [x] Test replacement, no raw attach, event isolation, command routing, reconnect snapshot, detach cleanup, and terminal regression behavior.
- [x] Run client/router tests and typecheck.

## Task 6 — Browser/mobile semantic pane transport (TDD)

**Files:**

- Modify `crates/amber/src/web.rs`
- Modify Rust web tests
- Modify `app/src/web/amber.ts`
- Modify `app/src/web/amber.test.ts`
- Modify `app/src/web/install.ts` if the pane-opening adapter requires a mode field

**Steps:**

- [x] Add `PiOpen` and `PiCommand` browser message shapes.
- [x] `PiOpen` validates an existing live Pi session, marks the browser client semantic-open, and performs no daemon Attach/grid borrow.
- [x] `PiCommand` is accepted only from the client semantic-open on that same Pi name and maps to a validated daemon `PiBridgeCommand`.
- [x] Daemon-link startup advertises `WatchPiEvents{version:1}`.
- [x] Forward Pi event/status frames only to semantic clients open on the matching name.
- [x] Extend browser server text messages with `piEvent`/`piStatus`.
- [x] Extend `PaneLink` with terminal/Pi mode: Pi mode sends `piOpen`, carries semantic messages, and never sends binary/resize/release.
- [x] Add security regression tests: wrong kind, unopened name, cross-pane command, malformed command, oversized prompt, and legacy terminal path.
- [x] Run Rust web tests and web-shim tests.

## Task 7 — Layout preference and pure Pi GUI model (TDD)

**Files:**

- Modify `app/src/shared/layoutFile.ts`
- Modify `app/src/shared/layoutFile.test.ts`
- Create `app/src/renderer/piGuiModel.ts`
- Create `app/src/renderer/piGuiModel.test.ts`

**Steps:**

- [x] Add optional `piViews?: Record<string,'gui'>` with a parser that drops malformed keys/values.
- [x] Test round trip, malformed input, layout CAS three-way merge, pruning, and rename-retarget helpers.
- [x] Define bounded/tolerant Pi GUI event and snapshot guards; never trust bridge payload shapes in React.
- [x] Define pure message extraction from normalized snapshot entries.
- [x] Define event reducer: sequence de-duplication, snapshot replace, transient streaming replace, tool lifecycle, busy/idle, bridge status, and error state.
- [x] Define safe content-to-text, clipping indicator, delivery-choice, and Enter/Shift+Enter helpers.
- [x] Run focused model/layout tests.

## Task 8 — Pi graphical pane and view toggle

**Files:**

- Create `app/src/renderer/PiGuiPane.tsx`
- Modify `app/src/renderer/SplitView.tsx`
- Modify `app/src/renderer/main.tsx`
- Modify `app/src/renderer/theme.css`

**Steps:**

- [x] Implement one-port lifecycle mirroring `Pane`: acquire Pi-mode port, request snapshot, replace port after `portEpoch`, and close on unmount.
- [x] Render safe text conversation rows for user/assistant/thinking/tool roles.
- [x] Replace one streaming message in React state rather than appending token fragments.
- [x] Implement near-bottom auto-follow, manual scroll preservation, empty/loading/unavailable/error states.
- [x] Implement multiline composer, idle Send, busy Steer/Queue, Stop, thinking selector, and accessible status.
- [x] Make the root/composer focusable so existing directional pane navigation works.
- [x] In `SplitView`, render `PiGuiPane` only for Pi + saved GUI preference.
- [x] Hide terminal-only search/refresh/preset/key-bar behavior in GUI mode while preserving session freeze/close/move/zoom.
- [x] Add context-menu `Open graphical view` / `Open terminal view` for Pi.
- [x] In `main.tsx`, persist the toggle, prune stale Pi view entries, and retarget on cross-group rename.
- [x] Add responsive styles that fit Amber Pocket safe areas and avoid horizontal overflow.
- [x] Run app tests, typecheck, desktop build, and web build.

## Task 9 — Constitution/status documentation and compatibility checks

**Files:**

- Modify `AGENTS.md`
- Update the design spec status
- Update this plan's checklist during execution

**Steps:**

- [x] Replace the broad AI-chat exclusion with a narrow recorded exception: Pi semantic GUI only; generic agent chat remains out of scope.
- [x] Add a build-status entry with architecture, gates, live evidence, and remaining limitations.
- [x] Confirm no generated secrets, sockets, certificates, session files, or local reports are staged.
- [x] Run `git diff --check` and inspect the complete diff.

## Task 10 — Automated and live validation

- [x] `cargo test --workspace`
- [x] `cargo clippy --workspace --all-targets -- -D warnings`
- [x] `npm test`
- [x] `npm run typecheck`
- [x] `npm run build`
- [x] `npm run build:web`
- [x] Run a private-daemon Pi bridge smoke for protocol registration, snapshot, safe command, event, disconnect, and reconnect.
- [x] Run the safe private real-Pi bridge smoke under an isolated Amber state/socket; record the remaining user-facing prompt/toggle and phone-touch checks as manual gaps.

## Task 11 — Independent review and repair

- [x] Run parallel review across architecture/invariants, Rust concurrency/backpressure/security, TypeScript transport/state, GUI accessibility/mobile behavior, and test coverage.
- [x] Classify findings by severity and evidence; discard speculative changes that weaken established invariants.
- [x] Repair every verified high/medium finding and reasonable low-risk low finding.
- [x] Rerun focused tests after each repair wave.
- [x] Rerun every final gate and inspect `git status`, `git diff --stat`, and `git diff --check`.
- [x] Commit milestones with concise conventional messages and no `Co-Authored-By` lines.
