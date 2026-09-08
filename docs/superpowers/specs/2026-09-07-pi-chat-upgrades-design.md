# Pi chat upgrades

Status: user approved the proposed direction and full implementation, including controls, on 2026-09-07. No production rollout is authorized.

## Scope and architecture

Improve the existing Pi graphical pane, not a generic agent UI. Keep exactly one supervised Pi TUI process and its daemon-owned PTY. Terminal remains the default and remains usable. Use the existing capability-gated semantic transport through Electron's utility process or authenticated amber web. Never scrape a TUI, read another agent's session file directly, add a network listener, bypass approvals, or modify pi-subagents installation/configuration.

Three sequential implementation stages: reliable prompts/attachments; supported subagent status and controls; shared desktop/mobile UX. The same renderer and command contract serves both clients. Extend closed Rust/TypeScript command enums with explicit bounded operations, not arbitrary RPC/method invocation.

## References and design lock

Primary reference: Amber's existing `theme.css`, `PiPane.tsx`, `PocketCommandCenter.css` and original Pi graphical-pane spec. Preserve dark surfaces, existing violet accent, system UI font, monospace code, pane chrome, terminal toggle and app navigation. This is a dense developer product, not a marketing page; no landing-page preset or animation framework. Refero tooling is not available in this environment; the existing product audit is the redesign reference.

| Decision | Source | Reason |
| --- | --- | --- |
| Reuse existing CSS tokens/components | theme.css; redesign-preserve brief | No new framework or visual identity |
| Flat turn-ordered transcript, collapsed tools | PiPane source audit | Existing separate tool list breaks conversational order |
| Inline agent activity with detail on demand | pi-subagents extension API | Keep progress visible without raw-JSON wall |
| Larger composer, attachment tray, visible labels | Current text-only composer and remote upload request | Common accessible desktop/mobile entry path |
| Restrained state transitions only | Existing dense pane layout | Low distraction and reduced-motion support |

Design dials: variance 2, motion 1, density 6. Keep readable message width around 75ch, responsive to split panes; 44px mobile controls, keyboard focus, contrast, and no transcript-wide aria-live token announcements. No external image fetching or decorative imagery.

## Reliable prompt delivery

Keep legacy Prompt decoding. Add a correlated prompt command with a client-generated request ID and optional attachment IDs. The owned Pi extension emits an accepted/error receipt for that exact ID after dispatching through the public `sendUserMessage` API. Receipt means submitted to Pi, not model completion. Investigate the installed return type/async behavior; never claim provider acceptance from a void API.

Bound and deduplicate accepted request IDs for the extension lifetime; do not automatically replay uncertain sends after disconnect/restart. Show uncertainty and preserve the draft. Never clear newer edits on a late receipt. Keep text drafts per origin/Amber session in guarded sessionStorage (bounded, tolerates denied/quota storage) across view switches/reloads; attachments retain only safe metadata/IDs, never base64 in storage. A changed Pi conversation ID resets pending operations and does not send old drafts automatically. Enter submits except during IME composition; Shift+Enter inserts newline. Show queued follow-up status truthfully from Pi snapshots/receipts. Errors stay visible until dismissed or explicitly superseded.

## Attachment transport and storage

Upload actual bytes from `File` objects via the existing semantic command path. The owned extension is the session-scoped consumer and stores upload inputs beneath `AMBER_STATE_DIR/pi-attachments/<Pi session UUID>/`. This is an input artifact store, not another session authority. No new Node service or daemon process exists. Store completed artifacts persistently so a model/tool can use them after client disconnect or host reboot.

Use closed `UploadBegin`, `UploadChunk`, `UploadFinish`, and `UploadCancel` commands, each correlated by request ID. Begin allocates a server-generated opaque attachment ID. Chunk uses that ID and exact expected offset; decode canonical base64 only, maximum decoded chunk 48 KiB. A client sends at most one outstanding chunk per file, waits for its receipt and shows acknowledged-byte progress. Finish checks exact declared length and publishes atomically. Never auto-resend uncertain mutations. Bound commands in Rust, web parser and extension; browser commands require that exact Pi pane to be open in semantic mode.

Initial limits: 16 MiB/file, 8 files/prompt, 32 MiB/prompt, 4 simultaneous pending uploads/session, 256 MiB total artifacts/Pi session including reservations. Reject before allocating/reading large content. Use 0700 directories, 0600 files, server-generated storage names, exclusive creation, no-follow/regular-file checks and directory containment. User filenames are display metadata only (255 characters; reject controls/path separators) and cannot select a path. Reject symlinked roots/files and cross-session IDs. No shell interpolation. Pending uploads expire after 24 hours and can be canceled; cleanup only owned pending artifacts, never submitted artifacts. Completed files count toward quota; on exhaustion explain location/limit rather than deleting conversation inputs. Bound metadata scans and serialize storage mutations without blocking Stop/subagent control handling. Clean up timers/file handles on shutdown.

