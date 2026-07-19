import { join } from 'node:path'

// Where to find the `amber` binary. In a packaged app it's bundled under the
// app's resources (electron-builder `extraResources`); in dev it's on PATH.
// `AMBER_BIN` overrides both (used by tests and local runs against a debug build).
export function resolveAmberBinary(
  env: NodeJS.ProcessEnv,
  isPackaged: boolean,
  resourcesPath: string,
): string {
  const override = env['AMBER_BIN']
  if (override && override.length > 0) return override
  const exe = process.platform === 'win32' ? 'amber.exe' : 'amber'
  if (isPackaged) return join(resourcesPath, 'bin', exe)
  return exe
}
