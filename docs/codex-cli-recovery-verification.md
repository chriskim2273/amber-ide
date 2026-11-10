# Codex CLI recovery verification — 2026-10-05

The affected workflow is typing `codex` in an Amber shell and restarting the
session daemon or machine. Two failures combined: shell snapshots detected
Claude and Muse but omitted Codex; Codex 0.160's shared app-server inherited
its first launcher's `AMBER_SESSION`, so later CLI panes had missing or misbound
conversation recordings. Live inspection found six manually launched Codex
TUIs across six shell panes, several with no recording.

## Change

- Add a backward-compatible `resume_as_codex` session-metadata field. Detect
  only the pane's nearest primary agent, preserve the flag on final snapshots,
  tolerate one absent periodic sample, and clear immediately on an agent switch.
- Promote flagged shells to Codex during restore and use the recorded cwd as
  well as the exact id. Preserve pane naming, slot, layout and scrollback.
- Generate daemon-owned Bash/Zsh startup files that source user startup files
  and wrap ordinary `codex` commands with `--dangerously-bypass-hook-trust`.
  This is the same option already used by Amber's Codex supervisor. Codex's
  [0.160 server-selection code](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/tui/src/daemon_startup.rs)
  selects its embedded server for that option, preserving each pane's hook
  environment. User alias options and explicit hook overrides are retained.
  Generated files use the state store's existing atomic-write implementation.

The launcher applies to Bash and Zsh shell panes. Direct absolute executable
calls, `command codex`, and other shells bypass that shell function; use the
hook-trust option explicitly in those cases. No user startup file is edited.
Real macOS/Zsh hardware validation remains manual.

## Evidence

- New detection and restoration regressions failed before the implementation.
  A native Bash regression also reproduced duplicate explicit hook flags before
  the launcher was corrected.
- Installed old daemon reproduced the missing Codex recovery flag in isolated
  state with no user authentication/configuration or API calls.
- Private-daemon proof starts two shell panes, launches fake Codex through the
  normal shell command, rotates one recorded id, then exercises clean and
  abrupt restarts. Both conversations resume their own ids in the same cwd,
  including a cwd supplied through `-C`. No `--last` selection is used.
- Five consecutive private restart proofs passed after synchronizing fixture
  input with the daemon's Created acknowledgement.
- Final integrated `cargo test --workspace`: **974 passed, 3 ignored**.
- `cargo clippy -p amber --lib -- -D warnings`: passed. Isolated worktree
  workspace/all-target Clippy passed. Integrated workspace/all-target Clippy
  fails on the pre-existing duplicate `#[test]` at browser_ops.rs:324.
- The clean git baseline has misplaced clipboard-image functions in web.rs;
  the isolated worktree used a validation-only repair, excluded from this fix.
  Its existing Pi reboot fixture also races metadata creation against Input;
  the integrated checkout's pre-existing Pi fixture repairs pass the full gate.
- Static-musl release binary passes the private restart proof, including the
  binary extracted from the newly packed AppImage.

## Installed artifacts and activation

Backup and artifact receipt:
`/home/poyto/recovery/amber-ide/codex-restart-20261005-v_acyk7x/`.

- Installed daemon: `~/.local/bin/amber`, SHA256
  `a9c0b1c65301e0c9dbac7c3ef51bc2408889699c641e6d4c654f7f0040d3d8f8`.
- Installed AppImage: `~/Applications/amber-ide.AppImage`, SHA256
  `51c489ea792b76be8cfda92c20966aaecee6edf45ae5597e5b0d67e2fc312e21`.
- All 87 package files/symlinks were compared before and after. Only
  `resources/bin/amber` changed; renderer, preload, ASAR, router and other
  packaged assets were retained. The repacked image was extracted and every
  entry verified against the intended manifest.
- The daemon was **not restarted**. PID 2521 keeps the old binary hash
  `aacebda64d4f465a0e9501d4f73c3b8286d446a6e722ff94d30bfd5eee7df5b2`.
  Both installed artifacts are staged for activation. The already-running
  desktop app also retains its original mounted package until relaunch.

A production daemon restart interrupts all 32 current panes. Existing manually
launched Codex sessions with missing/misbound old metadata need their conversation
ids saved and manually resumed once; the new build cannot invent those ids and
will not guess the latest conversation in a cwd. Keep those conversations running
until that one-time migration is ready. The release binary includes the integrated
checkout's pre-existing Rust WIP; this source change does not commit that work.

Rollback: atomically reinstall `amber.before` and `amber-ide.before.AppImage`
from the backup directory, then restart only when current conversations are safe.
