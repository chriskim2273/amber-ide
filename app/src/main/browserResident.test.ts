import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  activationRequest,
  cleanupTrackedTunnels,
  clearBrowserHostInhibit,
  coordinateBrowserHostQuit,
  createSingleFlight,
  installStableAppImage,
  parseActivationRequest,
  registerBrowserHostLauncher,
  ResidentIntentLatch,
  writeBrowserHostInhibit,
} from './browserResident'

describe('resident browser host activation', () => {
  it('latches activation and quit intents until lifecycle handlers are ready', async () => {
    const latch = new ResidentIntentLatch(); const calls: string[] = []
    latch.requestActivation(); latch.requestQuit()
    latch.install({ activate: async () => { calls.push('activate') }, quit: async () => { calls.push('quit') } })
    await latch.consume()
    expect(calls).toEqual(['activate', 'quit'])
  })

  it('accepts only the bounded versioned activation envelope', () => {
    expect(activationRequest(['amber', '--browser-host'])).toEqual({ version: 1, mode: 'browser-host' })
    expect(activationRequest(['amber'])).toEqual({ version: 1, mode: 'normal' })
    expect(parseActivationRequest({ version: 1, mode: 'normal' })).toBe('normal')
    expect(parseActivationRequest({ version: 1, mode: 'browser-host', extra: true })).toBeNull()
    expect(parseActivationRequest({ version: 2, mode: 'normal' })).toBeNull()
    expect(parseActivationRequest(null)).toBeNull()
  })
})

