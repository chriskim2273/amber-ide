# Reliable semantic targeting and screenshot-grounded pointer control

Status: hybrid approach approved; user requested the strongest practical implementation. Direct quality review incorporated below; implementation must still earn the acceptance evidence.

Base: `3ad9a0b9f515545bb5db2f05d6c7161a5578b42d`. Work directly, without subagents, in persistent `~/worktrees/amber-ide/browser-interaction` (`feat/browser-interaction`). No production restart, installation, merge, or permission relaxation is part of implementation authority.

## 1. Problem and evidence

On the user's shared Google home page, both `browser_fill` and `browser_type` targeting the visible Search combobox returned `TARGET_OCCLUDED`. The screenshot showed the search field unobstructed. Navigation worked; a direct search URL subsequently loaded `potatoes - Google Search`, but that did not validate typing or submission.

The current adapter (`app/src/main/browserAutomation.ts`) computes a border-box center, requests `DOM.getNodeForLocation` with `includeUserAgentShadowDOM:true`, then follows `DOM.describeNode.parentId`. Chromium documents `false` as resolving to the nearest non-user-agent-shadow ancestor. Native text controls can expose internal editing nodes when `true` is used. This is now reproduced in a private Electron 43 fixture using the unmodified adapter. With native-shadow hits enabled, both textarea and input fail `TARGET_OCCLUDED`; changing only that probe transport argument to false lets both receive the literal `potatoes`. A button containing a span fails under both settings, proving a separate ancestry defect. No production code was patched for this experiment. Probe and evidence: `~/recovery/amber-ide/browser-interaction/probe-native-hit.cjs` and `native-hit-probe.log`. The first probe launch had a test-harness Electron import error; it was corrected before these measurements, and only the private test process was terminated.

Other observed/source-confirmed weaknesses relevant to this work:

- Snapshots consumed budgets on generic containers and truncated before useful controls even with a large requested node budget. Reported depths were all zero on Google. Actual DOM-parent availability must be measured rather than assumed.
- `inspect()` computes x/width over mixed x/y entries of a quad. This is a definite geometry bug; fix with a pure regression test.
- Actionability uses one center point, does not scroll targets into view, and has no bounded wait for transient obstruction/stability.
- Screenshots expose image dimensions but no durable capture token or mapping to the actual CSS viewport. Host desired viewport metadata differed from the visible image dimensions during the live attempt.
- Semantic drag emits only an initial and final movement, and button/key cleanup is incomplete across failure paths.

Baseline app tests: **1079 passed, 1 intentional skip**, before modifications. Evidence: `~/recovery/amber-ide/browser-interaction/baseline-app.log`.

## 2. Approach and alternatives

Choose hybrid operation: semantic targets first, screenshot-grounded coordinates for visual/canvas/custom interactions. Reuse the existing main-owned debugger transport, host authority, queue, broker, Pi extension and approvals. Add focused geometry, observation and pointer helpers rather than concentrating all new logic in the existing adapter.

Alternatives rejected:

1. Semantic-only: fixes Google but still cannot operate an unlabeled canvas or spatial widget.
2. Coordinates-only: loses useful accessibility semantics and makes routine controls brittle; does not justify bypassing real occlusion checks.

OpenAI's public documentation describes move/click/double-click/scroll/type/keypress/drag/screenshot, modifier cleanup, screenshot feedback and coordinate remapping. It does not disclose the complete private Codex implementation. Adopt these published contracts, not claims of implementation equivalence. Playwright's visible/stable/receives-events/enabled/editable checks provide the actionability reference. No arbitrary agent-authored JavaScript, script runtime, exposed debugging endpoint or unrestricted CDP is introduced.

## 3. Authority stays main-owned

All new actions retain:

- Existing same-tab designated-controller identity, explicit sharing and revocation.
- Browser identity, page incarnation and generation checks before dispatch.
- Current active-surface/visibility and approval validity checks.
- Bounded parser, queue, cancellation and host-drain behavior.
- Uniform generation increments for every observed input callback. Do not restore synthetic-input suppression or pretend physical and synthetic input can be distinguished.
- A separate internal document/navigation epoch guards multi-event continuation. Renderer/page incarnation can survive navigation, so incarnation alone is not proof that subsequent typing is still aimed at the original document. After a navigation or frame replacement, stop remaining typing/activating events and perform only owned-input release cleanup. Return the observed final context; a single completed navigation-producing click is not an automatic failure.
- `ACTION_FAILED_NO_ROLLBACK` after partial dispatch, with actual final page context, `retryable:false`, and fresh-observation guidance.

