# Memory Audit — daemon + app

**Date:** 2026-07-31
**Status:** audit complete. Findings 1, 2, 2b, 3, 4 fixed in the first pass;
5, 7 and 10 fixed in a follow-up the user asked for. 6, 8, 9 and the per-Terminal
footprint are reported only — the reasons are recorded with each.

**Result of the fixes, measured end-to-end** (12 sessions, every ring driven to
its 2 MiB cap, isolated daemon, old binary vs new):

| | before | after |
|---|---|---|
| heap address space (`VmData`) | 148 MB | **125 MB** (≈2 MB/session less) |
| RSS per session | 3550 KB | 3424 KB |
| `Ring::push` at cap, 256 B batches | 49 µs | **0.035 µs** (1498×) |
| `Ring::push` at cap, 8 KiB batches | 57 µs | 0.19 µs (300×) |
| scrollback files rewritten per idle 22 s | 12 of 12 | **0 of 12** |
| decoder copy to receive one 2 MiB frame | 36.70 MB | **5.94 MB** (6.2×) |
| unbounded app-side leaks | 2 | **0** |

> **Correction to an earlier draft of this document.** The ring's 2× capacity
> overshoot was first written up as ~36 MB of *resident* waste. That was wrong,
> and the end-to-end measurement is what caught it. The over-allocated half is
> largely never touched, so it costs **address space and allocator
> fragmentation, not RSS** — `VmData` drops by ~2 MB/session while RSS drops by
> only ~130 KB/session (the part the old push pattern did touch, by writing past
> `cap` before draining). The Ring rewrite's real payoff turned out to be **CPU**:
> eliminating a full-buffer memmove per output frame. Numbers above are measured,
> not derived.

Full-repo audit for memory leaks and allocation/GC pressure across the Rust
daemon/CLI and the Electron app (main, utilityProcess client, renderer).

## Measurements (live box, this machine, before any fix)

Taken with `ps -eo pid,rss,args` and `systemctl --user show amber.service`
against the running boot-managed daemon, 19 live sessions, ~8 min uptime:

| thing | value |
|---|---|
| `amber daemon` RSS | **106.1 MB** (19 sessions → 5.6 MB/session) |
| `amber run` supervisors | 4.2 MB × 19 = ~80 MB |
| `claude` children | 354–487 MB each × 18 = **~7 GB** |
| `amber.service` cgroup `memory.current` | **15.65 GB** |
| scrollback files on disk | 18 × exactly 2 MiB (every ring at cap) |

**The uncontrolled memory is still overwhelmingly the child processes**, exactly
as the 2026-07-17 monitor design said. Nothing found here changes that. But the
daemon's own 106 MB is roughly **twice what it needs to be**, and that part *is*
amber's to fix.

The Electron app was not running during measurement; its numbers below are
structural analysis, not readings. See "Not measured".

## Classification

Findings are split three ways, because they need different treatment:

- **A — unbounded growth.** A real leak: the thing grows without limit as the
  process lives. Fixed.
- **B — bounded overshoot.** Capped, but the cap is 2× what it should be, or the
  same bytes are re-allocated/re-written on a timer. Fixed where the fix does not
  touch a proven invariant.
- **C — churn / architecture.** Real allocation pressure, but fixing it means a
  protocol change, a React architecture change, or a product-behaviour decision.
  Reported, not changed.

---

## A — unbounded growth (leaks)

### 1. `Router.ports` is never pruned; `detach()` has zero callers

`app/src/client/router.ts:18` holds `ports: Map<string, PortLike>`. `attach()`
inserts; `detach()` (`router.ts:48`) deletes — and **nothing in the repo calls
`detach()`**. Verified by grep across `app/src`: the only hits are the definition
itself and an unrelated comment in `SplitView.tsx:40`.

Three consequences, compounding over the app's lifetime:

1. **Unbounded Map growth.** Session names are minted with a fresh id every time
   (`makeId()`), so a key is never reused. Every pane ever opened — including
   every workspace switch, which unmounts and remounts panes — leaves an entry.
