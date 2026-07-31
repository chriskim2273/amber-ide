# Remote mosaic — the workspace over `amber web`

**Date:** 2026-07-31
**Status:** designed, not implemented.
**Depends on:** `2026-07-19-amber-web-mobile-design.md` (shipped) — this spec
extends that server and inherits every one of its security decisions unchanged
except the control whitelist (§6).

Read `CLAUDE.md` first. This spec obeys it.

## 0. The problem, and the reframe

The ask: *SSH into a machine running an amber daemon and pick up the whole
workspace — every pane, tab, workspace, split, freeze state — on a laptop over
tailscale.*

Reframed: **remote access already shipped.** `amber web` is a daemon client on
the host, fronted by `tailscale serve`, and it reaches every live session on
that box today. What it lacks is the *mosaic*: it renders a flat session list →
one full-screen xterm. There is no workspace, no tab, no split tree.

And the layout is already on the host. `<state-root>/ui-layout.json` holds
geometry, `label`, `tabOrder`, `fontSize`, the `frozen` map, `browsers` and
`editors`. `web.rs` runs on that machine and already resolves `<root>` (for
`web-token`). So the layout is a **local file read** — no transport, no
protocol change, no cross-machine sync problem, and no SSH required at all.

The feature is therefore: *teach the existing remote client the split tree.*

### 0.1 Rejected: a TUI multiplexer

The request's most literal reading is tmux-style: one SSH terminal, panes
composited into a single grid. **Rejected, knowingly.** Compositing N ptys into
one terminal grid means interpreting and re-emitting escape sequences — a
**second terminal emulator**. That is the exact liability core rule #4 exists to
forbid and the specific reason tmux was deleted from this project on 2026-07-13.

### 0.2 Rejected: `ssh -L` + the Electron app on the laptop

Legitimate and architecturally cheap on paper (rule #1 already makes the app a
disposable client, and `ssh -L` forwards unix sockets). Rejected for v1 because
it needs an `AMBER_SOCKET` override in `socketPath.ts`, suppression of
`daemonBoot`/`installBinary` self-heal in remote mode, sidecar transport plus
per-daemon namespacing so it does not collide with the laptop's own
`ui-layout.json`, an amber install on the laptop — and it forces the winsize
problem (§5) into smallest-client-wins territory. Kept on the shelf as a
possible follow-up; nothing in this spec blocks it.

## 1. Settled decisions (user, 2026-07-31)

| Question | Decision |
|---|---|
| Client | **Extend `amber web`.** Laptop needs only a browser over tailscale. |
| Mosaic UX | **Mosaic + tap-to-zoom.** Scaled split geometry by default; tap a pane → full-screen at true grid size. |
| Write scope | **Full parity** — Create / Kill / Rename / Suspend / Resume from the browser. |
| App-local panes | **Skipped entirely.** Browser and editor leaves are pruned; the parent split collapses. |
| Tile content | **Metadata only, no terminal bytes** (§4.1 — recommended and accepted). |
| Resize | **Never sent.** Unchanged from the shipped web client. |
| Sidecar writes | **None, ever, from the web client.** |

## 2. Architecture

**No new route.** `crates/amber/src/web.rs`'s existing `GET /api/sessions`
response grows a `layout` field carrying render-ready workspace/tab/split JSON:

```
GET /api/sessions  →  { sessions: [...], layout: {...} }
```

One endpoint, one auth boundary, one poll, one code path for both the initial
paint and every refresh. Nothing new to authorise.

The unauthenticated surface is unchanged: `/` and the static assets still serve
without a cookie (a fragment token is only readable by JS on the served page, so
the page must bootstrap first — spec §8 deviation of the mobile design). The
boundary stays `/api/*` + `/ws`.

### 2.1 The sidecar is parsed in Rust, not shipped to JS

`<root>/ui-layout.json` is read server-side per request, parsed with serde, and
emitted **already pruned and collapsed**. The browser receives a tree it can
draw directly.

The alternative — serve the file verbatim and let the front end interpret it —
is fewer lines but untestable: the web front end is hand-written HTML/CSS/JS
embedded with `include_bytes!`, with no bundler and no test runner. The
prune-and-collapse walk is the only non-trivial logic in this feature, so it
belongs where `cargo test` can reach it. This also matches the repo's standing
test discipline (daemon logic tested; renderer/front-end components deferred).