No changes to daemon session ownership, terminal transport, layout grouping, profile persistence, renderer-capacity limit, external network binding, or production startup flags.

## 4. Semantic target reliability

### 4.1 Hit testing

Turn the measured native input/textarea and nested-span failures into permanent real-Electron regressions; extend them to author shadow-root cases. Normalize native-control hits to the actual control rather than treating a UA editing implementation node as an unrelated overlay. Resolve ancestry using supported bounded protocol data; do not assume `parentId` is present in every `describeNode` response. Distinguish native shadow trees from author shadow trees and unrelated covering elements.

A real overlay must continue to fail. No `force:true`, disabled hit test, blind untargeted typing fallback, or accepting any geometrically overlapping element. For partially exposed controls, select a point in their visible clipped quad that actually hits the requested target/descendant; use a bounded set of candidates, not an unbounded pixel search. Avoid centers outside rotated/transformed quads.

### 4.2 Preparation and retries

Use a bounded 2-second actionability deadline inside the existing operation deadline, with cancellation-aware retries for detached/transient layout or obstruction. Permanent invalid/disabled/read-only controls fail immediately. Scroll a semantic target into view, including nested containers, only through controlled browser commands. Recompute geometry and metadata afterward. Scrolling may invoke page handlers, so it is an observable preparatory effect; do not falsely report zero side effects or silently retry an activating action.

Before activation, verify visibility, enabled/editable state as applicable, stable geometry on two observations, current fingerprint and actual hit receiver. Retry only before irreversible activation/typing; never automatically repeat a potentially dispatched click or text insertion. Changed controller, page identity, physical-interleaving generation or approved target invalidates the request rather than being re-authorized inside a retry loop.

Auto-scroll-generated context changes must be returned with fresh-observation guidance when they invalidate the lease. Do not relax the global input-generation contract to hide such changes. The live fixture must demonstrate an offscreen target remains usable under this rule, with an explicit second observation/action when needed.

### 4.3 Diagnostics and observations

Return bounded, redacted obstruction diagnostics: requested role/tag/label, action point, actual covering role/tag/label, and a stable error/recovery hint. No form values, secrets, arbitrary attributes, markup or filesystem artifacts.

Fix quad math in inspect. Make snapshot truncation explicit (including why/budget) and prioritize useful interactive roles over empty generic nodes. Preserve bounded input/transport work; never replace the bounded traversal with an unbounded full AX tree. Restore truthful hierarchy where protocol evidence provides it, otherwise mark unavailable rather than inventing depth. Existing ref validity and exact/ambiguous target behavior remain unchanged. Test controls late in a large document and controls inside supported frames/shadow roots. Unsupported frame targets produce a clear error, never dispatch into the top frame by guess.

## 5. Screenshot observation contract

Extend a viewport screenshot result with:

- Opaque `screenshotId`, bound to controller/share lifetime, browser/page incarnation, capture generation and effective viewport revision.
- Returned PNG width/height and actual CSS viewport rectangle, scroll/visual-viewport offsets and scale necessary for conversion.
- A declared coordinate space: **pixels of the returned PNG**, origin top-left.
- A bounded monotonic capture timestamp for diagnostics, not authority by itself.

Mapping uses actual capture and browser metrics, never desired viewport settings, Electron window coordinates, monitor coordinates or presumed devicePixelRatio. If the image is resized before the Pi tool delivers it, the returned metadata and mapping must describe that delivered image. Test both axes independently; nonuniform scaling cannot silently pass.

Keep at most four short-lived metadata records per live browser, expiring after 60 seconds and invalidated on navigation, viewport changes, freeze/disposal, controller change and revocation. Do not retain screenshot buffers by default. Coordinate requests also require the current ordinary generation lease; a screenshot is not permission to act after subsequent input. A move that changes generation means the agent obtains a new observation before another separate coordinate action; multi-point gestures are one bounded operation.

