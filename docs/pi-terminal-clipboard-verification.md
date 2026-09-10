# Pi terminal clipboard repair

Status: implemented in `54108af` on `fix/pi-clipboard`, based on `2a0519e`,
then fast-forwarded into local `fix/pi-session-recovery` with user approval.
Deployed to the installed Linux desktop AppImage on 2026-09-10 with explicit
user approval; the desktop client was relaunched. Web assets were not changed.
The main checkout's unrelated dirty/untracked work was not modified.

## Root causes and scope

- Pi's TUI paints literal spaces to pad rows, including otherwise blank rows.
  Installed xterm 6.0's `BufferLine.translateToString(true)` trims **unwritten
  cells**, not those spaces. `SelectionService.selectionText` preserves them.
  Both Amber's `SearchApi.copySelection` and xterm's native copy handler returned
  the padded text. A mounted reproduction copied 74-column blank lines.
- Pi's installed `pi-tui/dist/terminal.js` enables DECSET 2004 at startup; its
  editor accepts `ESC[200~...ESC[201~` as one paste. Amber replays only a capped
  raw-byte backlog, which can lose that startup sequence. A newly mounted or
  reset xterm consequently has `bracketedPasteMode=false`; `term.paste` then
  converts newlines to bare CR, which Pi can interpret as individual submissions.

`terminalClipboard.ts` shares one policy between Amber's keyboard/context-menu
API and native copy/paste events. It removes only trailing ASCII spaces/tabs on
copied Pi lines, retaining indentation, internal spacing, Unicode and newline
structure. It uses explicit paste framing when a supervised Pi pane has lost
xterm's negotiated mode. Already-negotiated pastes still use `term.paste`, without
double wrapping. Both paths use the existing xterm `onData`/MessagePort transport.
No PTY output is rewritten, no raw keystrokes are guessed to be pastes, and no
terminal private API or second emulator was added.

`SplitView` supplies the daemon's current `runState`; a ref updates clipboard
policy without remounting xterm. Pi's `shell-fallback` and ordinary shell panes
retain their previous clipboard behavior. OSC 52 application-provided clipboard
text is deliberately unchanged. Chat and file/image paste are outside this fix.

A Pi started manually inside a `kind:"shell"` session is not covered by the
missing-mode fallback: without an authoritative Pi kind we do not force arbitrary
shell applications into a mode they did not request.

## Evidence

Persistent host receipts: `~/worktrees/amber-ide/pi-clipboard-evidence/`.

- Baseline selected unit tests: 7 passed.
- Before implementation, private Electron mounted-Pane fixture
  `clipboard-tkjZ1O/results.json` failed six assertions: copy API, native copy,
  cold API paste, native paste, reconnect paste, and live-state Pi paste.
  The failures show padded text and unbracketed CRs, rather than test setup errors.
- Final app suite: **1226 passed, 1 skipped**, 104 passed files / 1 skipped.
  `app-tests-final.log`. The skip is the pre-existing real-daemon test.
- `npm run typecheck`: passed.
- `npm run build`: passed (`desktop-build.log`).
- `npm run build:web`: passed (`web-build.log`); existing duplicate `target`
  and chunk-size warnings remain.
- Final real-Electron fixture: **11 cases × 5 consecutive passing runs**:
  `clipboard-jwDa6q`, `clipboard-A1UBed`, `clipboard-jjxE9P`,
  `clipboard-WkBdK9`, `clipboard-s823HQ`. Earlier green runs are also retained.
  Uses mounted production `Pane`, real xterm, native mouse selections, OS
  clipboard/edit-role events and real MessageChannels. Only daemon delivery is
  replaced with controlled raw Data/backlog frames.
- Unit cases cover LF/CRLF copy cleanup, indentation/blank lines/Unicode,
  partial and empty selections, non-Pi selection, exact multiline framing,
  untouched raw Enter input, native paste disposal and file-only event bypass.

During fixture development, immediate X11 clipboard-write → renderer-paste
occasionally read an empty clipboard, including in unchanged ordinary-shell
code. The fixture now checks main-process readback and allows ownership to
propagate before pasting; the final five repetitions passed without retries.

Reproduce the mounted regression independently (no live daemon or Pi required):

```sh
cd app
AMBER_CLIPBOARD_TEST_DIR="$HOME/worktrees/amber-ide/pi-clipboard-evidence" \
  xvfb-run -a node scripts/verify-terminal-clipboard.cjs
```

## Local integration follow-up

The user approved a local merge into `fix/pi-session-recovery`. Commit `54108af`
fast-forwarded successfully. Before merging, hashes were captured for all 39
unrelated dirty/untracked files; all remained byte-identical afterward
(`integration-preservation.json`, stored in the evidence directory).

The integrated checkout, **including the user's existing uncommitted browser
work**, passed 1250 app tests / 1 skipped (`merged-app-tests.log`) and all 11
mounted clipboard cases (`clipboard-YwxKua/results.json`). Its typecheck is
**not green**: existing changes in `electronTabBrowserPage.ts` have `close`
overload and `NativeImage.resize`/quality type errors; `tabBrowserHost.test.ts`
has optional `captureFrame`/`exactOptionalPropertyTypes` errors. The affected
files were not changed by this task. Full diagnostics: `merged-typecheck.log`.
The isolated committed clipboard tree's typecheck and builds passed as recorded
above. No unrelated type errors were repaired. The task worktree was initially
retained; the later approved main integration below verifies the committed tree
independently of those unrelated working-copy changes.

