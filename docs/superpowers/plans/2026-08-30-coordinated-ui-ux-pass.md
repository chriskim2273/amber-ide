# Coordinated UI/UX Pass — Implementation Plan

**Status:** completed and verified  
**Worktree:** `/media/poyto/Teacup/Worktrees/amber-ui-ux-pass`  
**Validation mirror:** fast local filesystem; do not run test/build workloads on the media drive

## Milestone 1 — Pin pure UI truth with tests

1. Add a small renderer UI-model module for:
   - supported pane-kind choices and labels;
   - continuity counts/status copy;
   - snapshot display state.
2. Add tests first for:
   - connected/disconnected health;
   - alive versus exited-retained counts;
   - no fabricated snapshot timestamp before confirmation;
   - confirmed snapshot copy;
   - complete pane-kind inventory.
3. Run only these targeted tests in the fast mirror and observe the initial failure before implementation.

## Milestone 2 — Normalize icon infrastructure

1. Add a local `Icon.tsx` with a deliberately small SVG set used by this pass.
2. Keep one viewBox, stroke width, cap/join, optical box, and `aria-hidden` behavior.
3. Replace high-frequency emoji/Unicode in:
   - toolbar utility and creation controls;
   - pane move/overflow/menu state;
   - close buttons in touched dialogs/banners;
   - freeze/unfreeze affordances;
   - find-bar arrows/close where they share the same control grammar.
4. Preserve semantic status dots and provider colors.

## Milestone 3 — Simplify the desktop toolbar

1. Remove the persistent `NEW` label/select pair.
2. Make the primary `+ Pane` button open a pane-kind menu.
3. Create immediately on kind selection and remember the selection for keyboard/new-tab/new-workspace paths.
4. Add a single workspace-tools overflow containing labeled Save, Load, Sessions, and Memory actions.
5. Retain cwd selection, workspace navigation, remote access, help, and remote read-only marker.
6. Add outside-click/Escape dismissal and appropriate menu semantics.
7. Keep mobile’s existing replacement chrome and wire its new-pane action to the same kind picker model where practical without weakening 44px targets.

## Milestone 4 — Add truthful continuity status

1. Extend the preload bridge with `snapshotNow()`.
2. Extend utility-process command routing with `{cmd:'snapshot'}` → `ControlMsg::Snapshot`.
3. Handle existing `SnapshotOk` in renderer event flow.
4. Add a compact continuity pill using `connected` plus daemon session truth.
5. Add a detail popover with live/exited-retained counts and daemon-owned persistence explanation.
6. Add “Snapshot now” with idle/pending/confirmed/error presentation.
7. On disconnect, clear pending success assumptions and expose the disconnected state.
8. Add/adjust protocol/router tests for the snapshot command path.

## Milestone 5 — Clarify pane actions

1. Reduce visible pane actions to drag/move and overflow.
2. Open the same labeled menu from overflow click and header context-click.
3. Add menu rows for:
   - refresh terminal (terminal panes only);
   - provider reload (eligible agent panes only);
   - split right/down;
   - zoom/restore;
   - freeze/unfreeze;
   - copy cwd;
   - close.
4. Preserve mobile copy/paste rows and split-kind picker.
5. Preserve all keyboard shortcuts and terminal capability gates.
6. Ensure the menu’s close row remains visually separated/destructive.

## Milestone 6 — Accessibility and visual polish

1. Add `--accent-fill` with white contrast above 4.5:1; keep `--accent` for focus.
2. Raise desktop icon and tab-close targets to 26px without materially increasing chrome height.
3. Raise memory and other functional metadata to at least 11.5px.
4. Tune toolbar grouping, popover/menu geometry, pane action visibility, and narrow-pane overflow.
5. Add selection/caret/scrollbar theming and reduced-motion behavior where absent.
6. Confirm mobile/coarse-pointer targets remain at least 44px and menu rows at least 48px.
7. Update `DESIGN.md` token documentation for the split focus/fill violet.

## Milestone 7 — Validation and bounded live QA

1. Mirror the worktree to a fast local path, excluding `.git`, build outputs, and dependencies as appropriate.
2. Reuse/install dependencies on the fast filesystem only.
3. Run:
   - targeted new tests;
   - full app Vitest suite;
   - TypeScript typecheck;
   - renderer bundle/build;
   - lint if the repository’s configured lint command is operational.
4. Review the full diff for architecture, accessibility, error-state, and regressions.
5. Use the project verify workflow to launch a real daemon + Electron UI.
6. Perform one combined inspection at desktop and mobile/coarse-pointer dimensions:
   - creation menu;
   - tools menu;
   - continuity state and confirmed snapshot;
   - pane overflow actions;
   - keyboard focus and Escape dismissal;
   - control sizes/contrast/overflow.
7. Run the UI detector once against changed targets.
8. Batch-fix all real findings, then perform at most one confirmation inspection.
9. Update the project status checklist with concise evidence.

## Test strategy

- **Pure unit tests:** continuity copy/count logic, pane-kind inventory.
- **Protocol/utility tests:** snapshot command encoding/routing where existing harness boundaries allow.
- **Existing regression suite:** layout, store, mobile, keys, resource pressure, client routing, protocol.
- **Build gates:** strict TypeScript and production renderer bundle.
- **Live proof:** real daemon state, real `SnapshotOk`, menu interactions, visual target sizing, and adaptive layout.

## Implementation review

Reviewed for sequencing, architecture, and testability.

- Accessibility work is represented in the design from the first component edit, while the final polish milestone applies the tokens consistently across all touched surfaces.
- Snapshot support reuses an existing protocol variant and does not expand Rust scope.
- The plan avoids optimistic session mutations and preserves daemon authority.
- Pure logic is extracted only where it creates test value; component decomposition is limited to reusable icons/popovers rather than a broad renderer refactor.
- Validation is explicitly moved off the slow worktree drive.
- The live-QA loop is bounded to one inspection, one batched fix, and one confirmation.

## Stop conditions

Stop only for a true architecture conflict, unavailable dependency/toolchain, or evidence that the existing Snapshot command does not provide the confirmed semantics its protocol promises. Ordinary layout and copy decisions are resolved using the approved design and best judgment.
