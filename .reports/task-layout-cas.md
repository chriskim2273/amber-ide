# Layout compare-and-swap (spec 2026-08-01 §6)

## Status

Done. `ui-layout.json` now has two safe writers (the Electron app and `amber
web`) via compare-and-swap; core rule #3 (layout stays app-owned, not daemon
state) is untouched — no daemon/protocol change.

## Commits

- `9531a48` feat(layout): compare-and-swap the ui-layout.json sidecar (spec §6)

(single commit on `feat/live-tiles`)

## Test summary

Rust: `cargo test --workspace` — 313 passed (7 new `layout_cas` unit tests + 5
new `/api/layout` integration tests in `crates/amber/tests/web.rs`, incl. the
genuine interleaving test). `cargo clippy --workspace --all-targets -- -D
warnings` — clean (see note below on how I verified this — the harness's
`cargo` hook intercept gave a false "1 errors, 1 warnings" summary with no
detail; invoking the real binary directly at `/home/poyto/.cargo/bin/cargo`
showed a clean `Finished` build, exit 0, both before and after `touch`-forcing
a rebuild — this looks like a stale/buggy report from the token-saving proxy
wrapping `cargo`, not a real diagnostic, since the wrapper never produced a
file/line to fix). App: `npm run typecheck` clean, `npm test` — 446 passed / 1
pre-existing skip (12 new: 6 `mergeLayout` cases, 8 `layoutIO` cases minus 2
overlap... concretely: `layoutFile.test.ts` +8 merge tests, `layoutIO.test.ts`
new file +8 tests, `amber.test.ts` +2 tests net). Both `npm run build` (Electron)
and `npm run build:web` (the vite web target) still produce a bundle.

**Mutation check, both implementations, done as instructed:**
- Node (`app/src/main/layoutIO.ts`): changed `if (current !== expectedVersion)`
  to `if (false)`. Result: 3 tests failed, including
  `rejects a stale writer after a concurrent write has already landed` (the
  interleaving test) and the two other conflict-shaped tests. Reverted; all 8
  pass again.
- Rust (`crates/amber/src/layout_cas.rs`): changed
  `if current.as_deref() != expected_version` to `if false`. Result: 2 tests
  failed (`save_rejects_a_stale_version_without_touching_the_file` and
  `a_stale_writer_is_rejected_after_a_concurrent_write_lands`). Reverted; all 7
  pass again.

Both mutations proved the guard is load-bearing and the tests actually
exercise it, not just the merge/comparison helper in isolation.

## Design decisions (as asked to think through and report)

