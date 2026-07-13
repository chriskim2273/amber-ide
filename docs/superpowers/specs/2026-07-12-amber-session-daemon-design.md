# Amber Session Daemon — Design Spec

Status: **draft, awaiting user review**
Date: 2026-07-12
Branch: `feat/rust-session-daemon`
Supersedes: the tmux + tmux-resurrect + tmux-continuum persistence spine (Phase 1) and the
deferred custom-daemon (Phase 7) in the original `CLAUDE.md`.

---

## 0. Magnitude notice (read first)

This is **not an amendment** to the existing constitution — it is a different substrate.
Adopting it obsoletes `CLAUDE.md` rules 1–6 (tmux as source of truth, control-mode layer,
no-Rust, no-Windows, no-native-modules) and the entire Phase 1–7 plan. **`CLAUDE.md` must be
rewritten**, not edited in place; a constitution that says "re-read every session" while the
code contradicts it will actively mislead future sessions.

Realistic size: **weeks, not one session.** Therefore this spec defines the full target
design but sequences the build **slice-first** (§11): the risky spine is proven end-to-end
before any breadth. Nothing broad is built until the slice passes its exit test.

### Decision log (how we got here)

- Reported symptom: after machine reboot, tmux sessions + scrollback restored, but Claude
  panes were **not relaunched**.
- Falsified root causes (verified live this session, not assumed):
  - **PATH** — red herring. resurrect relaunches into `exec bash -l`, a login shell that
    re-adds `~/.local/bin`. `command -v claude` → found.
  - **resurrect match gate** — fires correctly; inline strategy yields
    `claude --dangerously-skip-permissions --continue`.
  - **send-keys eaten by `cat <historyfile>`** — falsified: `cat FILE` does not read stdin;
    keys buffer in the pty and the subsequent `bash -l` consumes them (tested with a 3.2 MB
    contents file).
- Remaining plausible + deterministic cause: **a TUI (claude) spawned detached at boot
  exits or misbehaves.** Unproven (needs a real reboot) and, critically, **it is the same
  condition this daemon must handle** — see §6.3. It is therefore a first-class requirement,
  not a justification.
- **The rebuild is justified by distribution, cross-platform reach, and performance — not by
  the tmux bug** (which is likely a one-line fix). See §1.

---

## 1. Why replace tmux (the actual justification)

For a **distributable, cross-platform, performant** terminal IDE, an external tmux dependency
is a long-term liability:

- **Distribution:** requires installing/pinning tmux ≥ 3.4, vendoring resurrect + continuum.
  A single self-contained binary has none of that friction.
- **Double emulation:** the app renders with xterm.js (a full terminal emulator); tmux runs
  its own emulation underneath. Dropping tmux removes one emulator and the **entire
  control-mode tax** (octal `%output` unescaping, per-pane control clients, `%pause`/`%continue`
  flow-control protocol, event-scoping quirks).
- **Cross-platform:** tmux has no native Windows build. `portable-pty` (ConPTY on Windows,
  Unix PTY elsewhere) keeps the Windows door open even though Windows is deferred for now.
- **Performance:** raw-byte passthrough with our own backpressure is simpler and faster than
  control-mode framing.

What we give up (accepted): tmux's 20 years of battle-testing, and *free* `tmux attach` — we
must build `amber attach` ourselves.

---

## 2. Architecture

One Rust binary, `amber`, busybox-style subcommands. One long-lived **daemon** owns
everything; clients are disposable.

```
            systemd user unit (Linux) / launchd agent (macOS)  — starts at boot
                                   │  amber daemon
                                   ▼
 ┌──────────────────────── amber daemon ────────────────────────┐
 │  session table: name → { cwd, kind, pty, child, ring, subs }  │
 │  portable-pty  (spawn shell / claude, resize, read/write)     │
 │  scrollback ring per session (capped raw bytes)               │
 │  supervisor    (claude resume/continue, bounded restart)      │
 │  snapshot      (timer + SIGTERM → state store, atomic)        │
 │  restore       (on start: respawn sessions from state store)  │
 │  listener      (unix socket; framed protocol; N clients)      │
 └───────────────────────────────────────────────────────────────┘
        ▲ socket                         ▲ socket
   Electron app                      `amber attach` CLI
   (raw bytes → xterm.js)            (raw-mode terminal proxy)
```

Subcommands:

| Command | Role |
|---|---|
| `amber daemon` | run the daemon (the boot unit runs this) |
| `amber attach <name>` | raw-mode terminal client — the `tmux attach` replacement |
| `amber ls` / `new` / `kill` / `rename` | session control via the socket |
| `amber hook` | Claude `SessionStart` hook — records session_id |
| `amber ctl install \| uninstall \| doctor \| status \| snapshot-now` | lifecycle / diagnostics |

Constitution-level rules that **survive** the substrate change: every app pane = one session
(1 logical terminal), grouping encoded in the session **name** (`amber-<ws>-<tab>-<ord>-<id>`)
so grouping survives reboot with no app persistence; the app holds zero authoritative state;
raw bytes never require the Electron main process to parse terminals (daemon ↔ renderer only).