Only viewport screenshots are coordinate-actionable in this version. Element/full-page screenshots remain readable images but explicitly say they are not pointer coordinate bases. This prevents selecting a location in an offscreen full-page image and clicking the wrong viewport point.

## 6. Pointer tools

Add four clear tools, using the existing broker operation pipeline:

1. `browser_mouse_move`: screenshotId, x, y; optional bounded path ending at x/y. Moves the browser-local pointer and triggers hover behavior.
2. `browser_mouse_click`: screenshotId, x, y; button left/right; clickCount 1 or 2; optional supported modifiers and bounded approach path ending at the click point. Move-and-click can be one observed/approved operation rather than forcing an extra screenshot merely because mouse movement itself advances generation.
3. `browser_mouse_scroll`: screenshotId, x, y, deltaX, deltaY. Wheel input at the chosen receiver, allowing nested-scroller operation.
4. `browser_mouse_drag`: screenshotId, ordered path of 2..64 points; left button; optional supported modifiers. Down, intermediate moves, up are one operation.

All require the existing page lease. Coordinates must be finite and inside the referenced image and current viewport; do not clamp invalid values into a different target. Deltas retain existing +/-10000 bounds. Paths have a maximum 2-second dispatch duration, including at most 64 interpolated points. No public raw `mouseDown`/`mouseUp` endpoints in this version: holding buttons across independent requests complicates revocation and user interleaving without improving the requested use cases.

Hover and wheel do not activate a hidden semantic target. Coordinate clicks operate on the actual topmost receiver; they are not a `force-click` version of a failed semantic target. Middle-click/popups and OS/native context menus are not introduced as an authority escape: existing popup/navigation policies continue to apply. A right click may open a browser/page menu, but no OS-level input API is available to operate privileged native menus.

### 6.1 Coordinate approval policy

In the initial release, **every coordinate click or drag requires approve-once**, even if a benign semantic target can be identified. This deliberate conservative boundary prevents unlabeled canvas/custom regions or changed page semantics from bypassing the existing consequential classifier. Hover and wheel follow the current benign navigation policy. No origin-wide coordinate activation grant.

Approval shows the current receiver's bounded metadata where available, pointer location/path and a bounded visual target preview. Bind its digest to screenshot identity, page/viewport context, exact coordinates/path/button/modifiers and target fingerprint. After approval recheck surface, viewport and hit receiver. For opaque canvas regions, recheck a bounded target-region pixel digest (a 64x64 CSS-pixel region clipped to the viewport at each activating endpoint, using the same capture scale before/after approval); a changed/animated region fails with fresh-observation guidance rather than trusting a stale visual authorization. This is stricter than semantic benign-click handling; a later measured policy change may reduce prompts, but not silently in this implementation.

An approved drag can traverse intermediate regions; bind the whole path and both endpoints. An unexpected receiver/focus change before button-down aborts. Once down, release the button on every exit; report partial dispatch without claiming rollback.

## 7. Browser-local agent cursor

Render a small distinctive agent pointer marker through the host-owned CDP Overlay surface (`Overlay.highlightQuad`/`hideHighlight`), with a Pi/agent activity label in browser chrome. The overlay uses main-frame viewport coordinates and does not move the OS cursor, inject page DOM, expose Node, or add an always-live renderer.

Coalesce pointer-marker updates to at most 60Hz. Use bounded fixed styling owned by Amber, not page-provided HTML. Hide on revoked sharing, tab hide, navigation, freeze, controller change, cancellation and host teardown. Marker failure must not turn into a different input command or leak a resource.

Hide the marker during screenshot capture and restore it only if its owning page/controller is still current. Prove that it neither intercepts real input nor contaminates screenshots/hit testing. If Electron's overlay cannot meet those checks on the supported platform, stop and revise this part of the design rather than use a privileged click-intercepting webview fallback. Real-device verification is required before claiming native cursor parity.

## 8. Keyboard and focused input

Extend `browser_press` with a bounded modifier array while retaining existing single-key calls. Initial supported editing/navigation chords: Shift plus arrows/Home/End/PageUp/PageDown/Tab; Control/Meta plus A/Z/Y and word-navigation arrows/Backspace/Delete; Shift combined with supported selection/redo/navigation combinations. Modifier order is canonicalized for digests; duplicates and unknown combinations are rejected.

