# Pi chat upgrades verification receipt

**Date:** 2026-09-08
**Status:** tested worktree state only — unmerged and not deployed. This receipt is
not production approval.

## Reviewed whole-feature scope

The repaired worktree carries the previously reviewed Pi graphical-chat scope:
mobile Chat/Terminal toggle; bounded uploads and image paste; subagent controls
with read-only child details; tool snapshots and draft persistence; and browser
fit/mobile/rotation behavior. The retained private evidence below is a fixture
record, not a new live claim or production certification.

## Bounded final P2 repairs

- `PiComposer` rejects picker, drop, and paste additions while an upload is
  active.
- `PiPane` also guards the parent seam with the synchronously claimed upload
  controller, so a same-turn event cannot replace the submitted selection.
- `PiPane` prunes completed-upload cache keys when selected files are removed or
  replaced. The pruning is local browser-reference cleanup only; it never sends
  a server delete/cancel for an already completed artifact.

The implementation was TDD'd at the mounted `PiPane`/`PiComposer` seam. The
focused regression covers all three addition paths during a delayed upload and
removal followed by resend; the pure cache test covers replacement semantics.

## Baseline and incremental diff

- Baseline commit: `b81c2cbb58ed1fa6f23d909e1b461fa6bef779b8`.
- The worktree already contained the reviewed whole-feature dirty changes.
- Incremental repair diff: `.reports/pi-chat-upgrades/attachment-final-fixes/incremental.diff`.
- No production daemon, provider, or user state was touched by this repair.

## Final gates for this repair

Logs are retained under `.reports/pi-chat-upgrades/attachment-final-fixes/`:

- Focused: `npm test -- --run src/renderer/piPaneLifecycle.test.ts src/renderer/piSubmission.test.ts` — 16 passed.
- Full app: `app-test.log` — 103 files passed, 1 skipped; 1199 tests passed, 1 skipped.
- TypeScript: `typecheck.log` — passed.
- Desktop bundle: `build-desktop.log` — passed.
- Web bundle: `build-web.log` — passed (existing chunk-size/config warnings only).
- `git diff --check` — passed.

No Rust files changed for this repair, so Rust was not rerun. The last full
Rust/clippy evidence remains the reviewed 906 passed / 2 ignored Rust gate and
clean clippy logs at `.reports/pi-chat-upgrades/revalidation-cargo-test-final.log`
and `.reports/pi-chat-upgrades/revalidation-cargo-clippy.log`.

## Retained private evidence references

These are private isolated-fixture artifacts, not production claims and not a
substitute for real-device/provider/package verification:

- Coarse mobile chat/toggle and touch evidence:
  `.reports/pi-chat-upgrades/stage-4-final/live/pi-chat-live-evidence.json` and
  `.reports/pi-chat-upgrades/stage-4-final/live/logs/mobile-web-real-coarse-viewport.json`.
- Remote file source/stored-byte equality:
  `.reports/pi-chat-upgrades/stage-4-final/live/logs/revalidation-remote-file-hash.log` and
  `.reports/pi-chat-upgrades/stage-4-final/live/logs/revalidation-remote-file-upload.json`.
- Image-only paste upload and public Pi image payload:
  `.reports/pi-chat-upgrades/stage-4-final/live/logs/revalidation-image-only-paste.json`.
- Semantic socket loss, retained draft/attachment, reconnect, and no automatic
  prompt:
  `.reports/pi-chat-upgrades/stage-4-final/live/pi-chat-live-revalidation.log` and
  `.reports/pi-chat-upgrades/stage-4-final/live/pi-chat-live-evidence.json`.
- Narrow viewport dimensions/DOM capture:
  `.reports/pi-chat-upgrades/stage-4-final/live/logs/mobile-web-real-coarse-viewport.json` and
  `.reports/pi-chat-upgrades/stage-4-final/live/logs/mobile-web-real-coarse-dom.json`.
- Browser interaction fixture and current F4 revalidation:
  `.reports/pi-chat-upgrades/revalidation-f4-live-private.log` and
  `.reports/pi-chat-upgrades/f4-live/repro.sh`.

The fixture evidence does not certify a physical phone, hardware IME, macOS,
real provider/model, package-owned revival, or production state.

## F8/F9 label correction

This receipt uses the source/test mapping, not the stale labels in the retained
revalidation summary:

- **F8 is receipt history bound:** the bounded receipt history and conversation reset
  are established by `app/src/renderer/piModel.ts` and
  `app/src/renderer/piModel.test.ts`. Terminal fallback is not F8 evidence.
- **F9 is Markdown rendering:** safe table/list parsing and semantic rendering
  are established by `app/src/renderer/PiTranscript.tsx` and
  `app/src/renderer/piTranscript.test.ts`. The extension verifier is not F9
  evidence.

Real-device, live-provider/package, IME, macOS, and deployment checks remain
open; this worktree is not production-complete.