## Review and limits

Self-review checked one-way data flow, shared input transport, native-event
capture ordering (no duplicate sends or copy overwrite), live shell-fallback
updates, teardown, and preservation of non-Pi clipboard behavior.

No Rust, daemon, supervisor or protocol code changed; Rust gates were not rerun.
The implementation checks did not change production state or invoke a provider.
The subsequently approved desktop deployment is recorded below. These are Linux
checks, not real-Mac, real-phone or live-provider end-to-end certification.

## Installed desktop deployment — 2026-09-10

Persistent backup and receipts: `~/worktrees/amber-ide/pi-clipboard-deploy/`.
Rollback AppImage: `amber-ide.before.AppImage`.

The installed AppImage already contained newer browser changes absent from the
clean commit. A fresh whole-app replacement would have reverted them. Instead,
`patch-renderer.cjs` applied the exact compiled clipboard helper and Pane from
the clean `8e1a627` build, plus the SplitView `runState` prop. Reversing the
clipboard delta first proved the installed Pane matched its pre-fix baseline
**byte-for-byte**. The resulting Pane/helper match the tested build exactly.

ASAR verification compared all **707 files**: only
`out/renderer/assets/index-RoGgjToQ.js` changed. Main, preload, client, browser
functionality, styling, dependencies and settings were preserved. The existing
AppImage runtime and statically linked bundled binaries were retained. The
repacked image was re-extracted and its **87 filesystem files/symlinks**, modes
and contents compared with staging before installation.

Fresh clean-source gates: 1226 app tests passed / 1 skipped, typecheck and
desktop build passed. `private-package-smoke.cjs` then launched the actual
replacement AppImage with a private profile and a protocol-speaking fixture
socket. **Seven checks passed**: real copy chord, native copy, paste chord,
native paste, reconnect paste, daemon-reported shell-fallback propagation, and
no renderer errors. This exercises the packaged main/preload/utilityProcess/
renderer chain; no Pi process or provider was started. Receipt:
`smoke-qdR3AH/result.json`.

Installed atomically at `~/Applications/amber-ide.AppImage`, guarded by the
original installed-file hash, with a durable backup. The supported
`scripts/relaunch-app-linux.sh` path restarted only the verified installed
desktop client. A fresh process mounted the exact patched ASAR:

- App PID: **2107624**, replacing **1253971**.
- AppImage SHA256:
  `01cd607290b33efb814677c04443108dadc2e45f2832aee23f834493a5b60c64`.
- Running ASAR SHA256:
  `5d878a5cc799a96c4cf0b74a50f14801a46d5e33bbe3bf268a0e8e9eca8d4df0`.
- All **24 sessions** preserved with the same names, kinds, slots and alive
  states; all **13 agent supervisor PIDs/start times** unchanged.
- Session daemon PID **604298** and web PID **576460** unchanged.
- All **39 unrelated dirty/untracked source files** still hash-identical.

Activation proof: `activation-verification.json`, `runtime-before.json`,
`runtime-after.json`, `asar-verification.json`, `filesystem-verification.json`.
No daemon/web/router restart, Pi extension change, permission change or web
asset deployment was performed. Existing source-level browser-host type errors
remain outside this repair; their already-installed artifact was preserved,
not rebuilt from the dirty checkout.

## Main integration and finish verification — 2026-09-10

The user subsequently approved merging into `main` and pushing its existing
unpushed commits as well. Main had advanced to `9dacbc1` with Pocket stable-row,
project/branch identity and touch-target changes. Merge `39ca2d0` preserved those
changes and the clipboard repair without conflicts, in the clean persistent
clipboard worktree; the unrelated dirty checkout was not used to build or test
this integration.

Fresh merged-tree gates:

- App: **1241 passed / 1 skipped**, typecheck, desktop and web builds passed.
- Mounted real-Electron clipboard fixture: **11/11 passed**.
- Rust workspace/all-targets: **922 passed / 2 ignored** on the full rerun.
- Clippy workspace/all-targets with `-D warnings`: passed.

The first Rust run failed the existing `pi_reboot` fixture's `manual Pi start`
wait. Its log shows input sent before the daemon had registered `work`: the
fixture waits for the metadata file, which `create_with_title` writes before
inserting into its live session map. The focused retry and full rerun passed.
This pre-existing timing race was not hidden, skipped, or repaired as part of
clipboard scope. Both failure and retry logs are retained.

Finish receipts are under `~/worktrees/amber-ide/pi-clipboard-evidence/finish/`.
They include the original clean build archive, merged app/build/typecheck logs,
Rust failure/retry logs and Clippy output. The task worktree/branch may be removed
once the checked merge is on main and the push is verified; all deployment
artifacts, rollback image and validation receipts live outside that worktree.
The source commits remain available to recreate a checkout for the deployment
scripts that reference the original worktree path. No redeployment accompanies
this repository-only finish.
