# Pi terminal clipboard repair

Status: implemented in `54108af` on `fix/pi-clipboard`, based on `2a0519e`,
then fast-forwarded into local `fix/pi-session-recovery` with user approval.
Not deployed. The main checkout's unrelated dirty/untracked work was not modified.

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
above. No unrelated type errors were repaired; the clipboard worktree and branch
are retained pending resolution of the combined checkout's gate.

## Review and limits

Self-review checked one-way data flow, shared input transport, native-event
capture ordering (no duplicate sends or copy overwrite), live shell-fallback
updates, teardown, and preservation of non-Pi clipboard behavior.

No Rust, daemon, supervisor or protocol code changed; Rust gates were not rerun.
No production daemon, app bundle, session, Pi configuration or provider was
changed or invoked. These are Linux private-renderer checks, not a real Mac,
real phone, or live-provider end-to-end certification. Deployment remains a
separate approval step; the repair itself needs only updated app/web assets,
not a daemon restart.
