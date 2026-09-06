# Browser Interaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The user explicitly selected direct work: do not launch subagents. Steps use checkbox syntax for tracking.

**Goal:** Reliably type/search through native controls and provide screenshot-grounded mouse interaction without weakening browser authority.

**Architecture:** Keep the existing main-owned transport/host/broker pipeline. Extract geometry, observation and pointer ownership helpers; preserve semantic tools and add coordinate actions through the same approval boundary.

**Tech Stack:** Electron 43 debugger transport, strict TypeScript, Vitest, Rust-generated Pi extension, private Electron fixtures under Xvfb.

**Spec:** `docs/superpowers/specs/2026-09-05-browser-interaction-design.md` (read it completely before execution).

## Global Constraints

- Persistent isolated cwd: `/home/poyto/worktrees/amber-ide/browser-interaction`; base `3ad9a0b9f515545bb5db2f05d6c7161a5578b42d`.
- No production restart, installation, merge, or permission relaxation is part of implementation authority.
- No arbitrary agent-authored JavaScript, script runtime, exposed debugging endpoint or unrestricted CDP is introduced.
- Keep existing semantic calls compatible and preserve newer Pi recovery/quota hooks.
- Pointer paths: 2..64 points for drag, maximum 2-second dispatch duration. Wheel deltas: +/-10000.
- Observation records: at most four per live browser, expiry 60 seconds; viewport screenshots only for coordinate actions.
- Every coordinate click or drag requires approve-once. Hover and wheel remain benign under the current policy.
- All input callbacks still increment generation. Partial activation never retries automatically.
- Existing app baseline: 1079 passed, 1 intentional skip. Private probe confirmed native-control and nested-span false occlusion independently.
- Capture red/green logs and receipts under `~/recovery/amber-ide/browser-interaction/`; keep a scorecard of supported/blocked/not-tested cases.

## File responsibilities

- Existing `app/src/main/browserAutomation.ts`: orchestration and debugger transport only; compose the helpers below.
- New `browserGeometry.ts`: pure quad math, clipping and delivered-image-to-CSS conversion.
- New `browserObservations.ts`: bounded screenshot metadata ownership/expiry/invalidation.
- New `browserPointer.ts`: operation-local button/modifier ownership, bounded paths and cleanup.
- New `browserAgentCursor.ts`: fixed noninteractive CDP Overlay marker lifecycle.
- Existing `browserToolProtocol.ts`, `browserApproval.ts`, `browserErrors.ts`: public input validation, exact approval binding and stable failures.
- Existing host/service/broker/shared status: authority, document epoch and binary metadata propagation.
- Existing `BrowserRail.tsx`: browser-local agent activity presentation, not page input authority.
- Existing `crates/amber/src/pi.rs` and extension verifier: generated tools, ownership-version upgrade and exact output contract.
- New `app/scripts/verify-browser-interaction.cjs`: self-contained private Electron fixture harness; no production daemon or browser profile.

## Task 1: Turn measured false occlusion into permanent regressions

**Files:** `browserAutomation.ts`, `browserAutomation.test.ts`, new `browserGeometry.ts`/`.test.ts`, new `app/scripts/verify-browser-interaction.cjs`.

**Interfaces:** `quadBounds(quad: readonly number[]): {x:number;y:number;width:number;height:number}` rejects invalid/nonfinite/degenerate quads. Existing `BrowserAutomation.snapshot/prepareInteraction/executeInteraction` remain the public adapter entry points.

- [ ] Promote the private `probe-native-hit.cjs` into a checked-in fixture runner. Keep `require('electron')` as the Electron built-in, use a caller-specified private userData directory, and exit nonzero on a failed case. Bundle the real adapter with esbuild; do not substitute a production code path in the harness.
- [ ] Add textarea, input, nested-span button, real covering overlay, and author-shadow fixtures. Capture actual input values and receiver event logs from the private fixture only. Add form submission outcome, not just Enter event logging.

The adapter test invocation is concrete:

```ts
const signal = new AbortController().signal
const snapshot = await automation.snapshot(lease,
  { maxDepth: 20, maxNodes: 100, maxBytes: 262144 }, signal)
const field = snapshot.nodes.find(node => node.name === 'Search' && node.role === 'textbox')!
const prepared = await automation.prepareInteraction(lease,
  { kind: 'fill', target: { snapshotId: snapshot.snapshotId, ref: field.ref }, text: 'potatoes' }, signal)
await automation.executeInteraction(prepared, signal)
```

- [ ] Record the native/nested red results using the original adapter. Record that a genuine overlay is rejected before and after the fix.
- [ ] Fix native-hit normalization and bounded composed ancestry. Do not accept an unrelated hit merely because its rectangle overlaps the target. Confirm actual ancestry data on Electron before selecting the protocol implementation; do not fabricate `parentId` in mocks to make it pass. If bounded ancestry needs a change beyond the approved transport design, stop and document it before introducing a new evaluator.
- [ ] Add the independent mixed-axis geometry regression:

