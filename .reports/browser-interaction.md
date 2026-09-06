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

## Still pending

Actionability deadlines/scrolling, stronger snapshot budgeting, real navigation-race fixtures, screenshot coordinate tokens, coordinate approval/dispatch, browser-local agent cursor, expanded keyboard/focused input, new generated Pi tools and full package/20-run acceptance matrix remain unimplemented. This report does not claim the entire feature or general Codex parity is complete.
