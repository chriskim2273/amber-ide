# Direct post-reboot browser-host acceptance

## Verdict

**Local implementation and Linux substrate validation complete; full feature merge remains blocked by external acceptance gates.** No production installation, release publication, daemon restart, or profile change was performed.

The user explicitly stopped subagents and requested direct execution. The parent assistant completed the final focused review, regression fix, and validation. This is **not** a claim that the interrupted full-branch parallel review ran, nor a new independent review of the parent-authored fix.

## Recovery and provenance

- Persistent worktree: `/home/poyto/worktrees/amber-ide/tab-browser-host` (ext4).
- Recovered branch tip: `535b362adf7ee482e42f7a12029262a3b9c69470`.
- Final tested production commit: `e53905ea886c01cbaa11ad794eae52ea69ce0f66`.
- Subsequent report-only commits do not change the tested code.
- Shared `/home/poyto/AGENTS.md` now forbids ephemeral worktrees and irreplaceable evidence in temporary storage. Historical `/tmp` paths in previous reports are not current evidence.
- Fresh persistent logs/driver: `/home/poyto/recovery/amber-ide/direct-validation-535b362/`.
- Private live fixture, screenshot and machine-readable results: `/home/poyto/recovery/amber-ide/live-535b362/`.

## Final source review and fix

Direct inspection confirmed pending SSH children enter the registry before readiness/window awaits; deferred/rejected opens and close/quit races retain cleanup ownership; normal, forced, compat and host-disabled finalization await cleanup; host-disabled Windows avoids POSIX inhibit access. Existing single-flight reopen, hidden activation cancellation, and process/socket recovery regressions pass.

A fresh packaged approval test found one additional issue. The visible approval panel resizes the native page slot, causing ResizeObserver to queue `show` behind the Pi action awaiting approval. Main cleared `activeBrowserExpanded` before the queued operation could run, so resolving the visible approval failed with `APPROVAL_DENIED`.

`e53905e` preserves an **already acknowledged** visible surface during queued show/resize. Initial show still stays unacknowledged until completion, and hide still revokes immediately. Window visibility, exact browser identity, destruction and context fencing remain required. A behavior-preserving extraction reproduced the failure (1 failing/6 passing context tests), then the minimal fix made the regression green. The packaged test failed before and passed twice after, including one final run without IPC instrumentation.

## Fresh automated evidence

| Gate | Result | Log |
| --- | --- | --- |
| Focused resident/SSH/menu | 52 passed | `resident-focused.log` |
| Full app after fix | 1026 passed, 1 intentional skip | `app-tests-after-fix.log` |
| TypeScript after fix | PASS | `typecheck-after-fix.log` |
| Rust workspace/all-targets | 821 passed, 1 intentional ignore, 36 suites | `rust-tests.log` |
| Warnings-as-errors Clippy | PASS | `clippy.log` |
| Electron + web + AppImage build after fix | PASS | `dist-after-fix.log` |
| Generated Pi v7 on installed pinned Pi 0.81 | PASS: 28,111 bytes, 27 tools, exact failure fields and fatal checks | `pi-extension-081.log` |
| Installed Pi 0.85 | BLOCKED before extension load: missing `@earendil-works/pi-server` | `pi-extension.log` |
| Diff whitespace | PASS | direct `git diff --check` |

Rust and Pi production code is unchanged by the final three-file TypeScript approval fix. Existing formatting drift and absent ESLint 9 flat configuration remain outside this feature; the above does not assert every repository tool is green.

## Fresh packaged Linux smoke

Artifact built via `npm run dist`, including executable **static-pie** `amber` and `amber-router`:

`/home/poyto/recovery/amber-ide/live-535b362/amber-ide.AppImage`

SHA-256: `8d5728f7f615644d49a63f4fed046cd3919ae983a4e1931b121621b10e33f71c`

Also retained in the persistent worktree's `app/release/amber-ide-0.0.2.AppImage`.

`live-smoke-final.log`, `live-535b362/final-evidence.json` and `visible-approval.png` prove:

- Private daemon, HOME/state/runtime/Electron profile, fake Pi-shaped session and fake SSH only. No real agent authentication, model call, SSH host or production daemon involved in the smoke.
- Real native browser page reaches the loopback fixture; `require` and `process` are absent in its page context. Unsafe file navigation returns `NAVIGATION_BLOCKED`; unsafe popup cannot navigate the fixture.
- User close hides the local window while the browser remains alive; five concurrent activation events converge on one local window. This tests event-handler concurrency, not five independent OS launches.
- Broker refuses unshared access, accepts explicit designation/sharing, returns a real accessibility snapshot, shows the untrusted-content approval card, performs the approved semantic click, reports an advanced final generation, and rejects access after sharing is revoked.
- Packaged `connectHost` spawns a private fake SSH child through the production path. Invoking the **actual application MenuItem callback** for Quit exits with code 0, kills that child, removes its owned forwarding socket, and writes the explicit-quit inhibit marker.
- The Node inspector initially delayed exit with `Waiting for the debugger to disconnect`; disconnecting it after invoking the menu callback resolves that harness artifact. No coordinator/menu implementation was patched to force success.

This is Xvfb/CDP substrate evidence. The MenuItem callback is invoked via a private loopback main-process inspector, **not a physical mouse/keyboard menu gesture**. The fake agent session validates daemon membership/authorization; it is not a real Pi conversation. The fake SSH validates process ownership/cleanup, not external SSH interoperability. The driver's explicit renderer show establishes the visible rail before approval. No claim of arbitrary concurrent physical input or hardware IME behavior follows from these checks.

## External blockers — unchanged merge barrier

1. **Deployed reader:** fresh read-only GitHub release query still shows v0.0.2 Windows-only assets and v0.0.1 Linux/macOS assets. Publish a reviewed Linux/macOS v2-reader release and perform the real upgrade-channel test before enabling `AMBER_TAB_BROWSER_V2_READER_DEPLOYED=1` in production. No release was published.
2. **macOS:** one SSH `true` probe succeeded, but both subsequent bounded toolchain preflight attempts timed out. No remote files/builds were created. An awake, stably reachable interactive Mac is required for native/package/focus/IME checks.
3. **Physical Linux input/menu/IBus:** requires the user's real hardware session; not substituted by the private inspector or Xvfb.
4. **Published Pi 0.85:** missing upstream package dependency remains; pinned Pi 0.81 is the proven baseline only. No global Pi package modifications were made.
5. **Windows native execution:** unavailable here; fail-closed browser-host and simulated no-host Quit paths are test-covered, not native Windows verified.

`mergeReady` remains **false**. Further advancement of these gates requires an external machine/package change or explicit release/deployment authority, not additional unbounded local review loops.
