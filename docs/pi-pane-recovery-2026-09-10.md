# Pi pane recovery — 2026-09-10

Operational receipt for recovering panes that came back as plain shells after a
daemon restart, plus the reusable tooling in `scripts/pi-pane-recovery/`. Raw
evidence (backups, before/after layout sidecars, conversion records) stays on
persistent storage at `~/worktrees/amber-ide/pi-pane-recovery/`.

## Symptom

After the amber daemon was restarted at 22:21:23, the user reported that "so
many Pi sessions" had become "just regular shells".

## Root cause (verified, not inferred)

Amber only auto-restores panes whose session **kind** is an agent
(`pi`/`claude`/`grok`/…). The user's Pi panes were **`kind=shell`** panes in
which they started `pi` by hand. A hand-started `pi` is only a child process of
that shell, so the daemon restart killed it and the pane restored as a plain
shell. Nothing re-runs it.

Proof — this very session's own process:

```
AMBER_SESSION=amber-1-5-4-mtw9zoul2
PI_SESSION_ID=01a089d5-c2e5-7101-aa53-88f2a721f0a1
cgroup: …/amber.service/session-20/workload      (kind=shell at the time)
```

and `amber ls` reporting that pane as `shell` while a `pi` child ran inside its
cgroup leaf.

**Nothing was lost by the daemon.** Its own log:

```
22:21:23  snapshot.completed   explicit snapshot completed
22:21:26  daemon.restore       restored 28 of 28 sessions; skipped 0
```

All 11 supervised Pi panes were restored and re-read their exact recorded
conversations (their recordings were rewritten at 22:21:26 with their original
`session_file` paths). The restart itself was requested by another Pi session
deploying the app: its last message reads "Deploying now — the timer fires in
~40 s, and the daemon restart will kill this pane".

## Which conversations died with the restart

Exactly four Pi conversations were written during the kill window
(`~/.pi/agent/sessions`, mtime 22:20:42–22:21:23) — the set of Pi processes open
at the restart:

| conversation | cwd | pane | evidence |
|---|---|---|---|
| `…/--home-poyto-IOTNation--/2026-09-10T01-36-43…01a088f5` | ~/IOTNation | `amber-1-3-17-mtudjz4v1` "Mitchell Message Fixes" | 3 sampled assistant lines present in that pane's scrollback at 92/94/99% |
| `…/--home-poyto-IOTNation--/2026-09-04T17-04-31…01a06d61` | ~/IOTNation | `amber-1-3-14-mtp7ldae1` "Lago" | 4/40 sampled lines in that pane; both distinctive strings from its final user message (`execute-api.us-east-1.amazonaws.com`, `oia5pwm9y8`) present |
| `…/--home-poyto-Projects-amber-ide--/2026-09-11T02-16-36…01a08e40` | amber-ide | `amber-1-5-5-mtwbrtz04` | pane created 22:16:29, conversation started 22:16:36; its text present in that pane |
| `…/--home-poyto--/2026-09-11T01-26-39…01a08e12` | /home/poyto | **unresolved** | no pane matches its text; the only weak hit was this session's own pane |

## Recovery applied

`convert-pane.py` in this directory; three panes converted. Each conversion
backed up the previous `sessions/<name>.json` and `claude/<name>.json` under
`before/<name>/`, then:

1. `amber kill <name>` — the daemon deletes the killed session's recording, so
   the recording must be written **after** the kill.
2. write `claude/<name>.json` = `{session_id, cwd, updated, session_file,
   agent_kind:"pi"}` pointing at the target conversation. This is the same
   contract the daemon's own restore path consumes; the supervisor reads it at
   spawn and launches `pi --session <file>`.