The prompt references only completed IDs belonging to the current Pi session. Read approved PNG/JPEG/GIF/WebP image bytes from the store and send public Pi image content with its actual installed type shape. Validate file signatures and image model capability; do not trust MIME claims or silently replace images with text on unsupported models. Non-image files become clearly labeled host file references in prompt text, safely quoted as data, not executable commands. Unknown image types remain files with an explicit explanation. Do not render arbitrary uploaded HTML/SVG. Local preview URLs are revoked on removal/unmount. No automatic external image requests.

Picker, drop and paste use the same path, allow image-only prompts, support removing/canceling pending attachments, and expose retry only after a known failure. A disconnected upload is visibly interrupted, not falsely successful. Tests must demonstrate a browser-local file becoming identical host-side bytes and a real image content block reaching the public Pi API.

## Subagents

Use installed pi-subagents public `subagents:rpc:v1:ready`, `subagents:rpc:v1:request`, `subagents:rpc:v1:reply:<requestId>` via `pi.events`. Probe `ping`, read capabilities, and use bounded `status` requests. Subscribe/unsubscribe correctly and handle either extension load order. A timeout/plugin absence is a displayable unsupported state, never a trigger to launch another process.

Expose only `status`, targeted transcript, `stop`, `steer`, `interrupt` and `resume` through explicit Amber command variants. Do not expose `spawn`, arbitrary `manage`, arbitrary paths, config or scripts. Use actual asyncSnapshot run IDs for top-level controls, never fleet display keys. Child targets must be proven by package-owned rich status identities (stable childId/index), never array position or inferred node labels. If a child cannot be safely targeted, show it read-only with run-level controls. External display-only jobs are read-only.

Status is a bounded current-session projection, polled no faster than 2s with only one in-flight refresh; stop during shutdown. Cache for snapshots/reconnect and normalize a small allowlist of display fields. Max 20 runs, 8 children/node, depth 3, 64 KiB projected state and 32 KiB transcript response. Display omitted counts, disconnected/stale state and errors. No reading arbitrary artifact/session paths and no forwarding provider metadata/credentials.

Each control has an exact request ID, pending state and receipt. Stop requires UI confirmation. Steer accepts an explicit message. Resume is labeled 'Resume with message', not a blind retry or new run; require user action and plugin capability. Preserve plugin-owned current-session ownership, state checks, exclusive session lease, permission gates and non-recovering steering. Never auto-retry controls. Refresh status after receipt. Disabled controls explain unsupported or stale targets.

## Conversation UX

Extract focused components/helpers from PiPane rather than expanding one monolith. Build timeline from message order and toolCallId, hydrate tool result states from snapshots and update in place without duplicate cards. Streaming stays a replacement message. Display compact human-readable tool summaries with expandable arguments/results and accurate errors. Display unknown content safely and image placeholders rather than dropping content silently.

Use installed marked lexer if useful, rendering allowed tokens to React nodes without raw HTML. Support headings, paragraphs, emphasis, lists, quotes, fenced code and tables, safe http(s) links with noopener, code/message copy buttons and bounded recursion/output. Raw HTML is literal/omitted, never executed; remote images are not fetched. No new dependencies without parent approval.

Add Jump to latest when away from bottom; do not yank scroll during reading. Keep composer visible in narrow/mobile panes and respect safe-area/keyboard conventions. Separate status announcements from streamed text. Add concise guidance for terminal-only dialogs without bypassing them.

## Evidence and non-goals

Tests: closed command round trips and bounds; browser semantic-open/wrong-kind and arbitrary-method denial; upload sizes/chunks/offsets/quotas/traversal/symlinks/cancellation/cross-session IDs; image shape/capability; plugin absence/timeout/load order/ownership/ID mapping; prompt receipts/late replies/deduplication/disconnect/IME; timeline snapshot/live reconciliation and safe Markdown.

Gates: Rust workspace tests and warnings-as-errors clippy; app tests, typecheck, desktop/web builds; generated extension typecheck and behavioral verifier against installed Pi; git diff --check. Live private daemon + private web/Electron fixture: remote File upload and paste, image block delivery, subagent status/control RPC receipts, reconnect and unchanged terminal fallback. No production daemon restart or provider paid fallback. Retain logs/screenshots under persistent worktree evidence paths. Mark real-device-only checks honestly.
