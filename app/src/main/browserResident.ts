import { chmod, copyFile, lstat, mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ensurePrivateRuntimeDirectory } from './browserHostPaths'

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

export class ResidentIntentLatch {
  private activation = false
  private quit = false
  private handlers: { activate: () => Promise<void>; quit: () => Promise<void> } | null = null
  private consuming: Promise<void> | null = null
  requestActivation(): void { this.activation = true; void this.consume() }
  requestQuit(): void { this.quit = true; void this.consume() }
  install(handlers: { activate: () => Promise<void>; quit: () => Promise<void> }): void { this.handlers = handlers }
  consume(): Promise<void> {
    if (!this.handlers) return Promise.resolve()
    if (this.consuming) return this.consuming
    this.consuming = (async () => {
      while (this.handlers && (this.activation || this.quit)) {
        if (this.activation) { this.activation = false; await this.handlers.activate() }
        if (this.quit) { this.quit = false; await this.handlers.quit() }
      }
    })().finally(() => { this.consuming = null })
    return this.consuming
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function atomicPrivateWrite(path: string, contents: string, uid: number): Promise<void> {
  const parent = dirname(path)
  await ensurePrivateRuntimeDirectory(parent, uid)
  const temporary = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(contents); await handle.sync() } finally { await handle.close() }
  try {
    await rename(temporary, path)
    await syncDirectory(parent)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

async function validateLauncherExecutable(candidate: string, platform: 'linux' | 'darwin', uid: number): Promise<string> {
  if (candidate.includes('/.mount_') || candidate.includes('/tmp/.mount')) throw new Error('browser host registration requires a stable installed executable')
  const executable = await realpath(candidate)
  if (executable.includes('/.mount_') || executable.includes('/tmp/.mount')) throw new Error('browser host registration requires a stable installed executable')
  const metadata = await stat(executable)
  if (!metadata.isFile() || (metadata.mode & 0o111) === 0) throw new Error('browser host executable is not a regular executable')
  if ((metadata.mode & 0o022) !== 0) throw new Error('browser host executable is group/world-writable')
  if (metadata.uid !== uid && metadata.uid !== 0) throw new Error('browser host executable has untrusted ownership')
  let parent: string | null = dirname(executable)
  while (parent) {
    const info = await lstat(parent)
    if (info.isSymbolicLink() || !info.isDirectory() || (info.uid !== uid && info.uid !== 0)) throw new Error('browser host executable has an unsafe parent')
    const mode = info.mode & 0o777
    if ((mode & 0o022) !== 0) throw new Error('browser host executable has a group/world-writable parent')
    if (info.uid === uid && mode === 0o700) break
    const next = dirname(parent)
    parent = next === parent ? null : next
  }
  if (platform === 'darwin' && !executable.includes('.app/Contents/MacOS/')) throw new Error('macOS browser host executable must be inside an app bundle')
  if (platform === 'linux' && executable.includes('.app/Contents/MacOS/')) throw new Error('Linux browser host executable cannot use a macOS bundle')
  return executable
}

export async function registerBrowserHostLauncher(root: string, input: BrowserHostLauncherInput): Promise<BrowserHostLauncherRecord> {
  if (input.platform !== 'linux' && input.platform !== 'darwin') throw new Error('browser host launcher is unsupported on this platform')
  const uid = input.uid ?? process.getuid?.()
  if (uid === undefined) throw new Error('browser host launcher cannot determine the current user')
  if (input.installGeneration.length < 1 || input.installGeneration.length > 128 || /[\u0000-\u001f\u007f]/u.test(input.installGeneration)) throw new Error('invalid browser host install generation')
  const candidate = input.platform === 'linux' && input.appImage ? input.appImage : input.executable
  const executable = await validateLauncherExecutable(candidate, input.platform, uid)
  const record: BrowserHostLauncherRecord = {
    version: 1, executable, args: ['--browser-host'], installGeneration: input.installGeneration,
    platform: input.platform, ownerUid: uid,
  }
  await atomicPrivateWrite(join(root, 'browser-host-launcher.json'), `${JSON.stringify(record)}\n`, uid)
  return record
}

export interface AppImageUpgradeHooks { beforeCommit?: () => Promise<void> }

export async function installStableAppImage(source: string, destination: string, register: () => Promise<void>, uid = process.getuid?.(), hooks?: AppImageUpgradeHooks): Promise<void> {
  if (uid === undefined) throw new Error('cannot determine current user')
  const sourcePath = await validateLauncherExecutable(source, 'linux', uid)
  const parent = dirname(destination)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const destinationPath = await realpath(destination).catch(() => destination)
  if (sourcePath === destinationPath) { await register(); return }
  const nonce = `${process.pid}-${randomUUID()}`
  const temporary = join(parent, `.${basename(destination)}.upgrade-${nonce}.tmp`)
  const backup = join(parent, `.${basename(destination)}.upgrade-${nonce}.old`)
  let backupReady = false, newInstalled = false
  try {
    await copyFile(sourcePath, temporary)
    await chmod(temporary, 0o700)
    const handle = await open(temporary, 'r'); try { await handle.sync() } finally { await handle.close() }
    await validateLauncherExecutable(temporary, 'linux', uid)

    // Keep a private rollback copy while the old pathname remains visible. The
    // final rename replaces that pathname in one filesystem operation; moving
    // the old pathname away first would leave a crash window with no launcher.
    try {
      await copyFile(destination, backup)
      await chmod(backup, 0o700)
      const backupHandle = await open(backup, 'r'); try { await backupHandle.sync() } finally { await backupHandle.close() }
      backupReady = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await hooks?.beforeCommit?.()
    await rename(temporary, destination); newInstalled = true
    await syncDirectory(parent)
    await register()
    if (backupReady) {
      // Registration has committed the new executable. Failure to clean the
      // private rollback copy must not undo that committed launcher pathname.
      await rm(backup, { force: true }).catch(() => {})
      backupReady = false
      await syncDirectory(parent).catch(() => {})
    }
  } catch (error) {
    if (newInstalled) {
      await rm(destination, { force: true }).catch(() => {})
      if (backupReady) {
        try { await rename(backup, destination); backupReady = false } catch { /* keep the rollback artifact for recovery */ }
      }
    }
    await syncDirectory(parent).catch(() => {})
    throw error
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
    // A backup is unnecessary when the old pathname was never replaced or was
    // restored successfully. If restoration itself failed, retain it rather
    // than deleting the only known-good executable.
    if (!newInstalled || !backupReady) await rm(backup, { force: true }).catch(() => {})
  }
}

export async function writeBrowserHostInhibit(root: string): Promise<void> {
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error('cannot determine current user')
  await atomicPrivateWrite(join(root, 'browser-host-inhibit'), `${JSON.stringify({ version: 1, reason: 'explicit-quit', writtenAt: Date.now() })}\n`, uid)
}

export async function clearBrowserHostInhibit(root: string): Promise<void> {
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error('cannot determine current user')
  await ensurePrivateRuntimeDirectory(root, uid)
  await rm(join(root, 'browser-host-inhibit'), { force: true })
  await syncDirectory(root)
}

export interface BrowserHostQuitDeps {
  writeInhibit: () => Promise<void>
  beginDrain: () => void
  flushAndDestroy: (signal: AbortSignal) => Promise<void>
  closeBroker: () => Promise<void>
  closeWatcher: () => void
  closeWindows: () => void
}

export async function coordinateBrowserHostQuit(deps: BrowserHostQuitDeps, timeoutMs = 5_000): Promise<{ ok: true } | { ok: false; error: 'QUIT_DRAIN_TIMEOUT' | 'QUIT_DRAIN_FAILED' }> {
  let flushController: AbortController | undefined
  try {
    await deps.writeInhibit()
    deps.beginDrain()
    flushController = new AbortController()
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        flushController?.abort()
        reject(new Error('QUIT_DRAIN_TIMEOUT'))
      }, timeoutMs)
    })
    try { await Promise.race([deps.flushAndDestroy(flushController.signal), timeout]) }
    catch (error) { flushController.abort(); throw error }
    finally { if (timer) clearTimeout(timer) }
    await deps.closeBroker()
    deps.closeWatcher()
    deps.closeWindows()
    return { ok: true }
  } catch (error) {
    flushController?.abort()
    return { ok: false, error: error instanceof Error && error.message === 'QUIT_DRAIN_TIMEOUT' ? 'QUIT_DRAIN_TIMEOUT' : 'QUIT_DRAIN_FAILED' }
  }
}
