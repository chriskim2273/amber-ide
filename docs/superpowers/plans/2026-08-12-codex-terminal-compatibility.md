# Codex Terminal Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Amber's terminal-first Codex panes resume the intended conversation through every supported reload and supervision path, with regression coverage and accurate documentation.

**Architecture:** Keep the existing raw-PTY supervisor and Codex CLI integration. Extract only the renderer's reload command construction into a pure TypeScript function, prove the existing Rust supervisor/hook path with one fake-Codex integration test, and fix the existing behavior-neutral Clippy warning.

**Tech Stack:** Rust 2021, shell-script test doubles, TypeScript 5.6, React 18, Vitest 2.

**Spec:** `docs/superpowers/specs/2026-08-12-codex-terminal-compatibility-design.md`

## Global Constraints

- Keep Amber's raw-PTY terminal architecture; do not add Codex App Server, SDK, or a native chat UI.
- Keep `--dangerously-bypass-approvals-and-sandbox` and `--dangerously-bypass-hook-trust` on every Amber-launched Codex command.
- Never use `codex resume --last`.
- Treat Codex `session_id` as a non-empty string; shell-quote it at the renderer boundary and reject control characters.
- Keep Claude and Grok reload IDs UUID-only.
- Add no dependency, provider framework, auth UI, or bundled Codex binary.
- Do not modify or suppress unrelated user/plugin hooks; Codex owns those hook lifecycles.
- Work test-first for changed behavior and preserve unrelated worktree changes.

---

### Task 1: Make renderer reload commands provider-correct

**Files:**
- Create: `app/src/renderer/reloadAgent.ts`
- Create: `app/src/renderer/reloadAgent.test.ts`
- Modify: `app/src/renderer/SplitView.tsx:1-18,267-291,692-712`

**Interfaces:**
- Consumes: `CLAUDE_SESSION_ID` from `app/src/shared/ids.ts`.
- Produces: `AgentName = 'claude' | 'grok' | 'codex'` and `reloadAgentCommand(agent: AgentName, id: string | null): string | null`.
- Return contract: a complete shell command, or `null` when a recorded ID is unsafe/invalid.

- [ ] **Step 1: Write the failing command-builder tests**

Create `app/src/renderer/reloadAgent.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { reloadAgentCommand } from './reloadAgent'

const CODEX_FLAGS = '--dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust'
const UUID = '91b9f942-914d-4ea0-8c29-cef2c8b3b984'

describe('reloadAgentCommand', () => {
  it('resumes the exact Codex string id with both required flags', () => {
    expect(reloadAgentCommand('codex', 'named session; still one argument'))
      .toBe(`codex resume 'named session; still one argument' ${CODEX_FLAGS}`)
    expect(reloadAgentCommand('codex', "abc'def"))
      .toBe(`codex resume 'abc'\\''def' ${CODEX_FLAGS}`)
  })

  it('opens the Codex picker without selecting the latest session', () => {
    const command = reloadAgentCommand('codex', null)
    expect(command).toBe(`codex resume ${CODEX_FLAGS}`)
    expect(command).not.toContain('--last')
  })

  it.each(['', '   ', 'line\nbreak', 'tab\tid', 'nul\0id', 'delete\u007fid'])
  ('rejects an invalid Codex id %j', (id) => {
    expect(reloadAgentCommand('codex', id)).toBeNull()
  })

  it('keeps Claude UUID validation and picker syntax unchanged', () => {
    expect(reloadAgentCommand('claude', UUID))
      .toBe(`claude --dangerously-skip-permissions --resume ${UUID}`)
    expect(reloadAgentCommand('claude', null))
      .toBe('claude --dangerously-skip-permissions --resume')
    expect(reloadAgentCommand('claude', 'named-session')).toBeNull()
  })

  it('keeps Grok UUID validation and picker syntax unchanged', () => {
    expect(reloadAgentCommand('grok', UUID))
      .toBe(`grok --permission-mode bypassPermissions --resume ${UUID}`)
    expect(reloadAgentCommand('grok', null))
      .toBe('grok --permission-mode bypassPermissions --resume')
    expect(reloadAgentCommand('grok', 'named-session')).toBeNull()
  })
})
```

- [ ] **Step 2: Run the focused test and verify the missing module fails**

Run:

```bash
npm test --prefix app -- --run src/renderer/reloadAgent.test.ts
```

Expected: FAIL because `./reloadAgent` does not exist.

- [ ] **Step 3: Implement the minimal pure command builder**

Create `app/src/renderer/reloadAgent.ts`:

```ts
import { CLAUDE_SESSION_ID } from '../shared/ids'

