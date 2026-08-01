# Fix — web pane geometry mismatch (garbled panes)

**Status:** done.

**Commit:** `07f668f` — fix(web): follow the pty's real grid instead of fitting to the browser box

**Root cause (given, confirmed, not re-investigated):** in the web build,
`Pane.tsx`'s `FitAddon` resized the local xterm grid to fit the browser's box,
then tried to push that as the pty's size — `app/src/web/amber.ts`'s
`PaneLink` correctly drops that resize (a pty's winsize is shared with the
desktop app's panes). Net effect: the local grid followed the container box
while the pty kept its own size, so pty-wrapped output rendered into a
mismatched grid — worst in narrow panes.

**Fix:** copied the mobile client's `syncGeom`/`applyScale` pattern
(`crates/amber/assets/app.js`): the pane's local grid now follows the pty's
real `cols`/`rows`, and a CSS transform scales the rendered box to fit —
never the other way around.

## What changed and why

- `app/src/web/amber.ts` — `PaneLink` (one pane's dedicated `/ws` connection)
  now also reads its OWN session's live `cols`/`rows` out of every `sessions`
  push (the server sends one immediately on connect, and again whenever the
  desktop app resizes that pty) and posts `{geom:{cols,rows}}` down the
  pane's `MessagePort`. This is never `dispatch()`ed — `main.tsx` never sees
  it — so it can't create the "N duplicate copies" problem the file's own
  header warns about for broadcast-class messages. Added `findSessionGeom`
  (pure helper) and 5 new tests covering: geom posted for the right session,
  deduped when unchanged, reposted when the desktop app resizes the pty,
  never posted for a dead (0×0) or absent session, and that a geom-carrying
  push never itself causes anything to be sent back to the socket.
  Electron's client (`app/src/client/router.ts`) never sends this — untouched.

- `app/src/renderer/Pane.tsx` (the only renderer file touched, as expected):
  - New `serverGeomRef`: null forever in Electron (nothing ever posts a
    `geom` message there); once non-null in the web build, it gates every
    place that used to call `FitAddon.fit()` + post a resize (the
    `ResizeObserver` callback, the reconnect nudge, the font-size effect, the
    tab-reactivate effect, and the initial port-wire) to instead call
    `term.resize(ptyCols, ptyRows)` + a CSS rescale. Electron's code paths in
    all of these are byte-identical to before.
  - New `sizerRef`/`stageRef` wrapping `hostRef` (container → sizer → stage →
    host). Both stay `100%/100%` identity (no transform) until geometry
    arrives, so Electron's `FitAddon.fit()` measures exactly what it always
    measured. Once geometry arrives, `stage` is sized to the terminal's real
    (unscaled) `.xterm-screen` box and transform-scaled (never magnified past
    1×, mirroring the fix in commit `32e863e`) to fit the container on both
    axes; `sizer` is sized to the resulting SCALED box and centred via
    `margin: auto` in the (now `display:flex`) container.
  - The `ResizeObserver` now observes the outer container instead of `host`:
    once geometry mode is active, `host`'s own size tracks the pty's fixed
    grid, not the container, so it would stop firing on a divider drag right
    when the rescale needs it.
  - Verified against the real xterm.js source (not guessed): `.xterm-screen`
    gets an inline pixel size set by xterm itself
    (`screenElement.style.width/height`) based on `cols/rows × measured cell
    size`, independent of any ancestor CSS — so measuring it after
    `term.resize()` gives the true natural box to scale, exactly like the
    mobile client's `applyScale`.

- **No protocol/Rust change.** `SessionInfo.cols/rows` already existed on the
  wire (2026-07-19 phone work); this just reads it on a connection that
  previously ignored it. `PaneLink`'s port handler still only ever forwards
  keystroke bytes to the socket (constraint 1) — a new test asserts a
  geom-carrying `sessions` push causes zero outbound socket sends.

## Gate

- `cd app && npm run typecheck` — clean.
- `npm test` — 451 passed, 1 pre-existing skip (`test/realDaemon.test.ts`,
  unrelated), including 5 new `PaneLink` geometry tests.
- `cargo test --workspace` — 184+ Rust tests green (unchanged — no Rust
  files touched).
- `cargo clippy --workspace --all-targets -- -D warnings` — clean.
- `npm run build:web` — builds clean.

## Live verification

Isolated private daemon + `amber web` at `/tmp/geomfix` (never the user's
real daemon on 7717), two 80×24 shell sessions, a hand-written
`ui-layout.json` sidecar splitting them 70/30 (`dir:"h"`) so the two panes
get deliberately different widths. Verified with Playwright at a 1400×900
viewport.

**Before/after measurement** (same live setup, same split, only the code
under test swapped via `git stash`/`stash pop` + rebuild — not a different
run):

| | pty | pane 1 (wide, ~626px natural/scaled box) | pane 2 (narrow) |
|---|---|---|---|
| **before** cols×rows | 80×24 | 123×44 | 51×44 |
| **after** cols×rows | 80×24 | 80×24 | 80×24 |

Before: neither pane matched the pty, and the two panes disagreed with each
other (confirms the reported bug). After: both panes exactly match the pty's
real grid regardless of their very different container widths — `/api/sessions`
also reported `cols:80,rows:24` for both throughout (the pty itself was never
touched, confirming constraint 1).

Additional checks, all passing:
- `ls -la /usr/bin | head -40` in the wide pane: columns aligned, and a
  filename overflowing 80 columns (`apt-add-repository -> add-apt-repository`)
  correctly soft-wrapped onto its own line at the real 80-col boundary — no
  torn/overlapping text.
- Typed a distinct command (`echo PANE2_MARKER_$((1+1))`) into pane 2: the
  output (`PANE2_MARKER_2`) appeared only in pane 2, pane 1's untouched
  `ls -la` output stayed put — keystrokes route to the correct pty.
- **Backlog-vs-geometry race, on a real reload (not just a fresh pane):** ran
  `ls -la /usr/bin | head -40` in BOTH panes, then reloaded the whole page
  (`about:blank` then back), forcing every pane through a fresh mount →
  `Attach` → backlog replay. Immediately after the reload, both panes showed
  the clean 80-col-wrapped backlog with no garbling, and `.xterm-screen`
  measured `cols:80,rows:24` in both. Geometry wins the race as reasoned (the
  `sessions_msg` is queued at connection-accept, before the client's `{t:'open'}`
  even reaches the server to trigger the `Attach` that produces the backlog),
  and this reload test is the one that would have caught it if it hadn't.
- Cleaned up: killed the private daemon + `amber web`, removed
  `/tmp/geomfix`. The user's real daemon (`amber daemon`, `amber web --port
  7717`, and its supervised claude sessions) was never touched.

## Concerns

- **Mouse-click cell precision inside a scaled pane is measurably off — not
  just a theoretical risk.** Root cause, verified against the actual
  `@xterm/xterm` source: `MouseService.getCoords` divides a click's
  `getBoundingClientRect()`-relative offset (which DOES reflect our CSS
  `transform: scale()`, i.e. screen space) by `CharSizeService`'s measured
  cell width (which uses `offsetWidth`, i.e. layout space, unaffected by the
  transform). At `scale ≠ 1` these disagree by exactly the scale factor.
  Measured live in the 0.668-scaled narrow pane (`getBoundingClientRect`
  418px / natural `offsetWidth` 626px): dispatching a real double-click at
  the visual screen position of column 70 (the tail of
  `apt-extracttemplates`, row `-rwxr-xr-x  1 root root        23008 Oct 22  2024 apt-extracttemplates`)
  selected **`2024`** — the word actually sitting at columns 45–48 — matching
  the predicted `column × scale` (70 × 0.668 ≈ 47) almost exactly. So a
  drag-select or a mouse-tracking TUI (e.g. `htop`) inside a scaled web pane
  will visibly misfire, proportionally worse the more a pane is shrunk. This
  is the same tradeoff the mobile client already accepted (it avoids the
  problem by not using xterm's native mouse handling at all — custom
  touch-scroll and an on-screen key bar instead). The task's own checklist —
  "clickable and focusable", "keystroke reaches the right pty" — is
  unaffected (focus/routing isn't coordinate-based) and was verified live
  above; I did not build coordinate-correction machinery for this, since it
  wasn't in the verification checklist and would mean deviating from "copy
  the mobile pattern" for a desktop-only interaction gap. Named upgrade path,
  **not attempted here**: switch the scale mechanism from CSS `transform` to
  the CSS `zoom` property, which scales layout too so `offsetWidth` and
  `getBoundingClientRect` move together and the mismatch disappears —
  untested here because compatibility of `zoom`-driven `offsetWidth` across
  engines needs its own verification pass, not a guess.
- The web bundle's `main-*.js` chunk is >500 KB (pre-existing vite warning,
  unrelated to this change).

## Follow-up (2026-08-01) — tried the named upgrade path (`zoom`), it does not fix Concern 1

**Status: code changed, mouse bug NOT fixed. Stopping here to report per explicit
instruction, rather than reverting or picking a third option.**

**What changed:** `app/src/renderer/Pane.tsx`'s `rescale()` now sets
`stage.style.zoom = String(scale)` instead of `stage.style.transform =
'scale(...)'`, and the `transform-origin: 0 0` that existed only to anchor the
transform's origin was removed from the JSX. `sizer`'s manual `w*scale`/`h*scale`
sizing was kept unchanged (still needed — see below). This is the only file
touched, matching the original fix's footprint. Gates all still green:
`npm run typecheck`, `npm test` (451 passed / 1 pre-existing skip, unchanged),
`cargo test --workspace` (313 passed — Rust untouched by either pass),
`cargo clippy --workspace --all-targets -- -D warnings` (clean), `npm run
build:web` (clean, same pre-existing >500 KB chunk warning).

**Why `zoom` was expected to fix it:** `MouseService.getCoords` divides a
click's `getBoundingClientRect()`-relative offset by `CharSizeService`'s
measured cell width, which reads `offsetWidth`. With `transform`, the click
offset is in screen space (transform-affected) and the cell width is in layout
space (transform-*un*affected) — they disagree by the scale factor. `zoom` was
supposed to make both layout-affecting, so they'd agree.

**What live testing actually found, verified against real Chromium (Playwright's
bundled browser), not assumed:** `zoom` does NOT make a descendant's own
`offsetWidth` reflect its ancestor's zoom, and — more surprising — it does not
even make the *zoomed element's own* `offsetWidth` reflect its *own* zoom.
Measured directly on the narrow pane's `stage` div (the element with
`style="zoom: 0.667732"` set on it directly, not a descendant):
  - `stage.offsetWidth` → **626** (the authored, un-zoomed value)
  - `stage.getBoundingClientRect().width` → **418** (626 × 0.667732, the
    on-screen/viewport value)
So the exact same class of unit mismatch that `transform` produced (a
screen-space number divided by a layout-space number) exists just as much
under `zoom` in this Chromium — `offsetWidth`/`clientWidth` stay in the
element's own un-zoomed CSS-pixel terms; only `getBoundingClientRect` (and
mouse event `clientX`/`clientY`) reflect the zoomed/on-screen size. (This
matches why the DOM has a dedicated `Element.currentCSSZoom` accessor for
code that wants to compensate — its existence is itself evidence that
`offsetWidth` does not self-correct for zoom. xterm's shipped `CharSizeService`
does not know about `currentCSSZoom` and was not going to be patched here.)

**Reproduced the exact same failure, both before and after, on identical
live conditions** (same private daemon, same 70/30 sidecar split, same
`ls -la /usr/bin | head -40` backlog, same row 22
`-rwxr-xr-x  1 root root        23008 Oct 22  2024 apt-extracttemplates`,
same synthetic double-click methodology — a `MouseEvent('mousedown', {detail:
2, clientX, clientY})` dispatched at the visual screen position of column 70,
since xterm keys single/double/triple-click handling off `event.detail` on
`mousedown`, not off a native `dblclick`; verified by reading the resulting
`.xterm-selection` overlay div's `left`/`width` and mapping back through the
row's own text, rather than trusting a value from inside the closed-over
`Terminal` instance, which isn't reachable from outside React):

| | clicked column | selected columns | selected text |
|---|---|---|---|
| **before** (`transform`, re-measured fresh via `git stash`, same page/build/daemon) | 70 | 45–48 | `2024` |
| **after** (`zoom`, this pass) | 70 | 45–48 | `2024` |

Wide pane (scale ≈ 1, both versions): clicked column 70 → selected column 70
(startCol reported by the same script) — correct in both, confirming no
regression where it already worked, exactly as before.

Also re-confirmed on the final (`zoom`) build: both panes' `/api/sessions`
still report `cols:80,rows:24` (the pty untouched); a distinct marker typed
into the narrow pane (`echo ZOOM_MARKER_6`) appeared only in that pane's
terminal, not the wide one (keystroke routing intact).

**Left in place as instructed:** the `zoom` swap is kept in the tree (not
reverted to `transform`) — per the task's explicit instruction to stop and
report a concrete `zoom` rendering problem rather than reverting or picking a
third option myself. It is a legitimate, harmless simplification either way
(one CSS mechanism instead of two, `transform-origin` cruft removed) but it is
**not a fix for the mouse-click regression** — that regression is unresolved
and needs a decision from the user: patch xterm-side (e.g. feed
`currentCSSZoom` into `CharSizeService`, or hand-correct `MouseService`'s
computed column by dividing out the zoom before column math — both mean
carrying a patched xterm), accept the tradeoff as documented in Concern 1
above (same as the mobile client), or something else. Not attempted here
without direction, per the same instruction.

Cleaned up again: private daemon + `amber web --port 7799` under
`/tmp/gzfix` killed and removed; confirmed the user's real daemon
(`amber daemon`, `amber web --port 7717`, and all 14 running claude sessions)
untouched throughout.

### Additional check: does the `[fontSize]` effect's ordering make things worse?

A reviewer flagged a real question before accepting "harmless simplification
either way": `Pane.tsx`'s `[fontSize]` effect sets `term.options.fontSize =
fontSize` (which makes xterm re-measure its cell size) *before* the
`serverGeomRef.current` branch calls `rescale()` — so under `zoom`, that
re-measurement happens while the OLD zoom value is still live on `stage`,
unlike under `transform` where timing never mattered because `transform`
touched no measurement at all. Checked by grepping the shipped
`@xterm/xterm` bundle rather than assuming: the entire bundle has exactly one
`getBoundingClientRect().width` call, and it's in `AccessibilityManager`
(screen-reader row alignment), unrelated to mouse/cell math. The actual cell
width comes from `CharSizeService`/`_measure`, both of which read
`.offsetWidth` on a hidden measuring element. Since Concern 1 already
established `offsetWidth` never reflects the ambient `zoom` (not even for the
zoomed element's own box), that measurement is zoom-invariant by construction
— re-measuring with a stale zoom in effect can't corrupt it.

Verified live (respun the same private daemon + sidecar split, dispatched the
`font-bigger` chord as a synthetic `KeyboardEvent` while both panes were
scaled): both panes' `.xterm-screen` natural `offsetWidth` moved together
(626px → 674px) — no divergence, no corruption. The click-mapping mismatch
**persists as the exact same predictable formula** (`selected col = clicked
col × current effective scale`) rather than becoming inconsistent or
undefined: with the bigger font the container-vs-natural-size ratio changed
for BOTH panes (taller/wider cells no longer fit either box at 1×), so the
**wide pane — previously scale ≈ 1 and therefore unaffected — now also
mis-selects** (clicked col 70 → selected "2024" at col 45, scale ≈0.654,
70×0.654≈45.8) and the narrow pane's mismatch tracks its own new scale
(≈0.326 → col 70 → col 23, a whitespace run). So: the fontSize-ordering
question is answered — it introduces no new/worse failure mode — but it
surfaces a sharper framing of Concern 1: **"no regression where it already
worked" is conditional on the pane staying at scale 1**, and any split ratio
or font size that pushes a pane below 1× (in EITHER axis) puts it in the same
broken bucket, including panes that started out fine.

### Incidental bug noticed, not fixed (separate from this task)

Every mouse selection change in the web build throws in the console:
`window.amber.resolvePath: not available in the web build`, from
`Pane.tsx`'s `term.onSelectionChange` handler (used for the "Open in file
manager" floating button) — `app/src/web/install.ts` doesn't implement
`resolvePath` at all, only Electron's preload does. This is almost certainly
why the very first synthetic double-click after each fresh page load in this
session consistently produced an empty selection overlay and every
double-click after it worked fine: the uncaught exception aborts the
handler-chain synchronously, and xterm's own visual-selection update
apparently races/depends on that same chain not being interrupted the first
time (subsequent clicks stopped hitting whatever cold-start path triggers
it). Not touched here — out of scope for the mouse-precision regression —
but worth a ticket, since it means every plain click in the web build
currently logs an uncaught error.

### Keep vs. revert — open question for the user

The `zoom` swap is committed (`4359243`) and is a legitimate simplification on
its own terms (one scaling mechanism instead of two, no functional
regression demonstrated anywhere: geometry, keystroke routing, and the
fontSize path all check out). But it delivers **no actual fix** for the
mouse-click regression this task exists to close — Concern 1 is unresolved,
just as it was on `transform`. Options, not chosen here:
1. Keep `zoom` as committed (arguably still the better mechanism going
   forward, and matches "the named upgrade path"), and separately pursue a
   coordinate fix — e.g. divide the click offset by `Element.currentCSSZoom`
   before column math, which means carrying a small patch against xterm since
   `MouseService`/`CharSizeService` know nothing about zoom.
2. Revert `Pane.tsx` to the `transform`-based commit (`07f668f`) and keep only
   this report's findings — since `zoom` demonstrably doesn't solve the
   problem it was reached for, transform is no worse and is one less new
   mechanism in the codebase.
3. Sidestep scaling entirely: shrink `term.options.fontSize` until the
   natural 80×24 box fits the container (quantized steps, letterboxing the
   slack) so the effective scale is always 1 and xterm's own click math stays
   internally consistent by construction, at the cost of a non-full-bleed
   render in odd-sized panes.
Not picking one of these without direction, per the instruction to stop and
report a concrete `zoom` problem rather than silently choosing a third path.

## Follow-up (2026-08-01) — option 3 chosen: font-shrink, no scaling at all

**Status: done. The mouse bug is fixed.**

Both prior attempts scaled a terminal whose own measurements assume it is
unscaled (`transform` leaves `offsetWidth` in layout space while clicks land
in screen space; `zoom` turned out not to update `offsetWidth` either, in this
Chromium). This pass removes the scale factor from the equation instead of
trying to correct for it: render the pty's 80×24 grid at whatever font size
makes it fit — never scaled — so `MouseService`'s click math and
`CharSizeService`'s `offsetWidth` are reading the same untransformed layout
and agree by construction.

**What changed**, all in `app/src/renderer/Pane.tsx` (the only renderer file
touched, matching every prior pass's footprint):

- `rescale` (CSS transform/zoom) is gone. In its place, `fitFont`: resizes the
  local xterm buffer to the pty's real cols/rows (unchanged from before), then
  shrinks `term.options.fontSize` — never past the user's configured size
  (32e863e's never-magnify rule) — until the terminal's own natural
  `.xterm-screen` box fits the container on both axes. Cell size scales
  ~linearly with fontSize, but xterm rounds its own cell math
  (`Math.round`/`ceil`/`floor` in the DOM renderer's `_updateDimensions` —
  read from the real shipped bundle, not assumed) — so the approach is:
  measure at the user's configured size, compute the fit ratio, apply it,
  **re-measure once and correct** (never assume the linear estimate was
  exact), then apply the corrected size. Two measurements, one correction,
  matching the task's spec exactly — not an open-ended search.
- `MIN_FONT_SIZE = 8` is the shrink floor — chosen to mirror `main.tsx`'s
  existing `clampFont` floor (the smallest size a user can already configure
  via the font-size chord) rather than invent a new number. Below it a pane
  clips (the container already had `overflow:hidden`) rather than rendering
  illegible text; no new scroll/letterbox machinery was needed for this.
- Fractional font sizes are used as computed, never quantized (confirmed live
  below: 8.69525px).
- The `sizerRef`/`stageRef` wrapper divs are deleted — with no transform/zoom,
  they had no remaining purpose. `hostRef` sits directly in `containerRef`;
  `fitFont`'s final measurement sizes `host` to the terminal's fitted natural
  box (in the axis that fit exactly) and the container's
  `alignItems/justifyContent: center` (added; harmless for Electron, where
  `host` is always 100%/100%) letterboxes whichever axis had slack.
- Electron path: `serverGeomRef` stays null there forever (nothing ever posts
  a `geom` port message on that client), so every `fitFont`/`fitFontRef` call
  site is gated behind the same `if (serverGeomRef.current)` branch as
  before — FitAddon's `fit()` is untouched, byte-for-byte.
- The font-size-bump effect was reordered: it now checks `serverGeomRef`
  **first** and calls `fitFontRef.current()` unconditionally when set, before
  the Electron-only equality guard. In web mode `term.options.fontSize` holds
  the *shrunk-to-fit* value, not the user's configured one, so the old
  `term.options.fontSize === fontSize` guard would almost always have been
  false and set the raw target size directly — bypassing the fit and
  reintroducing exactly the "bigger font breaks a previously-fine pane"
  regression the last pass found. Confirmed fixed live below.

**`resolvePath` fix** (`app/src/web/amber.ts`): was `notImplemented('resolvePath')`
— a synchronous throw — called from `Pane.tsx`'s `onSelectionChange` on
**every** mouse selection in the web build (confirmed as a real, live,
reproducible error in this pass, not just theoretical). `main.tsx`'s declared
contract is `Promise<string | null>` and `Pane.tsx` already handles
`abs ? {...} : null`, so `null` is the documented "cannot resolve" result —
changed to `(): Promise<string | null> => Promise.resolve(null)` with a
comment marking path resolution as desktop-only. `amber.test.ts`'s stub-throws
list dropped `resolvePath`; a new test asserts it resolves to `null`.

### Gate

- `cd app && npm run typecheck` — clean.
- `npm test` — 452 passed, 1 pre-existing skip (net +1 over the prior pass:
  removed the `resolvePath`-throws case from the stub list, added a
  `resolvePath`-resolves-null test).
- `cargo test --workspace` — 313 passed (Rust untouched).
- `cargo clippy --workspace --all-targets -- -D warnings` — clean.
- `npm run build:web` — clean (same pre-existing >500 KB chunk warning).

### Live verification

Isolated private daemon (`/tmp/gfrun` runtime dir, `/tmp/gfstate` state dir,
short-path recipe from the `verify-isolated-dev-instance` memory) + `amber
web --port 7801` + two fresh `amber create` shell sessions
(`amber-1-1-1-wide`, `amber-1-1-2-narrow`) under a hand-written
`ui-layout.json` sidecar splitting them 70/30 (`dir:"h"`, same shape as every
prior pass) — never the user's real daemon/app (port 7717, 17 sessions
including the 14 claude ones, confirmed alive and untouched throughout via
`amber ls` after cleanup). Driven with the Playwright MCP browser at
1400×900, authenticated via the token URL fragment
(`/app#t=<token>` → `bootstrapAuth()` → cookie), same as `amber web`'s real
flow.

**Note:** the first navigation attempt reused a Chromium disk cache from an
earlier pass's identical `127.0.0.1:7799` origin and served a **stale**
bundle (old `install-*.js` hash, still throwing on `resolvePath`) despite a
fresh build on disk — switching to an unused port (7801) got a clean fetch.
Not a product bug, just a test-harness gotcha worth flagging for whoever runs
this recipe next.

**Mouse click precision — the core ask.** Ran `ls -la /usr/bin | head -40` in
both panes, then double-clicked (via `page.mouse.dblclick`, a real trusted
double-click, not a hand-rolled `detail:2` `MouseEvent` — that path turned out
inert here, xterm's selection-service listener sits on `.element` and a
synthetic dispatch never produced a selection div despite bubbling correctly;
not investigated further since Playwright's native dblclick is the more
faithful test anyway) at the row `-rwxr-xr-x  1 root root  23008 Oct 22  2024
apt-extracttemplates` (row 22, identical in both panes):

| pane | clicked col | selected cols | selected text |
|---|---|---|---|
| wide (scale-1, unshrunk) | 65 | 50–69 | `apt-extracttemplates` |
| narrow (shrunk to fit) | 65 | 50–69 | `apt-extracttemplates` |
| wide | 70 | 50–69 | `apt-extracttemplates` |
| narrow | 70 | 50–69 | `apt-extracttemplates` |

Both clicked columns (65 and 70) land inside the word's true span (50–69) in
**both** panes, identically — the word actually under the cursor, not a
distant one. (Column 70 sits exactly one past the word's last character in
this particular row — a double-click there landing on the adjacent word is
expected boundary behavior, not the bug: the old bug's signature was a
*consistent, large* offset proportional to `1/scale` — e.g. 70→47 — not a
same-word boundary case. This was cross-checked directly against the
`.xterm-selection` div's own `left`/`width` inline style, read relative to
`.xterm-screen`'s own coordinate space, not just the DOM overlay's screen
position.) One measurement gotcha hit and fixed: reading the selection
DOM immediately after `dblclick()` raced xterm's redraw (selection-render
looked stale, one boundary case flip observed); adding a 150 ms wait before
reading made every repeat consistent — a test-harness timing issue, not a
product bug.

**Font-size bump — the regression the last pass found.** Dispatched the
`font-bigger` chord (`Ctrl+Shift+=`, Linux binding) three times (font 13→16).
Wide pane's rendered font legitimately grew to 16px (`getComputedStyle`
confirmed) since it had room to spare; narrow pane's fitted font recomputed
independently, still bound by its container. Re-ran the same click test
(cols 65 and 70, both panes) **after** the bump: identical result — both
panes select `apt-extracttemplates` (cols 50–69) in both cases. No
regression, unlike the `zoom`/`transform` passes where a font bump pushed the
previously-fine wide pane into the same broken bucket.

