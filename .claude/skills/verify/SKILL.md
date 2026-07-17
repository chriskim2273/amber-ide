---
name: verify
description: Drive amber daemon + Electron GUI live on this box (headless xvfb + CDP) to verify changes end-to-end.
---

# Verifying amber-ide live on this machine

## Daemon

- Installed binary: `~/.local/bin/amber`, systemd user unit `amber` (`systemctl --user {stop,start,restart,is-active} amber`).
- Deploy a new build: `cargo build --release -p amber && systemctl --user stop amber && install -m755 target/release/amber ~/.local/bin/amber && systemctl --user start amber`.
- State store: `~/.local/state/amber-ide/` (`sessions/*.json`, `scrollback/*.bin`, `config.toml` — snapshot interval 10s). Session survival check: `amber ls` before/after restart; scrollback `.bin` mtimes prove the snapshot timer runs.
- Daemon logs: `journalctl --user -u amber --since "5 minutes ago"`.
- Poison-restore test: plant a `sessions/<name>.json` whose `scrollback/<name>.bin` is a DIRECTORY → restart → journal shows "restore skipped session <name>", others restore. Clean up both files after.

## GUI (no DISPLAY in shell — use xvfb + CDP)

- Launch: `cd app && xvfb-run -a -s "-screen 0 1400x900x24" env AMBER_NO_SANDBOX=1 AMBER_SOFTWARE_GL=1 npm run dev -- -- --remote-debugging-port=9222` (background). Wait for `curl -s http://127.0.0.1:9222/json`.
- Drive via a tiny raw-CDP node script (node ≥22 has global WebSocket): commands `eval <expr>` (Runtime.evaluate), `shot <png>` (Page.captureScreenshot), `type <text>` (Input.insertText + Enter key events — xterm accepts these), `click <element-expr>` (bounding-rect center + Input.dispatchMouseEvent). A known-good copy of this script existed at the session scratchpad as `cdp.mjs`; recreate from this description if gone.
- Type into a terminal: click `.pane .xterm` first (focus), then `type`.
- Useful DOM anchors: panes `.pane`, tabs `.tab`, `+ Pane` = `button.btn-accent`, pane close = `.icon-btn.danger`, disconnect banner = `.banner:not(.error-banner)`, daemon-error banner = `.error-banner`, banner dismiss = `.banner-close`.
- utilityProcess pid: child of the app's electron main with `--utility-sub-type=node.mojom.NodeService` (ppid = pid of `electron ... --remote-debugging-port=9222 .`). `kill -9` it to test crash recovery; expect banner then auto-relaunch (banner clears <1s).
- Trigger a daemon Error frame from the app: `window.amber.createSession("amber-1-1-9-x", "/home/poyto", "bogus-kind")` — invalid KIND errors; invalid NAMES are accepted by the daemon (no Create-side name validation as of 2026-07-17).
- CLI↔GUI watcher check: `amber create --cwd $HOME amber-<ws>-<tab>-<ord>-<id>` / `amber kill <name>` while GUI open → pane appears/prunes within ~1s.

## Gotchas

- rtk hook rewrites `cargo test`/`cargo clippy`/grep/cat output into summaries; bypass with `c=cargo; $c ...` or `rtk proxy <cmd>`.
- Restarting the daemon kills live session processes (by design; sessions restore w/ scrollback). Markers you type land in the user's real session scrollback.
- Kill of a nonexistent session is a silent no-op (no Error reply) — don't use it to test the error banner.
