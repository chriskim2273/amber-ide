# Workspace Save/Load — Implementation Plan (2026-07-17)

Status: executing (subagent-driven development)

Spec (binding): `docs/superpowers/specs/2026-07-17-workspace-save-load-design.md`
— read it in full before any task. 3 tasks + gates.

## Global Constraints (bind every task)

- Constitution (root CLAUDE.md Core architecture) is law: daemon single source
  of truth; one-way data flow (loads create sessions ONLY via `createSession`;
  pane existence mutates only from daemon events); xterm outside React
  reconciliation (scrollback replay via ref-map handoff, never prop churn);
  read threads never do unbounded blocking writes (Backlog reply rides the
  forwarder path like the Attach backlog); `PtySession` stays `Send + Sync`.
- TS strict; Rust clippy zero warnings; no new runtime deps.
- TDD for pure logic and proto (failing test first). Integration tests
  fake-stub style (`crates/amber/tests/run_state.rs`, `backlog_hol.rs`).
- Gates per task: Rust tasks `cargo test --workspace && cargo clippy
  --workspace --all-targets`; app tasks `cd app && npm run typecheck && npx
  vitest run`.
- Conventional commits, concise, NO Co-Authored-By lines.
- File format, flows, and error handling exactly as the spec defines —
  deviations need controller approval.

## Task 1: Daemon DumpBacklog/Backlog

Scope: `crates/amber-core/src/proto.rs` (+ tests), `crates/amber/src/daemon.rs`,
new `crates/amber/tests/dump_backlog.rs`; `app/src/shared/proto.ts` (+ test,
encode DumpBacklog / decode Backlog — byte-compatible).

1. Proto: `DumpBacklog { name }` (client→daemon) and `Backlog { name, data:
   Vec<u8> }` (daemon→client), serde like existing msgs. Round-trip + JSON
   shape-lock tests. `proto.ts`: encode `DumpBacklog`, decode `Backlog`
   (base64 or byte array exactly matching serde's Vec<u8> JSON encoding —
   verify against the Rust serializer in a test fixture, do not guess).
2. Daemon handler: on `DumpBacklog`, snapshot the session's ring bytes
   (existing ring accessor used by Attach backlog) and send ONE `Backlog`
   frame via the connection's existing forwarder/outbound mechanism — never an
   inline write on the read thread. Unknown session → `Error` reply (existing
   bounded reply path). No watcher changes. Single frame is fine: ring cap
   ≤2 MiB ≪ 64 MiB frame cap.
3. Integration test `dump_backlog.rs`: create session, drive output through
   the pty, request DumpBacklog, assert Backlog bytes end-with the written
   output (ring may prepend earlier bytes); unknown name → Error. Style:
   existing tests.

## Task 2: File format + pure logic (app)

Scope: new `app/src/shared/workspaceFile.ts` (+ new test file),
`app/src/renderer/store.ts` ONLY if a selector is needed (avoid if possible).

1. Types + `parseWorkspaceFile(text)` / `serializeWorkspaceFile(doc)` per the
   spec's exact JSON shape: `version: 1` enforced (other → thrown
   `Error('unsupported version')` caught by caller), shape-guards per
   parseFrozen precedent (drop malformed optionals; reject structurally
   broken files with a clear error, never throw later in render).
2. Placeholder rewrite helpers (pure, tested both directions):
   `treeToPlaceholders(tree, nameToId)` and `treeFromPlaceholders(tree,
   idToName)` mapping layout-Node leaf paneIds.
3. `assembleSave(scope, liveState, sidecar, dumps)` — builds the doc from the
   live session groupings (reuse `groupSessions`/name parsing from
   `store.ts`/`names.ts`), sidecar labels/tabOrder/tree/frozen, and a
   `Record<sessionName, Uint8Array>` of scrollback dumps (base64-encode).
   Missing dump → `scrollback: ""`.
4. `buildLoadPlan(doc, opts)` — pure: given target ws numbers + a name-minting
   fn (injected so tests are deterministic), returns per-pane
   `{ name, cwd, kind }` create list + sidecar mutations (trees with real
   names, labels, tabOrder, frozen map entries) + `Record<name, Uint8Array>`
   scrollback replays. Options: `{ mode: 'new', nextWs }` or
   `{ mode: 'replace', ws }`.
5. TDD: round-trip, version reject, shape-guard drops, placeholder rewrites,
   assemble + plan builders incl. multi-workspace 'all' scope.

## Task 3: Wiring — client router, IPC, UI, replay

Scope: `app/src/client/` (router: DumpBacklog request/Backlog reply
correlation), `app/src/preload/index.ts`, `app/src/main/index.ts` (IPC
`workspace-save-file` / `workspace-open-file`: native dialogs + atomic write /
read), `app/src/renderer/main.tsx` (toolbar 💾/📂 + scope/mode/confirm
mini-dialogs via the help-overlay pattern + orchestration), 
`app/src/renderer/SplitView.tsx` + `app/src/renderer/Pane.tsx` (one-shot
scrollback replay via ref-map handoff mirroring `searchApis` — Pane writes the
bytes into xterm at mount before/independent of port data; fresh session
backlog is empty so ordering is display-correct), `app/src/renderer/theme.css`.

1. Client router: renderer can request a dump per session; `Backlog` frames
   route back by name; 5s timeout per pane resolves empty + collects straggler
   names (surfaced in one dismissible banner listing them).
2. IPC: `workspace-save-file(json, suggestedName)` → save dialog (`.amberws`
   filter) + atomic write (tmp+rename, layoutFile precedent);
   `workspace-open-file()` → open dialog + read, null on cancel.
3. Save orchestration: 💾 → scope dialog → dumps → `assembleSave` → IPC.
   Cancel anywhere → clean no-op.
4. Load orchestration: 📂 → IPC → parse (errors → banner) → mode dialog
   (replace shows pane-count confirm) → replace kills current-ws sessions
   first → `buildLoadPlan` → createSession per pane → commit sidecar
   mutations once sessions confirm (pending-placement pattern like `pending`
   splits) → hand scrollback bytes to the replay ref-map keyed by new names;
   Pane consumes + deletes its entry at mount (single-shot).
5. Replay handoff must not violate memo invariants (no new unstable Pane
   props — mirror the `searchReadyFor` cached-wrapper or module-level ref-map
   approach; document the contract in a comment).
6. A11y: aria-labels on both buttons; dialogs Esc-dismiss.
7. Gates + manual-check notes in report (live-GUI verification deferred as
   project-wide).

## Task 4: Final gates

`cargo test --workspace`; `cargo clippy --workspace --all-targets` (0
warnings); `cd app && npm run typecheck && npx vitest run && npm run build`.
Whole-branch review (opus) vs spec; one fix wave; CLAUDE.md build-status
entry (one concise item).
