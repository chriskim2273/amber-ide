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