describe('resident activation and tunnel cleanup', () => {
  it('coalesces concurrent deferred opens into one completion', async () => {
    let release!: () => void
    let opens = 0
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const reopen = createSingleFlight(async () => { opens += 1; await blocked })
    const first = reopen(); const second = reopen()
    expect(second).toBe(first)
    release()
    await Promise.all([first, second])
    expect(opens).toBe(1)
  })

  it('resets a rejected open so a later activation can retry', async () => {
    let shouldFail = true; let opens = 0
    const reopen = createSingleFlight(async () => { opens += 1; if (shouldFail) throw new Error('OPEN_FAILED') })
    const first = reopen(); const joined = reopen()
    expect(joined).toBe(first)
    await expect(first).rejects.toThrow('OPEN_FAILED')
    shouldFail = false
    await expect(reopen()).resolves.toBeUndefined()
    expect(opens).toBe(2)
  })

  it('focuses the window found by the in-flight recheck instead of opening another', async () => {
    let registered = false; let opens = 0; let focuses = 0
    const reopen = createSingleFlight(async () => {
      if (registered) { focuses += 1; return }
      opens += 1
    })
    registered = true
    await reopen()
    expect({ opens, focuses }).toEqual({ opens: 0, focuses: 1 })
  })

  it('force cleanup terminates a tracked tunnel and removes its owned runtime state', async () => {
    if (process.platform === 'win32') return
    const dir = await mkdtemp(join(tmpdir(), 'amber-tunnel-cleanup-'))
    const proc = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    try {
      await new Promise<void>((resolve, reject) => {
        proc.once('spawn', () => resolve())
        proc.once('error', reject)
      })
      const tracked = new Map([[1, { proc, dir, socket: join(dir, 'remote.sock') }]])
      await cleanupTrackedTunnels(tracked, 25)
      expect(tracked.size).toBe(0)
      expect(proc.exitCode !== null || proc.signalCode !== null).toBe(true)
      await expect(stat(dir)).rejects.toThrow()
      // A second normal/forced cleanup sees the same empty ownership set and
      // is a no-op, which is the idempotence guarantee used by index.ts.
      await cleanupTrackedTunnels(tracked, 25)
    } finally {
      if (proc.exitCode === null) proc.kill('SIGKILL')
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('coordinated resident quit', () => {
  it('writes inhibit, drains state, then closes process-owned resources in order', async () => {
    const order: string[] = []
    const result = await coordinateBrowserHostQuit({
      writeInhibit: async () => { order.push('inhibit') },
      beginDrain: () => { order.push('drain') },
      flushAndDestroy: async () => { order.push('persist+destroy') },
      closeBroker: async () => { order.push('broker') },
      closeWatcher: () => { order.push('watcher') },
      closeWindows: () => { order.push('windows') },
    }, 100)
    expect(result).toEqual({ ok: true })
    expect(order).toEqual(['inhibit', 'drain', 'persist+destroy', 'broker', 'watcher', 'windows'])
  })

  it('aborts the timed-out flush so it cannot complete after the caller cancels', async () => {
    let flushSignal: AbortSignal | undefined
    let closed = false
    const result = await coordinateBrowserHostQuit({
      writeInhibit: async () => {}, beginDrain: () => {}, flushAndDestroy: async (signal?: AbortSignal) => {
        flushSignal = signal
        return new Promise(() => {})
      },
      closeBroker: async () => { closed = true }, closeWatcher: () => { closed = true }, closeWindows: () => { closed = true },
    }, 5)
    expect(result).toEqual({ ok: false, error: 'QUIT_DRAIN_TIMEOUT' })
    expect(flushSignal).toBeDefined()
    expect(flushSignal?.aborted).toBe(true)
    expect(closed).toBe(false)
  })
})

describe('resident browser host registration', () => {
  it('canonicalizes and atomically writes a private executable registration', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'amber-browser-resident-'))
    const executable = join(root, 'amber ide')
    await writeFile(executable, '#!/bin/sh\n', { mode: 0o700 })
    const record = await registerBrowserHostLauncher(root, {
      platform: 'linux', executable, appImage: undefined, installGeneration: '1.2.3', uid: process.getuid?.(),
    })
    expect(record).toMatchObject({ version: 1, executable, args: ['--browser-host'], installGeneration: '1.2.3', platform: 'linux' })
    expect(JSON.parse(await readFile(join(root, 'browser-host-launcher.json'), 'utf8'))).toEqual(record)
    expect((await stat(join(root, 'browser-host-launcher.json'))).mode & 0o077).toBe(0)
  })

  it('uses the stable AppImage path and rejects an ephemeral mount', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'amber-browser-resident-'))
    const appImage = join(root, 'Amber IDE.AppImage')
    await writeFile(appImage, 'image', { mode: 0o700 })
    const record = await registerBrowserHostLauncher(root, {
      platform: 'linux', executable: '/tmp/.mount_amber/usr/bin/amber-ide', appImage, installGeneration: 'next', uid: process.getuid?.(),
    })
    expect(record.executable).toBe(appImage)
    await expect(registerBrowserHostLauncher(root, {
      platform: 'linux', executable: '/tmp/.mount_amber/usr/bin/amber-ide', installGeneration: 'next', uid: process.getuid?.(),
    })).rejects.toThrow('stable')
  })

  it('rejects writable executable paths and parents', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'amber-browser-resident-'))
    const unsafeParent = join(root, 'unsafe'); await mkdir(unsafeParent, { mode: 0o777 })
    await chmod(unsafeParent, 0o777)
    const executable = join(unsafeParent, 'amber'); await writeFile(executable, '#!/bin/sh\n', { mode: 0o700 })
    await expect(registerBrowserHostLauncher(root, { platform: 'linux', executable, installGeneration: 'x', uid: process.getuid!() })).rejects.toThrow('writable parent')
  })

  it('rolls an AppImage upgrade back when launcher registration fails', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'amber-browser-resident-'))
    const source = join(root, 'new.AppImage'), stable = join(root, 'stable.AppImage')
    await writeFile(source, 'new', { mode: 0o700 }); await writeFile(stable, 'old', { mode: 0o700 })
    await expect(installStableAppImage(source, stable, async () => { throw new Error('registration failed') })).rejects.toThrow('registration failed')
    expect(await readFile(stable, 'utf8')).toBe('old')
    expect((await readdir(root)).filter((name) => name.includes('.upgrade-'))).toEqual([])
  })

  it('keeps the prior stable image in place when replacement is interrupted before commit', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'amber-browser-resident-'))
    const source = join(root, 'new.AppImage'), stable = join(root, 'stable.AppImage')
    await writeFile(source, 'new', { mode: 0o700 }); await writeFile(stable, 'old', { mode: 0o700 })
    let observed = ''
    const install = installStableAppImage as unknown as (source: string, destination: string, register: () => Promise<void>, uid: number | undefined, hooks: { beforeCommit: () => Promise<void> }) => Promise<void>
    await expect(install(source, stable, async () => {}, process.getuid?.(), { beforeCommit: async () => {
      observed = await readFile(stable, 'utf8')
      throw new Error('simulated interruption')
    } })).rejects.toThrow('simulated interruption')
    expect(observed).toBe('old')
    expect(await readFile(stable, 'utf8')).toBe('old')
  })

  it('writes and clears the explicit-stop inhibit durably', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'amber-browser-resident-'))
    await writeBrowserHostInhibit(root)
    expect(JSON.parse(await readFile(join(root, 'browser-host-inhibit'), 'utf8'))).toMatchObject({ version: 1, reason: 'explicit-quit' })
    await clearBrowserHostInhibit(root)
    await expect(readFile(join(root, 'browser-host-inhibit'))).rejects.toThrow()
  })
})
