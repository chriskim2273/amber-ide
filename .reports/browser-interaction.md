# Browser interaction implementation evidence

Branch: `feat/browser-interaction`; persistent worktree `~/worktrees/amber-ide/browser-interaction`.

## Task 1 — semantic target identity and geometry

Implemented and locally verified; not installed in production.

- `includeUserAgentShadowDOM:false` normalizes native text-control hits to the actual input/textarea.
- `BrowserDomRelations` retains bounded numeric edges from real `DOM.setChildNodes` / insert/remove / shadow-root events. Chromium's `describeNode` responses omit parentId, so the old parent-walk could not recognize a button's nested span. No injected JavaScript or new evaluation capability is needed. Frame contentDocument boundaries are deliberately not treated as composed DOM ancestry.
- Relation storage is bounded, resets at fresh snapshots/document changes/disposal, fails closed at capacity and removes detached branches.
- Corrected mixed-axis quad calculations; reused a pure helper for inspect/action point/screenshot clipping.
- Checked-in private Electron runner: `app/scripts/verify-browser-interaction.cjs`. It uses an isolated profile, sanitized child environment, actual bundled adapter and real DOM/event outcome assertions. It does not start a daemon or attach to the user's browser.

Evidence under `~/recovery/amber-ide/browser-interaction/`:

- `fixture-red.log`: original adapter failed native textarea/input, nested-span button and nested form submission; genuine overlay rejection already passed.
- `unit-red.log`: inspect returned x20/width480 instead of x400/width100 for the literal offset quad.
- `fixture-shadow-green.log`: all six real cases pass, including an author-shadow span covering the host's click point. The real overlay remains TARGET_OCCLUDED and neither underlying nor covering click handlers fire.
- `task1-app.log`: **1095 passed, 1 intentional skip** across the full app suite.
- Focused helper/adapter tests: **37 passed**. Typecheck passes.

The first new quad test had a test-table argument-expansion error (Vitest treated array entries as separate arguments); the table was corrected to object rows rather than changing the production expectations. Xvfb may emit private-session DBus diagnostics; the run verdict comes from asserted fixture results and exit code, not absence of platform stderr.

## Task 2 — partial: document continuation fences and input release

A separate runtime document epoch now changes on navigation start/commit/in-page transitions. Host tests prove that a surviving WebContents incarnation cannot authorize a later activating/text event in a different document; final observation of an already completed navigation-producing click is still allowed. The adapter distinguishes dispatch, finish and owned-input cleanup guards, and attempts key/button release after cancellation or failure. A transport error after an input request is conservatively treated as possible dispatch, not proof of rollback safety.

Red tests: `document-epoch-red.log`, `key-cleanup-red.log`, `mouse-cleanup-red.log`. Current combined suite: **1101 passed, 1 intentional skip** (`task2-app.log`); typecheck passes (`task2-typecheck.log`). The six original real-Electron target fixtures still pass (`task2-fixture.log`). Navigation/cleanup assertions in this milestone are adapter/host tests, not yet the required real navigation-race fixture. Task 2 is not complete.

## Completed implementation and final verification — 2026-09-06

The preceding Task 2 subsection records the historical first slice, not current status. The isolated branch now implements:

- Native/author-shadow/composed target matching; clipped/rotated visible quad points; nested/offscreen scrolling; two stable observations and bounded pre-input obstruction recovery; readonly/disabled refusal. A one-pixel compositor readback prevents newly navigated pages silently dropping input despite current DOM geometry.
- Interactive-first accessibility projections with explicit truncation reasons and approximate-depth labeling. Bounded obstruction diagnostics contain only reason, reference and point-attempt count, never HTML or field values.
- Four expiring screenshot metadata records per browser, bound to controller, incarnation, generation, document epoch and effective viewport revision. Image coordinates map independently by axis from actual delivered PNG dimensions; viewport captures alone issue tokens. Capture scaling bounds high-DPI output before encoding.
- `mouseMove`, `mouseClick`, `mouseScroll`, `mouseDrag`, and `typeFocused`, with bounded paths, modifier allowlists, held-input cleanup, exact approval digests, receiver revalidation and opaque-region pixel checks. Coordinate activation always needs approve-once; benign motion/wheel does not gain broader authority.
- A noninteractive browser-local Overlay cursor, capture suppression/restoration, cancellation and revocation fencing. Native keyboard text, Enter, Tab/Shift-Tab, selection editing and Unicode are exercised against real fields.
- Generated Pi extension v9, 31 browser tools total, preserved recovery/quota hooks and installer ownership guards. Post-action binary images retain action outcomes; capture failure cannot erase completed dispatch or cause input replay.

