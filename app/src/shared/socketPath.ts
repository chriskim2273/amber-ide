import { join } from 'node:path'

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
export function resolveSocketPath(env: NodeJS.ProcessEnv): string {
  const explicit = env['AMBER_SOCKET']
  if (explicit && explicit.length > 0) return explicit
  const runtime = env['XDG_RUNTIME_DIR']
  if (runtime && runtime.length > 0) {
    return join(runtime, 'amber-ide', 'amberd.sock')
  }
  const stateHome = env['XDG_STATE_HOME']
  const root = stateHome && stateHome.length > 0
    ? join(stateHome, 'amber-ide')
    : join(env['HOME'] ?? '.', '.local/state/amber-ide')
  return join(root, 'amberd.sock')
}