Format drift with `layoutFile.ts` is the accepted cost. It is bounded: every
field of `LayoutFile` has only ever been *added*, all additions are optional,
and serde is configured to ignore unknown fields. A field this spec does not
read cannot break it.

### 2.2 Rust types

Mirrors `app/src/shared/layoutFile.ts` and `app/src/renderer/layout.ts`:

```rust
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Node {
    Leaf { #[serde(rename = "paneId")] pane_id: String },
    Split { dir: String, ratio: f32, a: Box<Node>, b: Box<Node> },
}

#[derive(Deserialize, Default)]
struct TabLayout { tree: Option<Node>, #[serde(default)] label: Option<String> }

#[derive(Deserialize, Default)]
struct WsLayout {
    #[serde(rename = "activeTab")] active_tab: u32,
    tabs: HashMap<String, TabLayout>,
    #[serde(default)] label: Option<String>,
    #[serde(default, rename = "tabOrder")] tab_order: Option<Vec<u32>>,
}

#[derive(Deserialize, Default)]
struct FrozenEntry { #[serde(default)] note: Option<String> }

#[derive(Deserialize, Default)]
struct LayoutFile {
    #[serde(default)] version: u32,
    #[serde(default, rename = "activeWorkspace")] active_workspace: u32,
    #[serde(default)] workspaces: HashMap<String, WsLayout>,
    #[serde(default)] frozen: HashMap<String, FrozenEntry>,
}
```

`Node` is an **internally tagged** enum — the sidecar writes
`{"kind":"leaf","paneId":"…"}`, tag alongside payload — so `tag = "kind"` plus
`rename_all = "lowercase"` (serde defaults variant names to `Leaf`/`Split`) plus
the explicit `paneId` rename are all load-bearing. Internally tagged enums
deserialize through a buffering `ContentDeserializer`; the recursion through
`Box<Node>` is the part to prove rather than assume, so **the first test written
is a round-trip of a real `~/.local/state/amber-ide/ui-layout.json`** — before
any prune logic exists.

`browsers`, `editors`, `fontSize` and `recentFiles` are deliberately **not**
deserialized. `recentFiles` in particular is a list of arbitrary host file paths
and there is no reason to move it across the boundary.

A missing, unreadable, or malformed sidecar is **not an error**: it degrades to
`LayoutFile::default()`, which produces the equal-splits fallback the desktop
app already uses. This is core rule #3 — grouping must be reconstructable from
session names alone.

### 2.3 Prune and collapse

Port `removeLeaf` from `app/src/renderer/layout.ts` (lines 18–25) — the
identical semantics: a removed leaf's parent is replaced by its surviving
sibling.

For each tab, walk the tree and drop every leaf whose `paneId` is not the name
of a session the daemon currently lists. That single rule covers all three
cases at once:

- **browser/editor panes** — `browser-*` / `editor-*` ids that are never daemon
  sessions;
- **stale leaves** — a session killed while the sidecar was not rewritten;
- **panes belonging to a workspace/tab the sidecar records but the daemon has
  since emptied.**

A tab that prunes to empty is omitted from the response. A workspace whose tabs
all prune away is omitted too.

**Accepted tradeoff:** when app-local panes exist on the desktop, the mosaic
geometry diverges from what is on the desktop screen — the sibling of a pruned
editor takes its space. Explicitly chosen over rendering a dead placeholder
tile.

### 2.4 Sessions not in the sidecar

A daemon session whose name parses as a pane (`amber-<ws>-<tab>-<ord>-<id>`) but
which appears in no tab tree — a reboot-restored session, an adopted CLI
session, or one this spec's own `Create` just made — is appended to its
name-encoded tab as an extra leaf, split evenly. Same reconciliation the desktop
app performs, and it is what makes a pane created from the browser (§6) appear
immediately without any sidecar write.

A session whose name does **not** parse as a pane — a bare `amber` CLI session
`s2`, or anything else outside the grammar — belongs to no workspace and is
**not shown**. Adopting those is the desktop 🧹 Sessions dialog's job and is a
separate surface (its own list, its own empty state); see §9.

