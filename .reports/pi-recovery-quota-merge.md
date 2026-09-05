# Pi recovery and live quota integration

Integrated main's persistent browser host with the primary-Pi recovery hook.
The generated extension is v8: browser registrations preserved, awaited exact-file
recovery and signal-aware quit handlers retained, original unmarked legacy source
kept only for ownership migration. Future owned versions still fail closed.

Merged-tree gates: 893 Rust tests passed; warnings-as-errors clippy passed;
1,079 app tests passed (one intentional skip); typecheck and desktop/web builds
passed; five generated recovery-extension tests passed. Fixed a pre-existing
CLI test-server hang by draining the incoming request before closing its reply
socket (otherwise unread input can reset the listing connection).

Additional verifier limitation: installed Pi 0.85 compiles the generated
extension, but its direct loader fails on the published package's missing
@earendil-works/pi-server dependency, as already documented by the browser-host
branch. The older local Pi 0.81 verifier also encounters Node type conflicts.
Neither installed Pi package nor the production extension was modified to hide
these external issues. Full direct-loader/browser runtime verification on the
installed package is not claimed.

Deployment is a separate operation. File replacement does not restart running
processes or migrate legacy Pi recordings. Those activation steps remain explicit.

## Production activation — 2026-09-05

Deployed build `5005217` with backups and atomic replacement of the AppImage,
daemon and router. Installed hashes and embedded binaries matched the tested
release; its private Pi reboot proof passed. Boot services, linger and existing
desktop autostart were verified.

After explicit activation approval, captured 21 live primary mappings directly
from Pi. The remaining mapping was verified against its exact prior launch
receipt and a live primary-child command matching the transcript's tool call.
Stopped services, backed up final state, migrated all 22 mappings, removed the
temporary capture extension, and restarted services and the app. Updated served
web assets with the entry HTML published last, retaining old hashed assets.

Post-activation verification confirmed 22 live primary Pi processes with the
same conversation IDs, exact files and cwds, plus fresh daemon-accepted hook
writes for every pane. The normal installed Pi runtime loaded the new hook;
the separate direct-loader packaging limitation above remains distinct.
Running service executables and app ASAR matched the tested build. Live quota
manual refresh produced a new successful sample. A final snapshot was saved.
Local evidence: `~/recovery/amber-ide/activation-20260905T093820Z/verified-active.json`.
A physical machine reboot was not performed.
