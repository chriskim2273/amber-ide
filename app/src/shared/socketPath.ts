import { join } from 'node:path'

// Mirror crates/amber/src/main.rs default_socket()/default_root().
export function resolveSocketPath(env: NodeJS.ProcessEnv): string {
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
