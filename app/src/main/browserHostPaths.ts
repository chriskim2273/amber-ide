import { chmod, lstat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export function browserHostRuntimeDirectory(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, uid: number, temporaryRoot: string): string {
  if (platform === 'win32') throw new Error('BROWSER_HOST_UNSUPPORTED')
  const runtime = env['XDG_RUNTIME_DIR']
  return runtime && runtime.length > 0 ? join(runtime, 'amber-ide') : join(temporaryRoot, `amber-ide-${uid}`)
}

export function browserHostSocketPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, uid: number, temporaryRoot: string): string {
  return env['AMBER_BROWSER_HOST_SOCKET'] ?? join(browserHostRuntimeDirectory(env, platform, uid, temporaryRoot), 'browser-host.sock')
}

export async function validatePrivateRuntimeDirectory(path: string, uid: number): Promise<void> {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink()) throw new Error('browser host runtime directory must not be a symlink')
  if (!metadata.isDirectory()) throw new Error('browser host runtime path is not a directory')
  if (metadata.uid !== uid) throw new Error('browser host runtime directory belongs to another user')
  if ((metadata.mode & 0o777) !== 0o700) throw new Error('browser host runtime directory must have mode 0700')
}

export async function ensurePrivateRuntimeDirectory(path: string, uid: number): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const metadata = await lstat(path)
  if (!metadata.isSymbolicLink() && metadata.isDirectory() && metadata.uid === uid && (metadata.mode & 0o777) !== 0o700) await chmod(path, 0o700)
  await validatePrivateRuntimeDirectory(path, uid)
}
