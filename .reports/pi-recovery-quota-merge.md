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
