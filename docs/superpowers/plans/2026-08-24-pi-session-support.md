# Pi Session Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Pi as a fully supervised, persisted, automatically integrated coding-agent pane across Amber daemon, desktop app, mobile web UI, and workspace files.

**Architecture:** Extend existing generic agent-kind and supervisor abstractions with `SessionKind::Pi`; keep Pi-specific CLI and extension behavior in new `crates/amber/src/pi.rs`. Record Pi's rotating session UUID through an Amber-owned global Pi extension and resume only by exact ID. App/web changes extend existing exhaustive kind lists without adding another persistence subsystem.

**Tech Stack:** Rust, serde, clap, Unix PTYs/sockets, TypeScript strict, React, embedded JavaScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-24-pi-session-kind-design.md`

## Global Constraints

- Never stop or restart user's running Amber daemon; live verification uses isolated state root and socket.
- Never use Pi `--continue` for automatic restore.
- Do not install Pi itself or add dependencies.
- Keep wire/persisted changes additive and backward compatible.
- Resolve Pi through user's login shell, never daemon service PATH.
- Extension installer owns only `amber-hook.ts` and leaves all other Pi files untouched.
- Tests write extension files only below temporary directories.

---

### Task 1: Pi kind, config, argv, and extension installer

**Files:**
- Create: `crates/amber/src/pi.rs`
- Modify: `crates/amber/src/lib.rs`
- Modify: `crates/amber-core/src/state.rs`

**Interfaces:**
- Produces: `SessionKind::Pi`, `Config::pi_path: Option<PathBuf>`, `pi::PiStart::{Resume, Fresh}`, `pi::pi_argv(&PiStart) -> Vec<String>`, `pi::is_session_id(&str) -> bool`, `pi::resolve_pi() -> Option<PathBuf>`, `pi::ensure_global_pi_extension()`, `pi::ensure_extension_in(&Path)`.
- Consumes: `claude::resolve_bin_with`, existing serde/config defaults, `StateStore::atomic_write_path` if accessible; otherwise same-directory unique temporary write plus rename.

- [ ] **Step 1: Add failing state tests**

Add assertions beside existing kind/config tests:

```rust
assert_eq!(serde_json::to_string(&SessionKind::Pi).unwrap(), "\"pi\"");
assert_eq!(serde_json::from_str::<SessionKind>("\"pi\"").unwrap(), SessionKind::Pi);
assert!(SessionKind::Pi.is_agent());
assert_eq!(SessionKind::Pi.as_str(), "pi");
assert_eq!(Config::default().pi_path, None);
```

- [ ] **Step 2: Run focused core tests and confirm failure**

Run: `cargo test -p amber-core state`
Expected: compile failure because `Pi` and `pi_path` do not exist.

- [ ] **Step 3: Add kind/config implementation**

Add `Pi` enum arm, include it in `is_agent`, map it to `"pi"`, add serde-defaulted `pi_path`, and initialize it to `None` in `Config::default()` and all explicit `Config` fixtures.

- [ ] **Step 4: Add `pi.rs` tests before implementation**

Tests must assert:

```rust
assert_eq!(pi_argv(&PiStart::Fresh), Vec::<String>::new());
assert_eq!(pi_argv(&PiStart::Resume("0198f8ea-9c13-7000-a123-0123456789ab".into())),
           ["--session", "0198f8ea-9c13-7000-a123-0123456789ab"]);
assert!(is_session_id("0198f8ea-9c13-7000-a123-0123456789ab"));
for bad in ["", "--continue", "../session.jsonl", "id with space", "id/slash"] {
    assert!(!is_session_id(bad));
}
```

Installer tests use `tempfile::tempdir()` and verify `extensions/amber-hook.ts`: imports `ExtensionAPI` from `@earendil-works/pi-coding-agent`; registers `session_start`; checks `AMBER_SESSION`; calls `getSessionId`; uses `AMBER_BIN`; sends `session_id` and `cwd`; is unchanged on repeated install; replaces stale owned content; preserves a neighboring extension. Verify atomicity by asserting no Amber temporary files remain.

- [ ] **Step 5: Run module tests and confirm failure**

Run: `cargo test -p amber pi::tests`
Expected: compile failure because module/functions do not exist.

- [ ] **Step 6: Implement focused Pi module**

Use conservative full UUID validation:

```rust
pub fn is_session_id(id: &str) -> bool {
    id.len() >= 8
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && id.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
        && id.bytes().last().is_some_and(|b| b.is_ascii_alphanumeric())
}
```

Generated extension shape:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { spawn } from "node:child_process"

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (!process.env.AMBER_SESSION) return
    const session_id = ctx.sessionManager.getSessionId()
    if (!session_id) return
    const child = spawn(process.env.AMBER_BIN || "amber", ["hook"], {
      stdio: ["pipe", "ignore", "ignore"],
    })
    child.on("error", () => {})
    child.stdin.on("error", () => {})
    child.stdin.end(JSON.stringify({ session_id, cwd: ctx.cwd }))
  })
}
```

