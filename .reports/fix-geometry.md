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
