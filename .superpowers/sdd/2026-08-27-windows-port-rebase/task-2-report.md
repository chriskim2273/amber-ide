# Task 2 report — named-pipe transport and Windows proof harness

## Outcome

Initial transport boundary: `8c91569b7421fa8314c5cae11459fcdba7280e5f`
(`feat(win): add named-pipe transport boundary`).

Review follow-up: `826f3c1d6ebcb35fa501b29a6fcf7effe1031e7b`
(`fix(win): harden named-pipe transport proof`).

Final raw-pipe follow-up: `0320bf337055fc2781685ce95718d68f26687207`
(`fix(win): force raw named-pipe teardown`). It replaces the Windows
interprocess stream wrapper with owned raw Win32 named-pipe handles. This is
necessary because the wrapper's dirty-stream drop can linger and call
`FlushFileBuffers`, so it cannot promise a bounded stalled-peer release after
output. The owned implementation performs `DisconnectNamedPipe` then directly
closes the `OwnedHandle`; it never enters the wrapper drop path.

Round-three follow-up: `1474ee650396d03da75cf600d2cf0eff03934639`
(`fix(win): recover named-pipe edge cases`). It recovers a pending pipe whose
client closed before `accept`, distinguishes server disconnect from client
close, and makes the queued-output reader barrier deterministic in both
Windows proofs. Its zero-byte write retry was superseded by the final-review
follow-up below because retrying inside `Write::write` had no bound.

Round-four follow-up: `80a376f6bda2d27b2c16179980cf6f9fdaa76577`
(`fix(win): retry busy pipe connects deterministically`). Windows `connect`
now follows Microsoft's required `CreateFileW` / `ERROR_PIPE_BUSY` /
`WaitNamedPipeW` / retry sequence. Each wait is at most 50 ms and the complete
retry helper carries a 250 ms busy-wait deadline. After the initial
`CreateFileW`, it checks that deadline immediately before every later
`CreateFileW`; no retry starts once the deadline has expired. The deadline
cannot preempt a Win32 call already in progress. It never uses
`NMPWAIT_WAIT_FOREVER`; disappearance of the listener and other non-busy errors
return immediately.

The forced-close proof now has a Windows-only `cfg(test)` hook on `Pipe`. The
hook fires only after a real `ReadFile` returns `ERROR_NO_DATA` inside
`Pipe::read`, immediately before the retry, so shutdown cannot be permitted by
the test until the reader has actually entered the transport retry loop. The
Node proof was narrowed to what Node/libuv can observe: the queued bytes are
assembled as a byte stream, a persistent `data` listener keeps the socket in
flowing mode, and Node observes the server close. It explicitly does **not**
claim that Node exposes a synchronization point for an underlying pending
Win32 `ReadFile`.

Nonblocking-I/O follow-up: `928632f227e13b8d1d3bad6b7502f2d53db1a8e3`
(`fix(win): make named-pipe IO nonblocking`). Every successful client `CreateFileW`
handle is passed to `SetNamedPipeHandleState` with byte-read + `PIPE_NOWAIT`
before Amber publishes the `Pipe`. Server handles already receive
`PIPE_NOWAIT` in `CreateNamedPipeW`. A failure to change the client state closes
the owned handle and returns the exact Win32 error. Consequently every
`ReadFile`/`WriteFile` executed while the pipe-handle mutex is held returns
immediately; the exact `ERROR_NO_DATA` read hook can no longer be stranded
behind a blocking client handle.
`SetNamedPipeHandleState` is exposed by the already-enabled
`windows-sys/Win32_System_Pipes` feature; both Amber's target dependency and
the isolated helper therefore needed no feature expansion, and the helper's
MSVC cross-clippy gate compiled the production import and call.

Successful nonempty `WriteFile(...)=TRUE, written=0` is now exposed as
`WouldBlock` after exactly one call. Positive partial progress is preserved.
There is no sleep/retry loop inside `Write::write`; an upper wall-clock writer
must retry `WouldBlock` while enforcing its own deadline. The Windows busy
runtime test no longer sleeps: its test-only callback fires only after an
actual `ERROR_PIPE_BUSY` has caused a real `WaitNamedPipeW` call. Finally, the
Node harness installs one persistent stdout/stderr/exit monitor at spawn time,
queues complete lines, satisfies `READY`/`QUEUED`/`RELEASED` from either the
queue or a waiter, and removes every listener during cleanup.