Add `browser_type_focused` with a current page lease, viewport `screenshotId`, and text capped at 8192 characters for controls selected visually. Re-read the focused receiver and apply the same credential/payment/read-only/file restrictions and approval classification used by semantic type. Unknown/canvas focus is not silently treated as a benign textarea; require approve-once with current visual context and conservatively redact the entire text argument in approval summaries, errors and logs. If frame/focus identity cannot be established, fail before sending text rather than guessing the top-level receiver. Never expose typed values from credential/payment fields in results, diagnostics or logs.

Ctrl/Meta clipboard, save/open/print, browser-chrome shortcuts and developer-tool shortcuts remain outside this change. Do not gain filesystem or clipboard access through key combinations. Enter retains consequential-submit approval; modifier Enter is not a loophole.

Track pressed buttons/modifiers inside one executing action, and attempt release in `finally` on failure, cancellation and navigation. Cleanup may release only inputs owned by that operation; it must not send text/click an additional target. The release attempt does not erase partial-dispatch reporting. Revoke/disconnect tests must prove no held key/button leaks to the next action.

## 9. Results and verification loop

Return dispatch facts and final page/viewport context, not only `accepted:true`. Include action point and actual receiver metadata when safe, plus whether a fresh screenshot/snapshot is needed. A dispatched event alone is not a claim that a site completed an action.

Support an optional bounded post-action viewport screenshot for the new mouse operations. It shares the observation contract and normal image limits, is captured only if authority still exists, and never prevents reporting an already dispatched action if observation fails. The Pi adapter must carry accompanying final-context and image metadata without turning image bytes into text. The agent should inspect results after meaningful actions rather than build long blind sequences.

Do not automatically retry on `ACTION_FAILED_NO_ROLLBACK`. A waiting approval is not an excuse to allow a different target to move under the pointer unnoticed.

## 10. Implementation boundaries

Expected touched areas:

- `browserAutomation.ts` and focused new geometry/hit-test/observation/pointer helpers.
- `browserToolProtocol.ts`, `browserErrors.ts`, `browserApproval.ts` and their tests.
- `tabBrowserHost.ts`, `tabBrowserService.ts`, broker binary-result metadata and lifecycle invalidation wiring.
- Shared browser status/events and `BrowserRail.tsx` only for pointer/activity presentation; React never executes page input.
- Generated Pi extension in `crates/amber/src/pi.rs` plus installer/ownership checks and the exact extension compile/load verifier. Preserve the newer Pi recovery/quota hooks merged after the original browser feature.
- No broad unrelated renderer, daemon or packaging refactor.

Old semantic tool calls remain valid. New tool/optional-result fields are additive; bump the generated extension ownership version as required by its existing installer contract. Unknown operations still fail closed on an older host. Document that already-running Pi sessions need the refreshed extension after installation; do not mutate production/global packages during tests.

## 11. Acceptance evidence

Each milestone uses red-before-green unit tests and real private Electron fixtures where protocol behavior is involved:

1. Reproduce native textarea/input false occlusion; type a literal potatoes query and submit it through actual events. Contrast with a genuine covering overlay that remains rejected.
2. Nested child, transformed/partially exposed control, author shadow root, disabled/read-only field, offscreen target/nested scroll, and supported iframe paths; unsupported frames fail explicitly.
3. Quad math and PNG-to-CSS conversion at fractional/high DPI, resized rail, emulated viewport, document/visual scroll offsets; stale screenshots and out-of-range coordinates never dispatch.
4. Visual custom/canvas click, hover-triggered menu, nested wheel receiver, intermediate-point drag and right click. Assert actual page outcomes, not just sent event counts.
5. Exact coordinate/path approval binding, receiver changes while approval is open, opaque-region changes, rejection/revocation/expiry/controller swap, no approval bypass through focused keys.
6. Modifier and button release on every failure phase, including mid-drag cancellation and page navigation. Preserve uniform-generation and no-rollback regressions.
7. Cursor visibility, non-interception and removal; screenshots do not include stale markers. Physical cursor never moves as a result of automation.
8. Snapshot usefulness and bounds on large hostile fixtures; no secret values or raw markup in errors.
9. New generated extension compile/load tests against the proven Pi baseline, correct image metadata and exact failure fields; preserve recovery hooks.
10. Full app suite/typecheck/build; Rust tests and warnings-as-errors Clippy for changed Pi installer/generator; private packaged smoke. Then a user-visible Google typed-search test with approval. Production upgrade remains separately authorized; manual Mac/IME/native gestures must be labeled honestly when unavailable.

