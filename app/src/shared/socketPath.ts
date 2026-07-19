import { join } from 'node:path'

// Mirror crates/amber/src/main.rs default_socket()/default_root().
// On Windows the daemon endpoint is a named pipe, not a filesystem socket;
// Node `net` connects to a named pipe when given a `\\.\pipe\...` path. This
// MUST byte-match the Rust `#[cfg(windows)] default_socket()` so the client and
// daemon meet on the same pipe.
export function resolveSocketPath(env: NodeJS.ProcessEnv): string {
  if (process.platform === 'win32') {
    return windowsPipePath(env)
  }
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

// `\\.\pipe\amber-ide-<user>` with the same alphanumeric sanitization as the
// Rust daemon (non-alphanumeric -> '-').
export function windowsPipePath(env: NodeJS.ProcessEnv): string {
  const raw = env['USERNAME'] && env['USERNAME'].length > 0 ? env['USERNAME'] : 'user'
  const user = raw.replace(/[^a-zA-Z0-9]/g, '-')
  return `\\\\.\\pipe\\amber-ide-${user}`
}
