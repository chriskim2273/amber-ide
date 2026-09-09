# Amber Pocket mobile UX — stable rows, real identity

Status: approved 2026-09-09. Supersedes nothing; amends the row model of
`2026-08-29-amber-pocket-mobile-product-design.md` §command-center.

The phone lands on `/app` (`tailscale.rs` builds `https://<host>/app#t=<token>`),
so this is the React Pocket build, not the `crates/amber/assets/` front end.

## 1. The two problems

Measured on a live private daemon at 402×874 (iPhone 16 Pro), Chromium with
iPhone metrics.

**1.1 Half the screen is dead.** `.app` is a flex column. `main.pocket-command`
carries `flex: 1` and `.tab-browser-workarea` (`BrowserRail.css:1`, committed)
also carries `flex: 1`, so each takes exactly 437px of 874. The Pocket
hidden-stage rule hides `.pane-stage`:

```css
.app.mobile .pane-stage.pocket-stage-hidden { position: absolute; visibility: hidden; }
```

but the stage is nested inside the work-area wrapper, and hiding a child does
not stop its parent claiming flex space. Reproduced at clean `main`, so this is
a committed regression from the browser-rail work, not local WIP. Result: one
and a half session cards visible, 437px of black below the nav bar.

**1.2 Position encodes state, so rows move.** `commandCenterModel` buckets panes
into `needs-you` / `working` / `parked` / `quiet`. Order *within* a bucket is
already stable and deliberately excludes activity — `compareItems` sorts by the
daemon slot and its comment says why. The instability is the **bucket**: a shell
moves `working` → `quiet` the moment `unseenActivity` goes false, and back on
the next output. A row therefore jumps the length of the list for a reason the
user did not act on.

The same grouping causes the identity failure. Four group headers with counts
plus a bordered "Nothing needs you" card for a zero state consume the vertical
budget, so the row itself degrades to `Workspa… / Ta… / 237…` — three ellipsized
crumbs carrying no information. The user's report is that sessions "move around
a lot" and are "very hard to tell apart without going into them"; both are this
one defect.

Live OSC-2 titles cannot fix identity: a title exists only once a pane is
attached and rendering, and Pocket does not attach a session until it is opened.
That is precisely why a session must be opened to be recognised.

## 2. Scope

In: the mobile command-center list, its row, the chrome above it, and one
additive daemon field. Out: Focus/terminal behaviour, Mosaic, the soft-keyboard
docking (hardened 2026-08-29, untouched), desktop chrome beyond what the shared
row component forces, and the `crates/amber/assets/` front end.

## 3. Fix A — the pane stage must not claim flex space

The hidden-stage contract is "absolute + `visibility: hidden`, never
`display: none`" (Pane's unconditional initial `fit.fit()` would fit a 0×0 host
to xterm's 2×1 floor, and Mosaic's scale mode never re-fits). That contract has
to reach the *wrapper*, not just the stage.

When Sessions is the front surface, `.tab-browser-workarea` takes the same
absolute treatment its child already has. The stage keeps a real box; the flex
column keeps one in-flow child.

Test: with Sessions front, `.pocket-command` height equals the `.app` height, and
the stage still reports a non-zero box.

This lands and is verified before any layout judgement is made, because every
such judgement against a 437px viewport is a judgement about the wrong screen.

## 4. Fix B — `SessionInfo.branch`

Two panes in one repository are the case the user cannot resolve. Project,
kind and slot do not separate them; the git branch does.

Additive field, `#[serde(default, skip_serializing_if = "Option::is_none")]`,
exactly as `slot`, `cols` and `rows` were added. Older peers omit it and decode
`None`; the app's decoder ignores unknown fields already.

Resolution is a pure function in `amber-core`, no `git` subprocess:

- walk up from the session cwd for a `.git` entry;
- `.git` as a directory → `HEAD` inside it;
- `.git` as a file → `gitdir: <path>` (a linked worktree) → `HEAD` at that path;
- `ref: refs/heads/<name>` → `<name>`;
- 40 hex characters → detached, report the 7-character short sha;
- anything else, or no repository → `None`.

`session_infos()` runs on every control gesture and on the web poll's 1s tick,
so the read is stat-keyed through the existing `FileCache` discipline: one
`stat` per session per call once warm. It already clones the session map and
releases the sessions lock before doing file IO, so this adds no lock
contention.

A branch is display metadata. Nothing about session existence, naming or
supervision depends on it, and a failed read is `None`, never an error.

## 5. Fix C — one stable list

`commandCenterModel` keeps classifying. It stops deciding *position*.

- One list, sorted by daemon slot alone — daemon-owned and stable for the
  session's lifetime, and the same number `amber attach <n>` resolves.
- A row never changes position for any state change. State is rendered *on* the
  row as a badge.
- Group headers and the zero-state card are removed.

Urgency is not lost. `exited`, `retrying`, `shell-fallback` and
`suspend-failed` are the failures the supervisor work exists to surface, so they
get a pinned alert strip above the list that names the count and scrolls to the
first affected row. The strip is present only when such a session exists.

The model keeps returning groups for the desktop's "Needs you" affordance, which
already consumes them; the mobile list flattens them at render time and sorts by
slot. No desktop behaviour changes.

## 6. Fix D — the row

Two lines, ~76px, one 44px-minimum tap target:

```
#2  Pocket redesign                      ◆ pi working
    amber-ide · fix/pi-session-recovery · pi
```

- Leading `#<slot>` — stable, and the handle for `amber attach`.
- Primary line: friendly title, falling back to the cwd basename when untitled.
- Secondary line: project basename · **branch** · kind. Branch is omitted when
  the cwd is not a repository rather than rendering an empty separator.
- Trailing badge: the state label the model already produces, with a colour for
  its group. The badge changes in place; the row does not move.

Truncation is per-field with the branch protected, so the identifying half of
the line never collapses to `Ta…`.

## 7. Fix E — chrome

- Machine, connection dot and session count collapse to one row. The machine
  name currently renders as `127`, taking the first dot-separated label of
  `127.0.0.1`; it takes the first label of a *hostname* and the whole string
  when the origin is an IP literal.
- Workspace filter pills drop from 56px to 32px.
- Plan usage stops being an unlabelled floating line and joins the machine row.

Bottom navigation (Sessions / Mosaic / Desktop / New) is unchanged.

## 8. Testing

- Pure: the branch resolver (directory, linked worktree, detached, no repo,
  malformed HEAD); the flattened slot ordering; per-field truncation.
- Component: a state change re-renders a row's badge without changing its index;
  the alert strip appears only with an urgent session.
- Rust: `session_infos()` reports a branch for a repo cwd and `None` otherwise.
- Live, Chromium at 402×874 / DPR 3 / touch, against a private daemon: full-height
  layout, rows distinguishable without opening, no row movement across a state
  flip, 44px targets.

Real Safari is not covered. Playwright's WebKit needs `libevent-2.1-7t64` and
`libavif16`, which are not installed, so safe-area insets and soft-keyboard
behaviour on the actual iPhone engine remain unproven and must not be claimed.

## 9. Deliberate cuts

- No live output preview on a row: it would require attaching every session.
- No activity-based ordering: it is the behaviour being removed.
- No new browser control message; `amber web` gains no privileged operation.
