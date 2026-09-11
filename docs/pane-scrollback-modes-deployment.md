# Deploying the pane-scrollback/mode repair on this machine (2026-09-10)

Companion to `docs/pane-scrollback-modes-repair.md`. Records the machine
deployment of `f474201` (branch `fix/pane-scrollback-replay-modes`, also on
`main`) and the evidence that gated it.

## Why this needed a build from the dirty tree, not from clean `main`

A wholesale rebuild from `origin/main` would have **reverted the user's
uncommitted browser work**. Measured before touching anything:

- the installed `app.asar` contains `rewriteRemotePresentation` and
  `sendAssociation` (2/4 occurrences) — both defined only in the *untracked*
  `app/src/main/browserUiDispatch.ts` and absent from `origin/main`'s sources;
- the installed app/daemon predate main's newest commits (`pocketBadgeLabel`,
  `git.rs`'s `refs/heads` parsing are absent), so they were built from the
  `fix/pi-session-recovery` + dirty working tree generation;
- no dirty/untracked file is newer than the installed artifacts.

So the build tree is `~/worktrees/amber-ide/scrollback-deploy/tree`: an rsync
copy of `/home/poyto/Projects/amber-ide` (excluding `target`, `node_modules`,
`out`, `release`, `dist`) with the five commits applied as a patch. The live
checkout was never written to: all 38 dirty files hashed identical before and
in the copy, and only `crates/amber/src/web.rs` differs anywhere (the copy has
the extra test hunk).

## App-side A/B in the real packaged AppImage

`wheel-mode-smoke.cjs` launches an AppImage against a fixture daemon socket
(never the live daemon), answers the attach the way a cold pane is answered, then
wheels over the terminal. Three probes:

| AppImage | input the pane sent for a wheel-up |
| --- | --- |
| installed (pre-fix) | `\x1b[A` ×3 — arrow keys = the reported input-history scrolling ❌ |
| rebuilt (fixed) | `\x1b[<64;69;17M` ×3 — SGR mouse report = the app scrolls ✅ |

That fixture also caught a real bug in the first version of this fix: xterm
parses `write()` **asynchronously**, so the alt-buffer check inside the replay
handler still saw the pre-replay buffer and cleared the protocol the replay had
just queued. Fixed in `f474201` by settling the modes in the write's completion
callback; `terminalModes.test.ts` now pins the trap.

## Daemon-side evidence (before)

`verify-preamble.py` attaches to live sessions exactly as a fresh pane mount does
(`resume {epoch:'0'}`) and inspects the one replay frame:

```
amber-1-5-2-mtj4p98c5 | alt_first=False | mouse=False | bytes=2097152
amber-1-13-0-mtqm62m31 | alt_first=False | mouse=False | bytes=2097152
head: '87mâ\x94\x80\x1b[39m...'   (mid-frame, mid-UTF-8: no alt screen, no modes)
```

## Artifacts deployed

| | path | sha256 (16) |
| --- | --- | --- |
| daemon | `~/.local/bin/amber` | `$(sha256sum ...)` recorded in the receipt |
| router | `~/.local/bin/amber-router` | receipt |
| app | `~/Applications/amber-ide.AppImage` | receipt |

Rollback: `~/Applications/amber-ide.AppImage.pre-scrollback-backup`,
`~/.local/bin/amber.pre-scrollback-backup`, `~/.local/bin/amber-router.pre-scrollback-backup`.

## Sequence (run detached, in a transient systemd unit)

1. `amber ctl snapshot-now`; backup the installed binary, router and AppImage.
2. Install the new binary + router and the new AppImage atomically (write beside,
   then rename).
3. `systemctl --user restart amber.service` — **this kills every pane, including
   the session that requested the deploy** (agent panes resume their
   conversations; shells come back fresh).
4. Wait for the daemon (90 s), roll back the binary and restart if it does not
   come up.
5. Restart `amber-web.service` (it serves the embedded phone client, `app.js`).
6. Re-run `verify-preamble.py` (retried while resumed TUIs re-assert their
   modes) — the post-deploy proof that a cold replay is preamble-led.
7. Relaunch the desktop client on the new AppImage via
   `scripts/relaunch-app-linux.sh`, in its own `systemd-run --scope` so it
   outlives the deploy unit's cgroup.

Receipt: `~/worktrees/amber-ide/scrollback-deploy/deploy-receipt.json`, log:
`~/worktrees/amber-ide/scrollback-deploy/deploy.log`.
