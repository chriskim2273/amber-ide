# macOS (Intel) verification checklist

Behavioral acceptance criteria for macOS Intel (`x86_64-apple-darwin`) support.
Run on a real Intel Mac — these cannot be checked from Linux. The pure logic
is covered by the Linux unit tests, and the macOS *compile* gate
(`cargo check --target x86_64-apple-darwin`) is run from Linux (no Mac needed);
this doc covers *behavior*.

## Build & unit tests

1. `rustup target add x86_64-apple-darwin`
2. `AMBER_MACOS_INTEL=1 ./scripts/dist.sh`  → produces `dist/amber-x86_64-apple-darwin`.
3. `cargo test -p amber`  → host target is x86_64; unit + integration green,
   including `procinfo` self-introspection and `snapshot_persists_a_shells_live_cwd_after_cd`.

## Install (launchd)

4. `infra/daemon/install.sh`  → launchd agent loaded.
5. `launchctl print gui/$(id -u)/com.amber-ide.daemon`  → shows the agent running.

## Live-cwd parity  (validates `procinfo::cwd_of`)

6. Create a shell session, then inside it `cd` into a deep directory
   (e.g. `mkdir -p ~/amber-cwd-test/a/b/c && cd $_`).
7. `amber ctl snapshot-now`.
8. Restart the daemon (`launchctl kickstart -k gui/$(id -u)/com.amber-ide.daemon`).
9. Re-attach the session → it restores at `~/amber-cwd-test/a/b/c`, NOT the
   original creation cwd. ✅ if the `cd` survived.

## Ad-hoc-claude parity  (validates `procinfo::process_table` + walk)

10. In a shell session, hand-run `claude` (not via `amber run`).
11. `amber ctl snapshot-now`, then restart the daemon (step 8).
12. Re-attach → the pane comes back as a supervised, resumable claude, not a
    bare shell. ✅ if it resumed claude.

## Reboot torture

13. Follow `infra/daemon/README.md`'s reboot procedure → sessions survive a
    real reboot via the launchd agent + final SIGTERM snapshot.

## App (dmg)

14. `app/scripts/dist.sh` → build the dmg; launch it.
15. Confirm end-to-end: daemon → utilityProcess → xterm renders; keystrokes
    reach the pty. ✅ if a pane is interactive.

Record pass/fail per step. Any failure at 9 or 12 means the corresponding
macOS `procinfo` primitive is wrong despite the compile gate — capture
`amber ctl doctor` output and the daemon log.
