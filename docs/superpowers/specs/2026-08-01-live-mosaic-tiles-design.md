# Live mosaic tiles — `amber web`

**Date:** 2026-08-01
**Status:** designed, not implemented.
**Depends on:** `2026-07-31-remote-mosaic-web-design.md` (shipped). This spec
reverses exactly one decision in it — §4.1's "tiles carry no terminal bytes" —
and changes nothing else.

Read `CLAUDE.md` first. This spec obeys it.

## 0. Why

The shipped mosaic renders metadata tiles: slot, title, kind, state dot. User
feedback after using it: *"I can't view the session unless I click into it."*

§4.1 chose metadata tiles for a stated reason: every `Attach` replays up to
2 MiB of scrollback, so a 6-pane tab would pull ~12 MiB on each tab switch, and
there was no bounded-backlog attach in the protocol. That reason is real, but
the conclusion was wrong for the actual use — the whole point of the mosaic is
seeing what your machine is doing without opening six panes.

**The cost is avoidable, and most of the machinery already exists.**

## 1. The insight: an agent pane needs no scrollback at all

`daemon.rs:320-335` already implements exactly what a preview needs, for a
different client:

```rust
let skip_backlog = suppress_backlog(raw_client, manager.session_kind(&name));
if skip_backlog {
    // Repaint nudge: resize one column away and back delivers two SIGWINCHes
    // with a real size change, which alt-screen TUIs answer with a full redraw.
    if let Some((rows, cols)) = sess.size() {
        let _ = sess.resize(rows, cols.saturating_sub(1).max(1));
        let _ = sess.resize(rows, cols);
    }
}
```

A claude/grok pane lives on the alt screen. Replaying its ring into a cold
terminal is both expensive and *wrong* (alt-screen and cursor sequences corrupt
the render) — so a raw client skips the backlog entirely and forces the child to
repaint. The result is **one screenful of bytes** and a correct current frame.

That is precisely a preview. The feature is largely: let the web client ask for
that same treatment.

### 1.1 The hazard this creates, and its bound

**The nudge resizes the real pty.** A pty has one winsize shared with every
client including the desktop app's panes (`CLAUDE.md`, the accepted tradeoff
recorded for the attach status row). One nudge pair per rare `amber attach` is
noise. **Six nudges on every mosaic tab switch is not** — it would reflow the
user's live desktop panes continuously, which is the exact failure this whole
feature line exists to avoid, and the reason the phone may never send `Resize`.

So the nudge is bounded on two axes, both daemon-side (a client must not be
trusted to rate-limit itself):

- **Per session, at most once per `NUDGE_MIN_INTERVAL` (15 s).** `PtySession`
  records `last_nudge`; a preview attach inside the window silently skips the
  nudge and takes whatever the subscription delivers.
- **Only when the session has no other preview subscriber.** A second tile
  attaching to a pane someone is already previewing rides the first one's frame.

Net worst case: one resize pair per session per 15 s while a mosaic is open —
comparable to a single divider drag, and only while someone is watching.

**This is a real, accepted tradeoff, not a solved problem.** Opening the mosaic
can cause a brief reflow of a desktop pane. It is bounded, it is never
phone-sized (the nudge returns to the *same* cols), and it is the only way to
get a correct frame out of an idle alt-screen TUI without emulating one.

## 2. Shell panes: a bounded tail

A shell has no alt screen; its ring is mostly text with simple SGR. A preview
gets **the last `PREVIEW_TAIL_BYTES` (16 KiB)** of the ring rather than all of
it.

Cutting a ring at an arbitrary offset can land mid-escape-sequence, so the tail
is trimmed forward to the byte after the first `\n` it contains. Worst case the
preview loses one partial line; without it, a severed CSI can swallow the
following characters.

16 KiB is far more than a tile shows, and ~128× cheaper than the 2 MiB cap.

## 3. Protocol

One additive field. `crates/amber-core/src/proto.rs`:

