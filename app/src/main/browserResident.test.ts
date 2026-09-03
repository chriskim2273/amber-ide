import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  activationRequest,
  clearBrowserHostInhibit,
  coordinateBrowserHostQuit,
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

  it('returns a timeout without closing resources so the caller may cancel or force', async () => {
    let closed = false
    const result = await coordinateBrowserHostQuit({
      writeInhibit: async () => {}, beginDrain: () => {}, flushAndDestroy: async () => new Promise(() => {}),
      closeBroker: async () => { closed = true }, closeWatcher: () => { closed = true }, closeWindows: () => { closed = true },
    }, 5)
    expect(result).toEqual({ ok: false, error: 'QUIT_DRAIN_TIMEOUT' })
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

  it('writes and clears the explicit-stop inhibit durably', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amber-browser-resident-'))
    await writeBrowserHostInhibit(root)
    expect(JSON.parse(await readFile(join(root, 'browser-host-inhibit'), 'utf8'))).toMatchObject({ version: 1, reason: 'explicit-quit' })
    await clearBrowserHostInhibit(root)
    await expect(readFile(join(root, 'browser-host-inhibit'))).rejects.toThrow()
  })
})