### Gates and evidence

Evidence root: `/home/poyto/recovery/amber-ide/browser-interaction/`.

- Full app suite: **1126 passed, 1 intentional skip** (`tests-final.log`); both TypeScript configurations pass (`check-final.log`).
- Rust workspace/all-targets: **893 passed, 2 ignored**, zero failures (`rust-tests.log`); warnings-as-errors Clippy passes (`clippy.log`).
- Electron/web builds and static-musl AppImage packaging pass (`package-final.log`). Pre-existing bundle-size/package-metadata warnings remain; repository-wide formatting/ESLint cleanup is not claimed.
- Pinned Pi 0.81 compile/load verification passes for all **31 tools**, exact image/observation forwarding, post-action results, fatal token/frame checks and nonretryable partial failures (`pi-final.log`).
- Final real Electron 43/Xvfb matrix: **37 cases × 20 consecutive runs = 740/740 checks**, zero failures (`matrix-reviewed/`). Aggregate p50 **120.5 ms**, p95 **414 ms**, excluding human approval dwell. See `browser-interaction-scorecard.md` for per-case timings and representative adapter request counts.
- Final packaged smoke: `/home/poyto/recovery/amber-ide/bi-proof/final-evidence.json`. Real broker/renderer approval UI, two coordinate approve-once dialogs with image previews, fresh raw-binary observations, focused typing of `potatoes`, sharing refusal/revocation, hidden resident browser survival, concurrent reopen, explicit menu Quit and SSH-tunnel cleanup all pass. No input retries; the passing run needed no read-only observation refresh.
- Final AppImage: `app/release/amber-ide-0.0.2.AppImage`, SHA256 `997c9fac592cbfe908fa7958321baff6fdcc2c31720cd82f8b2f6222e1840ee9`.

### Failures retained, not erased

Native regression work exposed that releasing a cancelled press over its target still generates a click even with clickCount zero; cleanup now releases outside web content using renderer-local CDP coordinates, never desktop input. Navigation-race fixtures prove no trailing text reaches the new document.

Direct review caught a cursor suspension/revocation race (`cursor-race-red.log`) and a queued cursor surviving cancellation (`cancel-hover-probe.log`). The cursor's own revision is now captured before awaiting hide, and cancellation clears pending display.

An intermediate matrix failed on run 12 when an overlay disappeared between hit testing and ancestry inspection (`matrix-final/run-12.log`). Its exact missing-node CDP failure is reproduced deterministically (`vanishing-overlay-red.log`), recovered only in the pre-input hit walk, and covered in all 20 final runs. It is not broadly swallowed or retried after dispatch.

Packaged-harness attempts are retained: one correctly refused a stale read-only screenshot lease; another used an overlong Unix socket path; an intermediate harness incorrectly assumed a successful status response. The final short-path harness asserts status responses and permits only bounded read-only stale-lease refresh. The final package proof passed without any input replay.

### Scope and remaining external acceptance

No main merge, production install, production restart, or permission change was performed for this interaction branch. No subagents were used. Private Xvfb runs used test-only `--no-sandbox` and software rendering. The inherited smoke JSON's `sandbox:true` label refers to its Node/context-isolation checks, not proof that Chromium's OS sandbox was enabled.

A typed Google search through the installed public tools still requires separately authorized installation and a fresh Pi tool load. URL navigation is not counted as typing. Physical Linux/IME/pointer and macOS checks remain external; Xvfb is not evidence for them. Unresolved frame focus explicitly fails closed; arbitrary/OOP-frame text targeting and exhaustive native select/file-picker behavior are not newly certified. No claim of private Codex implementation parity is made.