---

## 3. Session model & state store

A **session** = one pty + one child process (`$SHELL` or `claude`) + a scrollback ring +
zero-or-more subscribers.

State store — `$XDG_STATE_HOME/amber-ide/` (default `~/.local/state/amber-ide/`), atomic
writes (temp + `rename`), one file per session so a partial write can never corrupt the set:

```
config.toml                claude_path, snapshot_interval_secs (10), scrollback_bytes (2 MiB)
sessions/<name>.json       { name, cwd, kind: "shell"|"claude", updated }
claude/<name>.json         { session_id, cwd, updated }   ← written by `amber hook`
scrollback/<name>.bin       capped raw output bytes (both kinds; see §5)
runtime/amberd.sock         unix socket (0600), under $XDG_RUNTIME_DIR when available
```

Missing/partial files are tolerated: no `sessions/<name>.json` → session gone; no
`claude/<name>.json` → fall back to `--continue`; no scrollback → empty history.

---

## 4. Protocol (client ↔ daemon)

Length-prefixed frames over the unix socket. Control frames are small structs (serde;
CBOR/msgpack); pty output is a raw-bytes frame with a session id header — **no per-byte
escaping** (the control-mode tax we are removing).

- client → daemon: `Hello`, `ListSessions`, `Create{name,cwd,kind}`, `Attach{name}`,
  `Detach{name}`, `Input{name, bytes}`, `Resize{name, cols, rows}`, `Kill{name}`,
  `Rename{from,to}`.
- daemon → client: `SessionList`, `Output{name, bytes}`, `Created/Killed/Renamed`,
  `Exit{name, code}`, `Error{msg}`.

Multiple clients may attach one session (app + CLI simultaneously); input is interleaved,
output is fanned out to all subscribers.

---

## 5. Scrollback & reconnect

The daemon keeps a **capped raw-byte ring** per session (default 2 MiB, configurable). Every
pty output chunk appends to the ring and fans out to live subscribers.

- **On attach:** daemon sends the ring contents first, then live output. Feeding raw bytes to
  xterm.js reproduces screen + scrollback exactly — no server-side vt parsing.
- **Persistence:** the ring is flushed to `scrollback/<name>.bin` by the snapshot path (§7).
- **Reconnect semantics differ by client** (a real trap, called out):
  - *xterm.js (app):* raw-byte replay is clean — xterm is a full emulator.
  - *plain terminal (`amber attach`):* replaying raw bytes that include alt-screen /
    cursor-move sequences into a cold terminal can corrupt it. `amber attach` must reset the
    terminal, and for an alt-screen child (claude) rely on the child's next repaint rather
    than replaying historical alt-screen bytes. Shell sessions replay cleanly.

---

## 6. Supervision (the deterministic relaunch)

The daemon spawns and owns each child directly — **no send-keys, ever.**

### 6.1 Shell session
`spawn $SHELL -l` in `cwd`. Ring pre-loaded from `scrollback/<name>.bin` so a reattaching
client sees prior history. Child exits → session ends (matches "close the pane").

### 6.2 Claude session
```
env AMBER_SESSION=<name>, AMBER_STATE_DIR=<state>
claude = config.claude_path            (resolved via login shell — §8)
loop (bounded: N restarts, exponential backoff):
    id = claude/<name>.json.session_id
    id ? claude --dangerously-skip-permissions --resume <id>   --settings <gen>
       : claude --dangerously-skip-permissions --continue      --settings <gen>
    clean exit (user quit) → break
    crash            → backoff, retry; exhausted → drop to $SHELL with a visible notice
fallthrough → exec $SHELL -l           # a session never silently dies
```
`--settings <gen>` injects a `SessionStart` hook = `amber hook`, which writes
`claude/$AMBER_SESSION.json` **on every fire** (session_id rotates on resume/clear/compaction —
last write wins). This is the original Phase-6 precise-resume, folded in from the start, so
**two claude sessions in the same directory resume their own conversations**.

### 6.3 Detached-TUI-at-boot (the point-4 trap — MUST prove, not assume)
At boot the daemon respawns claude with **no client attached**. Decisions:
- **Default pty size** on spawn: 80×24 (configurable); real size applied on first `Attach`
  via `Resize`. The child must never be spawned with a 0×0 pty.
- **Zero-subscriber behavior:** the daemon always drains the pty (into the ring) even with no
  subscribers, so the child is never blocked on a full pty and never sees EOF/zero-size that
  makes a TUI exit. Backpressure (§9) only engages when a *subscriber* is slow, never when
  there are none.
- This is the exact failure mode that plausibly broke the tmux relaunch; the slice exit test
  (§11) proves a real TUI survives respawn-while-detached + later attach.

---

## 7. Snapshot / restore / reboot

- **Snapshot** (owned by the daemon; replaces continuum): every `snapshot_interval_secs`
  (default 10) write changed `sessions/*.json` + flush each ring to `scrollback/*.bin`, atomically,
  skipping unchanged (content hash). Also snapshot on any structural change (create/kill/rename).