2. **Leaked `MessagePortMain`.** Each entry pins a live port object in the
   utilityProcess. The renderer closes its own end on unmount (`Pane.tsx:310`),
   but the utility end is never closed. `attach()` overwriting an existing key
   drops the old port on the floor without closing it.
3. **A visible misbehaviour, not just memory.** `reattachAll()` (`router.ts:42`)
   fires on every daemon reconnect and re-`Attach`es *every name it has ever
   seen*. Dead names draw `Error { msg: "no such session: …" }` from
   `daemon.rs:285-293`, which the app surfaces in the red dismissible error
   banner. So a reconnect after a long session pops a daemon-error banner for
   panes the user closed hours ago.

There is also a smaller effect on the daemon side: with no `Detach`, the daemon
keeps the pty subscription for a pane whose renderer is gone and keeps
forwarding its output into a closed port until the session itself is killed.

**Fix:** wire a real close path — renderer `Pane` unmount → preload
`closePane(session)` → main `close-pane` IPC → utilityProcess `{kind:'pane-close'}`
→ `router.detach(session)`, which now also `close()`s the port. `attach()` closes
a previously-mapped port for the same session before replacing it.

### 2. `open-pane` brokers a fresh `MessageChannelMain` per acquire

`app/src/main/index.ts:538-544` mints a new channel on every `open-pane` and
transfers both ends away. Both ends are transferred, so *main* retains nothing —
but the utility end lands in `Router.ports` (finding 1) and the previous one is
never closed. Bounded by re-acquire count (client-restart `portEpoch` bumps,
workspace switches), not by pane count, so it grows over a long session.

Subsumed by the finding-1 fix: `router.attach` closing the superseded port is
what actually releases these.

### 2b. TS `Decoder.feed` reallocates the whole buffer per socket chunk

Not unbounded, but grouped here because it is the app's single largest garbage
source and the fix is the same size as the leak fixes.

`app/src/shared/proto.ts` (`Decoder.feed`) did:

```ts
const next = new Uint8Array(this.buf.length + chunk.length)
next.set(this.buf, 0); next.set(chunk, this.buf.length); this.buf = next
```

O(n²) while a large frame accumulates. Measured by instrumenting
`Uint8Array.prototype.set` and feeding one 2 MiB `Data` frame in 64 KiB socket
chunks (the Attach-backlog shape): **36.70 MB copied to receive 2.00 MB — 17.5×**.
`next()` then copied twice more (`body = buf.slice(…)`, `buf = buf.slice(…)`)
plus a third for the payload. Every pane's output flows through this in the
utilityProcess.

**Fix:** a read cursor plus compaction (`copyWithin` when consumed space
suffices, geometric growth otherwise), and reading the header fields in place
instead of slicing a `body` copy. Same measurement after: **5.94 MB, 2.97×** —
a 6.2× reduction.

Two properties are pinned by tests because getting either wrong turns the fix
into a different bug: consumed bytes must actually be reclaimed (a cursor alone
would retain every frame ever received), and the payload must still be **copied**
out rather than handed out as a view onto the shared buffer — it is posted across
MessagePorts and written into xterm, and compaction would alias it.

---

## B — bounded overshoot

### 3. `Ring` retains exactly 2× its cap, and memmoves the whole buffer per frame

`crates/amber-core/src/ring.rs` is not a ring — it is a `Vec<u8>` with
`drain(..overflow)`:

```rust
self.buf.extend_from_slice(data);          // len can reach cap + chunk
if self.buf.len() > self.cap {
    let overflow = self.buf.len() - self.cap;
    self.buf.drain(..overflow);            // memmove of the remaining ~cap bytes
}
```

Two costs, both proven rather than reasoned:

