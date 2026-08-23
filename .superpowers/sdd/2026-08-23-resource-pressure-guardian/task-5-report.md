# Task 5 — Electron and Web Resource-Pressure UI

## Delivered

- `app/src/shared/proto.ts` and `app/src/shared/proto.test.ts`
  - Added typed `ResourcePressure` decode/encode support with strict `normal | critical` level and `cpu | io | memory` cause validation.
  - Preserved `MemoryPressure`; `blocked` remains additive and defaults to `false`.
  - Verified the watcher wire form accepts version 2.
- `app/src/client/index.ts`
  - Requests `WatchMemoryPressure { version: 2 }` after connect.
- `app/src/web/amber.ts` and `app/src/web/amber.test.ts`
  - Parses and maps web `resourcePressure` broadcasts into the shared daemon-event shape.
- `app/src/renderer/store.ts`, `app/src/renderer/store.test.ts`, `app/src/renderer/main.tsx`, and `app/src/renderer/SplitView.tsx`
  - Stores aggregate-memory and host-resource pressure independently.
  - Clears both pressure types when the connection drops, protecting reconnects to older daemons.
  - Shows a critical banner naming all active host-pressure causes.
  - Renders `resource-suspended` with the existing parked visual token while preserving legacy `memory-suspended` behavior and copy.
  - Generalizes the existing guarded parked overlay; it continues to resume only through the user-interaction Focus path.

## TDD evidence

1. RED: `npm test -- --run src/shared/proto.test.ts src/web/amber.test.ts`
   - Failed for missing `ResourcePressure` protocol decode and web bridge mapping.
2. GREEN: same focused command passed: 52 tests.
3. Protocol-shape correction: Rust declares `causes: Vec<ResourcePressureCause>` (plural), so tests were updated from the initially ambiguous singular reading.
   - RED: focused protocol/web tests failed against the singular implementation.
   - GREEN: same focused command passed: 52 tests.
4. RED: `npm test -- --run src/renderer/store.test.ts`
   - Failed for absent resource state/reducer, generalized parked presentation, and `resource-suspended` dot.
5. GREEN: renderer store tests passed: 51 tests.
6. RED: renderer tab aggregation test failed for all-resource-parked panes.
7. GREEN: renderer store tests passed: 52 tests.

## Final verification

- `cd app && npm test -- --run` — 556 passed, 1 skipped across 41 files (the existing connection test intentionally logs malformed-frame/socket reconnect diagnostics).
- `cd app && npm run typecheck` — passed.
- `git diff --check` — passed before commit.

## Commit

- `2c580c5 feat: show amber resource pressure`

## Self-review

- The TS wire shape matches the live Rust protocol's plural `causes` array and preserves strict validation/default behavior.
- `MemoryPressure` state, telemetry, banner, and legacy parked projection stay separate and unchanged in behavior.
- Resource parked panes reuse existing overlay and status-dot styling, avoiding a visual redesign or new design tokens.

## Risks

- The browser bridge accepts the documented Rust `resourcePressure` JSON shape only; a daemon emitting a different field name is intentionally ignored rather than guessed.
- The full suite has existing expected stderr from the malformed-connection test; it did not affect the passing result.

## Fix round 1 — direct renderer UI coverage

### Files

- `app/src/renderer/PressureBanners.tsx` — extracted the live resource-pressure banner as a renderable component; `main.tsx` still owns the critical-state gate and renders this component.
- `app/src/renderer/resourcePressureUi.test.ts` — jsdom-mounted renderer coverage, with `Pane` and `KeyBar` reduced only to their DOM boundaries so the real `SplitView` event handlers run.
- `app/package.json` and `app/package-lock.json` — added the test-only `jsdom` environment required for DOM mounting and event dispatch.
- `app/src/renderer/main.tsx` — uses `ResourcePressureBanner` rather than inline markup.

### Red/green evidence

1. RED: `cd app && npm test -- --run src/renderer/resourcePressureUi.test.ts`
   - Failed before the testability extraction: Vite could not resolve `./PressureBanners`; the live banner was inline in the application entrypoint and had no isolated render surface.