- **Pre-reboot gap:** the daemon installs a **SIGTERM handler → final snapshot**. systemd sends
  SIGTERM on stop/reboot before killing the unit (with `TimeoutStopSec` headroom); launchd sends
  SIGTERM on logout/shutdown. This closes continuum's known "detached server saves nothing" gap
  on Linux; macOS keeps at most a `snapshot_interval` residual gap (documented).
- **Restore** (replaces resurrect restore + the `_amber-boot`/merge dance, which are **deleted**):
  on `amber daemon` start, read `sessions/*.json` and respawn each session per §6, pre-loading its
  ring. No bootstrap session, no merge hazard — the daemon creates real sessions directly. Empty
  state → daemon idles with zero sessions (valid).

---

## 8. Claude-resolution contract (distribution)

Never depend on the daemon's own PATH (the very bug we found). At install, `amber ctl doctor`
resolves via a login shell — `$SHELL -lic 'command -v claude'` — and stores the absolute path in
`config.toml:claude_path`. At runtime the daemon uses it; if missing/stale it re-resolves the
same way and rewrites config. Portable across machines and shells.

---

## 9. Performance

- **Backpressure:** per-subscriber write-buffer watermark. A slow subscriber → daemon stops
  draining that subscriber's queue and, if all subscribers are saturated, stops reading the pty →
  the child blocks (the `cat 1 GB` case stays flat in memory). With **no** subscribers the pty is
  still drained into the (capped) ring, so memory is bounded by ring size, not child output.
- **Output batching:** coalesce pty reads into ~16 ms frames per session before fan-out (matches
  the app's render cadence); never one frame per read.
- Ring is a fixed-capacity byte buffer (overwrite oldest); no unbounded growth.

---

## 10. Boot units & packaging

- **Linux:** `amber.service` (user unit) `ExecStart=amber daemon`, `Restart=on-failure`,
  `TimeoutStopSec` for the final snapshot; `loginctl enable-linger` so it starts at boot before
  login. Socket owned by the daemon (0600).
- **macOS:** `com.amber-ide.daemon` launchd agent, `RunAtLoad` + `KeepAlive`.
- **Binary:** one `amber`, Cargo workspace (`amber-proto`, `amber-pty`, `amber-state` libs +
  `amber` bin). Cross-compile: Linux x86_64/aarch64 (musl static), macOS universal
  (x86_64+aarch64). No external runtime deps.
- `amber ctl install` writes units + `config.toml` (+ `doctor`), idempotent; symmetric uninstall.

---

## 11. Build sequence (slice-first — the actual work order)

**Slice 0 — prove the spine (this is the de-risking gate; nothing broad until it passes):**
1. `amber daemon` spawns **one shell** in a pty (portable-pty), drains output → capped ring.
2. `amber attach` connects over the socket, raw-mode proxy: stdin→`Input`, `Output`→stdout,
   SIGWINCH→`Resize`. Live typing round-trips.
3. Snapshot ring+metadata to state; **kill the daemon; restart it**; reattach → scrollback and
   live input both intact.
4. **Repeat step 3 with a real TUI child** (e.g. `vim`/`htop`) spawned **detached**, attach
   *after* respawn → the TUI is alive and repaints (proves §6.3).

**Slice 0 exit test:** shell + a detached TUI both survive a daemon restart and reattach
losslessly, with scrollback, zero manual steps.

Then, only after Slice 0 passes:
- Slice 1: protocol hardening, multi-client fan-out, `ls/new/kill/rename`.
- Slice 2: claude supervision (§6.2) + `amber hook` + claude-resolution (§8), with a **fake
  `claude` stub** honoring `--resume`/`--continue` + firing the hook.
- Slice 3: snapshot cadence + SIGTERM final snapshot + boot units (§10); reboot torture test.
- Slice 4: backpressure + batching perf gate (§9); cross-compile matrix.
- Slice 5: rewrite `CLAUDE.md` as the new constitution; app integration is a separate spec.

---

## 12. Testing

- **Unit:** protocol frame round-trip; state (de)serialize + atomic write; ring cap/overwrite;
  name-schema decode; claude-path resolution; snapshot content-hash diff.
- **Integration:** daemon on a temp socket + temp state dir; create shell session; write input;
  assert output; snapshot; restart daemon; assert restored (scrollback + live). Fake `claude`
  stub for supervision tests.
- **Torture (reboot):** scripted setup + manual reboot; exit test = every session (shell +
  claude) back with cwd, scrollback, and each claude conversation resumed, zero manual steps.

---

## 13. Open questions for the user

1. `amber attach` alt-screen replay (§5) — acceptable to *not* replay historical alt-screen
   bytes for a TUI in the plain-terminal client (rely on the child's repaint), while the app
   path replays fully? (Recommended: yes.)
2. Snapshot interval default 10 s vs continuum's 60 s — 10 s trades a little IO for a smaller
   reboot gap. OK?
3. Bounded claude restart count before dropping to a shell — proposed default 3 with exponential
   backoff. OK?
