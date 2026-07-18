# Memory Monitor + Soft Throttle — Design

**Date:** 2026-07-17
**Status:** Slice 1 approved (monitor); Slice 2 designed (throttle, deferred)

## Problem

A pane's child process (usually `claude`, sometimes a runaway user command) can
grow without bound. amber's *own* memory is already capped — scrollback `Ring`
(~2 MiB/session), subscriber queues (8 deep), reader channel (32) — so the
uncontrolled memory is entirely in the **child processes**. Live example on the
dev box: the `amber.service` cgroup reads `memory.current` = **10.7 GB** across
all sessions. The user wants a monitor that throttles memory-hungry
panels/sessions "intelligently."

## Core truths (shape the whole design)

- You **cannot shrink a process's memory from outside**. You can only (a) *cap*
  it (cgroup / rlimit → OOM at the ceiling), or (b) *evict/restart* it. True
  *throttling* — slow allocation under pressure, no kill — exists only as Linux
  cgroup v2 **`memory.high`**.
- `memory.high` throttles by forcing reclaim. A leak is anonymous heap;
  anonymous pages reclaim only to **swap**. **With swap** (dev box: 8 GB) the
  process swaps out and slows gently — the promised UX. **Without swap** the
  same knob degrades to allocation-stall (near-freeze). Efficacy is
  swap-dependent; document it, don't hide it.
- cgroups are **Linux-only**. macOS degrades to `/proc`-equivalent monitor +
  warn, no throttle.

## Decisions (settled with user + advisor review)

- **Target:** child processes (not amber's own memory, not renderer panes).
- **Aggressiveness:** soft throttle (`memory.high`), never OOM-kill by default.
- **Monitor first, throttle second.** The monitor is zero-risk,
  cross-platform-degradable, and the prerequisite for any throttle decision.
- **Static `memory.high = f(total RAM, live session count)`, NOT an adaptive
  chase.** A "set high just above current, relax when growth stops" control loop
  oscillates or chases the ceiling upward (defeating itself). Instead: a static
  soft cap; growth-rate detection drives only the **UI warning** and **which
  session to tighten first under global pressure** — never a per-session loop.
  Keeps the decider a pure, testable function.
- **Exempt the focused session AND the daemon's own supervision.** The throttle
  must never target the pane the user is actively driving. Focus is renderer
  state, so the app sends the daemon a "focused session" hint (small control
  frame). The session running the user's live Claude/agent (e.g.
  `amber-1-1-0-…`, which is where this very agent runs) is typically the focused
  one — exempting focus covers the self-throttle hazard.
- **Never silently kill.** Warn in the UI first. A hard `memory.max` ceiling is
  a separate opt-in, routed through the supervisor (restart → shell fallback),
  out of scope for these slices.

## Slice 1 — Monitor (this slice; no daemon restart, no cgroups)

Read each session's child-process-tree RSS from `/proc`, broadcast it, surface
per-pane MB + a "growing" badge. Uses `/proc` (not cgroups) so it needs **no
cgroup restructure and no daemon restart** — a running daemon picks it up on the
next normal restart, and nothing about process placement changes.

### Daemon

- **`procmem` (pure, Linux):** given a root pid, sum RSS across the pid + its
  descendants. RSS per pid from `/proc/<pid>/statm` field 2 (resident pages) ×
  page size, or `/proc/<pid>/smaps_rollup` `Rss:` for accuracy. Descendants via
  `/proc/<pid>/task/*/children` (cheap, kernel-maintained) or a `ppid` scan of
  `/proc/*/stat`. Pure over an injected "proc reader" so it unit-tests with fake
  fixtures (no real `/proc`). Returns `rss_kb`.
- **Monitor thread:** every `mem_poll` (config, default 3 s) walk live sessions
  (`PtySession.pid`), compute `rss_kb`, and `watchers.broadcast(MemoryStat)`.
  Rides the **existing bounded watcher broadcast** (same path as `Activity` /
  `ReportRunState` — bounded per-watcher queue + forwarder + laggard eviction),
  so it can never stall the daemon. Skip sessions whose pid is gone.