Harness-lifecycle follow-up: `633872518296907c90cfe59517aaada1b35ccbd5`
(`fix(win): bound pipe harness lifecycle`). Child `exit` is now metadata only.
The persistent line monitor drains complete records through stdout `end`,
flushes a final unterminated record there, and rejects still-unsatisfied
waiters only at child `close`, after stdio has closed. Thus a direct child can
exit while an inherited stdout writer still owns the pipe without racing a
buffered `RELEASED` against waiter rejection.

Every Node socket enters the cleanup set synchronously after construction,
before its named-pipe connect succeeds or fails. The 15-second deadline now
aborts all event/read/connect waits, destroys and unreferences every tracked
socket, disposes the line monitor, terminates the Rust peer, and waits at most
two seconds for `exit` before destroying its stdio and unreferencing the child.
The exit wait uses `events.once(..., { signal })`; its dedicated timer is
cleared and its abort controller is aborted on every outcome, so neither the
timer nor event/error listeners survive cleanup. Deadline rejection is emitted
only after this idempotent cleanup completes.

### Harness-lifecycle TDD and verification

RED was reproduced with a real child process that spawned an unreferenced
grandchild inheriting stdout. The direct child exited first; the grandchild
wrote an unterminated `RELEASED` record 100 ms later. The old monitor rejected
at `exit` before that record arrived:

```text
$ node --test app/test/windows-pipe-lifecycle.test.mjs
not ok 1 - line monitor drains inherited stdout after the direct child exits
Error: Rust peer exited (code 0, signal null)
```

Fresh focused results after the lifecycle fix:

```text
$ node --test app/test/windows-pipe-lifecycle.test.mjs
tests 2; pass 2; fail 0

$ node --check app/test/windows-pipe.mjs
exit 0

$ node --check app/test/windows-pipe-lifecycle.test.mjs
exit 0

$ node app/test/windows-pipe.mjs
SKIP windows-pipe.mjs: Windows named pipes require Windows
```

Primary Node contracts consulted:

- [Child process `exit`](https://nodejs.org/api/child_process.html#event-exit)
  documents that child stdio streams may still be open when `exit` fires.
- [Child process `close`](https://nodejs.org/api/child_process.html#event-close)
  documents that `close` follows process termination and stdio closure, and
  always follows `exit` or `error`.
- [`events.once`](https://nodejs.org/api/events.html#eventsonceemitter-name-options)
  documents the `AbortSignal` option used to cancel each pending event wait.
- [`socket.destroy`](https://nodejs.org/api/net.html#socketdestroyerror)
  documents that destruction prevents further I/O and closes the connection;
  the harness also unreferences every socket during deadline cleanup.

Harness-safety follow-up: this commit (`fix(win): own pipe peer lifecycle
directly`). Promises for the stalled socket's `close`, the peer's `exit`, and
the queued read are now staged immediately: both fulfillment and rejection
handlers are attached at creation, the stage itself always fulfills, and its
returned await function rethrows the captured rejection only where the proof
expects to await it. Deadline abort therefore cannot create an unhandled
rejection while control is still waiting for `QUEUED` or `RELEASED`.

The harness no longer runs the peer through `cargo run`. It first executes a
bounded `cargo build` for the standalone helper, waits for a successful child
`close`, and then spawns the built peer executable directly. The helper has the
explicit binary name `windows_pipe_peer`. This revision initially pinned a
helper-local target directory and inferred the usual debug executable path;
the final harness-safety follow-up below supersedes that inference with Cargo's
reported artifact path. The harness owns the actual peer child, so operation
cleanup targets it directly rather than relying on Cargo as its parent.

Process monitors now register `error` / `exit` / `close` handlers before they
inspect stdio, and every stdout/stderr access is conditional. A spawn failure
whose child has absent stdio is reported through the original process error,
not a setup-time property dereference. The Cargo-build monitor follows the same
ordering. Cleanup remains idempotent, aborts socket/event/read waits, destroys
tracked sockets, and uses the same tested bounded child-termination helper for
an in-progress build or the directly spawned peer.

### Harness-safety TDD and verification

The first RED run failed during module instantiation because the new build/run
invocation and staged-wait APIs did not exist:

```text
$ node --test app/test/windows-pipe-lifecycle.test.mjs
SyntaxError: The requested module './windows-pipe.mjs' does not provide an
export named 'peerBuildInvocation'
tests 1; pass 0; fail 1
```

After that cycle was green, the direct-child cleanup regression was added and
the next RED run failed because its cleanup API did not exist:

```text
$ node --test app/test/windows-pipe-lifecycle.test.mjs
SyntaxError: The requested module './windows-pipe.mjs' does not provide an
export named 'terminateChild'
tests 1; pass 0; fail 1
```

Fresh focused results after implementation:

```text
$ node --check app/test/windows-pipe.mjs
exit 0

$ node --check app/test/windows-pipe-lifecycle.test.mjs
exit 0

$ node --unhandled-rejections=strict --test \
    app/test/windows-pipe-lifecycle.test.mjs
tests 6; pass 6; fail 0

$ cargo build -q \
    --manifest-path crates/amber/tests/windows_pipe_peer/Cargo.toml \
    --target-dir crates/amber/tests/windows_pipe_peer/target
exit 0; target/debug/windows_pipe_peer exists and is executable on Linux

$ rustup run stable cargo check \
    --manifest-path crates/amber/tests/windows_pipe_peer/Cargo.toml \
    --target-dir crates/amber/tests/windows_pipe_peer/target \
    --target x86_64-pc-windows-msvc
Finished successfully

$ cargo test -p amber --test windows_pipe
test result: 2 passed; 0 failed

$ node app/test/windows-pipe.mjs
SKIP windows-pipe.mjs: Windows named pipes require Windows
```

The six lifecycle tests cover inherited-stdio draining, cleanup-before-deadline
rejection, abort of pending pre-created `events.once` and queued-read waits
without an unhandled rejection, failed spawn with absent stdio, exact Cargo
build/direct-run invocations and platform executable paths, and termination of
a real directly spawned child. The generated helper `target/` directory was
removed after these gates; it is not part of the change.

Primary Node contracts consulted for this follow-up:

- [`events.once`](https://nodejs.org/api/events.html#eventsonceemitter-name-options)
  documents that the `signal` option cancels a pending event promise by
  rejection; this is why every pre-created wait receives an immediate rejection
  handler.
- [Child process `error`](https://nodejs.org/api/child_process.html#event-error)
  documents failed spawn and kill errors, and warns that `exit` may not follow
  an error.
- [Child process `close`](https://nodejs.org/api/child_process.html#event-close)
  documents that `close` follows either `exit` or a failed-spawn `error` after
  stdio closure; the build gate resolves only there.
- [`subprocess.stdout`](https://nodejs.org/api/child_process.html#subprocessstdout)
  and [`subprocess.stderr`](https://nodejs.org/api/child_process.html#subprocessstderr)
  document that these streams may be null or undefined after a failed spawn.

Windows execution was unavailable on this Linux host. The helper's Windows
transport path cross-compiles, but the Node/Rust named-pipe runtime proof
remains a Windows-only gate and is not reported as passing here.

### Final harness-safety follow-up

This commit closes the remaining harness lifecycle gaps from the final review.
The build now requests Cargo's documented line-delimited JSON with
`--message-format=json` and selects only a `compiler-artifact` whose manifest
is the standalone helper manifest, whose target is the named binary, and whose
`executable` is a nonempty absolute path. The harness verifies that exact path
is a file and executes it directly. It no longer assumes `target/debug`, so
Cargo target-directory and build-target configuration are honored.

A build timeout now terminates Cargo's Windows process tree with
`taskkill.exe /PID <pid> /T /F`, waits for `taskkill` itself with a bound, and
requires the direct Cargo child to emit `exit` within the cleanup bound. The
direct Rust peer remains separately owned and receives the same cleanup. Every
owned child stream is destroyed and every child is unreferenced in `finally`,
including already-exited children whose stdout remains open through an
inheriting descendant. Cleanup continues across both children, aggregates
multiple failures, and propagates kill, taskkill-spawn, taskkill-timeout, and
reap failures instead of silently replacing them with the nominal timeout.

Fresh focused results:

```text
$ node --check app/test/windows-pipe.mjs
exit 0

$ node --check app/test/windows-pipe-lifecycle.test.mjs
exit 0

$ node --unhandled-rejections=strict --test \
    app/test/windows-pipe-lifecycle.test.mjs
tests 12; pass 12; fail 0

$ node --input-type=module -e '<spawn Cargo; parse compiler-artifact; stat executable>'
/home/poyto/Projects/amber-ide/.worktrees/codex-windows-port-rebase/
  crates/amber/tests/windows_pipe_peer/target/debug/windows_pipe_peer

$ rustup run stable cargo check \
    --manifest-path crates/amber/tests/windows_pipe_peer/Cargo.toml \
    --tests --target x86_64-pc-windows-msvc
Finished successfully

$ cargo test -p amber --test windows_pipe
test result: 2 passed; 0 failed

$ node app/test/windows-pipe.mjs
SKIP windows-pipe.mjs: Windows named pipes require Windows
```

The 12 platform-neutral lifecycle tests cover inherited-stdio draining,
cleanup-before-timeout rejection, cleanup-error propagation, staged aborted
waits under strict unhandled-rejection handling, failed line-monitor spawn,
failed build-wait spawn with absent stdio, Cargo invocation and exact artifact
selection, direct child termination, already-exited child stream release,
Windows taskkill-tree invocation and failed spawn, and mandatory target reap.

Primary contracts consulted for this follow-up:

- [Cargo JSON messages](https://doc.rust-lang.org/cargo/reference/external-tools.html#json-messages)
  document one JSON object per line, `reason`-based message selection, and the
  `compiler-artifact.executable` field.
- [Microsoft `taskkill`](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill)
  documents `/PID`, `/F`, and `/T`; `/T` terminates the selected process and
  child processes it started.
- [Node child-process lifecycle](https://nodejs.org/api/child_process.html)
  documents that `error` covers failed spawn and failed kill, `exit` may leave
  stdio open, and `close` follows process termination plus stdio closure.

Windows execution remains unavailable on this Linux host. The helper's Windows
transport path cross-compiles, and the taskkill/reap state machine has
platform-neutral fakes, but the named-pipe runtime proof is still reported only
as skipped here.

### Final-review TDD and verification

RED was observed before implementation:

```text
$ cargo test -p amber nonblocking_write
error[E0425]: cannot find function `classify_nonblocking_write` in this scope

$ cargo check --manifest-path crates/amber/tests/windows_pipe_peer/Cargo.toml \
    --tests --target x86_64-pc-windows-msvc
error[E0425]: cannot find function `connect_after_busy_wait` in this scope
error[E0599]: no method named `is_nonblocking` found for struct `Arc<Pipe>`
```

Fresh final-review results on Linux:

```text
$ cargo test -p amber nonblocking_write
test result: 2 passed; 0 failed; 483 filtered out

$ cargo test -p amber busy_connect
test result: 2 passed; 0 failed; 483 filtered out

$ cargo test -p amber --test windows_pipe
test result: 2 passed; 0 failed

$ rustup run stable cargo clippy -p amber --lib --tests -- \
    -D warnings -A clippy::needless-return
Finished successfully

$ rustup run stable cargo clippy \
    --manifest-path crates/amber/tests/windows_pipe_peer/Cargo.toml \
    --tests --target x86_64-pc-windows-msvc -- -D warnings
Finished successfully

$ node --check app/test/windows-pipe.mjs
exit 0

$ node app/test/windows-pipe.mjs
SKIP windows-pipe.mjs: Windows named pipes require Windows
```

A fresh unrestricted `cargo test -p amber` run was interrupted after two
minutes at the repository's previously recorded parallel socket-test stall; it
is not reported as passing. Native Windows runtime tests were unavailable and
remain unrun.

### Round-four TDD and verification

RED was observed before implementation in two compile gates:

```text
$ cargo test -p amber busy_connect_waits_then_retries_an_available_instance
error[E0425]: cannot find function `retry_busy_connect` in this scope

$ cargo check --manifest-path crates/amber/tests/windows_pipe_peer/Cargo.toml \
    --tests --target x86_64-pc-windows-msvc
error[E0599]: no method named `install_read_attempt_hook` found for struct `Arc<Pipe>`
```

The first test protects the required busy -> wait -> retry transition; a
second pure test protects the timeout boundary. The Windows transport unit
test claims the listener's sole instance, starts another Rust `connect`, then
cycles `accept` and requires the second client to connect through the
replacement instance. Keeping this test beside `transport.rs` means the
isolated Windows helper cross-compiles the real production transport plus this
runtime-only probe despite unrelated Amber modules still being Unix-only.

Fresh round-four results:

```text
$ cargo test -p amber
test result: 483 passed; 0 failed; 1 ignored (22 suites)

$ cargo test -p amber busy_connect
test result: 2 passed; 0 failed; 482 filtered out

$ cargo test -p amber --test windows_pipe
test result: 2 passed; 0 failed

$ rustup run stable cargo clippy -p amber --lib --tests -- \
    -D warnings -A clippy::needless-return
Finished successfully

$ rustup run stable cargo clippy \
    --manifest-path crates/amber/tests/windows_pipe_peer/Cargo.toml \
    --tests --target x86_64-pc-windows-msvc -- -D warnings
Finished successfully

$ node --check app/test/windows-pipe.mjs
exit 0
```

The two `needless_return` allowances above are the same pre-existing
`platform.rs` warnings recorded earlier in this report. Running the unmodified
`cargo clippy -p amber --all-targets -- -D warnings` still stops on those two
Task-1 warnings before reaching Task 2. A whole-product Windows check still
stops on 26 pre-existing Unix-only imports/signal paths in `attach`, `daemon`,
`manager`, `supervisor`, `watchers`, `web`, and related modules; the isolated
helper is therefore the decisive Task-2 Windows compile gate.

Primary contracts consulted for this follow-up:

- [`SetNamedPipeHandleState`](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-setnamedpipehandlestate)
  documents that client handles returned by `CreateFileW` may be changed to
  `PIPE_NOWAIT`, that nonblocking `ReadFile`/`WriteFile` return immediately,
  and that a duplex client handle needs generic-write access (Amber requests
  `GENERIC_READ | GENERIC_WRITE`).
- [Microsoft named-pipe client guidance](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-client)
  documents that `CreateFile` client handles default to blocking-wait mode and
  that clients use `SetNamedPipeHandleState(..., PIPE_NOWAIT, ...)` to enable
  nonblocking mode.
- [Microsoft named-pipe client example](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-client) documents retrying `CreateFile` after `ERROR_PIPE_BUSY` by calling `WaitNamedPipe`.
- [`WaitNamedPipeW`](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-waitnamedpipew) documents bounded millisecond waits, `ERROR_SEM_TIMEOUT`, and the race where a successful wait can still be followed by a failed `CreateFile`.
- [Named pipe type/read/wait modes](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-type-read-and-wait-modes) documents `ERROR_NO_DATA` for an empty nonblocking read; that is the exact retry point used by the test-only hook.

Windows execution was unavailable on this Linux host. The exact-hook teardown
test, listener-capacity test, and Node/Rust runtime proof are cross-compiled or
syntax-checked here but remain **runtime-only Windows gates**; no Windows pass
is claimed.

Focused Unix tests are green and the isolated Windows transport helper
cross-compiles. Windows runtime execution was not available on this Linux host
and is explicitly **not** claimed as passed.

## TDD evidence

The first failing test established the missing transport boundary. The
stalled-peer test was then strengthened to put output in the pipe before the
server forces the release.

### RED

```text
$ cargo test -p amber local_stream_round_trips_a_protocol_frame
error[E0432]: unresolved import `amber::transport`
 --> crates/amber/tests/windows_pipe.rs:9:5
  |
9 | use amber::transport;
  |     ^^^^^^^^^^^^^^^^ no `transport` in the root
```

### GREEN / focused gates

```text
$ cargo test -p amber --test windows_pipe
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

$ cargo test -p amber local_stream_round_trips_a_protocol_frame
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 480 filtered out

$ cargo test -p amber nonblocking_write_retries_zero_progress_without_losing_partial_progress
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 481 filtered out

$ cargo check --manifest-path crates/amber/tests/windows_pipe_peer/Cargo.toml
Finished `dev` profile [unoptimized + debuginfo] target(s) successfully

$ cargo check --manifest-path crates/amber/tests/windows_pipe_peer/Cargo.toml \\
    --target x86_64-pc-windows-msvc
Finished `dev` profile [unoptimized + debuginfo] target(s) successfully

$ cargo clippy -p amber --all-targets
Finished successfully (two pre-existing `needless_return` warnings in
crates/amber/src/platform.rs)

$ node app/test/windows-pipe.mjs
SKIP windows-pipe.mjs: Windows named pipes require Windows
```

`git diff --check` is clean before the final commit.

## API/security decision and evidence

The raw fallback is intentionally isolated inside `transport.rs`' Windows
implementation. The public `bind` / `connect` / stream-split API and Unix
implementation remain unchanged.

- [`GenericNamespaced`](https://docs.rs/interprocess/2.4.3/interprocess/local_socket/enum.GenericNamespaced.html)
  documents the Windows `\\.\\pipe\\` mapping. `pipe_path` validates every
  endpoint via `to_ns_name::<GenericNamespaced>()`, strips one existing prefix,
  and passes the exact documented concrete `\\.\\pipe\\<endpoint>` path to
  Win32. This retains the required namespace contract even though interprocess
  cannot supply the required force-close property.
- The local downloaded `interprocess 2.4.3` source shows its raw named-pipe
  stream drop handles dirty output by lingering and flushing. That makes the
  wrapper unsuitable for the stalled-peer guarantee, so this task uses direct
  `CreateNamedPipeW`, `CreateFileW`, `ReadFile`, `WriteFile`, and
  `DisconnectNamedPipe` calls only within the Windows transport module.
- The first raw server instance sets `FILE_FLAG_FIRST_PIPE_INSTANCE`; all
  listener instances use byte-mode, nonblocking, local-only pipes and the same
  descriptor. A replacement is created before each `accept`; success installs
  it, while an accept error also installs that fresh replacement, so a failed
  pending instance cannot strand the listener without one.
- [`ConnectNamedPipe`](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-connectnamedpipe)
  specifies `ERROR_NO_DATA` when a prior client closed before the server
  disconnected its instance. The nonblocking accept loop calls
  `DisconnectNamedPipe` and returns to listening in that case; only
  `ERROR_PIPE_CONNECTED` denotes an accepted client. A Windows test creates
  exactly that pre-accept client close then accepts a fresh client.
- [`WriteFile`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-writefile)
  specifies that a nonblocking byte-mode pipe may return `TRUE` with a short
  byte count when capacity is insufficient. A nonempty `TRUE, 0` maps to
  `WouldBlock` after one Win32 call; positive short writes are returned
  unchanged. Pure focused tests cover both results.
- [`DisconnectNamedPipe`](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-disconnectnamedpipe)
  applies to a server handle created with `CreateNamedPipeW`. Each `Pipe`
  therefore carries a server/client role: server shutdown disconnects then
  closes; client shutdown only clears/closes its owned client handle.
- [`Microsoft's named-pipe security guidance`](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)
  says default named-pipe access is broader and that generic write contains
  `FILE_CREATE_PIPE_INSTANCE`. `current_user_sddl` reads the current token's
  user SID and builds `D:P(A;;GRGW;;;SID)`. `TOKEN_USER` is copied from the
  byte-backed API buffer with `ptr::read_unaligned`, avoiding an aligned
  reference into `Vec<u8>`; the SID pointer remains valid until conversion has
  completed.

`GRGW` is deliberately accepted **same-user trust parity**, not same-user
isolation: another process under the same SID has create-instance rights and
can pre-create the deterministic pipe before Amber starts. First-instance
ownership protects an already-active listener only; it does not prevent every
second-server/preemption scenario. The SID DACL blocks cross-user access.

## Node ↔ Rust proof

`crates/amber/tests/windows_pipe_peer` is an independent miniature Cargo
package with only `amber-core`, `interprocess`, `widestring`, and `windows-sys`.
It includes the real transport module by path and therefore typechecks Task 2
without compiling Amber's unrelated Unix-only application modules. The
cross-target command above successfully typechecked the Windows transport path.

On Windows, `app/test/windows-pipe.mjs` runs that peer and proves:

1. Node writes an Amber length-prefixed `SessionList` frame and receives the
   exact Rust echo.
2. Rust accepts a second Node client.
3. Node drains Rust's queued bytes, remains in flowing read mode, crosses a
   one-byte first-client barrier, and then observes Rust's forced server close
   without initiating a client close.

The Node harness has a 15-second aborting deadline and idempotent `try`/`finally`
cleanup for both sockets, the Rust child, and its persistent stdout/stderr line
monitor. Because the monitor is installed once immediately after spawn, queues
lines, and treats `exit` as metadata until stdout ends and the child closes, a
fast or late `QUEUED`/`RELEASED` cannot be lost between sequential wait calls.

## Changed files

- `crates/amber/Cargo.toml` — Windows raw-pipe dependency features.
- `crates/amber/src/transport.rs` — Unix transport unchanged; Windows direct
  named-pipe transport, user-SID DACL, first-instance listener, direct teardown.
- `crates/amber/tests/windows_pipe.rs` — Unix TDD parity and Windows
  pre-accept-disconnect recovery plus two-client queued-write/read-pending
  forced-release tests.
- `crates/amber/tests/windows_pipe_peer/Cargo.toml`, `Cargo.lock`, and
  `src/main.rs` — isolated Rust peer used by the Node proof.
- `crates/amber/src/bin/windows_pipe_peer.rs` — removed obsolete
  feature-gated product-crate helper.
- `app/test/windows-pipe.mjs` — bounded Node ↔ isolated-Rust proof harness.
- `app/test/windows-pipe-lifecycle.test.mjs` — platform-neutral child/stdout
  ordering and deadline-cleanup regressions using real Node processes/timers.
- `.superpowers/sdd/2026-08-27-windows-port-rebase/task-2-report.md` — cumulative
  Task 2 evidence and explicit Windows-unverified boundary (kept in the local
  ignored SDD evidence directory).

## Windows-unverified boundaries, assumptions, and risks

- Required Windows runtime gates remain unrun here:
  `cargo test -p amber --test windows_pipe` and
  `node app/test/windows-pipe.mjs`. The latter is the end-to-end Node ↔ Rust,
  multi-client, queued-output force-release proof and must run in Windows CI.
- `cargo check -p amber --target x86_64-pc-windows-msvc` remains blocked by
  pre-existing Unix-only Amber modules (`attach`, `daemon`, `web`, `watchers`,
  and others). The isolated helper removes that blocker specifically for this
  transport and cross-checks the actual `transport.rs` Windows code.
- The Windows implementation uses immediate nonblocking `ReadFile`/`WriteFile`
  calls so its handle mutex is never held across a kernel wait. Empty reads
  retry outside the mutex; zero-progress writes return `WouldBlock` for the
  upper deadline loop to retry. The direct server shutdown removes the handle;
  a retrying peer then returns `BrokenPipe`. Runtime timing and precise Node
  close-event behavior still require Windows execution.
- `cargo clippy -p amber --all-targets` exits zero but reports two existing
  `needless_return` warnings in `crates/amber/src/platform.rs`, outside this
  task. A fresh `cargo test -p amber` was attempted but did not complete at the
  pre-existing parallel socket-test stall; the focused Task 2 gates above did
  complete.

## Final harness redesign: prebuilt direct peer only

The final reviewer correctly rejected the preceding Cargo/tree-kill cleanup
design: starting a process tree and invoking a second process to kill that tree
does not give this Node harness a reliable child-reaping contract. Worse, the
old `finally` path destroyed stdio and called `unref()` even when the directly
owned process had not emitted `exit`, allowing cleanup failure to masquerade as
release. This redesign supersedes every build/artifact-parser/taskkill claim in
the earlier historical harness sections.

The Windows harness now requires `AMBER_WINDOWS_PIPE_PEER` to identify the
exact prebuilt standalone `windows_pipe_peer.exe`. Validation happens before
spawn: the value must exist, must be absolute under Windows path semantics, and
must stat as a file. There is no fallback, target-directory guess, build
command, artifact parser, shell, or process-tree helper. The one validated
executable is spawned directly with the generated pipe endpoint as its only
argument, preserving the intended Node ↔ real Rust peer runtime proof.

Windows usage is:

```powershell
$env:AMBER_WINDOWS_PIPE_PEER = (Resolve-Path '<exact-artifact>\windows_pipe_peer.exe').Path
node app/test/windows-pipe.mjs
```

**Task 8 CI integration is required:** the Windows CI task must separately
build `crates/amber/tests/windows_pipe_peer`, resolve its exact resulting
executable artifact, set `AMBER_WINDOWS_PIPE_PEER` to that absolute file path,
and only then invoke the Node harness. Task 2 deliberately does not edit CI or
build the helper inside Node. On non-Windows hosts the executable entrypoint
checks the platform first and prints its skip message without reading or
validating the environment variable.

Cleanup now owns only the direct peer. The successful protocol still asks the
peer to close itself after the Node acknowledgement. Deadline cleanup first
aborts all event/read waits and destroys both pipe sockets, giving the peer a
bounded 250 ms opportunity to observe EOF and exit through its protocol error
path. Only if it remains alive does Node call `subprocess.kill()` on that exact
child and wait within the remaining two-second bound for the child's `exit`
event. Streams are destroyed only after `exit` (or after a failed spawn with no
PID), and the harness never detaches or unreferences the peer. If termination
throws, returns false, or no `exit` arrives, cleanup rejects loudly while
retaining the known-live child and its stdio references.

This follows Node's documented contracts: [`exit`](https://nodejs.org/api/child_process.html#event-exit)
is emitted after the child process ends; on Windows the supported termination
signals passed to [`subprocess.kill()`](https://nodejs.org/api/child_process.html#subprocesskillsignal)
terminate that direct process forcefully; and
[`subprocess.unref()`](https://nodejs.org/api/child_process.html#subprocessunref)
would remove the child from the event-loop reference count, which is precisely
why cleanup no longer calls it.

Fresh platform-neutral verification after the redesign:

```text
$ node --check app/test/windows-pipe.mjs
exit 0

$ node --check app/test/windows-pipe-lifecycle.test.mjs
exit 0

$ node --unhandled-rejections=strict --test \
    app/test/windows-pipe-lifecycle.test.mjs
tests 13; pass 13; fail 0

$ env -u AMBER_WINDOWS_PIPE_PEER node app/test/windows-pipe.mjs
SKIP windows-pipe.mjs: Windows named pipes require Windows
```

The 13 tests cover deadline and abort cleanup, line-monitor listener disposal,
failed spawn handling, missing/nonabsolute/non-file/unreadable configuration,
validation-before-spawn, exact direct-peer invocation, source-level absence of
build/tree-kill/target-guess logic, real direct-child termination and observed
exit, protocol-grace exit without a signal, and both false-returning and
throwing termination failures retaining a known-live peer without leaked wait
listeners. Native Windows runtime execution remains unavailable on this Linux
host and is still a Task 8 gate, not reported as passing here.

## Final Task 2 harness correction

The executable entrypoint no longer uses a bare top-level `await run()`. It now
catches a harness or cleanup failure, prints the error, sets `process.exitCode`
to 1, and checks the directly owned peer. If that peer is still known live, the
entrypoint installs explicit `error` and `exit` listeners and remains pending
until the peer actually emits `exit`. The child and its stdio stay referenced;
the existing line monitor also remains attached so peer output keeps draining,
and there is still no `unref()` path. Only after observed exit are the streams
destroyed and the lease/monitor listeners removed. Thus a successful `kill()`
return followed by no exit can no longer let the harness report completion or
orphan the peer: the process remains tied to it (and an outer CI job timeout
can expose the unreaped child).

`AMBER_WINDOWS_PIPE_PEER` resolution now distinguishes three cases. `ENOENT`
and `ENOTDIR` mean the configured path is missing, a successful stat of a
non-file reports that shape error, and all other stat failures report that the
path could not be inspected. Inspection errors include their code (for example
`EACCES` or `EPERM`) and retain the original error as `cause`; access denial is
no longer mislabeled as a missing artifact.

The direct-spawn regression also uses a Windows executable path containing
spaces and a spaced endpoint. It proves the full executable string remains the
single command, the endpoint remains one argument, and `shell: false` remains
set, so no quoting or shell parsing is introduced.

Final platform-neutral verification on Linux:

```text
$ node --check app/test/windows-pipe.mjs
exit 0

$ node --check app/test/windows-pipe-lifecycle.test.mjs
exit 0

$ node --unhandled-rejections=strict --test \
    app/test/windows-pipe-lifecycle.test.mjs
tests 16; pass 16; fail 0

$ env -u AMBER_WINDOWS_PIPE_PEER node --unhandled-rejections=strict \
    app/test/windows-pipe.mjs
SKIP windows-pipe.mjs: Windows named pipes require Windows
```

The three added regressions cover access-denied stat classification with the
original cause, direct spawn with a Windows path containing spaces, and the
entrypoint-level cleanup failure where `kill()` returns true but the child does
not exit. The last test proves the entrypoint reports failure yet remains
pending with live-child listeners and intact streams, then releases only after
a deterministic synthetic exit. Native Windows runtime execution remains
unavailable on this Linux host and is still reported as unrun.
