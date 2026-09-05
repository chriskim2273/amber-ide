# Agent usage-limit tracking — design

**Status:** initial implementation shipped; live Codex correction implemented
and tested in an isolated worktree (2026-09-05), pending production activation.
The amendment below supersedes the Codex source/labels in §1.3 and updates the
refresh/staleness behavior in §1.5, §2–4.

## 2026-09-05 live Codex correction

Confirmed failure: the newest local rollout sample reported 53% in a
10,080-minute primary window, while a direct account read reported 81% (83%
by the later compiled-collector smoke). The old UI labelled primary as 5h and
stamped old data with each poll's current time. Codex usage from Pi did not
update those CLI rollout logs.

- Production now invokes the locally installed `codex app-server --listen
  stdio://` on the daemon's background collector thread. It initializes the
  connection, reads `account/read` with `refreshToken:false`, checks ChatGPT
  login, then calls `account/rateLimits/read`. No conversation, model turn,
  login, reset-credit consumption, TCP listener or token copying is requested.
  Codex owns its normal authentication behavior; Amber never handles its token.
- `rateLimitsByLimitId` is preferred over the legacy single bucket. Quota
  buckets remain distinct (including the separate `codex_bengalfox` bucket).
  Labels come from actual `windowDurationMins`, never primary/secondary position.
- Each helper is owned and reaped, capped at 8 seconds plus bounded cleanup and
  1 MiB of stdout. Raw RPC errors/account metadata are not sent to the UI.
  Missing Codex/API-key auth/offline/errors produce an explicit unavailable
  result, never zero usage. Linux is live-tested; macOS uses the same Unix
  implementation and remains manually unverified. Windows reports unavailable
  rather than pretending its old logs are live.
- The normal poll is approximately 60 seconds. Additive `RefreshUsage` only
  wakes the collector and returns the current cache immediately. Repeated
  requests coalesce; at most one collection per ten seconds, never concurrent
  quota-reader subprocesses. `GetUsage` remains a pure cache read.
- On failure, retain the last successful timestamp but mark all its gauges
  stale and the row non-ok (no numerical UI). Successful Codex samples also
  expire after three minutes if the poller or connection stops progressing.
  The dialog shows source and age, with a Refresh usage action. The action
  remains accessible when all usage rows are unavailable; the open dialog polls
  the daemon cache every three seconds, not the provider.
- Web `POST /api/usage` requests the same background refresh behind existing
  cookie auth and same-origin validation. `GET` refreshes only the hub's daemon
  cache. No browser WebSocket control permissions were widened.

Verification: parser and fake stdio-server tests cover window metadata, bucket
separation, read-only RPC ordering, login gate, sanitized errors, timeout and
output bounds. Cache/UI tests cover old and failed snapshots; private daemon
and web tests cover cache-only refresh, 401 unauthenticated and 403 cross-origin
POST. Explicit opt-in compiled collector smoke used installed Codex 0.149.1:
`AMBER_CODEX_QUOTA_SMOKE_BIN=/path/to/codex cargo test -p amber --lib
codex_usage::tests::live_quota_smoke -- --ignored --nocapture`.
The Codex and Pi login account IDs were compared locally and matched; no IDs,
emails or tokens were printed. This is a point-in-time check: changing either
login can make them diverge, so the UI says Codex login, not Pi-account quota.

Official contract: <https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md>.
Final combined validation: 849 Rust tests passed twice (two explicit opt-in
ignores), 778 app tests passed (one intentional skip), all five generated Pi
extension tests passed, warnings-as-errors clippy, TypeScript checks, desktop
and web builds, and `git diff --check` passed. Web build retains its existing
large-chunk warning. Native GUI refresh gestures and macOS remain unverified.
No production binary, extension, daemon or app was replaced during this pass.

## Context

Amber runs supervised agent panes (claude, codex, grok, opencode, pi, hermes)
all day. The question the user actually has is "how much of my plan do I have
left this week?" — and today the only way to answer it is to leave amber, open
each agent's own UI, and read a number that amber already has the credentials
and files to fetch.

This spec adds one read-only quota surface, owned by the daemon, shown as a
toolbar pill + dialog on the desktop and a compact row in Pocket.

### What each provider actually exposes (probed on this box, 2026-09-01)