Resolve extension root from non-empty `PI_CODING_AGENT_DIR`, else non-empty `HOME` plus `.pi/agent`. Installer logs and returns on errors; write same-directory unique temporary file then rename over owned target.

- [ ] **Step 7: Run focused tests**

Run: `cargo test -p amber-core state && cargo test -p amber pi::tests`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add crates/amber-core/src/state.rs crates/amber/src/lib.rs crates/amber/src/pi.rs
git commit -m "feat: add pi agent primitives"
```

---

### Task 2: Supervisor, daemon lifecycle, CLI, and protocol integration

**Files:**
- Modify: `crates/amber/src/supervisor.rs`
- Modify: `crates/amber/src/manager.rs`
- Modify: `crates/amber/src/main.rs`
- Modify: `crates/amber/src/daemon.rs`
- Modify: `crates/amber/src/attach.rs`
- Modify: `crates/amber/src/web.rs`
- Test: `crates/amber/tests/socket.rs`

**Interfaces:**
- Consumes: Task 1 `SessionKind::Pi`, `Config::pi_path`, and `pi` module API.
- Produces: `Agent::Pi`, `select_pi_start(Option<&str>, u32) -> PiStart`, CLI acceptance of `--kind pi`, automatic extension repair, desktop/mobile wire acceptance, doctor resolution.

- [ ] **Step 1: Add failing supervisor tests**

Add tests proving valid ID resumes only at escalation 0, malformed ID starts fresh, later retry starts fresh, and a changed `ClaudeMeta.updated` recording resets Pi's ladder if Pi is included in timestamp-sensitive agents.

```rust
assert_eq!(select_pi_start(Some(ID), 0), pi::PiStart::Resume(ID.into()));
assert_eq!(select_pi_start(Some(ID), 1), pi::PiStart::Fresh);
assert_eq!(select_pi_start(Some("--continue"), 0), pi::PiStart::Fresh);
```

- [ ] **Step 2: Add failing socket/config tests**

Extend create-kind integration test with `"pi"`, asserting returned `SessionInfo.kind == "pi"`. Add doctor/config tests proving an older config without `pi_path` parses and a discovered Pi path round-trips.

- [ ] **Step 3: Run focused tests and confirm failure**

Run: `cargo test -p amber supervisor && cargo test -p amber --test socket`
Expected: compile or assertion failure for missing Pi arms.

- [ ] **Step 4: Wire Pi through generic supervisor**

Add `Agent::Pi`, label `"pi"`, argv selection through `pi::pi_argv`, and timestamp-sensitive recording reset matching Codex because Pi can change session ID during `/new`, `/resume`, and `/fork`. Keep neutral run-state strings unchanged.

- [ ] **Step 5: Wire lifecycle and path resolution**

Manager create/restore maps `SessionKind::Pi` to `amber run ... --kind pi`; runtime selects cached `pi_path` or `resolve_pi`; Pi launch invokes `ensure_global_pi_extension()` before spawn. Rename respawns Pi through existing agent path. Daemon parser accepts `"pi"`; attach treats Pi as agent through `is_agent()`.

- [ ] **Step 6: Add automatic repair command and setup**

Add `amber ctl install-pi-extension` calling installer and reporting destination. `ctl doctor` resolves/caches Pi when present without failing if absent. Daemon startup may refresh extension only when Pi binary or Pi sessions exist; every Pi `run` must refresh unconditionally. Update app-side packaged setup in later task to call repair command without making app startup fail.

- [ ] **Step 7: Extend mobile web whitelist/UI data**

Accept `kind: "pi"` only through same create path as other agent kinds. Extend embedded JS/CSS kind lists and badge class; do not widen any unrelated control permission.

- [ ] **Step 8: Run focused and full Rust checks**

Run: `cargo fmt --check && cargo test -p amber-core && cargo test -p amber && cargo test -p amber --test socket`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add crates/amber/src crates/amber/tests/socket.rs
git commit -m "feat: supervise persistent pi sessions"
```

---

### Task 3: Desktop app and workspace integration