**Retained capacity is 2× cap.** `extend_from_slice` pushes `len` past `cap`
before the drain, which triggers `Vec`'s amortized doubling; `drain` never
shrinks capacity. Measured with a standalone reproduction of the exact push
loop (2 MiB cap, 256 KiB chunks — the daemon's `BATCH_MAX_BYTES`):

```
cap=2097152 len=2097152 capacity=4194304 overshoot=2.00x
```

What that costs is **address space and allocator fragmentation, not RSS** — the
over-allocated half is largely never written, so it never faults in. Measured
end-to-end at 12 full rings: `VmData` 148 MB → 125 MB (≈2 MB/session), while RSS
moved only ~130 KB/session. The resident part is real but small: the old push
wrote *past* `cap` before draining, so it touched ~cap + batch every cycle.

**A full-cap ring memmoves the whole buffer per output frame — this is the
expensive half.** Once at cap, every push drains from the front, shifting the
entire remaining ~2 MiB. The cost is fixed at ~`cap` *regardless of how few
bytes were pushed*, so it is worst exactly where the daemon spends most of its
life: a pane trickling small batches. Measured, push-at-cap on a 2 MiB ring:

| batch size | old | new | |
|---|---|---|---|
| 256 B | 49 µs | 0.035 µs | 1498× |
| 8 KiB | 57 µs | 0.19 µs | 300× |
| 64 KiB | 63 µs | 1.7 µs | 37× |
| 256 KiB | 74 µs | 6.9 µs | 11× |

The batcher closes a frame every ~16 ms, so an interactive pane at full ring was
paying ~62 × 49 µs ≈ 3 ms of pure `memmove` per second — ~0.3% of a core each,
and it scales with pane count (~5% of a core across the box's 18 panes) for
literally no work. A pane dumping a build log paid far more: 1.14 s of memmove
per 156 MiB of output.

**Fix:** a real circular buffer — grow geometrically (capacity hard-clamped to
`cap`, so an idle session still costs nothing) up to `cap`, then wrap in place
with `copy_from_slice` and a head index. Capacity never exceeds `cap`; a push at
cap copies only the pushed bytes. `snapshot()` joins the two slices, which is the
same single allocation the old `buf.clone()` made.

The lock discipline in `PtySession::subscribe` (`pty.rs:440-456`) — ring lock
held across the backlog snapshot *and* the subscriber-list snapshot — is
deliberately unchanged; that ordering is what makes backlog+live lossless and is
covered by `subscribe_backlog_and_live_never_duplicate_or_lose_bytes`.

### 4. The snapshot rewrites every scrollback file every 10 s, changed or not

`SessionManager::snapshot_inner` (`manager.rs:459-462`) unconditionally does:

```rust
self.store.write_scrollback(name, &sess.scrollback())?;
```

for every live session, on the configured cadence (default 10 s). At the
measured state — 18 sessions, every ring full at 2 MiB — that is:

- **36 MiB of transient `Vec` allocation every 10 seconds** (`scrollback()` is
  `ring.snapshot()`, a full clone), and
- **36 MiB written to disk every 10 seconds ≈ 3.6 MB/s sustained**, forever,
  for sessions that are mostly idle. `atomic_write` also means a full temp-file
  write plus a rename per session per tick.

An idle pane's scrollback does not change between ticks, so nearly all of that
is redundant.

**Fix:** `Ring` gains a monotonic `written()` counter (total bytes ever pushed).
The manager remembers the counter it last persisted per session and skips both
the clone and the disk write when it is unchanged. The bytes on disk are
byte-for-byte what they would have been, so reboot survival (core rule #6) is
untouched — this only removes writes that were already no-ops.

**Verified live** against an isolated daemon with 12 sessions at full ring: over
22 idle seconds (≥2 snapshot ticks) the old binary rewrote **12 of 12**
scrollback files, the new one **0 of 12**. A session that produces output is
still persisted on the next tick.

---

## C — churn and architecture (reported, not changed)

### 5. `Backlog` encoded `Vec<u8>` as a JSON numeric array — FIXED

`ControlMsg::Backlog { name, data: Vec<u8> }` (`proto.rs:111`) is serde-JSON, so
a 2 MiB scrollback serialises to a JSON array of ~2 million decimal numbers —
roughly **8 MB of text**, built with `serde_json::to_vec` on the daemon and
parsed into a 2-million-element JS array before `Uint8Array.from` on the client
(`proto.ts`, `case 'Backlog'`). Per pane, per workspace save.

Fixed on the user's call: a dedicated binary frame tag (2), same body layout as
`Data` and distinct from it because a dump is a *reply* and must never be written
into the pane. The client→renderer hop keeps the old message shape — it is a
MessagePort, so structured clone, no serialisation either way.
`ControlMsg::Backlog` is retained as a DECODE path so a new client still
understands an older daemon.

Two things the tests caught and that were fixed rather than worked around: the
connection test used tag 2 as its "unknown tag" (now a real frame), and the TS
decoder did not bounds-check a truncated data frame the way Rust does — with the
new reused read buffer, a corrupt length prefix would read past the frame and
yield a garbage session name instead of an error.

Verified live end to end: `dumpBacklog` from the renderer returned a real
`Uint8Array` with the right session name.

### 6. Every `Data` frame is copied twice more than it needs to be

Per output frame the byte path is: pty read → `to_vec()` into the batcher
channel → `extend_from_slice` into the batch → `Ring::push` → `chunk.to_vec()`
**per subscriber** in `deliver_chunk` (`pty.rs:119-122`) → `proto::encode`
allocating a full duplicate of the frame (`proto.rs:174-195`).

`deliver_chunk` could hand out `Arc<[u8]>` instead of per-subscriber copies, and
`encode` could be split into header + payload written with `write_vectored`. Both
were deliberately skipped: the common case is exactly **one** subscriber (the
app), where `Arc` saves nothing, and both changes sit directly on top of the
backpressure and wedged-client invariants that took multiple debugging passes to
get right (`slow_subscriber_backpressures_producer`,
`stalled_subscriber_does_not_freeze_healthy_subscriber`, `wedged_client.rs`).
Worth doing only with a measured multi-subscriber workload to justify it.

### 7. Renderer re-render storm from `Activity` + `MemoryStat` — FIXED

The daemon emits `Activity` at up to 2/s/session (`pty.rs:41`) and `MemoryStat`
at 1 per 3 s per session (`main.rs:595`). Both are dispatched into the `App`
reducer (`main.tsx:265`). Every dispatch re-renders `App`, which rebuilds
`groupSessions` → `mergeBrowsers` → `mergeEditors` (fresh `Map`s and arrays) and
then calls `deriveTab` **once per keep-alive layer** (`main.tsx:991`) — i.e. for
every tab in the active workspace, not just the visible one.

At the measured 19 sessions that is on the order of 45 full-tree renders per
second while idle. `Pane` is memoized so terminals are not reconciled, but every
other object allocated in that path is garbage. This is a plausible mechanism for
"the app gets laggy after a while" independent of the already-fixed SwiftShader
cause.

Fixed on the user's call, with the cheap lever rather than the architectural one:
both events only drive a tab dot and a header MB label, so neither needs
sub-second latency. They are buffered and flushed on a 250 ms timer, and React 18
batches the dispatches inside that timeout into **one** render — so N events cost
one pass instead of N. Session lifecycle, `Exit` and `Error` stay immediate.

Not done: moving that state out of the main reducer entirely
(`useSyncExternalStore`, so only the badge subscribes), which would stop even the
one render from touching the whole tree. The throttle gets most of the benefit for
~15 lines; the split is worth doing only if a measurement says the residual
matters.

Verified live: the per-pane MB label still updates, and no daemon event is lost.

### 8. `session_infos()` does ~2 file reads per session under the sessions lock

`manager.rs:702-725` calls `store.list_sessions()` (a `read_dir` plus a read +
`serde_json` parse per session) and then `store.read_claude(name)` per session —
all while holding `self.sessions`. It runs on every `Create`, `Rename`,
`ReportRunState` and `WatchSessions`. At 19 sessions that is ~38 file reads and
as many JSON parses per control gesture. Allocation churn plus a lock hold on
the path that `write()`/`Input` contends with.

Not fixed: it is a caching change to the session-metadata layer with correctness
implications (the store is the source of truth and is hand-editable).

### 9. `process_table()` allocates a full table every 3 s

The memory monitor (`main.rs:599-626`) calls `procinfo::process_table()` every
`MEM_POLL_SECS = 3`, which builds a `Vec<ProcEntry>` for **every process on the
machine** with a `String` comm each, and reads `smaps_rollup` per pid — measured
in `procinfo.rs:146-151` at ~446 ms of RSS reads on a 781-process desktop. So the
monitor spends a meaningful fraction of every 3 s window walking address spaces
of processes it does not care about, and throws the whole table away.

Cheap improvement available: the monitor only needs RSS for pids in the sessions'
subtrees, so it could take the parentage-only `process_table_lite()` and then read
`smaps_rollup` for just those pids. Not fixed here (it is the monitor's own cost,
not a leak, and it belongs with a monitor-cadence review).

### 10. Every reconnect appends a duplicate backlog into every live terminal

Observed during this pass's live verification (not previously written down).
`Connection`'s `open` handler calls `router.reattachAll()`, and the daemon
replays the **full** scrollback on every `Attach`. On a daemon reconnect the
`Pane` does *not* unmount — its `Terminal` is deliberately preserved — so the
replayed backlog is appended to a buffer that already contains those bytes.

Visible in the verification screenshot: after one daemon restart, `MARKER_ALPHA`
and `MARKER_BETA_AFTER_REATTACH` each appear twice.

Pre-existing, not a regression from these fixes (`Pane.tsx`'s `rearmRef` comment
already notes "the daemon replays a fresh backlog on every re-Attach"). It is
listed here because it is memory-relevant, not just cosmetic: each reconnect
grows every live terminal's buffer by up to a full 2 MiB backlog until xterm's
own scrollback limit evicts it, so a flappy daemon inflates renderer memory in
steps.

**Fixed, after one wrong attempt worth recording.** The first attempt reused the
existing `rearmRef` heuristic — "the next message after a reconnect is the
backlog" — and reset the terminal on it. Live-tested against a real daemon
restart, the pane went **blank**: the replay arrives on its own IPC task and can
beat React's reconnect effect, so the reset landed on a *later* frame and wiped
history the daemon still held. A reset is not a benign thing to fire on a guess,
which is what `MOUSE_RESET` had been getting away with.

The real fix puts the decision where the fact actually lives: the **client**
sends the `Attach`, so the first `Data` frame it sees for that session afterwards
*is* the replay. `Router` now tags exactly that frame (`{data, backlog: true}`)
and `Pane` resets only on a tagged frame — and only if it has already consumed
one backlog, so a `.amberws` load's staged replay is never wiped. `rearmRef` is
gone; the mouse reset rides the same exact signal.

Verified live: marker count after a daemon restart is **2 → 2** (it was 2 → 4
before the fix, and 2 → 0 with the broken first attempt).

### 11. Not measured

- **Per-`Terminal` renderer footprint.** Keep-alive keeps every visited tab's
  panes mounted within the active workspace (`main.tsx:988-1044`,
  `SplitView.tsx:374-385`), so xterm instances accumulate. Each holds its own
  scrollback buffer plus a WebGL context. This is structurally the app's dominant
  footprint, but no reading was taken (the app was not running during the audit),
  and no number is asserted here. See the open question below.
- **CodeMirror undo history** per editor pane. Bounded by CM6's history depth but
  proportional to edit volume on files up to the 8 MiB cap. Not observed to be a
  problem.

## Live verification (GUI, this box)

Driven headless (xvfb + CDP) against an **isolated** private daemon (private
`XDG_RUNTIME_DIR`/`XDG_STATE_HOME` + private `--user-data-dir`), so the user's
real daemon and its 19 live sessions were never touched.

The detach wiring is the risky part of this pass — a mistake there kills panes —
so it was exercised end to end:

- two panes created, typed into, output echoed back (`MARKER_ALPHA`);
- **workspace switch away and back**, which unmounts every pane and is therefore
  the gesture that now fires `Detach`: panes came back with their scrollback
  intact and still accepted input (`MARKER_BETA_AFTER_REATTACH`);
- pane closed via the kill dialog: pruned cleanly, no error banner;
- **daemon restarted** under the running app: the disconnected banner appeared
  and then cleared, the pane restored, input still reached the pty
  (`MARKER_GAMMA_AFTER_DAEMON_RESTART`), and **no daemon-error banner appeared**
  at any point;
- **client utilityProcess `kill -9`'d** — the one changed path the other gestures
  miss. It matters because `Pane`'s `portEpoch` re-acquire runs *without* an
  unmount, so no `closePane` fires and `attach()`'s "close the port you
  supersede" is the only cleanup — and that port belongs to a process that is
  already dead. If `MessagePortMain.close()` were missing or threw there, the
  throw would land in the new child's `parentPort` handler and kill it, and the
  resulting crash-relaunch would be easy to mistake for a clean pass. Observed:
  exactly one relaunch (pid 1093584 → 1103624, then **stable**), no
  `TypeError`/throw in the app log, no error banner, and the pane accepted input
  again (`AFTER_CLIENT_CRASH`).

Not provable from the GUI: that the client's port map is actually empty after a
detach (it has no observable surface from the renderer). That property is pinned
by the `Router` unit tests instead — `attachedCount()` exists for exactly that.

## Things checked and found clean

Recorded so the next audit does not re-derive them:

- `store.ts` reducer prunes `dead` / `lastActivity` / `lastSeen` / `mem` against
  the live set on every `Sessions` / `SessionsChanged` (`keepLive`).
- `main.tsx` prunes `titles` (with a deliberate browser/editor exemption) and
  `frozen` against the live set.
- `SplitView` sweeps `titleCbs` / `searchApis` / `searchReadyCbs` / `rebuild`
  against the live leaf set (`SplitView.tsx:337-358`).
- `Pane` disposes its `Terminal`, `ResizeObserver`, results subscription, port and
  every DOM listener on unmount. `Editor` destroys its `EditorView` and clears both
  debounce timers. `Browser` removes its webview listeners. `MdPreview` disconnects
  its `ResizeObserver`.
- No `React.StrictMode`, so the single `ipcRenderer.on('daemon-event')`
  registration in the `[bridgeReady]` effect is not doubled.
- Daemon side: `Watchers.entries` prunes on eviction and on a vanished writer;
  the memory monitor's `samples` map prunes against `live_pids()`;
  `claude_absent` prunes against the sessions table; per-connection
  `Subscriptions` are released on every exit path of `handle_connection`; the
  Attach forwarder thread exits on channel close, on `Detach`, and on a bounded
  write timeout; `amber web`'s `Hub` evicts clients on a full or disconnected
  queue and detaches the session when the last client holding it goes.
- `write_bounded` / `CLIENT_WRITE_TIMEOUT` mean no client can pin daemon buffers
  indefinitely (the 2026-07-20 wedged-client fix holds).

## Open question for the user — ANSWERED: leave it

Reducing the app's dominant footprint means one of two things, and both trade
away product behaviour rather than fixing a defect. **The user chose to leave
both alone**, on the grounds that no reading was ever taken of the real running
app — optimising an unmeasured number is how you trade a feature for nothing.
Recorded here so the next pass does not re-open it without a measurement first:

1. **Lower xterm's `scrollback`** (currently the library default) — less
   in-terminal history per pane. The daemon's 2 MiB raw ring is unaffected, so a
   re-attach still repaints from the daemon.
2. **Evict background terminals** — dispose the `Terminal` for panes in
   non-visible tabs and rebuild from the daemon backlog on return. That is
   exactly the keep-alive behaviour that was deliberately built, and it costs a
   visible repaint on every tab switch.

Both are user-visible. Per the constitution's "stop and ask" rule they are not
being changed unilaterally.
