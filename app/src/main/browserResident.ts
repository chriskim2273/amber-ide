import { chmod, mkdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface BrowserHostLauncherRecord {
  version: 1
  executable: string
  args: ['--browser-host']
  installGeneration: string
  platform: 'linux' | 'darwin'
  ownerUid?: number
}

export interface BrowserHostLauncherInput {
  platform: NodeJS.Platform
  executable: string
  appImage?: string | undefined
  installGeneration: string
  uid?: number | undefined
}

export interface BrowserHostActivationRequest { version: 1; mode: 'normal' | 'browser-host' }

export function activationRequest(argv: readonly string[]): BrowserHostActivationRequest {
  return { version: 1, mode: argv.includes('--browser-host') ? 'browser-host' : 'normal' }
}

export function parseActivationRequest(value: unknown): BrowserHostActivationRequest['mode'] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 2 || record['version'] !== 1) return null
  return record['mode'] === 'normal' || record['mode'] === 'browser-host' ? record['mode'] : null
}

async function atomicPrivateWrite(path: string, contents: string): Promise<void> {
  const parent = join(path, '..')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await chmod(parent, 0o700).catch(() => {})
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
    await chmod(path, 0o600)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

export async function registerBrowserHostLauncher(root: string, input: BrowserHostLauncherInput): Promise<BrowserHostLauncherRecord> {
  if (input.platform !== 'linux' && input.platform !== 'darwin') throw new Error('browser host launcher is unsupported on this platform')
  const candidate = input.platform === 'linux' && input.appImage ? input.appImage : input.executable
  if (candidate.includes('/.mount_') || candidate.includes('/tmp/.mount')) throw new Error('browser host registration requires a stable installed executable')
  const executable = await realpath(candidate)
  if (executable.includes('/.mount_') || executable.includes('/tmp/.mount')) throw new Error('browser host registration requires a stable installed executable')
  const metadata = await stat(executable)
  if (!metadata.isFile()) throw new Error('browser host executable is not a regular file')
  if ((metadata.mode & 0o111) === 0) throw new Error('browser host executable is not executable')
  const record: BrowserHostLauncherRecord = {
    version: 1, executable, args: ['--browser-host'], installGeneration: input.installGeneration,
    platform: input.platform, ...(input.uid === undefined ? {} : { ownerUid: input.uid }),
  }
  await atomicPrivateWrite(join(root, 'browser-host-launcher.json'), `${JSON.stringify(record)}\n`)
  return record
}

export async function writeBrowserHostInhibit(root: string): Promise<void> {
  await atomicPrivateWrite(join(root, 'browser-host-inhibit'), `${JSON.stringify({ version: 1, reason: 'explicit-quit', writtenAt: Date.now() })}\n`)
}

export async function clearBrowserHostInhibit(root: string): Promise<void> {
  await rm(join(root, 'browser-host-inhibit'), { force: true })
}

export interface BrowserHostQuitDeps {
  writeInhibit: () => Promise<void>
  beginDrain: () => void
  flushAndDestroy: () => Promise<void>
  closeBroker: () => Promise<void>
  closeWatcher: () => void
  closeWindows: () => void
}

export async function coordinateBrowserHostQuit(deps: BrowserHostQuitDeps, timeoutMs = 5_000): Promise<{ ok: true } | { ok: false; error: 'QUIT_DRAIN_TIMEOUT' | 'QUIT_DRAIN_FAILED' }> {
  try {
    await deps.writeInhibit()
    deps.beginDrain()
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('QUIT_DRAIN_TIMEOUT')), timeoutMs) })
    try { await Promise.race([deps.flushAndDestroy(), timeout]) } finally { if (timer) clearTimeout(timer) }
    await deps.closeBroker()
    deps.closeWatcher()
    deps.closeWindows()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error && error.message === 'QUIT_DRAIN_TIMEOUT' ? 'QUIT_DRAIN_TIMEOUT' : 'QUIT_DRAIN_FAILED' }
  }
}
