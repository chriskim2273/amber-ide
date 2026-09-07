# Pi Chat Upgrades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. User explicitly approved full implementation; parent owns design and final acceptance.

**Goal:** Shared desktop/remote chat with actual uploads, supported subagent controls and a readable reliable transcript/composer.

**Architecture:** Closed bounded commands on the existing semantic transport. The Amber extension inside the same Pi TUI owns public Pi/plugin API calls and a persistent input-artifact store; no new service/process or session writer. Sequential writers in one persistent isolated worktree.

**Tech Stack:** Existing Rust protocol/daemon/web, TypeScript generated Pi extension, React and plain CSS, existing marked lexer if needed; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-07-pi-chat-upgrades-design.md`

## Global constraints

- Worktree `/home/poyto/worktrees/amber-ide/chat-upgrades`, branch `feat/chat-upgrades`, base `668597b`.
- Preserve production daemon, state, Pi settings/plugin installation and unrelated repository changes.
- Read relevant local Pi docs completely and follow relevant API cross-references. Installed docs at `/home/poyto/.nvm/versions/node/v24.16.0/lib/node_modules/@earendil-works/pi-coding-agent/`; plugin public API at `/home/poyto/.pi/agent/npm/node_modules/pi-subagents/docs/extension-api.md`.
- All exact limits, filesystem guards, capability checks, request receipts and no-replay requirements in spec apply.
- Before modifying a file record its baseline hash and verify it is unchanged before replacing. One writer at a time; conventional milestone commits without coauthor lines.
- Evidence in `.reports/pi-chat-upgrades/` (persistent). No new packages, production installation, schema beyond the specified command families, arbitrary RPC or architecture substitutions without parent decision.

## Task 1: Reliable prompt and attachment transport

Files: `crates/amber-core/src/proto.rs`, `crates/amber/src/daemon.rs`, `crates/amber/src/web.rs`, `crates/amber/src/pi.rs`, generated-extension helper template files beside pi.rs if needed, `crates/amber/tests/pi_extension.test.mjs`, `app/src/shared/proto.ts`, `app/src/client/router.ts`, `app/src/web/amber.ts`, their existing tests and `app/scripts/verify-pi-browser-extension.mjs` only if verifier fixtures require new public APIs.

Interface: retain legacy Prompt. Add `PromptWithAttachments { requestId, message, delivery, attachments: string[] }`, `UploadBegin { requestId, filename, mimeType, size }`, `UploadChunk { requestId, attachmentId, offset, data }`, `UploadFinish { requestId, attachmentId }`, `UploadCancel { requestId, attachmentId }`. Rust serialization uses existing external-tag casing; TS mirrors exactly. Extension emits `command_result { requestId, command, success, error?, data? }` through PiEvent; begin data includes attachmentId; chunk data includes acknowledged offset; finish includes filename, size, MIME and attachmentId metadata only. Errors never include uploaded bytes. Snapshot includes `capabilities: { attachments: true, promptReceipts: true }` and model input modalities.

- [ ] Establish baseline: worktree-local dependencies (npm ci if needed), `cargo test --workspace`, app `npm test` and `npm run typecheck`. Log exact baseline failures; stop for parent decision rather than treating as regressions.
- [ ] Add failing Rust serialization/validation and web parser/Hub tests for new commands, semantic-only exact pane binding, chunk encoded limits, wrong-kind and rejected internal/arbitrary operation. Expected: missing variants or commands rejected before implementation.
- [ ] Implement additive enums, shared Rust validator used by daemon/web, strict TS decoder and web adapter. Never widen arbitrary forwarding or PTY path.
- [ ] Add generated extension behavioral tests using existing stub harness and isolated directories: bytes hash roundtrip, bad offset/base64/size, quotas, symlink roots, cross-session identifiers, finish/cancel/expiry, image capability and real installed content shape, exact prompt receipt and duplicate request behavior. Watch fail first.
- [ ] Implement bounded async upload store inside the owned extension; do not serialize Stop behind large file work. Safe paths/permissions, reservations, atomic finish, persistent metadata, no-follow opens, completed-file quota and pending expiry per spec. Format host references as quoted data and images as installed public ImageContent.
- [ ] Add request-ID acceptance cache and explicit error receipts. Derive busy behavior from latest context; do not claim model completion. All unknowns/timeouts are errors, not retries. Keep legacy requests working.
- [ ] Run focused Rust/web/proto/generated extension tests, app proto/router/web tests, typecheck and extension verifier. One focused repair per failure before escalation. Commit tested milestone and report actual commands/results and exported interfaces.

## Task 2: Subagent API bridge

Files: generated extension semantic helper/pi.rs, Rust/TS command enums and validators, web adapter, extension behavioral tests; new `app/src/renderer/piSubagents.ts` and tests for safe normalized DTOs if useful. Task 1 interfaces remain stable.

Interface: explicit `SubagentStatus { requestId }`, `SubagentTranscript { requestId, runId, index? }`, `SubagentControl { requestId, action: 'stop'|'steer'|'interrupt'|'resume', runId, childId?, index?, message? }`. These map only to the documented RPC methods/fields. `subagent_status` event contains bounded normalized capabilities, async runs and display fleet, with stale/unavailable reason. `command_result` carries control receipt or bounded transcript. Do not use fleet keys for control or step IDs as child indexes.

- [ ] Read public plugin RPC docs and relevant installed source DTO/parameter guards. Probe shape only in test fixtures/private session, never mutate current run/plugin config. Return any incompatible contract to parent.
- [ ] Write failing tests for plugin absence/load-order/timeout, cleanup, request correlation, exact valid run IDs, read-only display rows, control method allowlist, limits and non-recovering steering. Mock real documented replies, not invented shapes.
- [ ] Implement event-bus RPC adapter with timeout/unsubscribe, one status call in flight and 2-second poll, normalized bounded snapshot cache. No polling filesystem/internal imports and no timer/network resources started from factory rather than session lifecycle.
- [ ] Validate control target against latest package-owned current-session status, delegate owner checks to plugin, confirm capability for resume. Use targeted rich status for child identity or expose read-only child rows; no guessing.
- [ ] Wire closed commands through Rust/web/TS layers. Return success only after RPC receipt; stop request is stopping, not stopped. Refresh snapshot after receipt. Missing plugin is descriptive degraded state.
- [ ] Run focused tests, typecheck and generated extension verifier; commit and report evidence plus DTO used by UI.

## Task 3: Shared chat UX and composer

Files: `app/src/renderer/PiPane.tsx`, `piModel.ts`, `piModel.test.ts`, focused new `PiComposer.tsx`, `PiTranscript.tsx`, `PiSubagents.tsx`, `piAttachments.ts`, `piDraft.ts`, `PiPane.css` or equivalent focused files with tests; modify only existing Pi CSS block in theme.css if extracting it. Use existing dependencies; do not change app-wide identity/navigation.

- [ ] Write failing pure/component tests for timeline merge by toolCallId, snapshot recovery, stable errors, exact late receipt, draft storage denial, image-only prompts, IME Enter, upload offset progress, obsolete replies after session/view change, read-only fleet keys, safe Markdown/links.
- [ ] Normalize transient tools into their assistant turn; do not duplicate toolResult messages and ToolCards. Preserve content order, bounded buffers, unknown content labels and reconnect checkpoints.
- [ ] Implement React-safe Markdown tokens, code/message copy buttons, compact collapsed tool summaries and selected subagent transcript/control panels. Do not use raw HTML, fetch remote images, or widen links beyond safe schemes.
- [ ] Implement upload client as acknowledged sequential File.slice chunks (48 KiB), per-file progress/error/cancel states, size/count limits, preview object URL cleanup. Picker/drop/paste share it and upload actual bytes. Do not store base64 in browser storage.
- [ ] Implement session-scoped guarded draft storage and prompt receipt handling without clearing newer edits. Preserve uncertain draft and show explicit unknown delivery after disconnect; never auto-send. Show pending follow-up status. Persist completed attachment metadata only if restore validates current Pi session.
- [ ] Implement Stop confirmation and message input for subagent steer/resume, pending receipt/errors, fresh status guards and accessible detail toggles. Unknown/uncontrollable targets have no active controls.
- [ ] Improve layout with existing tokens, readable measure, visible labels/focus, compact metadata, large mobile controls, responsive composer and jump-to-latest. No per-token live announcements; no continuous scroll state updates; no gratuitous motion.
- [ ] Run app tests, typecheck, desktop/web build and diff check. Commit and report verified behavior versus remaining live checks.

## Task 4: Review and private verification

- [ ] Parent reviews actual diff and evidence against spec. Independent read-only reviewer reviews protocol/storage/ownership/lifecycle and identifies concrete blockers with file references; it does not mutate.
- [ ] Parent assigns only accepted findings back to one sequential writer; no scope creep or alternate execution-mode fallback. If infrastructure fails capture clean/partial worktree state and report exact error.
- [ ] Run full Rust tests/clippy; full app tests/typecheck/build/build:web; generated extension verifier; git diff --check. Record full logs and test counts.
- [ ] Read verify skill; private daemon/state/web/Electron only. Browser-origin File upload hash equals host bytes, pasted image reaches real public Pi content shape, subagent fixture exercises actual RPC envelope/receipts, reconnect preserves conversation and terminal attachment still works. Retain screenshots at desktop/narrow/mobile sizes. No model charges or production restarts.
- [ ] Record remaining real-hardware/live-plugin gaps explicitly; update AGENTS.md status only to observed evidence. Commit final milestone; no automatic merge, install or deploy.