3. `amber create --kind pi --cwd <cwd> --title <title> <name>` — the name is
   preserved, so the pane keeps its workspace/tab/split identity (rule #2).

Verified after conversion:

- all three listed as `kind=pi` with a live `pi` in their own cgroup leaf
  (pids 4065268 / 4065361 / 4065418);
- each recording still points at its **original** conversation file, which is
  what proves Pi resumed rather than starting fresh;
- `ui-layout.json` pane lists for the affected tabs (ws1 tab3, ws1 tab5) are
  **identical, same order** to the pre-conversion sidecar — no rearrangement;
- no pane is in `shell-fallback` or suspended; supervised Pi panes went 11 → 14;
- daemon PID 4026874 unchanged (no daemon restart was needed).

The Pi conversations themselves were never modified by this work; `pi` owns
those files and appends to them.

## Decisions taken by the user (2026-09-10 22:37)

- **`amber-1-5-4-mtw9zoul2` is deliberately left as a `kind=shell` pane.** It
  stays vulnerable: the next daemon restart kills the Pi running in it and the
  pane returns as a plain shell. No action was taken on it.
- **The deploy conversation (`01a08e12`) is handed back to the user** with the
  exact resume command rather than assigned to a guessed pane:

  ```sh
  pi --session /home/poyto/.pi/agent/sessions/--home-poyto--/2026-09-11T01-26-39-109Z_01a08e12-e904-74b2-aa65-aeb49af91556.jsonl
  ```

  Run it in whichever pane should own that conversation (its recorded cwd is
  `/home/poyto`); the file is a valid Pi session
  (`{"type":"session","version":3,…"cwd":"/home/poyto"}`).

## Second batch — user-named panes (2026-09-10 22:43)

The user named the remaining panes by slot: `26,24,27,17,1,11,6,21`. All eight
resolved to shell panes. Identification could not use the flush-at-kill signal
(those Pi processes were idle when the daemon died), so each pane was matched
against candidate conversations **by the text of its own last rendered screen**:
the daemon restores a pane's ring before the replacement shell writes its first
prompt, so the text before that prompt is Pi's TUI frame for the conversation
that was open. `match-ngram.py` scores 5-word n-grams taken from that final
screen against every conversation in the pane's own cwd directory.

Every winner scored strictly positive with **every other conversation at 0**:

| pane | slot now | conversation | score | next best |
|---|---|---|---|---|
| `amber-1-14-1-mtv66tg92` | 5 (was 26) | `2026-09-10T06-54-54…01a08a19` (mobile-app design) | 18 | 0 |
| `amber-1-14-3-mtwb1hjt3` | 24 | `2026-09-10T07-17-06…01a08a2d` (matches the `pi --continue` visible in this pane) | 9 | 0 |
| `amber-1-14-2-mtvqjqer1` | 26 (was 27) | `2026-09-10T16-24-12…01a08c22` (Investors / SEC Form D screen) | 5 | 0 |
| `amber-1-12-0-mtnxa4g53` | 17 | `2026-09-05T05-08-46…01a06ff8` (T4–T14 todo screen) | 24 | 0 |
| `amber-1-12-1-mttfz5a01` | 1 | `2026-09-09T01-52-10…01a083dd` | 7 | 0 |
| `amber-1-3-15-mttgquv12` "Filter Fixes" | 11 | `2026-09-09T02-13-39…01a083f1` | 39 | 0 |
| `amber-1-1-33-mtswfkcq1` | 6 | `2026-09-08T19-27-17…01a0827d` | 17 | 0 |
| `amber-1-1-34-mtt4awpy4` | 21 | `2026-09-08T20-24-15…01a082b1` | 8 | 0 |

No conversation was claimed by two panes: the two `rubber-ducky-app` panes took
different conversations, as did the two `inyeon-platform` panes.

Verified after conversion: all eight `kind=pi` with a live `pi` in their cgroup
(pids 4128542/4128601/4128708/4128765/4128839/4128938/4129047/4129124), every
recording pointing at its **original** conversation, no pane in `shell-fallback`,
and **zero tabs with a changed pane list or order** (`layout-before-8.json` vs
`layout-after-8.json`). Supervised Pi panes went 14 → 22.

Two panes changed slot number (`amber-1-14-1` 26→5, `amber-1-14-2` 27→26); slots
are allocation-order numbers, not identity, and both panes kept their name,
title, workspace/tab and split position.

Unrelated fact recorded for accuracy: `amber-1-5-2-mtj4p98c5` (the pane whose
screen discussed "pi sessions are not being restored properly") was killed at
22:40:10 by a **client request** — i.e. from the app or CLI, not by this work.
Its conversation remains on disk.

## Still open

- Shell panes that had an *idle* Pi (no message written near the kill) cannot be
  detected by this method; they are not covered by this recovery.
- Any future hand-started `pi` inside a shell pane will be lost the same way.
  The durable fix is to convert the pane (this script) so amber supervises it.