- **Growth detection (pure):** keep a short ring of recent samples per session;
  flag `growing` when RSS climbs monotonically over the window past a delta.
  Emitted as a bool in `MemoryStat` (the app needn't recompute).

### Protocol

- New `ControlMsg::MemoryStat { name: String, rss_kb: u64, growing: bool }`,
  `#[serde(default)]` on the additive fields for wire back-compat (the app
  decodes unknown control frames tolerantly already). Mirrors `Activity`.

### App

- `store` reducer records `rss_kb` + `growing` per session (like `run_state`).
- Pane header shows a compact `MB` figure; a warning badge (⚠ / amber dot) when
  `growing` or over a display threshold. Reuses the existing dot/badge slots.
- Tab dot aggregates (a tab with a growing pane gets a subtle marker).

### Gates (Slice 1)

- Rust: pure `procmem` (pid-tree sum over fake fixtures) + growth detector
  unit-tested; monitor thread integration-tested with a stub session; clippy
  clean.
- App: proto round-trip; store reducer; typecheck + vitest.
- Degradation: non-Linux → monitor no-ops (no `/proc`); the app simply shows no
  MB. No hard dependency on cgroups.

## Slice 2 — Soft throttle (designed, deferred; needs restart + unit change)

Linux cgroup v2 `memory.high`. Requires the daemon to restructure its cgroup:

- **Unit:** add `Delegate=memory` to `amber.service` (reboot-persistent
  delegation; the current mkdir works only via default user delegation).
- **Daemon start (Linux, cgroup v2, `memory` in `cgroup.controllers`):** move
  self → `amber.service/_daemon/` leaf, write `+memory` to
  `amber.service/cgroup.subtree_control` (cgroup v2 "no internal processes"
  rule — the daemon+children can't sit directly in a cgroup that has controlled
  children). Idempotent + before any child spawns; the **restore path** must
  place re-spawned children into cgroups too.
- **Per session:** `mkdir s-<name>/`, write child pid → `cgroup.procs`, set
  static `memory.high`. `memory.current` then also gives an exact per-session
  RSS — Slice 2 can source the monitor from cgroups instead of `/proc`.
- **Policy (pure decider):** `decide(samples, total_ram, live_count, focused) →
  { target_high per session, warn? }`. Static cap; focused/self exempt;
  growth-rate picks which session to tighten under global pressure. Unit-tested
  with sample sequences.
- **rmdir** the session cgroup after the child exits.
- **Alternative to evaluate:** `systemd-run --scope -p MemoryHigh=` offloads the
  no-internal-processes dance to systemd — but its interaction with
  portable-pty's controlling-tty spawn needs checking before adopting.

Deploying Slice 2 restarts the daemon (sessions restore with scrollback).

## Slice 3 — Freeze → claude suspend/resume (designed, deferred)

A different lever than throttling: **actually free a parked claude pane's RAM**
by killing its child and resuming it on unfreeze. This is *manual, per-session
reboot survival* — it reuses the existing restore/spawn path and the claude
`--resume <id>` ladder (core rules #6/#7), so most of the machinery exists.

**Decisions (settled with user):**
- **Scope: claude panes only.** A claude child (Node) is the real RAM hog and
  resumes cleanly (`claude --resume <recorded-id>`; the transcript lives under
  the alt screen and redraws on resume). **Shell panes keep today's
  display-only freeze** — a shell's state *is* its process memory (env, shell
  vars, running foreground programs, in-memory history); killing it would
  discard all of that (only cwd survives), so shells are excluded.
- **Trigger: after a grace delay.** Freeze parks the pane (display-only) now;
  the daemon kills the claude child only if it stays frozen ≥ `suspend_grace`
  (config, e.g. 30 s). A brief freeze/unfreeze pays nothing; a long park frees
  the RAM. Unfreeze before the grace = no kill, no resume cost.

**Mechanism:**
- New control msgs `Suspend { name }` / `Resume { name }`. `Suspend` kills the
  child but **retains** the session metadata (name, cwd, kind, recorded claude
  id) and marks it suspended; `Resume` respawns from that metadata via the
  restore path. The reap timer must **skip suspended sessions** (their child
  exited on purpose — never destroy the record). New `run_state` = `"suspended"`
  so the UI shows a distinct parked-and-freed state vs plain frozen.
- App: the freeze gesture starts a per-pane grace timer (claude panes only);
  on expiry → `Suspend`; unfreeze → `Resume` (and cancel a pending timer).
  Reuses the existing frozen overlay; resume triggers the daemon repaint nudge.

**Risks:** unfreeze latency = a full claude relaunch+resume (seconds); a claude
whose recorded id is stale/rotated falls through the resume ladder to a fresh
start (same as reboot restore — acceptable). Deploying restarts the daemon.

## Out of scope

- Renderer-pane LRU eviction (a separate lever for the keep-alive footprint;
  not what the user chose to target).
- Hard `memory.max` OOM ceilings (separate opt-in).
- Windows.