**Files:**
- Modify: `app/src/shared/proto.ts`
- Modify: `app/src/shared/workspaceFile.ts`
- Modify: `app/src/renderer/store.ts`
- Modify: `app/src/renderer/store.test.ts`
- Modify: `app/src/renderer/reloadAgent.ts`
- Modify: `app/src/renderer/reloadAgent.test.ts`
- Modify: `app/src/renderer/SplitView.tsx`
- Modify: `app/src/renderer/main.tsx`
- Modify: `app/src/renderer/theme.css`
- Modify: `app/src/main/index.ts`
- Modify relevant workspace/protocol tests under `app/test/` and `app/src/`.

**Interfaces:**
- Consumes: wire spelling `"pi"`, repair command `amber ctl install-pi-extension`.
- Produces: Pi pane creation, display, reload, freeze/run-state, workspace round-trip, automatic extension repair on app setup.

- [ ] **Step 1: Add failing pure tests**

Add Pi to protocol/workspace parse fixtures. Assert:

```ts
expect(isAgentKind('pi')).toBe(true)
expect(paneDot('pi', 'claude-retrying')).toEqual(paneDot('claude', 'claude-retrying'))
expect(reloadAgentCommand('pi', PI_ID)).toBe(`pi --session '${PI_ID}'`)
expect(reloadAgentCommand('pi', null)).toBe('pi -r')
expect(reloadAgentCommand('pi', '--continue')).toBeNull()
```

Workspace save/load fixture with `kind: 'pi'` must produce a daemon create with preserved kind and no app-local browser/editor entry.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `cd app && npm test -- --run src/renderer/reloadAgent.test.ts src/renderer/store.test.ts src/shared/workspaceFile.test.ts`
Expected: type/assertion failures for unknown Pi kind.

- [ ] **Step 3: Extend strict kind unions and pure helpers**

Add `pi` to `AgentName`, `PaneKind`, protocol `SessionInfo.kind`, workspace schema allowlist, `isAgentKind`, `agentOf`, dots, and reload helper. Use same conservative Pi ID regex as Rust: `/^[0-9A-Za-z](?:[0-9A-Za-z-]*[0-9A-Za-z])?$/` plus minimum length 8.

- [ ] **Step 4: Extend all creation/rendering surfaces**

Add Pi option to toolbar dropdown, split/context picker, new workspace path, labels/tooltips, reload confirmation/action, mobile-responsive agent handling, styles, and any exhaustive terminal-agent arrays. Pi remains daemon-owned, never app-local.

- [ ] **Step 5: Add best-effort automatic setup**

Alongside existing Codex setup call, invoke packaged Amber with `ctl install-pi-extension`; surface stderr warning without aborting application startup. Do not start, stop, or restart daemon.

- [ ] **Step 6: Run app gates**

Run: `cd app && npm test -- --run && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/src app/test
git commit -m "feat: expose pi panes across amber app"
```

---

### Task 4: Documentation, compatibility audit, and isolated verification

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md` only if tracked project constitution requires status update in worktree; preserve user's untracked root file.
- Modify: `docs/superpowers/specs/2026-08-24-pi-session-kind-design.md` status.

**Interfaces:**
- Consumes: complete Tasks 1–3 behavior.
- Produces: user documentation, constitution status, complete verification evidence.

- [ ] **Step 1: Audit every existing agent-kind site**

Run searches for `opencode`, `codex`, `SessionKind::`, `PaneKind`, `AgentName`, and literal kind arrays. Classify every hit: Pi arm added, intentionally agent-specific, or app-local. Fix missed exhaustive lists and add regression assertion where practical.

- [ ] **Step 2: Update docs and status**

Document Pi prerequisite, automatic extension path/repair command, exact resume behavior, and no `--continue` fallback. Mark spec implemented only after all gates pass. Add constitution checklist entry without changing core architecture.

- [ ] **Step 3: Run final static gates**

Run:

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --workspace
cd app && npm test -- --run
cd app && npm run typecheck
cd app && npm run build
git diff --check
```

Expected: all pass.

- [ ] **Step 4: Run isolated smoke when Pi binary exists**

Create temporary state root and socket, install extension into a temporary `PI_CODING_AGENT_DIR`, and launch a private daemon process with explicit private paths. Create Pi session through that socket; confirm `kind: pi`, extension recording, and exact `--session` restore after stopping only private process. If authentication/model interaction prevents recording, report that limit and retain deterministic module/integration tests. Never use default socket/state and never signal user's daemon.

- [ ] **Step 5: Inspect final diff and commit docs/fixes**

```bash
git diff --check
git status --short
git add README.md CLAUDE.md docs/superpowers/specs/2026-08-24-pi-session-kind-design.md
git commit -m "docs: document pi agent integration"
```

- [ ] **Step 6: Request final code review and address findings**

Review architecture invariants, security of generated extension and shell argv, backward compatibility, every kind gate, and proof that no default daemon was touched. Apply only in-scope fixes, rerun affected checks, and commit them.