```ts
expect(quadBounds([400, 20, 500, 20, 500, 60, 400, 60]))
  .toEqual({ x: 400, y: 20, width: 100, height: 40 })
```

- [ ] Implement axis-specific extraction with `xs=[q[0],q[2],q[4],q[6]]` and `ys=[q[1],q[3],q[5],q[7]]`; reuse it in inspect, actionability and screenshot clips.
- [ ] Run `cd app && npm test -- src/main/browserAutomation.test.ts src/main/browserGeometry.test.ts`, plus the private fixture. Commit `fix(browser): resolve real target hits and geometry` only when the real native/nested/overlay contrast passes.

## Task 2: Reliable preparation, useful snapshots and navigation fences

**Files:** `browserAutomation.ts`/`.test.ts`, `tabBrowserHost.ts`/`.test.ts`, `electronTabBrowserPage.ts`/`.test.ts`, fixture runner.

**Interfaces:** Add internal `documentEpoch:number` to runtime state, incremented on document/navigation replacement independently of generation. An operation captures this epoch; subsequent activating/text events require it to remain unchanged. Existing public page leases are unchanged.

- [ ] Add a host regression where click/focus navigates to another document while WebContents incarnation remains the same. Assert subsequent insertText is absent and partial-dispatch context is returned. Contrast with a completed one-click navigation that still returns its actual final state.
- [ ] Add offscreen/nested-scroll, transient covering overlay, moving/transformed quad, disabled/read-only, late-document control and frame-boundary fixture cases. Explicitly assert failure for unsupported frame paths.
- [ ] Implement cancellation-aware preparation within 2000ms; try bounded visible interior points, require two stable observations, scroll only through controlled commands, and recompute target metadata after any scroll. Stop on user/context changes; no broad generation exemption.
- [ ] Add structured bounded/redacted obstruction diagnostics and truthful snapshot truncation reasons. Prioritize interactive controls over generic nodes while retaining hard input/work budgets.
- [ ] Run the adapter/host/page tests and fixture cases. Assert no text values, HTML or credentials appear in diagnostics. Commit `fix(browser): stabilize targeting and fence document changes`.

## Task 3: Ground coordinates in actual returned screenshots

**Files:** new `browserObservations.ts`/`.test.ts`, `browserGeometry.ts`/`.test.ts`, adapter, host and broker with tests, generated Pi image-result forwarding.

**Interfaces:**

```ts
interface ScreenshotObservation {
  screenshotId: string
  browserId: string
  controller: string
  pageIncarnation: string
  generation: number
  documentEpoch: number
  viewportRevision: number
  imageWidth: number
  imageHeight: number
  cssViewport: { x: number; y: number; width: number; height: number }
  capturedAt: number
  coordinateActionable: boolean
}
// Pixels are in the returned PNG, not physical-screen/window coordinates.
function mapScreenshotPoint(observation: ScreenshotObservation,
  point: { x: number; y: number }): { x: number; y: number }
```

- [ ] Add red tests for each axis, fractional scaling, image bounds, expiry, fifth-record eviction, controller switch, viewport revision and generation mismatch. Full-page/element images must reject coordinate use.
- [ ] Implement independent axis mapping using actual image and effective viewport measurements; validate finite values and reject rather than clamp. Store metadata only, maximum four records/60 seconds, cleared on authority/runtime invalidation.
- [ ] Extend binary result types and broker's explicit serialization allowlist so screenshot metadata survives the wire. Test the actual generated Pi image output; unknown fields cannot merely disappear at the serializer.
- [ ] Test real PNG pixels against actual page event receivers at DPR 1, 1.25 and 2 and after resize/scroll. If delivery resizes the image, include that transform and test it end-to-end.
- [ ] Run geometry/observation/broker/adapter tests and Pi output checks. Commit `feat(browser): bind screenshots to pointer coordinate observations`.

## Task 4: Pointer operations through existing approvals

**Files:** new `browserPointer.ts`/`.test.ts`, protocol/errors/approval, host/service/broker and tests.

**Interfaces:** New operation kinds `mouseMove`, `mouseClick`, `mouseScroll`, `mouseDrag`; all carry `screenshotId` and the existing outer page lease. Point/path/button/modifier fields follow spec section 6. No public persistent down/up state.

- [ ] Add parser tests rejecting NaN, infinity, extra keys, invalid buttons/modifiers, paths outside 2..64, ungrounded IDs and out-of-image points. Preserve existing semantic parse tests.
- [ ] Add tests proving every coordinate click/drag enters approve-once, exact path/button/modifier changes invalidate the digest, and move/wheel follow existing benign policy.
- [ ] Implement an operation-local held-input set. Before each activating/text event verify authority, document epoch and pre-dispatch lease; in `finally`, attempt release of only owned buttons/modifiers. A successful release never converts partial failure into a clean retryable error.
- [ ] Include a bounded move approach in click and intermediate movement in drag. Dispatch no more than 64 points within 2000ms. Report the actual receiver and final context where safe.
- [ ] After approval recheck receiver and viewport; for opaque regions compare the approved 64x64 CSS-pixel endpoint region at the same capture scale. Reject changed regions instead of trusting stale approval.
- [ ] Private fixtures assert hover menus, canvas activation, nested wheel receiver, intermediate drag path, rejection, revoke mid-drag and navigation during a gesture. Commit `feat(browser): add approved screenshot-grounded pointer actions`.