| Agent | Source | Verified |
|---|---|---|
| **claude** | `GET https://api.anthropic.com/api/oauth/usage`, `Authorization: Bearer <claudeAiOauth.accessToken>` from `~/.claude/.credentials.json`, `anthropic-beta: oauth-2025-04-20`. This is the call `/usage` makes (endpoint string found in the `claude` binary). | **HTTP 200 live.** Returned `five_hour{utilization:15.0, resets_at:"2026-09-02T06:00:00Z"}`, `seven_day{utilization:2.0, resets_at:"2026-09-06T05:00:00Z"}`, plus a `limits[]` array and `extra_usage`/`spend` blocks. |
| **codex** | `~/.codex/sessions/**/rollout-*.jsonl`, `token_count` events carrying `info.rate_limits`. | **Live sample:** `{"limit_id":"codex_bengalfox","limit_name":"GPT-5.3-Codex-Spark","primary":{"used_percent":0.0,"window_minutes":300,"resets_at":1788161651},"secondary":{"used_percent":0.0,"window_minutes":10080,"resets_at":1788748451},"plan_type":"pro","rate_limit_reached_type":null}`. Many events carry `"rate_limits":null`. |
| **grok** | **None.** No `x-ratelimit` header string, no usage/quota endpoint in `~/.grok/bin/grok`; `~/.grok/logs/unified.jsonl` carries no token or limit data; sessions are an FTS sqlite index. The binary's `rate_limit` string is a *hook/error event name* (it fires when a turn is blocked), not a gauge. | Probed; nothing found. |

Decisions locked with the user:

- **Placement: the daemon**, shelling out to `curl` for the one HTTPS call.
  Rejected alternatives: Electron main (app-local ⇒ a Pocket phone or an
  SSH-remote window would read the *local* machine's `~/.claude`, i.e. the
  wrong machine's quota — the exact class of bug `resolveSocketPath` and the
  read-only layout mirror exist to prevent) and `amber-router` (links
  reqwest-rustls already, but it is an LLM proxy, not a telemetry service, and
  it would add a router→daemon hop).
- **Rule #8 is not violated.** It constrains what `amber`/`amberd` *link*, not
  what they *invoke* — the same reading already applied to `login_path()`'s
  login-shell call and to `systemctl --user show-environment` in the pane
  display-env fix. No new Cargo dependency is added by this spec.
- **grok is out of scope.** It gets a row that says its quota is not exposed,
  never a number.

## Non-goals (v1)

Notifications or threshold alarms; usage history/charting; per-pane token or
cost attribution; a budget the user types in; anything that would let a client
*change* quota state. Grok-blocked detection via a grok `rate_limit` hook is
explicitly deferred, not designed here.

**No derived percentages, ever.** A gauge is rendered only from a number the
provider itself reports. Amber never divides transcript tokens by a guessed
plan limit: "how much is left" is precisely the number the user does not know,
so a synthesized one would be this feature wearing a mask. Where there is no
source, the UI says so.

## 1. Daemon: `crates/amber/src/usage.rs`

### 1.1 Shape

```rust
pub struct Gauge {
    pub kind: String,           // "session" | "weekly" | provider's own kind
    pub label: String,          // "5h window" | "weekly"
    pub percent: f64,           // 0..=100, USED
    pub resets_at: Option<i64>, // unix seconds
    pub stale: bool,            // resets_at is in the past — window rolled
}

pub struct ProviderUsage {
    pub provider: String,           // "claude" | "codex" | "grok"
    pub plan: Option<String>,       // "pro", from the provider
    pub gauges: Vec<Gauge>,
    pub updated: u64,               // unix seconds of this sample
    pub state: String,              // "ok" | "unavailable" | "needs-auth" | "error"
    pub detail: Option<String>,     // human reason when state != "ok"
}
```

`percent` is USED; the UI derives remaining. Keeping the wire in the
provider's own units means a provider that changes its reporting does not
silently invert a bar.

### 1.2 claude collector

1. Resolve the config dir: `$CLAUDE_CONFIG_DIR` else `~/.claude`. Read
   `.credentials.json`.
2. Missing file / no `claudeAiOauth` ⇒ `state:"unavailable"`,
   `detail:"claude not logged in"`.
3. `expiresAt` (ms) in the past ⇒ `state:"needs-auth"`,
   `detail:"claude token expired — run claude to refresh"`. **Amber never
   refreshes the token itself**: minting or rotating a credential as a side
   effect of a read-only status poll is the mistake `load_token()` was added to
   avoid in the remote-access pass. Claude Code refreshes it in the normal
   course of use, and the next poll picks the new one up.
