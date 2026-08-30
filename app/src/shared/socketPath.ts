import { posix } from 'node:path'

/**
 * Where the daemon's unix socket is.
 *
 * `AMBER_SOCKET` wins over every derivation. Two reasons it exists:
 * SSH remote windows (spec 2026-08-23) must point a client at a tunnel's local
 * end, and an isolated verification run must be able to steer the app off the
 * user's real daemon — the absence of this override already cost one live test
 * in this repo, where an `AMBER_SOCKET` that looked set was ignored and the GUI
 * attached to the user's production sessions.
 */
export function resolveSocketPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  const explicit = env['AMBER_SOCKET']
  if (explicit && explicit.length > 0) return explicit
  // This must stay byte-for-byte aligned with Rust's
  // `platform::socket_name_for_root`. The endpoint is already isolated by the
  // daemon's current-user DACL and first-instance ownership; a username suffix
  // would make Electron unable to reach it.
  if (platform === 'win32') return '\\\\.\\pipe\\amber-ide'
  const runtime = env['XDG_RUNTIME_DIR']
  if (runtime && runtime.length > 0) {
    return posix.join(runtime, 'amber-ide', 'amberd.sock')
  }
  const stateHome = env['XDG_STATE_HOME']
  const root = stateHome && stateHome.length > 0
    ? posix.join(stateHome, 'amber-ide')
    : posix.join(env['HOME'] ?? '.', '.local/state/amber-ide')
  return posix.join(root, 'amberd.sock')
}