## Task 5: Visible cursor, focused typing and real keyboard behavior

**Files:** new `browserAgentCursor.ts`/`.test.ts`, adapter, Electron page/service teardown, shared browser events, `BrowserRail.tsx`, protocol/approval and tests.

**Interfaces:** Cursor helper exposes `show(point)`, `hide()` and `dispose()` over the existing private debugger transport. New `typeFocused` operation requires screenshotId/text plus page lease. Press gains a canonical bounded modifiers array.

- [ ] Write lifecycle tests before implementation: hide/dispose on revoke/tab hide/navigation/freeze/cancel; no update after owner change; coalescing capped at 60Hz.
- [ ] Implement a fixed `Overlay.highlightQuad` marker and `Overlay.hideHighlight`. It never creates page DOM or moves the OS pointer. Hide for captures and restore only to the current owning page/controller.
- [ ] Prove marker pixels are absent from screenshots and the marker does not intercept hits or physical pointer input. If Overlay cannot meet these constraints, revise rather than add an unsafe overlay view.
- [ ] Implement focused receiver verification and text classification. Redact all unknown-focused text summaries; reject unresolvable focus/frame identity. Preserve credential/payment/file restrictions and Enter approval.
- [ ] Implement only the spec's editing/navigation modifier combinations; reject clipboard/filesystem/browser-chrome escapes and unknown/duplicate combinations.
- [ ] Assert actual form submission, Tab traversal, selection replacement, modifier editing and Unicode input, plus cleanup after navigation/cancellation. Commit `feat(browser): show agent pointer and improve keyboard interaction`.

## Task 6: Pi tools and closed-loop visual results

**Files:** `crates/amber/src/pi.rs`, `app/scripts/verify-pi-browser-extension.mjs`, adapter/protocol/host/broker result tests, fixture runner.

**Interfaces:** Publish `browser_mouse_move`, `browser_mouse_click`, `browser_mouse_scroll`, `browser_mouse_drag`, `browser_type_focused`; keep old tools valid. Optional post-action viewport screenshot carries its observation plus the action's final-context result.

- [ ] Add generator/verifier tests for exact tools/schemas, delivered screenshot coordinates, unknown-host operation failure, preservation of recovery/quota hooks and installer ownership behavior.
- [ ] Increment the managed extension version according to existing installer policy; never overwrite a user-owned extension silently.
- [ ] Implement new tool declarations and binary metadata forwarding. Document fresh observation after independent input, semantic-first behavior, approve-once coordinates, and no retries after partial dispatch.
- [ ] Test post-action screenshot failure independently from completed dispatch: the image error cannot erase the action result or trigger an automatic second click. Revoked sharing prevents further capture.
- [ ] Run pinned-Pi compile/load verification plus Rust generator tests. Commit `feat(pi): expose grounded browser mouse tools`.

## Task 7: Acceptance matrix and package review

**Files:** fixture runner, `.reports/browser-interaction.md`, relevant regression tests and spec status.

- [ ] Create a scorecard with one row per spec section 11/12 case: strategy, actual outcome, supported/blocked/not-tested, approval count, request count, timing and evidence path.
- [ ] Repeat the critical local matrix 20 times. Record failures instead of silently retrying them away; require zero unexplained critical-flow failures. Report p50/p95 excluding human approval dwell.
- [ ] Run full app tests/typecheck/Electron and web builds; Rust workspace/all-target tests and warnings-as-errors Clippy; exact Pi verifier. Use persistent logs and report pre-existing formatting/lint limits separately.
- [ ] Build and run a private packaged smoke with isolated HOME/XDG/profile/daemon. Verify the new broker/Pi tools, image metadata, cursor, approvals, revoke and resident lifecycle together.
- [ ] After a separately authorized install, demonstrate a real Google typed-potatoes search through the public browser tools. A search-URL fallback does not pass. Label external CAPTCHA/network/physical-platform blockers honestly.
- [ ] Review the entire diff directly for authority gaps, resource leaks, accidental raw-eval exposure and regressions to Pi recovery hooks. Update the report and commit validation evidence. Do not merge or deploy implicitly.

## Plan self-review coverage

Tasks 1-2 cover semantic reliability, geometry, snapshots and document races. Task 3 establishes the coordinate/observation contract. Task 4 enforces pointer approval and cleanup. Task 5 covers browser-local visualization and keyboard semantics. Task 6 covers generated tooling and the observe/action loop. Task 7 proves task outcomes and platform/evidence limits. The separate current production state and previously merged feature are never used as the test fixture.