4. Otherwise spawn `curl -sS --max-time 5 -H 'Authorization: Bearer <token>'
   -H 'anthropic-beta: oauth-2025-04-20'
   https://api.anthropic.com/api/oauth/usage`. The token is passed as an argv
   element of a process amber spawns; it is **never** logged, never written to
   the state store, and never placed in any frame sent to any client.
5. Parse. **Prefer `limits[]`** — each entry is
   `{kind, group, percent, severity, resets_at, is_active}`, i.e. a
   server-driven list that already names its own windows. Map
   `group:"session"`→`label:"5h window"`, `group:"weekly"`→`"weekly"`, any
   other group through with its `kind` as the label. Fall back to the
   `five_hour` / `seven_day` objects when `limits` is absent or empty. The
   codename-keyed fields (`tangelo`, `iguana_necktie`, `nimbus_quill`, …) are
   deliberately **not** parsed: they are unstable server-side experiment slots.
6. Non-zero curl exit, timeout, non-JSON body, or an HTTP error body ⇒
   `state:"error"` with a short `detail`. One provider failing never affects
   the other.

### 1.3 codex collector

1. Resolve `$CODEX_HOME` else `~/.codex`; walk `sessions/` (layout is
   `YYYY/MM/DD/rollout-*.jsonl`).
2. Visit files newest-first **by mtime**, and within a file scan lines from the
   end. Take the first `rate_limits` that is **non-null** — the newest rollout
   file frequently has `"rate_limits":null` throughout (observed), so "newest
   file" is the wrong rule and would report nothing.
3. Map `primary`→`{kind:"session", label:"5h window"}` and
   `secondary`→`{kind:"weekly", label:"weekly"}` using each block's
   `used_percent` and `resets_at`; carry `plan_type` as `plan`.
   `window_minutes` (300 / 10080) is a cross-check, not the label source.
4. **`resets_at` in the past ⇒ `stale:true`.** The window has rolled since that
   record was written, so the stored `used_percent` describes a window that no
   longer exists. The UI renders stale as "window rolled — reopen codex", never
   as a number.
5. Bound the walk: at most 200 files and 2 MiB read per file (tail-first), so a
   large `~/.codex` cannot turn a 60 s poll into a disk storm.
6. No sessions dir / no non-null record ever found ⇒ `state:"unavailable"`,
   `detail:"no codex usage recorded yet"`.

### 1.4 grok collector

A constant: `state:"unavailable"`, `detail:"grok exposes no quota data"`. It
exists so the UI can say so honestly rather than omitting a kind the user runs.
**Grok's quota is not inferred from pane bytes.** The repo already ruled on
that class of inference in the Pocket pass ("waiting is NEVER inferred from TUI
bytes"); scraping a TUI for a limit banner is the same antipattern.

### 1.5 Poller

One thread, started with the daemon, refreshing every **60 s** into
`Arc<Mutex<Vec<ProviderUsage>>>`. It runs off every connection read thread —
the head-of-line rule this repo has been bitten by twice (the backlog HOL fix,
the watcher broadcast fix). A `GetUsage` handler returns the cached snapshot
immediately and never blocks on curl or disk.

Cadence rationale: a 5h window moves ~0.33%/minute at full burn, so 60 s is
already finer than the number's own resolution, and it is one HTTPS request per
minute against the user's own account.

## 2. Protocol

Additive, in `amber-core::proto`:

```rust
ControlMsg::GetUsage,                       // client -> daemon
ControlMsg::Usage { providers: Vec<ProviderUsage> },  // daemon -> client
```

Both `#[serde(default)]` on every optional field, matching the wire discipline
of `SessionInfo` — an older client that never sends `GetUsage` is unaffected,
and an older daemon that does not know it replies `Error`, which the app
already surfaces (and which the pill renders as "unknown", not as zero).

Mirrored in `app/src/shared/proto.ts`, decode-side, with the same strictness as
the existing decoder (unknown keys throw — so `ProviderUsage` must be added
there in the same change).

**Not pushed.** `Usage` is never broadcast through the watcher registry: the
bounded per-watcher queue exists to carry session lifecycle, and adding a
once-a-minute payload for every connected client risks the laggard eviction
path for data that a poll answers exactly as well.

## 3. `amber web` / Pocket

`amber web`'s hub already polls the daemon every 1 s for sessions. It gains a
**separate 60 s** `GetUsage` tick, cached, served as authenticated
`GET /api/usage` behind the same session-cookie boundary as `/api/sessions`.

**The browser control whitelist is NOT widened.** `map_browser_msg` stays
exactly as it is: usage rides an HTTP route the server owns, so no new
`ControlMsg` becomes reachable from a browser socket, and
`Snapshot`/`ReportRunState` remain categorically unreachable. (This refines the
in-chat sketch, which had said `GetUsage` would be whitelisted; an HTTP route
is strictly the smaller surface.)

The mobile UI shows one compact row in the Sessions header — tightest active
gauge per provider — expanding to the same list the desktop dialog shows.

## 4. Desktop UI

**Pill** in the toolbar, beside the router and remote-access pills. It shows
the *tightest active* gauge across providers, as remaining:
`⏳ 85% left`. Colour: normal < 70% used, warning ≥ 70%, danger ≥ 90%.
All-unavailable ⇒ the pill is hidden entirely rather than shown broken (the
lesson from the web build's permanently-red remote pill: `managed`-style
gating from day one, so the Pocket/web shim never paints a dead badge).

**Dialog** on the repo's own `.help-overlay` / `.help-card` shell (inventing
CSS classes is the mistake the remote-access pass shipped and had to undo):