**1. Version = the file's exact previous content, not mtimeMs+length.**
mtimeMs+length collides in practice: two writes landing in the same host
millisecond (plausible under the 300 ms UI debounce plus network latency for
the browser writer), or two edits of identical byte length (e.g. a split
ratio's last digit flipping, `0.500000` -> `0.500001` — same length, different
content) both produce a false version match, which is a silent clobber —
exactly the bug being fixed. Using the file's exact content as the version
token instead makes a false match structurally impossible (it's true equality,
not a probabilistic proxy), needs no hash function, and — the part worth
recording so nobody "cleans this up" later — **the two independent
implementations (Node in `app/src/main/layoutIO.ts`, Rust in
`crates/amber/src/layout_cas.rs`) never need to agree on an algorithm**,
because each writer only ever compares its own token against its own re-read
of the same file; there is no cross-process comparison of tokens. The sidecar
is small (3.2 KB measured on this machine's real `~/.local/state/amber-ide/
ui-layout.json`) against a 32 KB `MAX_REQUEST_LEN` in `web.rs`, so sending full
content instead of a digest costs nothing worth optimizing; I left
`MAX_REQUEST_LEN` alone.

**2. "Re-apply the mutation against the fresh tree" — how this was actually
done.** `layoutFile.ts` gained a generic 3-way JSON merge (`mergeLayout`,
built on `merge3`/`deepEqual`): given `base` (what an edit started from),
`local` (that edit applied) and `remote` (what's on disk now), it recurses
into plain objects key by key — if `local` didn't change a key since `base`,
take `remote`'s value (including a deletion); otherwise keep `local`'s,
recursing one level deeper when possible. It's schema-agnostic, which is what
makes it safe against the browsers/editors-pruning failure mode (see below)
without hardcoding a list of "known fields to preserve." `main.tsx`'s persist
effect uses it twice per conflict:
  - On the first conflict, `mergeLayout(baseRef.current, local, remote)`
    reconciles the disk state into the retry payload — this is the literal
    "re-apply the edit against the fresh tree," not "resend the stale local
    object."
  - The retry can itself land after the *local* tree moved on again (the user
    kept editing during the two network round trips). `setLayout`'s functional
    updater compares against the truly-current React state
    (`cur === local ? merged : mergeLayout(local, cur, merged)`): if nothing
    changed locally during the round trip, adopt the merged tree outright;
    otherwise treat the pre-await snapshot as the new `base` and merge the
    newer local edits against the reconciled tree. Without this, the naive
    `setLayout(merged)` an early draft used would have silently discarded any
    edit the user made while the conflict was being resolved — an advisor
    review caught this before it shipped; it's covered by reasoning, not a
    test, since renderer components stay test-deferred in this repo (existing
    pattern) — the pure merge logic they depend on is fully unit-tested.
  - A second conflict does not retry again; it surfaces via the existing
    `notice` banner (the same mechanism used for workspace-load parse errors
    and dump-timeout stragglers) rather than silently dropping either side.
  - Overlapping debounced saves are serialized through a promise chain
    (`saveChainRef`) so a save in flight is never raced by the next one reading
    `versionRef`/`baseRef` mid-update.

**3. browsers/editors preservation.** Because the merge is schema-agnostic, a
web client whose local tree never touched `browsers`/`editors` (the web build
can't create either kind — spec §7) automatically inherits whatever the
desktop wrote there on conflict, rather than needing special-cased
preservation logic. Test:
`layoutFile.test.ts`'s "never prunes desktop-only browser/editor panes the web
build cannot create" — local edits only a workspace tree, remote adds a
browser and an editor entry local never had, and the merged result keeps both
the tree edit and both app-local maps intact.

**4. Debounce — no new code in the web shim.** `main.tsx`'s existing 300 ms
debounce (`useEffect` on `[layout, bridgeReady, loaded]`, `app/src/renderer/
main.tsx`) is shared verbatim by both builds — it's the renderer, and
`window.amber.saveLayout` is the platform boundary, so this requirement is
satisfied by construction rather than by adding a second policy in
`amber.ts`. Checked that a divider drag doesn't defeat this: `SplitView.tsx`'s
`startDrag` calls `props.onSetRatio` (-> `setLayout`) on every `mousemove`, so
the effect restarts its timer on every drag tick and only actually writes
~300 ms after the drag *settles* — this was true before my change and I didn't
touch it; "no write mid-drag" holds without drag-specific code on either
platform.

## Files touched

- `app/src/shared/layoutFile.ts` / `.test.ts` — `LoadLayoutResult`/
  `SaveLayoutResult`/`LayoutVersion` types, `mergeLayout`.
- `app/src/main/layoutIO.ts` (new) / `.test.ts` (new) /
  `layoutIORace.test.ts` — Node CAS file IO and deterministic descriptor-race
  fixtures.
- `app/src/main/index.ts` — `layout-load`/`layout-save` IPC handlers now thin
  wrappers over `layoutIO.ts`.
- `app/src/preload/index.ts` — `loadLayout`/`saveLayout` signatures updated.
- `app/src/renderer/main.tsx` — CAS refs (`baseRef`/`versionRef`/
  `saveChainRef`), `persistLayout` (retry-once + merge + notice-on-second-
  conflict), mount-effect updated for `{text, version}`.
- `crates/amber/src/layout_cas.rs` (new) — Rust CAS file IO, same contract.
- `crates/amber/src/lib.rs` — registers the module.
- `crates/amber/src/web.rs` — `GET`/`POST /api/layout`, cookie-gated like
  `/api/sessions`.
- `crates/amber/tests/web.rs` — cookie-gate test, round-trip test, conflict
  test, genuine-interleaving test over real HTTP.
- `app/src/web/amber.ts` — `loadLayout`/`saveLayout` now call injected
  `layoutGet`/`layoutSave` deps instead of the old no-op stubs.
- `app/src/web/install.ts` — real `fetch`-based `layoutGet`/`layoutSave`
  against `/api/layout`.
- `app/src/web/amber.test.ts` — updated `deps()` fixture + replaced the old
  "inert no-op" test with passthrough/conflict tests.

## Concerns

- The same-leaf double-edit case (two clients editing the identical pane's
  ratio inside one retry window) resolves to "local wins" rather than a true
  merge — documented in code as a `ponytail:`-style tradeoff. This is a
  narrow, rare race (bounded by the ~300 ms debounce + one retry), and a finer
  merge wasn't built since nothing in the task suggested it's been observed in
  practice; escalate if it ever bites.
- `main.tsx`'s conflict-resolution path (item 2 above) is not directly unit
  tested — renderer components/orchestration are test-deferred throughout this
  repo (confirmed via `Browser`/`SplitView` precedent), so I followed the
  existing pattern and put the two rounds of testing weight on the pure merge
  function instead. If this is not acceptable for this feature specifically,
  it would need a lightweight renderer-level harness that doesn't currently
  exist anywhere in the app.
- The original CAS commit did not modify `crates/amber/src/mosaic.rs` because
  its read-only render path was then out of scope. The 2026-09-03 containment
  follow-up now does: mosaic and CAS share the bounded regular-file loader,
  graph/string validation, and cached hostile-file polling fallback. This is a
  separate hardening pass and not a change to CAS merge semantics.
- `cargo clippy`/`cargo test` run through this environment's normal shell
  produced a misleading summarized report at one point (see Test summary
  above); I verified directly against the real `cargo` binary before relying on
  the result. Flagging in case it recurs for whoever reviews this next.

## 2026-09-03 containment follow-up

The later tab-browser host review added the bounded ingress work that was
outside the original CAS commit: `crates/amber/src/layout_file.rs` is now the
shared Rust regular-file loader used by both `layout_cas` and `mosaic`, with
8 MiB, symlink, replacement/growth, timeout, exact-byte, and fatal UTF-8
checks. Mosaic parsing validates
workspace/tab/map/string/tree bounds and its web poller caches an unchanged
fallback. The Node CAS reread and SSH remote-layout probe use matching 8 MiB
limits, fatal UTF-8 decoding, and no partial result on overflow/timeout.
Deterministic tests cover truncation, truncate-and-regrow, append, FIFO, and
symlink replacement during descriptor reads, plus shell-expanded XDG/HOME
paths containing spaces and glob characters. The broker admission fix and
its queue-key cancellation tests are tracked in `tab-browser-host.md` and the
machine-readable remaining report. Current validation is recorded there; the
branch remains `mergeReady: false` because the deployment/package/platform and
independent resident-review gates are still open.
