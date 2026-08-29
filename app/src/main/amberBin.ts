import { join, win32 } from 'node:path'

// Where to find the `amber` binary. In a packaged app it's bundled under the
// app's resources (electron-builder `extraResources`); in dev it's on PATH.
// `AMBER_BIN` overrides both (used by tests and local runs against a debug build).
export function resolveAmberBinary(
  env: NodeJS.ProcessEnv,
  isPackaged: boolean,
  resourcesPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env['AMBER_BIN']
  if (override && override.length > 0) return override
  if (isPackaged) return platform === 'win32'
    ? win32.join(resourcesPath, 'bin', 'amber.exe')
    : join(resourcesPath, 'bin', 'amber')
  return platform === 'win32' ? 'amber.exe' : 'amber'
}

/** Locate the windowless daemon binary bundled alongside the console CLI. */
export function resolveAmberDaemonBinary(
  env: NodeJS.ProcessEnv,
  isPackaged: boolean,
  resourcesPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env['AMBERD_BIN']
  if (override && override.length > 0) return override
  if (isPackaged) return platform === 'win32'
    ? win32.join(resourcesPath, 'bin', 'amberd.exe')
    : join(resourcesPath, 'bin', 'amberd')
  return platform === 'win32' ? 'amberd.exe' : 'amberd'
}

/** Stable console CLI location installed by the per-user Windows app. */
export function windowsAmberPath(localAppData: string): string {
  return win32.join(localAppData, 'Programs', 'amber-ide', 'amber.exe')
}

/** Stable windowless daemon location installed by the per-user Windows app. */
export function windowsDaemonPath(localAppData: string): string {
  return win32.join(localAppData, 'Programs', 'amber-ide', 'amberd.exe')
}