**Geometry**: `/api/sessions` reported `cols:80,rows:24` for both sessions,
both before and after the font bump — the pty's real grid, never touched.

**Final font sizes**: wide pane **16px** (grown from the default 13 after
3 chord presses — legitimately at the user's configured size, no shrink
needed); narrow pane **8.69525px** (fractional, not quantized — shrunk to fit
its container; sits just above the `MIN_FONT_SIZE=8` floor at this split
ratio/viewport, without hitting it).

**Keystroke routing**: typed `echo NARROW_MARKER_$((3+3))` into the narrow
pane; `NARROW_MARKER_6` appeared only in that pane's terminal, not the wide
one.

**`resolvePath` console check**: zero `resolvePath` errors across every
selection/double-click performed in this session (previously: one per
selection change, unconditionally). The only console error throughout was an
unrelated `favicon.ico` 404.

Cleaned up: killed the private daemon + both `amber web` instances (7799 —
the stale-cache one — and 7801), removed `/tmp/gfrun`, `/tmp/gfstate`,
`/tmp/geomfix2`. Confirmed via `amber ls` against the real daemon afterward:
17 sessions, all alive, untouched throughout.

### Review catch: resize was gated behind the container-size bail

A pre-commit review caught a real ordering bug the two-visible-panes live test
above could not have exercised: `fitFont` originally bailed on
`!cw || !ch` (empty container — e.g. a `display:none` background tab, per
this codebase's own tab keep-alive design) **before** the `term.resize()`
call. A backgrounded pane's `PaneLink` keeps its WebSocket open and keeps
receiving `geom` pushes (the mount effect never re-runs while merely hidden),
so a divider drag on the desktop app while a web tab was in the background
would resize the pty but leave the hidden pane's local buffer at the OLD
cols/rows — output would keep streaming in wrapped at the new width into a
buffer sized for the old one. That is the exact garbling class this whole
task exists to close, reintroduced by refactor ordering. Fixed by hoisting
the `term.resize()` call above the zero-size bail — the grid follows the pty
unconditionally; only the font-fit math needs a laid-out container.

**Live-verified with a THIRD isolated instance** (`/tmp/gfrun2`/`/tmp/gfstate2`,
`amber web --port 7802`), specifically targeting this case: a two-tab sidecar
(tab 1: the wide/narrow split; tab 2: a solo pane), switched to tab 2 in the
browser (confirmed via `getComputedStyle(...).display === 'none'` up the
wide/narrow panes' ancestor chain), then resized `amber-1-1-1-wide`'s pty to
120×40 **while backgrounded** — driven from a real controlling pty
(`pty.fork()` + `TIOCSWINSZ` ioctl on the master, which delivers a real
kernel `SIGWINCH` to `amber attach`'s foreground process group, which forwards
a `Resize` control message; confirmed via `stty size` inside that same attach
session). While still on tab 2, the hidden wide pane's `.xterm-rows` already
had **40 row divs** (narrow/solo stayed at 24) — proof the buffer followed the
pty immediately, without waiting for the tab to become visible. Switching back
to tab 1 rendered cleanly at 120×40 with no garbling (`stty size` output
`40 120` displayed correctly), `.xterm-screen` measured 939×720px (matches
626×432 natural-at-font-13 scaled by 120/80, 40/24 exactly — still fits the
978×792 container without needing to shrink the font, confirming the
non-regression case too). Cleaned up the same way as the other passes;
real daemon confirmed alive and untouched (`amber ls`, 17+ sessions) both
before and after.

### Concerns / residual

- **Per-resize cost.** `fitFont` does up to 3 `term.options.fontSize` writes
  and 3 forced `.xterm-screen` layout reads per call, and each fontSize write
  runs xterm's full `CharSizeService.measure → handleCharSizeChanged →
  _updateDimensions` path (restyles every row element, clears the width
  cache). It runs from the `ResizeObserver`, i.e. potentially once per frame
  per pane during a live divider drag — where the old `rescale` was a single
  style write untouched by any of that. Not measured under a live drag in
  this pass (the isolated-daemon setup has no desktop-app divider to drag);
  if it's ever felt as jank, the cheap fix is caching the natural
  (unshrunk) box per `(cols, rows, userMax)` so a pure container resize with
  the same pty grid and font ceiling skips straight to the ratio, without
  round-tripping through the userMax reset. Not built pre-emptively — no
  evidence yet that it's needed.
- The font-fit floor (`MIN_FONT_SIZE=8`) means a pane squeezed narrower than
  ~80 cols at 8px (a genuinely tiny split) will clip rather than shrink
  further. Not exercised live in this pass (the 70/30 split at 1400px never
  got that narrow) — the container's pre-existing `overflow:hidden` plus the
  `safe center` alignment (added specifically so a below-floor pane clips
  symmetrically instead of a plain `center` overflowing asymmetrically and
  eating column 0 off the left edge) is what makes this safe, not new
  fit-logic.
- `sizerRef`/`stageRef` are gone entirely; anyone looking for the old
  transform/zoom scaling code won't find it — this is intentional per the
  task ("do not leave two mechanisms"), noted here so it isn't mistaken for
  an incomplete diff.
- Did not re-verify the `.amberws` staged-replay interaction or the
  reconnect/backlog-race path from the original pass — out of scope for this
  font-fit swap (no code on those paths changed; `fitFont` is called from the
  same call sites `rescale` was).
