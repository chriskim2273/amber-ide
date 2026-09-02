# Agent usage-limit tracking — live verification

Spec: `docs/superpowers/specs/2026-09-01-usage-limit-tracking-design.md`
Plan: `docs/superpowers/plans/2026-09-01-usage-limit-tracking.md`
Date: 2026-09-01. Branch `feat/usage-limits`.

Everything below ran against an **isolated private daemon** (`AMBER_STATE_DIR` /
`AMBER_SOCK` under `/tmp/amber-usage-verify`) and a **private `amber web`** on
port 7931 — never the user's real daemon or service.

## Automated gates

| Gate | Result |
|---|---|
| `cargo test --workspace` (twice) | 813 passed, 0 failed |
| `cargo clippy --workspace --all-targets -- -D warnings` | clean |
| `npm test` | 744 passed, 1 skipped (the pre-existing real-daemon skip) |
| `npm run typecheck` | clean |
| `npm run build` (Electron) | green |
| `npm run build:web` | green |
| `git diff --check` | clean |

## Live checks

**1. claude matches its own endpoint, exactly.** With the daemon freshly
started (so its cache is seconds old), `amber ctl usage --json` and a hand-run
`GET /api/oauth/usage` at the same moment:

```
endpoint [('session', 56.0), ('weekly', 6.0)]
amber    [('session', 56.0), ('weekly', 6.0)]   MATCH
resets_at 2026-09-02T05:59:59.510893+00:00 -> 1788328799   (correct)
          2026-09-06T04:59:59.510914+00:00 -> 1788670799   (correct)
```

An earlier comparison read 55 vs 56 — the daemon's cache was ~50 s old and the
session window was moving while this work ran. That is the designed 60 s
cadence, not drift: the weekly figure matched exactly in the same sample, and a
fresh daemon matched on both.

**2. codex — and the bug this check caught.** The first live run reported
`codex: no codex usage recorded yet` on a box with 1,295 rollout files, 196 of
whose newest 200 contain a populated `rate_limits`. Cause: codex has **moved
the block between releases** — older rollouts nest it at
`payload.info.rate_limits`, current ones write it as `info`'s **sibling** at
`payload.rate_limits`. The collector read only the nested path. Fixed with an
ordered path list (`RATE_LIMIT_PATHS`) plus a regression test built from the
real line shape. After the fix:

```
codex · pro
  5h window    window rolled — reopen codex
  weekly       100% left   in 5d
```

The stale path is exercised for real here: the newest non-null record is from
2026-08-30, so its 5 h window has genuinely rolled and the number is withheld
rather than shown.

**3. grok** prints `grok exposes no quota data` and no number — the honest
absence, not a fabricated zero.

**4. `needs-auth`, without touching the real credential.** A private
`CLAUDE_CONFIG_DIR` holding an expired token:

```
claude: claude token expired — run claude to refresh
codex · pro                       <- unaffected: one provider failing never blanks another
```

The unit test additionally asserts no `curl` is spawned on that path (amber
never refreshes or mints the credential).

**5. No token leakage.** `amber ctl usage --json` output contains `sk-ant`
0 times and `Bearer` 0 times. The error path is covered by a unit test that
feeds curl stderr containing the token and asserts only the exit status
surfaces.

**6. `GET /api/usage` sits behind the session cookie.**

```
no-cookie:   401
auth:        204
with-cookie: 200
token present in body: 0
```

Body was the real snapshot (`needs-auth` claude row + codex gauges), proving
the hub cached a `Usage` frame from the daemon over its own 60 s tick.

**7. Browser control surface unchanged.** A unit test enumerates every
`BrowserMsg` and asserts none maps to `GetUsage`, `Snapshot`, or
`ReportRunState`. Usage reaches a browser only over the authenticated HTTP
route the server owns.

## Not verified here

- **The desktop pill and dialog in a live GUI.** Component behaviour is covered
  by `usagePanel.test.ts` / `usageView.test.ts`, and the bundle builds, but the
  rendered toolbar was checked only after deployment to the real app.
- **A real phone** over the tailnet (needs the user's device); the Pocket row is
  unit-tested and the payload it reads was verified over HTTP.
- **macOS / Windows.** The collectors are portable std code (the `RunOutput`
  seam exists so no test needs a unix-only `ExitStatus`), but neither platform
  was run.
- **A `curl` binary that is missing entirely** — handled as `state:"error"` by
  construction and unit-tested through the runner seam, not exercised live.

## Notes for the next reader

- A running daemon must be **restarted** to answer `GetUsage`; an older one
  replies `Error`, which the CLI surfaces as a message and the pill renders as
  "unknown" (it hides rather than showing a zero).
- `amber web` must likewise be restarted before `/api/usage` exists.
- The claude token is read per poll, passed only as a `curl` argv element, and
  never logged, persisted, or placed in any frame or HTTP body.