export type AgentName = 'claude' | 'grok' | 'codex'

const CODEX_FLAGS = '--dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust'
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function reloadAgentCommand(agent: AgentName, id: string | null): string | null {
  if (id !== null) {
    if (id.trim() === '' || CONTROL_CHARACTER.test(id)) return null
    if (agent !== 'codex' && !CLAUDE_SESSION_ID.test(id)) return null
  }

  if (agent === 'codex') {
    const resume = id === null ? 'resume' : `resume ${shellQuote(id)}`
    return `codex ${resume} ${CODEX_FLAGS}`
  }

  const resume = id === null ? ' --resume' : ` --resume ${id}`
  return agent === 'grok'
    ? `grok --permission-mode bypassPermissions${resume}`
    : `claude --dangerously-skip-permissions${resume}`
}
```

- [ ] **Step 4: Route SplitView through the helper and correct picker copy**

In `app/src/renderer/SplitView.tsx`, replace the `CLAUDE_SESSION_ID` import with:

```ts
import { reloadAgentCommand } from './reloadAgent'
```

Replace `reloadClaude` with:

```ts
  // Reload the pane's agent in its shell: Ctrl-U clears any stray input line,
  // then the provider-specific resume command runs. Command construction is a
  // pure trust-boundary helper because the command is inserted into a shell.
  const reloadClaude = (paneId: string, id: string | null, kind: string): void => {
    const cmd = reloadAgentCommand(agentOf(kind), id)
    if (cmd === null) { setReloadPane(null); return }
    searchApis.current.get(paneId)?.insert(`\x15${cmd}\n`)
    setReloadPane(null)
  }
```

Replace the reload dialog's explanatory content and two relevant labels with:

```tsx
              {/* Provider-specific resume confirmation. "Resume saved" targets
                  the exact recorded conversation; "Pick session…" delegates to
                  the provider's interactive picker/current-folder behavior. */}
              {reloadPane === paneId && meta?.claudeId && !isFrozen &&
                <div className="reload-claude-prompt" role="dialog" aria-label={`reload ${agentOf(meta.kind)}`}>
                  <div className="reload-claude-title">Reload {agentOf(meta.kind)} in this pane?</div>
                  <div className="reload-claude-sub">Clears the current line, then runs <code>{meta.kind === 'codex' ? 'codex resume' : `${agentOf(meta.kind)} --resume`}</code>.</div>
                  <div className="reload-claude-actions">
                    <button className="btn btn-accent" onClick={() => reloadClaude(paneId, meta.claudeId ?? null, meta.kind)}>
                      Resume saved <span className="reload-id">{meta.claudeId!.slice(0, 8)}…</span>
                    </button>
                    <button className="btn" onClick={() => reloadClaude(paneId, null, meta.kind)}
                      title={
                        meta.kind === 'grok' ? 'resumes the most recent conversation in this folder'
                          : meta.kind === 'codex' ? "opens codex's session picker"
                            : "opens claude's own session list"
                      }>
                      Pick session…
                    </button>
                    <button className="btn btn-ghost" onClick={() => setReloadPane(null)}>Cancel</button>
                  </div>
                </div>}
```

- [ ] **Step 5: Run focused and frontend checks**

Run:

```bash
npm test --prefix app -- --run src/renderer/reloadAgent.test.ts
npm run typecheck --prefix app
```

Expected: the new test file passes and both TypeScript projects typecheck.

- [ ] **Step 6: Commit the renderer fix**

```bash
git add app/src/renderer/reloadAgent.ts app/src/renderer/reloadAgent.test.ts app/src/renderer/SplitView.tsx
git commit -m "fix: resume exact Codex sessions from panes"
```

### Task 2: Prove Codex supervision end to end

**Files:**
- Create: `crates/amber/tests/codex_supervise.rs`
- Modify: `crates/amber/src/codex.rs:154-158`

**Interfaces:**
- Consumes: `supervise_agent`, `Agent::Codex`, `SuspendControl`, the real `amber hook` binary, and the shared `StateStore` conversation metadata.
- Produces: one integration test proving fresh argv, SessionStart persistence, crash recovery, exact resume, and both bypass flags.

- [ ] **Step 1: Add the fake-Codex lifecycle integration test**

Create `crates/amber/tests/codex_supervise.rs`:

```rust
use amber::supervisor::{supervise_agent, Agent, SuperviseOutcome, SuspendControl};
use amber_core::state::StateStore;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