## 12. Direct quality-review additions and release scorecard

Quality is measured by task success and diagnosability, not the number of tools. The original adapter's fixture-only event assertions were insufficient evidence of general interaction capability. For this change:

- **Primary golden flow:** focus an ordinary native textarea, enter potatoes, submit using keyboard or the semantic Search button, and verify the resulting page state. A direct search URL, a programmatic DOM value assignment, or a `dispatched:true` reply cannot count as passing this flow.
- **Receiver truth:** assert which element receives events, not only which CDP command was sent. Cover nested descendants, UA-shadow controls, author shadow trees, supported frame boundaries and real overlays. State exactly which cross-origin/OOPIF paths work; never label an untested frame path universally supported.
- **Visual ground truth:** coordinate tests use pixels from the actual returned screenshot at DPR 1, fractional DPI and DPR 2, with document scrolling, rail resizing and zoom/emulation where supported. Do not accept a correct pure mapping test while the real browser clicks the wrong receiver.
- **Navigation race:** a click/focus handler navigating during a fill/drag must not redirect subsequent text into the next page, even when the WebContents incarnation is unchanged. Cover same-origin replacement as well as cross-origin navigation.
- **Native keyboard behavior:** demonstrate actual Enter submission, Tab focus traversal, selection replacement, modifier editing and non-ASCII text. Verify default browser behavior as well as JS handlers; merely observing a `keydown` with the right string is insufficient.
- **No hidden fallback:** every test records the actual strategy used. Semantic failure followed by a successful coordinate action is useful recovery, not evidence that semantic targeting was fixed.
- **Repeatability:** run the local critical-flow matrix 20 consecutive times with zero unexplained failures; report per-case results, CDP request counts and p50/p95 durations. Exclude human approval dwell time from execution latency, but record approval counts separately. Timeouts are failures, not silently retried green runs.
- **Usability:** preserve prompt-free benign semantic interactions and allow a move-and-click gesture under one approval. Measure the cost of conservative coordinate approvals; do not weaken the safety policy or add broad permanent grants just to improve benchmark numbers.
- **Read budget:** retain hard host/CDP memory and work limits while exposing useful late-page controls. Tests must distinguish emitted output bytes, scanned node/input budget and actual useful nodes returned.
- **Evidence honesty:** record Linux Xvfb versus physical Linux versus native macOS separately. Test tooling cannot certify hardware focus/IME or Mac behavior it did not exercise. No claim of complete Codex parity.

The scorecard belongs in the implementation report. A capability row needs evidence and an explicit supported/blocked/not-tested verdict. Any critical safety regression blocks integration, even if task-completion metrics improve.

## 13. Primary references consulted

- OpenAI in-app browser docs: https://developers.openai.com/codex/app/browser (currently renders Browser / ChatGPT Learn; documents shared browsing, confirmations and separately approved full-CDP developer access).
- OpenAI computer-use integration recipes: https://developers.openai.com/api/docs/guides/tools-computer-use-integration (structured pointer actions, held-modifier cleanup, screenshot loop and resized-coordinate remapping).
- Playwright actionability: https://playwright.dev/docs/actionability and https://playwright.dev/docs/input.
- CDP DOM: https://chromedevtools.github.io/devtools-protocol/tot/DOM/ (`getNodeForLocation`, native-shadow normalization and DOM identity).
- CDP Input: https://chromedevtools.github.io/devtools-protocol/tot/Input/.
- CDP Overlay: https://chromedevtools.github.io/devtools-protocol/tot/Overlay/ (`highlightQuad` is main-frame-viewport-relative).

These are public behavior references, not evidence that Amber uses Codex's private browser source.