2. GREEN: same focused command passed: 4 tests.
   - Asserts the critical banner’s rendered CPU/I/O copy.
   - Asserts exact resource-parked and legacy memory-parked overlay text from the real `SplitView` render.
   - Re-renders a kept-alive background `SplitView` as active and proves the programmatic focus path does not call `onPaneFocus`.
   - Activates the visible overlay Resume button and proves it calls `onPaneFocus` for that pane.
3. Final: `cd app && npm test -- --run && npm run typecheck && git diff --check`
   - 560 tests passed, 1 integration test skipped; typecheck and diff check passed.

### Commit

- `7ef8eab test: cover resource pressure UI`

### Self-review

- The assertions query mounted DOM output and exercise the actual `SplitView` focus/Resume handlers; they do not rely on the earlier pure presentation helpers.
- The banner extraction is a production-only refactor: there are no test-only conditions or branches.
- The test mocks only the terminal-heavy `Pane` and unrelated key bar, keeping the target `SplitView` event code and overlay markup real.

### Risks

- jsdom cannot mint browser-trusted synthetic pointer events. The test covers the real active-tab Resume control path; the background activation test covers the guard that rejects unarmed programmatic focus. Browser event `isTrusted` remains enforced by the existing production handler.

## Fix round 2 — trusted resume policy without jsdom

### Response to findings

1. **Trusted interaction policy:** addressed. `shouldResumeParkedPane(active, trusted)` is now the shared production policy. `shouldResumeMemoryParked` delegates to it for the real `SplitView` focus and pointer handlers, and `ParkedOverlay` calls it for the actual Resume-button handler. The replacement tests prove that only `active && trusted` resumes; untrusted input and background activation are denied.
2. **No new dependencies:** addressed. Removed direct `jsdom` from `app/package.json` and all of its package-lock entries. `npm ls jsdom --depth=0` reports an empty tree. The replacement uses existing `react-dom/server` and Vitest only.

### Files

- `app/src/renderer/store.ts` — added the shared `shouldResumeParkedPane` policy and routed the pre-existing focus/pointer guard through it.
- `app/src/renderer/PressureBanners.tsx` — added the real `ParkedOverlay` component; its Resume click now applies that same policy.
- `app/src/renderer/SplitView.tsx` — renders `ParkedOverlay`, keeping resource and legacy text selection unchanged.
- `app/src/renderer/resourcePressureUi.test.ts` — dependency-free static render assertions for the banner and both overlay copies, plus the trusted/background resume-policy matrix.
- `app/package.json` and `app/package-lock.json` — removed jsdom.

### Red/green evidence

1. RED: `cd app && npm test -- --run src/renderer/resourcePressureUi.test.ts`
   - Failed with `ParkedOverlay` undefined and `shouldResumeParkedPane is not a function`, proving the real presentation component and shared trusted policy were absent.
2. GREEN: `cd app && npm test -- --run src/renderer/resourcePressureUi.test.ts src/renderer/store.test.ts`
   - 55 tests passed.
3. Final: `cd app && npm test -- --run && npm run typecheck && git diff --check`
   - 559 tests passed, 1 integration test skipped; typecheck and diff check passed.
4. Dependency check: `cd app && npm ls jsdom --depth=0`
   - Reported `(empty)`.

### Commit

- `13eea25 test: enforce parked resume policy`

### Self-review

- The tested policy is invoked by all three real resume routes: overlay button, overlay pointer interaction, and keyboard/focus interaction.
- Server rendering verifies exact live markup copy for the banner and both overlay variants without a test-only presentation branch.
- The legacy memory overlay copy and the background/keep-alive protection remain intact.

## Fix round 3 — SplitView server-render integration evidence

### Response to finding

- `app/src/renderer/resourcePressureUi.test.ts` now server-renders the **real** `SplitView`, with only `Pane` and `KeyBar` mocked to avoid terminal/browser dependencies. A focused `PressureBanners` spy wrapper captures the props passed by `SplitView` while returning the real exported `ParkedOverlay` element.
- The test asserts `SplitView` passes `active: false` for the background layer and `active: true` after activation, preserves the resource parked copy, then invokes the **real** Resume button handler with explicit `{ isTrusted }` event-shaped inputs. It proves background + trusted and active + untrusted do not call `onPaneFocus`, while active + trusted calls it with the exact pane name.
- The React state mock uses React's real `useState` hook and only seeds the server-only initial 0×0 stage rect. Server rendering does not run the browser `ResizeObserver` effect, so this lets the actual pane/overlay render branch execute without a production branch or dependency.

