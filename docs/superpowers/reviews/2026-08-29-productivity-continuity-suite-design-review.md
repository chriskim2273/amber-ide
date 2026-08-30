# Deep Review — Productivity & Continuity Suite Design

**Reviewed:** `docs/superpowers/specs/2026-08-29-productivity-continuity-suite-design.md`
**Method:** six independent review lenses applied against `AGENTS.md`, `PRODUCT.md`, the protocol, daemon manager/state store, renderer lifecycle, and existing `.amberws` implementation. The harness exposes no subagent/Agent tool, so the reviews were performed independently in sequence and then deduplicated here.

## Verdict matrix

| Dimension | Verdict | Critical | Important | Minor |
|---|---:|---:|---:|---:|
| Product/vision alignment | PASS | 0 | 0 | 1 |
| Completeness | PASS WITH FIXES | 0 | 4 | 3 |
| Technical feasibility | PASS WITH FIXES | 0 | 4 | 2 |
| Security/privacy | PASS | 0 | 2 | 2 |
| Architecture/consistency | PASS WITH FIXES | 0 | 3 | 2 |
| Clarity/testability | PASS WITH FIXES | 0 | 3 | 2 |

**Overall:** PASS WITH FIXES. All implementation-blocking ambiguities found in review were incorporated into the spec before implementation.

## Findings and dispositions

### Product and vision

**Strengths**

- The suite compounds Amber’s differentiator—continuity—rather than turning it into a general IDE or AI chat client.
- Search remains over daemon-owned retained scrollback, templates remain recipes, and recovery points are explicitly not process checkpoints.
- Local-first ownership is preserved; there is no account or hosted index.

**Minor — feature density risks a “control center” product drift.**
Disposition: keep each surface on-demand. No permanent dashboard or sidebar is introduced; palette and tools menu are the primary entrances.

### Completeness

**Important — recovery-point semantics originally overstated agent resumption.**
The first draft said an imported restore point could precisely resume supervised conversations. Existing `.amberws` intentionally strips conversation IDs and mints new daemon names, so that claim was false.
Disposition: corrected §§3.3 and 14 to promise fresh sessions and fresh agent conversations.

**Important — checkpoint storage lacked a self-describing metadata format.**
A separate index can get out of sync with files after a crash.
Disposition: checkpoint metadata now wraps each `WorkspaceDoc`; listing derives from files. No index transaction exists to split.

**Important — old-daemon behavior lacked a bounded failure state.**
Unknown request variants are safely skipped, which otherwise means a spinner forever.
Disposition: §17 now mandates an 8-second timeout and update/restart guidance.

**Important — automatic checkpoint failure policy needed to be explicit.**
Continuing a bulk kill after failed preflight defeats the feature.
Disposition: §14.2 explicitly blocks the destructive action.

**Minor — template partial-create behavior needs correlation.**
Disposition: reuse the existing pending-load name set and timeout; commit only confirmed names and surface missing names.

**Minor — bookmarks against evicted/reflowed text cannot be exact offsets.**
Disposition: spec defines semantic text anchors and a clear missing-text state.

**Minor — checkpoint file count was unbounded.**
Disposition: implementation plan caps listing at 100 files and automatic retention at 20; manual points remain user-owned.

### Technical feasibility

**Important — search must not repeat the backlog head-of-line bug.**
Disposition: worker thread snapshots/scans/writes; connection read thread only validates and dispatches.

**Important — ANSI sanitization can become an accidental terminal emulator.**
Disposition: use a bounded byte-state stripper only. It recognizes control-string boundaries and printable/newline bytes but never tracks cursor state, screen cells, or VT semantics.

**Important — project commands require a much larger durable launch model.**
Sending startup text after Create would violate deterministic restore and is unsafe for repository-provided input. Extending `SessionMeta` and supervision for arbitrary commands is outside this suite’s safe blast radius.
Disposition: `.amber.toml` v1 explicitly rejects commands and environment fields while still providing layout/kind/cwd profiles.

**Important — automatic checkpoints reuse a multi-MiB dump path and can be slow.**
Disposition: they are user-triggered/destructive-action preflights, never periodic. Existing per-session dump timeout and one-frame binary transport are reused.

**Minor — global result line numbers do not map exactly to xterm rows.**
Disposition: line number is informational; selection opens xterm’s real search by text.

**Minor — command navigation needs focus after keep-alive activation.**
Disposition: route through a `find/focus request` sequence consumed by the active `SplitView`, not direct DOM lookup from App.

### Security and privacy

**Strengths**

- No terminal output is used verbatim in OS notifications.
- Project-profile parsing is strict and explicit; no shell execution exists.
- New disk paths are main-process-owned and ID-validated.
- Search/recovery surfaces remain desktop-only and do not widen the remote browser whitelist.

**Important — handoffs can contain sensitive scrollback and conversation IDs.**
Disposition: native user-selected export only, no automatic upload/open, explicit UI warning, and no reusable daemon identity. Conversation ID remains a labeled reference because it is required by the requested handoff use case.

**Important — checkpoint restore/delete IDs are path-traversal boundaries.**
Disposition: strict `[a-z0-9-]{8,64}` grammar plus resolved-parent containment before file IO.

**Minor — bookmark excerpts can contain secrets.**
Disposition: local-only, user-triggered capture, bounded; UI warns before handoff inclusion.

**Minor — desktop notification payload is renderer-controlled.**
Disposition: main validates type and length, uses no markup, shell, or URL handling.

### Architecture and consistency

**Important — productivity metadata must not become pane authority.**
Disposition: separate file contains only templates/bookmarks/preferences; no live grouping or existence.

**Important — notification transition detection cannot rely on post-reducer state alone.**
Disposition: implementation uses previous-session refs and processes the authoritative control event before updating the ref.

**Important — recovery journal writes can race across connection/reap threads.**
Disposition: serialized append/clear mutex in `StateStore`, atomic whole-array replacement, 500-entry cap.

**Minor — search variants must be added to the protocol’s known-variant exhaustiveness list and every strict TS switch.**
Disposition: explicit implementation task and wire tests.

**Minor — Rust web/mosaic exhaustive matches may require no-op arms despite no whitelist mapping.**
Disposition: compilation gate and explicit security test that forged web messages remain unmapped.

### Clarity and testability

**Important — global-search chord conflicted with Linux pane-local find.**
Disposition: standardized global search to `Cmd/Ctrl+Shift+G`; pane-local find remains `Cmd+F` / `Ctrl+Shift+F`.

**Important — checkpoint listing behavior needed file-size and count bounds.**
Disposition: max 100 files, 128 MiB/file, metadata wrapper, full parse only on restore.

**Important — “workspace template” could imply command execution.**
Disposition: fields are enumerated; commands/env are explicitly rejected in v1.

**Minor — event timestamps can collide.**
Disposition: `sequence` is the deterministic tie-breaker.

**Minor — search request IDs wrap.**
Disposition: u32 equality is sufficient with one renderer and at most a few requests per second; wrapping cannot make an ancient response remain in flight for 2^32 requests.

## Required implementation checks

1. Every large daemon operation is off the connection read thread.
2. No session lifecycle action updates renderer grouping optimistically.
3. Search/recovery remain absent from the amber-web browser-message map.
4. Productivity/checkpoint writes are atomic, bounded, and path-contained.
5. All overlay inputs trap Escape and do not leak keystrokes to xterm.
6. Notification clicks navigate only by a currently listed session name.
7. Destructive multi-session actions wait for a successful preflight checkpoint.
8. Tests run from the fast mirror, not the `/media` worktree.