```
claude · pro                          resets
  5h window    ███░░░░░░░  85% left   in 4h 12m
  weekly       █░░░░░░░░░  98% left   Sat 06 Sep

codex · pro
  5h window    ░░░░░░░░░░ 100% left   in 2h 03m
  weekly       ░░░░░░░░░░ 100% left   in 6d

grok          quota not exposed by grok
```

Non-`ok` states render as words, never numbers: `needs-auth` →
"log in with claude to see usage"; `stale` → "window rolled — reopen codex";
`error` → the short detail; `unavailable` → the reason.

Cadence: pill polls every 60 s (matching the daemon's own refresh — polling
faster only re-reads the same cache); the open dialog polls every 15 s so a
manual refresh feels live.

## 5. Testing

Pure parsers, TDD'd, no network in any test:

- claude: `limits[]` → gauges; `limits` absent → `five_hour`/`seven_day`
  fallback; both absent → `unavailable`; expired `expiresAt` → `needs-auth`
  **without** a spawn (asserted via the runner seam); malformed JSON → `error`;
  **no test fixture or assertion contains a real token**, and a test asserts
  that a rendered `ProviderUsage` contains no substring of the input token.
- codex: null-`rate_limits` lines skipped; newest non-null wins across files;
  `resets_at` in the past ⇒ `stale`; empty dir ⇒ `unavailable`; the file/byte
  bounds hold on a synthetic large tree.
- The HTTPS call sits behind a small runner seam (a trait or `fn(&[&str]) ->
  io::Result<Output>`) so collectors are tested against captured bodies.
- App: `proto.ts` round-trip for `GetUsage`/`Usage`, and the pure
  percent→remaining/colour/reset-countdown formatting.

Live verification, per repo habit, against an **isolated private daemon**
(private `XDG_STATE_HOME`, short `/tmp` socket) and a private `amber web`:
claude gauge matches what `claude`'s own `/usage` prints at the same moment;
codex gauge matches the newest non-null record; a hand-corrupted
`.credentials.json` yields `needs-auth` and no spawn; grok renders its
unavailable row; `/api/usage` 401s without a cookie; and a `curl` blackholed to
a dead host leaves the codex gauge unaffected.

## 6. Files touched

- `crates/amber/src/usage.rs` (new), registered in `lib.rs`.
- `crates/amber-core/src/proto.rs` — `GetUsage`, `Usage`, `ProviderUsage`,
  `Gauge`.
- `crates/amber/src/daemon.rs` — handler returning the cached snapshot;
  `manager.rs` or `main.rs` — poller startup.
- `crates/amber/src/web.rs` — 60 s usage tick + `GET /api/usage`.
- `crates/amber/src/main.rs` — `amber ctl usage [--json]`, the CLI mirror
  (every daemon surface in this repo has one).
- `app/src/shared/proto.ts`, `app/src/main/` IPC + preload,
  `app/src/renderer/` pill + dialog, mobile Sessions header row.