fn write_fake_codex(dir: &Path) -> PathBuf {
    let bin = dir.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let path = bin.join("codex");
    let payload = serde_json::json!({
        "session_id": "codex-named-session",
        "cwd": dir,
        "hook_event_name": "SessionStart"
    })
    .to_string();
    let amber = env!("CARGO_BIN_EXE_amber");
    let script = format!(
        r#"#!/bin/sh
printf '%s\n' "$*" >> "$AMBER_STATE_DIR/codex_argv.log"
if [ ! -e "$AMBER_STATE_DIR/codex_crashed_once" ]; then
    : > "$AMBER_STATE_DIR/codex_crashed_once"
    printf '%s' '{payload}' | "{amber}" hook
    exit 1
fi
exit 0
"#
    );
    fs::write(&path, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    path
}

#[test]
fn crash_resumes_the_id_recorded_by_codex_session_start() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let codex = write_fake_codex(root);
    let phases = Mutex::new(Vec::<String>::new());
    let report = |phase: &str| phases.lock().unwrap().push(phase.to_string());

    let outcome = supervise_agent(
        &Agent::Codex,
        &codex,
        root,
        "work",
        root,
        3,
        report,
        &SuspendControl::new(),
    )
    .unwrap();

    assert!(matches!(outcome, SuperviseOutcome::CleanExit));
    assert_eq!(
        *phases.lock().unwrap(),
        vec!["claude", "claude-retrying", "claude"]
    );

    let lines: Vec<String> = fs::read_to_string(root.join("codex_argv.log"))
        .unwrap()
        .lines()
        .map(str::to_string)
        .collect();
    assert_eq!(
        lines,
        vec![
            "--dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust",
            "resume codex-named-session --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust",
        ]
    );
    assert!(!lines.iter().any(|line| line.contains("--last")));

    let recorded = StateStore::new(root).read_claude("work").unwrap().unwrap();
    assert_eq!(recorded.session_id, "codex-named-session");
    assert_eq!(recorded.cwd, root);
}
```

- [ ] **Step 2: Run the characterization integration**

Run:

```bash
cargo test -p amber --test codex_supervise -- --nocapture
```

Expected: PASS. This is a missing integration proof for already-present supervisor behavior; do not force an artificial production change merely to make the test fail first.

- [ ] **Step 3: Collapse the behavior-neutral newline condition**

In `crates/amber/src/codex.rs`, replace lines 154-158 with:

```rust
        if !s.ends_with('\n') {
            s.push('\n');
        }
```

This preserves the existing result while satisfying `clippy::collapsible_if`.

- [ ] **Step 4: Run focused Rust checks**

Run:

```bash
cargo test -p amber codex
cargo test -p amber --test codex_supervise -- --nocapture
cargo clippy -p amber --all-targets -- -D warnings
```

Expected: all focused tests pass and Clippy reports no warnings.

- [ ] **Step 5: Commit the supervisor proof and lint fix**

```bash
git add crates/amber/tests/codex_supervise.rs crates/amber/src/codex.rs
git commit -m "test: cover Codex crash resume lifecycle"
```

### Task 3: Run the full compatibility gates

**Files:**
- Verify only; no planned source changes.

**Interfaces:**
- Consumes: committed renderer and Rust changes from Tasks 1-2.
- Produces: evidence required before documentation may claim compatibility.

- [ ] **Step 1: Run Rust lint and tests**

```bash
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Expected: both commands exit 0.

- [ ] **Step 2: Run all app gates**

```bash
npm run typecheck --prefix app
npm test --prefix app
npm run build --prefix app
npm run build:web --prefix app
```