```rust
Attach {
    name: String,
    #[serde(default)]
    raw_client: bool,
    /// A small mosaic tile, not a full view. Agent sessions get NO backlog plus
    /// a bounded repaint nudge (§1.1); shell sessions get the tail only (§2).
    /// `#[serde(default)]` keeps the wire back-compatible: an older client
    /// omits it and decodes as `false` = today's full-backlog attach.
    #[serde(default)]
    preview: bool,
}
```

`app/src/shared/proto.ts` mirrors it (encode side — the app never sets it).

No new control message. `Detach` already ends a preview.

## 4. The web hub becomes multi-attach

`Client.open: Option<String>` assumes one session per browser client. A mosaic
previews every pane in the visible tab at once.

```rust
struct Client {
    id: u64,
    /// The full-screen session, if any (tap-to-zoom). Gets input.
    open: Option<String>,
    /// Sessions previewed as mosaic tiles. Never receive input.
    preview: Vec<String>,
    tx: SyncSender<Out>,
}
```

- **Data routing** (`Hub::on_frame`) currently matches `c.open.as_deref() ==
  Some(session)`. It becomes `c.open == session || c.preview.contains(session)`.
  The browser already routes binary frames by the session name in the frame, so
  no framing change.
- **`detach_if_unwanted`** must consider both sets across all clients before
  sending `Detach` — a session that is one client's zoom and another's tile
  stays attached.
- **Input is gated on `open` only.** `handle_browser`'s binary path already
  writes to `c.open`; it must NOT learn about `preview`. A tile is display-only,
  and that is enforced server-side, not by the front end declining to send.

## 5. Browser protocol

One new message, whitelisted like the rest — the server constructs every
`ControlMsg` itself, nothing is passed through:

```
{"t":"preview","names":["amber-1-1-0-aa", …]}
```

Declarative, not incremental: it replaces the client's entire preview set. The
server diffs against the current set, emits `Attach{preview:true}` for additions
and `Detach` for removals (respecting §4's cross-client check). A name that is
not a live session is dropped, exactly like `open`.

Sending `{"t":"preview","names":[]}` clears the set — what the front end does on
entering the zoomed view.

**Bounded:** at most `MAX_PREVIEWS` (16) names per client; the rest are ignored.
A tab with more panes than that shows metadata tiles for the remainder. This
caps a malicious or buggy client at 16 subscriptions, not 10 000.

Still unreachable from any browser message: `Resize`, `Snapshot`, `DumpBacklog`,
`ReportRunState`.

## 6. Front end

Each visible tile hosts its own `Terminal`, sized to the session's real
`cols`/`rows` and CSS-scaled to the tile box — the same transform trick the
zoomed view uses, and the same reason: **the pty is never resized.**

- Terminals are created for the visible tab only, and disposed on tab/workspace
  switch. `xterm.dispose()` on every removed tile — a leaked instance per tab
  switch is the obvious way to make this feature a memory bug.
- The preview set is recomputed after each `{t:"sessions"}` push and sent only
  when it actually changed, so a 1 s poll does not re-attach 6 panes every tick.
- Tile terminals get `scrollback: 0` — a preview has no history and the ring
  tail is already bounded. This is also what keeps 16 tiles cheap.
- No `onData` handler is wired on a tile terminal. Input reaching a tile is
  impossible by construction on the client too, belt and braces with §4.
- Tapping a tile still opens the existing full-screen view, which attaches
  normally (full backlog, real emulator, input enabled).

Text at tile scale is small and not meant to be read — the tile carries shape,
colour, cursor and activity. Detail is one tap away. The metadata header (slot,
kind, state dot, ❄) stays, overlaid on the terminal.

## 7. Testing

**Rust:**
- `Ring::tail(n)` — returns at most n bytes, the LAST n; trims to the first
  `\n`; a ring shorter than n returns everything; an empty ring returns empty.
- `preview` attach on a shell delivers ≤ `PREVIEW_TAIL_BYTES` and not the full
  ring (fill a ring past the tail size and assert the delivered length).
- `preview` attach on an agent session delivers no backlog frame.
- The nudge rate limit: two preview attaches inside 15 s produce exactly one
  resize pair (assert on the session's observed size events, not on a sleep).
- A second preview subscriber does not nudge.
- Input still cannot reach a previewed-but-not-open session: send binary on a
  client whose only subscription is a preview, assert the pty received nothing.
- `preview` names beyond `MAX_PREVIEWS` are ignored.
- The forbidden four remain unreachable (existing cross-product test, extended
  with `{"t":"preview"}` shapes that try to smuggle a resize).

**Live:** a tab of mixed shell + agent panes shows moving content in tiles;
switching tabs disposes the old terminals (assert instance count, not vibes);
the desktop app is watched across a mosaic open to confirm the reflow is a
single brief flicker and not continuous; typing into a tile does nothing.

## 8. Out of scope

Previewing panes in a non-visible tab or workspace; preview for browser/editor
panes (they have no daemon session); any resize from the phone; per-tile
scrollback; making the nudge unnecessary (that needs a server-side emulator,
which core rule #4 forbids).