## 3. Data flow

The layout rides the **existing `/api/sessions` poll**, which already runs at
1 s. One payload, one timer, no new polling loop.

The shipped design polls rather than making the daemon broadcast, and that
reasoning holds here verbatim: a divider drag would flood the bounded watcher
queue and risk evicting the desktop app. Nothing in this feature adds a
broadcast.

The sidecar is a few KB; it is re-read per tick and re-serialised unconditionally.
No mtime caching, no ETag — measure before adding either.

The initial paint is the front end firing that same request once immediately
rather than waiting for the first tick — not a second route.

## 4. Views

### 4.1 Mosaic (default)

Workspace pills → tab bar (ordered by `tabOrder`, labelled by `label`) → the
split tree rendered as nested flexbox at the sidecar's real `ratio` values.

Each leaf is a **tile**, carrying:

- `#slot` (`SessionInfo.slot` — the same number `amber attach <n>` resolves),
- the live OSC title, falling back to `cwd`,
- kind (shell / claude / grok),
- a state dot: `run_state` for agents (claude / retrying / shell-fallback /
  suspended), `frozen` for shells.

**Tiles carry no terminal bytes.** Every `Attach` triggers a full backlog replay
of up to 2 MiB as one frame; a four-pane tab would push ~8 MiB down a phone link
on each tab switch, and there is no "attach without backlog" flag in the
protocol today (adding one would be an additive `Attach { backlog: bool }` proto
change). Metadata tiles cost zero bytes and are legible at tile size, which a
CSS-scaled 200×50 grid is not.

### 4.2 Zoomed pane (tap)

Tap a tile → `Attach` → full backlog → the pane renders at the session's **real**
`cols`/`rows` (already on `SessionInfo`), CSS-scaled to fit the viewport width
with pan for overflow. Existing key bar (Esc/Tab/sticky Ctrl/arrows honouring
`applicationCursorKeysMode`), existing touch scrolling with its alt-screen
arrow-key substitution — all unchanged.

Back gesture → `Detach` → return to the mosaic.

Exactly one pane is attached at a time. This keeps the subscriber count, and
therefore the daemon's backpressure profile, identical to what the shipped web
client already produces.

## 5. Winsize — why nothing resizes

One pty has one shared winsize. This is already a recorded, accepted tradeoff
(the `amber attach` status row shrinks the child for every client). A remote
full-layout client makes it far worse: a laptop at 1440×900 against a desktop at
4K means the last writer reflows the other, which corrupts a live claude TUI.

The shipped web client already chose the answer: **never send `Resize`; scale and
pan in CSS.** That decision is inherited unchanged and is what lets the laptop
and the desktop app be attached simultaneously without fighting.

`Resize` is not on the whitelist, is not constructible from any browser message,
and the front end ships no fit addon.

The honest alternative, if two full clients ever need to coexist with correct
per-client sizing, is tmux's smallest-client-wins: the daemon tracks a size per
subscriber and sizes the pty to the minimum. That is a real daemon feature with
a visible cost (the desktop shrinks when the laptop attaches) and needs its own
two-client live test. **Out of scope here.**

## 6. Full parity — and why it needs no sidecar write