Expected: all four commands exit 0. Record the existing skipped-test count separately; do not turn it into a failure.

### Task 4: Publish accurate Codex support and security behavior

**Files:**
- Modify: `README.md:43-52,82-88,185-200,242-248`
- Modify: `CLAUDE.md:888-902`

**Interfaces:**
- Consumes: verified command behavior and full green gates from Tasks 1-3.
- Produces: public support claims and an internal status entry that distinguish automated proof from the outstanding real-conversation smoke test.

- [ ] **Step 1: Generalize the architecture claim in README**

Replace the Claude-only supervision bullet under “How it works” with:

```markdown
- **Coding-agent sessions are supervised and resumed precisely.** Claude Code,
  OpenAI Codex, and Grok panes run through `amber run <name>`, which resumes the
  exact recorded conversation id and falls back to a shell so a pane never
  silently dies.
```

- [ ] **Step 2: Replace the Claude-only feature block with exact provider behavior**

Use this block under “Features”:

```markdown
**Coding agents**
- Claude Code, OpenAI Codex, and Grok are supported supervised pane kinds. Their
  exact recorded conversations resume after agent crashes, unfreeze, daemon
  restart, and machine reboot.
- Codex remains its native terminal UI. Amber resolves the user-installed
  `codex` executable through the login shell; it does not bundle Codex or own
  authentication.
- Supervised panes run unattended. Codex receives
  `--dangerously-bypass-approvals-and-sandbox` and
  `--dangerously-bypass-hook-trust`; use Amber only in directories where that
  trust level is acceptable.
- Run-state dots: agent / retrying / shell-fallback.
```

- [ ] **Step 3: Add Codex to build prerequisites and project status**

After the system-tools prerequisite, add:

```markdown
**4. Agent CLIs (optional)** — install the provider binaries you plan to use.
Amber discovers `claude`, `codex`, and `grok` through your login shell. A
missing provider only makes that pane fall back to a shell.
```

Change the Status paragraph's opening claim to:

```markdown
Early — `v0.0.1`, single-developer project. The daemon spine, Claude Code,
Codex, and Grok supervision, reboot restore, and the full Electron IDE surface
(tabs, workspaces, splits, drag-to-rearrange, browser panes, workspace
save/load) work through automated coverage; live GUI verification remains
feature-specific.
```

- [ ] **Step 4: Update the internal Codex status entry without overstating live coverage**

Replace the final two sentences of the Codex entry in `CLAUDE.md` with:

```markdown
  Fake-Codex integration covers fresh launch → real `amber hook` ID capture →
  crash → exact-ID resume, including both bypass flags and the never-`--last`
  invariant. Renderer tests cover exact string IDs, shell quoting, control-byte
  rejection, and the interactive picker. Full Rust/app gates are green. A real
  installed-Codex create/kill/resume smoke remains manual because isolated
  Amber state does not isolate Codex authentication and conversation storage.
```

- [ ] **Step 5: Check documentation and commit**

Run:

```bash
git diff --check
grep -n -i 'codex\|coding agents' README.md CLAUDE.md
```

Expected: no whitespace errors; README and CLAUDE.md contain the new Codex claims and no claim that the installed-CLI lifecycle was live-tested.

Commit:

```bash
git add README.md CLAUDE.md
git commit -m "docs: document Codex pane support"
```

### Task 5: Inspect and hand off the completed compatibility work

**Files:**
- Verify only; no planned source changes.

**Interfaces:**
- Consumes: all changes from Tasks 1-4.
- Produces: a clean worktree and an evidence-based operational handoff.

- [ ] **Step 1: Inspect the final diff and worktree**

```bash
git diff --check
git status --short
git log --oneline -5
```

Expected: no uncommitted changes, and the latest commits are the design, plan, renderer, Rust proof, and documentation milestones.

- [ ] **Step 2: Report the operational boundary**

Report these facts in the handoff:

```text
Amber terminal-first Codex compatibility: automated gates pass.
Real installed-Codex supervised conversation smoke: not run, because a temporary Amber state directory does not isolate Codex auth/conversation state.
Third-party Codex hook failures: external to Amber; current clean Codex lifecycle check passed PreToolUse, PostToolUse, UserPromptSubmit, and Stop.
```