### TDD evidence

- This is coverage for behavior implemented in fix round 2; the policy and handler were already green before this integration test was added. The first focused execution after adding the real-`SplitView` harness was green (no production behavior mutation or artificial regression was introduced).
- Focused: `cd app && npm test -- --run src/renderer/resourcePressureUi.test.ts` — 3 passed.
- Final: `cd app && npm test -- --run && npm run typecheck && git diff --check` — 559 passed, 1 integration test skipped; typecheck and diff check passed.

### Commit

- `3617968 test: exercise splitview parked overlay`

### Self-review

- The test does not claim a synthetic browser event is trusted. It deliberately calls the real React handler contract with event-shaped trusted/untrusted values, as requested.
- `SplitView` owns the captured wiring, `ParkedOverlay` owns the exercised handler, and the production code contains no test-only branch.

## Fix round 4 — SplitView activation lifecycle evidence

### Response to finding

- `app/src/renderer/resourcePressureUi.test.ts` now uses `react-dom/client` with a local minimal DOM shim to mount one real `SplitView` root. There is no `jsdom`, `happy-dom`, `react-test-renderer`, or new dependency.
- The new test renders `SplitView` once with `active: false`, then updates the same root to `active: true`. This runs the actual activation `useEffect`, not two independent server renders.
- The test proves the activation path bumps the real `Pane` `activateSeq` from `0` to `1`, calls the mocked pane textarea's real `focus()` method once through `focusPane(target, false)`, and still does not call `onPaneFocus`.
- Static server-render coverage remains for exact banner/overlay copy and the existing real overlay handler active/trusted matrix.

### Renderer decision

- Existing app tests use Vitest's Node environment only (`app/vitest.config.ts`), and `npm ls jsdom happy-dom react-test-renderer --depth=0` reports an empty tree.
- Electron is present as an app/runtime dependency, but using it for this unit proof would require a separate Electron app harness and display wrapper. The committed lifecycle coverage instead uses the already-installed React DOM client renderer plus a test-local DOM surface.

### Red/green evidence

1. Baseline before edits: `cd app && npm test -- --run src/renderer/resourcePressureUi.test.ts`
   - 3 tests passed. This confirmed the existing coverage was green but still server-render-only for activation.
2. First failing harness run after adding the lifecycle test: `cd app && npm test -- --run src/renderer/resourcePressureUi.test.ts`
   - 1 failed, 3 passed.
   - Failure: `TypeError: activeElement.attachEvent is not a function` from React DOM's input focus polyfill while executing the programmatic focus path.
3. GREEN after adding the missing no-op fake-DOM `attachEvent`/`detachEvent` methods: `cd app && npm test -- --run src/renderer/resourcePressureUi.test.ts`
   - 4 tests passed.
4. Focused renderer verification: `cd app && npm test -- --run src/renderer/resourcePressureUi.test.ts src/renderer/store.test.ts`
   - 56 tests passed across 2 files.
5. Typecheck: `cd app && npm run typecheck`
   - Passed (`tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.node.json`).
6. Full app suite: `cd app && npm test -- --run`
   - 560 passed, 1 skipped across 42 files. Existing malformed-frame reconnect diagnostics still print on stderr.
7. Dependency check: `cd app && npm ls jsdom happy-dom react-test-renderer --depth=0`
   - Reported `(empty)`; npm exits 1 for the empty tree.

### Self-review

- Production renderer behavior is unchanged; this round only changes `resourcePressureUi.test.ts` and this report.
- The lifecycle test executes React effects with a real client root and reuses the real `SplitView` activation effect, `focusPane(target, false)` path, pane ref registration, and focus-capture guard.
- The fake DOM is test-local and only implements the browser surface React/SplitView need for this lifecycle assertion.
