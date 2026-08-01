# Task 1 — Ring::tail + Attach.preview

**Status:** done.

**Commit:** `69ff5bf` — feat(core): add Ring::tail and Attach.preview for mosaic tiles

**Tests:** Rust workspace 176 unit/integration tests + 0 doctests, all green;
`cargo clippy --workspace --all-targets -- -D warnings` clean. App: `npm run
typecheck` clean, `npm test` 410 passed / 1 skipped (pre-existing skip,
unrelated).

**Concerns:** none blocking.
- TS side deliberately does NOT add `preview` to the wire: like `raw_client`
  in the same message, the Electron app never sets it, so the encoder omits
  the field and relies on the daemon's `#[serde(default)]` to decode the
  absence as `false` — this matches the existing pattern rather than
  diverging from it (confirmed via advisor review before committing).
- `daemon.rs`'s `Attach` match arm now destructures `preview: _preview` (bound
  but unused) — mechanical, no behavior change; the next task wires it up.
- `Ring::tail` is built on `snapshot()` (one extra allocation vs. a hand-rolled
  wrap-aware index dance) — correct-by-construction at the wrap seam, and
  irrelevant at the 16 KiB preview size the spec calls for.