Grouping is name-encoded (core rule #2) and geometry falls back to equal splits
when the sidecar lacks a leaf. Every parity gesture therefore routes through the
daemon and lets the desktop app's own reconcile update the tree:

| Gesture | Control message | How the desktop tree updates |
|---|---|---|
| new pane | `Create { name, cwd, kind }` | name encodes the target ws/tab → `SessionsChanged` → `groupSessions` → reconcile appends the leaf |
| close pane | `Kill { name }` | kill/reap broadcast prunes the leaf |
| move pane | `Rename { from, to }` | the proven cross-tab-move path (`2026-07-18-cross-tab-move-design.md`) |
| unfreeze an agent | `Resume { name }` | supervisor relaunches `--resume <recorded-id>` — the same conversation |
| freeze an agent | `Suspend { name }` | supervisor kills the child, `run_state: "suspended"`, RAM freed |

**The layout file keeps exactly one writer: the desktop app.** The web client
never writes it. That preserves the sidecar's implicit single-writer assumption
(atomic write, no generation counter) with no locking, no merge, and no new
failure mode.

### 6.1 Consequence: shell display-freeze is read-only

A shell pane's freeze lives only in the sidecar `frozen` map — it is a display
freeze, purely cosmetic, and toggling it would be a sidecar write. The mosaic
**shows** it and cannot change it.

Agent freeze/unfreeze is `Suspend`/`Resume`, daemon-side, and works fully. This
is the one that matters: it is the gesture that frees ~GB of RAM and the one you
actually want from the road.

### 6.2 Name minting

The web client mints session names itself. Port `parseName`/`formatName`/
`retargetPane`/`makeId` from `app/src/shared/names.ts` into the web JS (32 lines,
no dependencies) — the front end is hand-written already.

`ord` is chosen as the lowest free ord within the target ws/tab, computed from
the live session list the client already polls. Two clients can race to the same
ord; the daemon's `SessionManager::create` already rejects a `Create` on a live
name under the sessions lock (closed 2026-07-23), so exactly one wins.

### 6.2.1 No error channel — the poll is the truth

The shipped browser protocol has no server→browser error path (`open`/`close`
plus raw binary), and this spec does not add one. Every parity gesture is
**fire-and-forget**; the 1 s `/api/sessions` poll is the sole confirmation.

This is core rule #3 applied literally: the client never optimistically creates,
destroys or renames anything locally, so there is nothing to roll back when a
gesture fails. A `Create` that loses a race, a `Kill` on an already-reaped
session, a `Rename` the daemon refuses — all look identical to the front end:
the tree simply does not change.

The front end shows a **pending tile** in the target slot on `Create` and clears
it after 3 poll ticks if the session has not appeared. That is the entire error
UX, and it costs no protocol surface. If failures turn out to be common enough
to need a reason, an error channel is a later, separate decision.

### 6.3 cwd

`Create` takes a cwd from the client. The web client sends:

- **pane menu → new pane / split**: the cwd of the pane the gesture came from,
- **tab-level `+`**: `$HOME`.

No path picker. A folder chooser is a whole native-dialog surface with no
equivalent in a browser, and typing a path on a phone is unpleasant. If it turns
out to matter, a text field is a later, separate decision.

## 7. Security

The token, cookie, throttle and reach are **unchanged**: 32 random bytes in
`<state>/web-token` (0600), carried in the URL fragment, POSTed for an
`HttpOnly; SameSite=Strict` cookie, constant-time compared, failed attempts
throttled to 429, `127.0.0.1` bind in exactly one place, `tailscale serve` for
TLS and tailnet-only reach.

### 7.1 Pricing the parity widening honestly

The web token **already grants arbitrary command execution**: `Input` into any
existing shell pane runs whatever you type. Full parity does not widen that.
What it adds is:

- **destruction** — `Kill` can close a pane (the daemon's own kill path; the
  session's scrollback is lost the same way it is from the desktop app),
- **mutation** — `Rename` can move a pane between tabs/workspaces,
- **process spawning in a chosen cwd** — `Create` takes no argv; `kind` is one
  of `shell` / `claude` / `grok` and nothing else.

So the threat model does not change category. Anyone holding that token could
already run commands on the desktop; they can now also destroy panes.

### 7.2 Whitelist discipline

The browser protocol stays its own whitelist. Browser messages are **never
passed through** to the daemon — the server matches a fixed enum of browser
message types and *constructs* the `ControlMsg` itself. The mapping becomes:

```
open        → Attach
close       → Detach
(binary)    → Input
create      → Create   (validated, §7.3)
kill        → Kill     (validated)
move/adopt  → Rename   (validated)
suspend     → Suspend  (agent sessions only)
resume      → Resume   (agent sessions only)
```

Still unreachable from any browser message: **`Resize`**, `Snapshot`,
`DumpBacklog`, `ReportRunState`.

### 7.3 Validation at the boundary

- `Create.name` and `Rename.to` must match `^amber-\d+-\d+-\d+-[A-Za-z0-9]+$`
  exactly. A name outside the pane grammar is rejected — the browser cannot mint
  a session that no pane can ever show, nor one that shadows the `s<n>` CLI
  namespace.
- `Create.kind` ∈ {`shell`, `claude`, `grok`}.
- `Create.cwd` must be an existing directory.
- `Kill.name` / `Rename.from` must name a session the daemon currently lists.
- `Suspend`/`Resume` are refused for non-agent sessions before the message is
  built, so the daemon's own `Error` is never the only guard.

### 7.4 Unchanged known limitation

Behind `tailscale serve` every peer IP is `127.0.0.1`, so the auth throttle
buckets all clients together. A 256-bit token makes brute force moot; recorded,
not fixed.

## 8. Testing

**Rust (`cargo test`):**

- sidecar parse: a real multi-workspace `ui-layout.json` round-trips to the
  expected tree; unknown fields are ignored; a malformed / missing / empty file
  degrades to the default rather than erroring.
- prune + collapse: a tree mixing daemon panes with `browser-*`/`editor-*` leaves
  collapses to the right shape; a tab that is **entirely** app-local panes is
  omitted, not emitted empty; a workspace whose every tab prunes away is omitted.
- reconcile: a daemon session absent from the sidecar is appended to its
  name-encoded tab; a non-pane name lands in the unassigned section.
- auth: the shipped `/api/sessions` tests (401 unauthenticated, 401 forged
  cookie, 429 while throttled — where a *good* token is refused while throttled)
  already cover the layout payload, since it rides that response. Extend them to
  assert the `layout` field is absent from every rejected response body.
- whitelist: a browser message carrying `Resize` / `Snapshot` / `DumpBacklog`
  JSON reaches the daemon as nothing, and the target session's geometry is
  untouched afterwards.
- name-grammar rejection: `Create`/`Rename` with a name outside the pane grammar,
  an unknown kind, or a non-existent cwd are all refused before a `ControlMsg` is
  constructed.

**Live (private daemon, per the isolated-dev-instance memory):**

- mosaic renders a real multi-ws/multi-tab sidecar with correct split geometry;
- tap-to-zoom attaches, shows backlog, accepts input, back detaches;
- `Create` from the browser lands in the correct tab of the running desktop app,
  and `Kill` prunes it there;
- a pane moved from the browser appears in the target tab and keeps its child
  (same evidence shape as the adopt verification: `echo $$` unchanged);
- a suspended claude unfrozen from the browser resumes the **same** conversation;
- the desktop app and the browser attached simultaneously: neither reflows the
  other (no `Resize` ever sent).

**Front end:** test-deferred, per the repo pattern. This is precisely why §2.1
puts the logic in Rust.

## 9. Out of scope

Divider drag, tab/workspace rename, font size, `.amberws` save/load, browser and
editor panes, `Resize` in any form, live terminal content in tiles, smallest-
client-wins pty sizing, `ssh -L` + Electron on the laptop, a server→browser
error channel, **adopting non-pane sessions from the phone** (§2.4), and **any
write to `ui-layout.json` from the web client**.

## 10. Consequences for `CLAUDE.md`

On landing, the build-status entry must record: the web client is no longer
terminal-only (the editor-pane spec's "the phone UI stays terminal-only" is
narrowed to "renders no editor/browser panes"); the browser control whitelist now
reaches `Create`/`Kill`/`Rename`/`Suspend`/`Resume` while **still** never
reaching `Resize`; and a second reader of `ui-layout.json` now exists in Rust.

On that second reader, be precise about what does and does not drift. The prune
rule is *"drop any leaf that is not a live daemon session"* — stated as a
property of the daemon's session list, never as a list of known id prefixes. So
**a fourth app-local pane kind needs zero Rust change**: it is pruned by
construction, exactly like `browser-*` and `editor-*`. That is deliberate, and
it is the one place this feature is immune to the runtime-string class of bug
that bit the editor pass (`isBrowserName` / `kind === 'browser'` checks
TypeScript does not catch, the missed `+ ws` branch).

What *does* need a matching Rust change is narrower: a new field in
`WsLayout`/`TabLayout` that the mosaic must display (a per-tab colour, say), or
a change to the `Node` shape itself. Neither has happened in the sidecar's
history; every change so far has been additive and optional.
