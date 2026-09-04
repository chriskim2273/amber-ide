import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { authorizeBrowserRequest, brokerRequestDigest, dispatchAttachedBrokerAction, isEligiblePiController, parseBrokerRequest, safeBrokerError, TabBrowserBrokerServer } from './tabBrowserBroker'
import type { LayoutFile } from '../shared/layoutFile'
import { BrowserOperationRegistry } from './browserOperationRegistry'

const cleanup: string[] = []
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }) })

const layout: LayoutFile = { version: 2, activeWorkspace: 1, workspaces: { '1': { activeTab: 1, tabs: { '2': { tree: null, browser: { id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', width: 420, collapsed: false, designatedPi: 'amber-1-2-0-pane', sharedWithPi: true } } } } } }

describe('tab browser broker boundary', () => {
  it('forwards stop cancellation and fresh authorization to the service queue', async () => {
    const controller = new AbortController(); const validator = () => true
    let captured: unknown[] = []
    await dispatchAttachedBrokerAction({ type: 'stop', pageIncarnation: 'page', expectedGeneration: 2 }, 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', controller.signal, validator,
      async (...args) => { captured = args; return {} })
    expect(captured[0]).toEqual({ type: 'stop', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', pageIncarnation: 'page', expectedGeneration: 2 })
    expect(captured[1]).toBeInstanceOf(AbortSignal)
    expect(captured[1]).not.toBe(controller.signal)
    await expect((captured[2] as () => Promise<boolean>)()).resolves.toBe(true)
  })

  it('strictly parses bounded typed requests', () => {
    expect(parseBrokerRequest({ version: 1, clientInstanceId: 'client-01', sequence: 1, requestId: 'r1', amberSession: 'amber-1-2-0-pane', action: { type: 'status' } }).action).toEqual({ type: 'status' })
    expect(parseBrokerRequest({ version: 1, clientInstanceId: 'client-01', sequence: 2, requestId: 'r2', amberSession: 'amber-1-2-0-pane', action: { type: 'snapshot', pageIncarnation: 'page', expectedGeneration: 1 } }).action).toMatchObject({ type: 'snapshot', limits: { maxNodes: 2000 } })
    expect(() => parseBrokerRequest({ version: 1, clientInstanceId: 'client-01', sequence: 1, requestId: 'r1', amberSession: 'amber-1-2-0-pane', action: { type: 'cdp' } })).toThrow('INVALID_REQUEST')
    expect(() => parseBrokerRequest({ version: 1, clientInstanceId: 'client-01', sequence: 1, requestId: 'r1', amberSession: 'amber-1-2-0-pane', action: { type: 'stop' } })).toThrow('INVALID_REQUEST')
    expect(() => parseBrokerRequest({ version: 1, clientInstanceId: 'client-01', sequence: 1, requestId: 'r1', amberSession: '', action: { type: 'status' } })).toThrow('INVALID_REQUEST')
    expect(() => parseBrokerRequest({ version: 1, clientInstanceId: 'client-01', sequence: 1, requestId: 'r1', amberSession: 'amber-1-2-0-pane', action: { type: 'navigate', url: 'https://example.test', pageIncarnation: 'x'.repeat(257), expectedGeneration: 0 } })).toThrow('INVALID_REQUEST')
  })
  it('forwards every observation/navigation tool through cancellation and dispatch-time authorization', async () => {
    const signal = new AbortController().signal; const validate = () => true; const calls: unknown[][] = []
    const action = { type: 'snapshot' as const, pageIncarnation: 'page', expectedGeneration: 1, limits: { maxDepth: 20, maxNodes: 2000, maxBytes: 262144 } }
    await dispatchAttachedBrokerAction(action, 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', signal, validate, async (...args) => { calls.push(args); return {} })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toEqual({ type: 'automation', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', action })
    expect(calls[0]?.[1]).toBeInstanceOf(AbortSignal)
    expect(calls[0]?.[1]).not.toBe(signal)
    await expect((calls[0]?.[2] as () => Promise<boolean>)()).resolves.toBe(true)
  })

  it('hashes replay identity without retaining credential plaintext', () => {
    const digest = brokerRequestDigest({ sequence: 1, amberSession: 'amber-1-2-0-pane', action: { type: 'interact', pageIncarnation: 'page', expectedGeneration: 1, operation: { kind: 'fill', target: { snapshotId: 'snap', ref: 'n1' }, text: 'super-secret' } } })
    expect(digest).toMatch(/^[a-f0-9]{64}$/); expect(digest).not.toContain('super-secret')
  })

  it('maps implementation errors to a stable code without leaking diagnostic canaries', () => {
    expect(safeBrokerError(new Error('ACTION_TIMEOUT'))).toBe('ACTION_TIMEOUT')
    expect(safeBrokerError(new Error('Authorization: Bearer secret /home/user/file'))).toBe('INTERNAL_ERROR')
  })

  it.each([
    ['Share off during screenshot', { type: 'screenshot' as const, pageIncarnation: 'page', expectedGeneration: 1, fullPage: false }, 'shared'],
    ['designation changes during wait', { type: 'wait' as const, pageIncarnation: 'page', expectedGeneration: 1, condition: { kind: 'text' as const, value: 'ready' }, timeoutMs: 1000 }, 'designated'],
    ['association changes during navigation', { type: 'navigate' as const, pageIncarnation: 'page', expectedGeneration: 1, url: 'https://example.test/' }, 'associated'],
    ['controller dies during screenshot', { type: 'screenshot' as const, pageIncarnation: 'page', expectedGeneration: 1, fullPage: false }, 'controllerAlive'],
  ])('suppresses results when %s', async (_label, action, revokedKey) => {
    const authority = { shared: true, designated: true, associated: true, controllerAlive: true }
    let release!: () => void
    const dispatched = new Promise<Record<string, unknown>>((resolve) => { release = () => resolve({ secretResult: true }) })
    const request = dispatchAttachedBrokerAction(action, 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', new AbortController().signal,
      () => Object.values(authority).every(Boolean), async () => dispatched, 1)
    authority[revokedKey as keyof typeof authority] = false
    release()
    await expect(request).rejects.toThrow('STALE_BROWSER_CONTEXT')
  })

  it('reports that a completed interaction cannot be rolled back when authority changes before return', async () => {
    const action = { type: 'interact' as const, pageIncarnation: 'page', expectedGeneration: 1, operation: { kind: 'click' as const, target: { snapshotId: 'snap', ref: 'n1' } } }
    await expect(dispatchAttachedBrokerAction(action, 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', new AbortController().signal,
      () => false, async () => ({ dispatched: true, rollbackPossible: false }))).rejects.toThrow('STALE_BROWSER_CONTEXT_NO_ROLLBACK')
  })

  it('aborts active cancellable work when controller authority is revoked', async () => {
    let authorized = true; let operationSignal: AbortSignal | undefined
    const request = dispatchAttachedBrokerAction(
      { type: 'wait', pageIncarnation: 'page', expectedGeneration: 1, condition: { kind: 'networkIdle' }, timeoutMs: 1000 },
      'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', new AbortController().signal, () => authorized,
      async (_command, signal) => new Promise((_resolve, reject) => {
        operationSignal = signal
        signal?.addEventListener('abort', () => reject(new Error('ACTION_CANCELLED')), { once: true })
      }), 1)
    authorized = false
    await expect(request).rejects.toThrow('STALE_BROWSER_CONTEXT')
    expect(operationSignal?.aborted).toBe(true)
  })

  it('rejects dead and shell-fallback Pi controllers', () => {
    expect(isEligiblePiController({ kind: 'pi', alive: true, runState: 'claude' })).toBe(true)
    expect(isEligiblePiController({ kind: 'pi', alive: false, runState: 'claude' })).toBe(false)
    expect(isEligiblePiController({ kind: 'pi', alive: true, runState: 'shell-fallback' })).toBe(false)
    expect(isEligiblePiController({ kind: 'shell', alive: true })).toBe(false)
  })

  it('authorizes only the designated shared controller in its current tab', () => {
    expect(authorizeBrowserRequest(layout, 'amber-1-2-0-pane')).toEqual({ ws: 1, tab: 2, browserId: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
    expect(() => authorizeBrowserRequest(layout, 'amber-1-2-1-other')).toThrow('NOT_DESIGNATED_CONTROLLER')
  })
  it('allows an open-only solicitation from a Pi-shaped current tab without sharing', () => {    const unshared: LayoutFile = { version: 1, activeWorkspace: 1, workspaces: { '1': { activeTab: 2, tabs: { '2': { tree: null } } } } }
    expect(authorizeBrowserRequest(unshared, 'amber-1-2-0-pane', true)).toEqual({ ws: 1, tab: 2 })
    expect(() => authorizeBrowserRequest(unshared, 'amber-1-2-0-pane')).toThrow('NO_BROWSER_FOR_TAB')
  })

  it('does not unlink a live broker socket owned by another host', async () => {
    if (process.platform === 'win32') return
    const dir = await mkdtemp(join(tmpdir(), 'amber-browser-broker-')); cleanup.push(dir)
    const socketPath = join(dir, 'broker.sock')
    const first = new TabBrowserBrokerServer(socketPath, join(dir, 'token-a'), async () => ({}))
    const second = new TabBrowserBrokerServer(socketPath, join(dir, 'token-b'), async () => ({}))
    await first.start()
    await expect(second.start()).rejects.toThrow('BROWSER_HOST_ALREADY_RUNNING')
    await expect(new Promise<void>((resolve, reject) => {
      const socket = connect(socketPath); socket.once('connect', () => { socket.destroy(); resolve() }); socket.once('error', reject)
    })).resolves.toBeUndefined()
    await first.close()
  })

  it('quarantines a corrupt private regular token and atomically rotates it', async () => {
    if (process.platform === 'win32') return
    const dir = await mkdtemp(join(tmpdir(), 'amber-browser-broker-')); cleanup.push(dir)
    const tokenPath = join(dir, 'token'); await writeFile(tokenPath, 'corrupt\n', { mode: 0o600 })
    await writeFile(`${tokenPath}.crash.tmp`, 'partial', { mode: 0o600 })
    const server = new TabBrowserBrokerServer(join(dir, 'broker.sock'), tokenPath, async () => ({}))
    await server.start()
    expect((await readFile(tokenPath, 'utf8')).trim()).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect((await stat(tokenPath)).mode & 0o077).toBe(0)
    expect((await readdir(dir)).some((name) => name === 'token.invalid')).toBe(true)
    await server.close()
  })

  it('rejects a symlink token file', async () => {
    if (process.platform === 'win32') return
    const dir = await mkdtemp(join(tmpdir(), 'amber-browser-broker-')); cleanup.push(dir)
    await writeFile(join(dir, 'target'), 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n', { mode: 0o600 })
    await symlink(join(dir, 'target'), join(dir, 'token'))
    const server = new TabBrowserBrokerServer(join(dir, 'broker.sock'), join(dir, 'token'), async () => ({}))
    await expect(server.start()).rejects.toThrow('invalid browser host token file')
  })

  it('requires the private token before dispatching a framed request', async () => {
    if (process.platform === 'win32') return
    const dir = await mkdtemp(join(tmpdir(), 'amber-browser-broker-')); cleanup.push(dir)
    const socketPath = join(dir, 'broker.sock'); const tokenPath = join(dir, 'token')
    const server = new TabBrowserBrokerServer(socketPath, tokenPath, async (request) => ({ action: request.action.type }))
    await server.start()
    const token = (await readFile(tokenPath, 'utf8')).trim()
    const encode = (value: unknown): Buffer => { const body = Buffer.from(JSON.stringify(value)); const out = Buffer.alloc(body.length + 4); out.writeUInt32BE(body.length); body.copy(out, 4); return out }
    const replies = await new Promise<unknown[]>((resolve, reject) => {
      const socket = connect(socketPath); let buffer = Buffer.alloc(0); const values: unknown[] = []
      socket.on('error', reject)
      socket.on('connect', () => socket.write(encode({ token })))
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE(0) + 4) {
          const size = buffer.readUInt32BE(0); values.push(JSON.parse(buffer.subarray(4, 4 + size).toString())); buffer = buffer.subarray(4 + size)
          if (values.length === 1) socket.write(encode({ version: 1, clientInstanceId: 'client-01', sequence: 1, requestId: 'x', amberSession: 'amber-1-2-0-pane', action: { type: 'status' } }))
          if (values.length === 2) { socket.end(); resolve(values) }
        }
      })
    })
    expect(replies).toEqual([{ ok: true }, { version: 1, requestId: 'x', ok: true, result: { action: 'status' } }])
    await server.close()
  })

  it('closes on invalid UTF-8 before JSON parsing', async () => {
    if (process.platform === 'win32') return
    const dir = await mkdtemp(join(tmpdir(), 'amber-browser-broker-')); cleanup.push(dir)
    const socketPath = join(dir, 'broker.sock'); const tokenPath = join(dir, 'token')
    const server = new TabBrowserBrokerServer(socketPath, tokenPath, async () => ({}))
    await server.start(); const token = (await readFile(tokenPath, 'utf8')).trim()
    const encode = (value: unknown): Buffer => { const body = Buffer.from(JSON.stringify(value)); const out = Buffer.alloc(body.length + 4); out.writeUInt32BE(body.length); body.copy(out, 4); return out }
    await new Promise<void>((resolve, reject) => {
      const socket = connect(socketPath); socket.on('error', () => {})
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('broker did not close malformed ingress')) }, 1000)
      socket.once('close', () => { clearTimeout(timer); resolve() })
      socket.once('connect', () => socket.write(encode({ token })))
      socket.once('data', () => {
        const body = Buffer.from([0xc3])
        const malformed = Buffer.alloc(4 + body.length); malformed.writeUInt32BE(body.length); body.copy(malformed, 4)
        socket.write(malformed)
      })
    })
    await server.close()
  })

  it('transports screenshot attachments as a raw binary frame, never a path or JSON byte array', async () => {
    if (process.platform === 'win32') return
    const dir = await mkdtemp(join(tmpdir(), 'amber-browser-broker-')); cleanup.push(dir)
    const socketPath = join(dir, 'broker.sock'); const tokenPath = join(dir, 'token'); const image = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const server = new TabBrowserBrokerServer(socketPath, tokenPath, async () => ({ mediaType: 'image/png' as const, data: image, width: 1, height: 1 }))
    await server.start(); const token = (await readFile(tokenPath, 'utf8')).trim()
    const encode = (value: unknown): Buffer => { const body = Buffer.from(JSON.stringify(value)); const out = Buffer.alloc(body.length + 4); out.writeUInt32BE(body.length); body.copy(out, 4); return out }
    const received = await new Promise<{ meta: Record<string, unknown>; bytes: Buffer }>((resolve, reject) => {
      const socket = connect(socketPath); let buffer = Buffer.alloc(0); let authenticated = false; let meta: Record<string, unknown> | undefined
      socket.on('error', reject); socket.on('connect', () => socket.write(encode({ token })))
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE(0) + 4) {
          const size = buffer.readUInt32BE(0); const body = Buffer.from(buffer.subarray(4, 4 + size)); buffer = buffer.subarray(4 + size)
          if (!authenticated) { authenticated = true; socket.write(encode({ version: 1, clientInstanceId: 'client-image', sequence: 1, requestId: 'shot', amberSession: 'amber-1-2-0-pane', action: { type: 'status' } })); continue }
          if (!meta) { meta = JSON.parse(body.toString()) as Record<string, unknown>; continue }
          socket.end(); resolve({ meta, bytes: body })
        }
      })
    })
    expect(received.bytes).toEqual(image)
    expect(received.meta).toMatchObject({ ok: true, result: { contentTrust: 'untrusted-browser-content', mediaType: 'image/png', attachment: { encoding: 'binary-frame', byteLength: 4 } } })
    expect(JSON.stringify(received.meta)).not.toMatch(/path|"data"/)
    const replay = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = connect(socketPath); let buffer = Buffer.alloc(0); let authenticated = false
      socket.on('error', reject); socket.on('connect', () => socket.write(encode({ token })))
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]); if (buffer.length < 4 || buffer.length < buffer.readUInt32BE(0) + 4) return
        const size = buffer.readUInt32BE(0); const value = JSON.parse(buffer.subarray(4, 4 + size).toString()) as Record<string, unknown>; buffer = buffer.subarray(4 + size)
        if (!authenticated) { authenticated = true; socket.write(encode({ version: 1, clientInstanceId: 'client-image', sequence: 1, requestId: 'shot', amberSession: 'amber-1-2-0-pane', action: { type: 'status' } })); return }
        socket.end(); resolve(value)
      })
    })
    expect(replay).toMatchObject({ ok: false, error: 'ACTION_CANCELLED' })
    await server.close()
  })

  it('aborts in-flight work when its client disconnects', async () => {
    if (process.platform === 'win32') return
    const dir = await mkdtemp(join(tmpdir(), 'amber-browser-broker-')); cleanup.push(dir)
    const socketPath = join(dir, 'broker.sock'); const tokenPath = join(dir, 'token')
    let aborted = false
    const server = new TabBrowserBrokerServer(socketPath, tokenPath, async (_request, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('ACTION_CANCELLED')) }, { once: true })
    }))
    await server.start()
    const token = (await readFile(tokenPath, 'utf8')).trim()
    const encode = (value: unknown): Buffer => { const body = Buffer.from(JSON.stringify(value)); const out = Buffer.alloc(body.length + 4); out.writeUInt32BE(body.length); body.copy(out, 4); return out }
    await new Promise<void>((resolve, reject) => {
      const socket = connect(socketPath)
      socket.on('error', reject)
      socket.on('connect', () => socket.write(encode({ token })))
      socket.once('data', () => {
        socket.end(encode({ version: 1, clientInstanceId: 'client-01', sequence: 1, requestId: 'cancel', amberSession: 'amber-1-2-0-pane', action: { type: 'status' } }))
        resolve()
      })
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(aborted).toBe(true)
    await server.close()
  })

  it('Stop Pi aborts active work for exactly the designated controller', async () => {
    if (process.platform === 'win32') return
    const dir = await mkdtemp(join(tmpdir(), 'amber-browser-broker-')); cleanup.push(dir)
    const socketPath = join(dir, 'broker.sock'); const tokenPath = join(dir, 'token'); let started = false; let aborted = false
    const server = new TabBrowserBrokerServer(socketPath, tokenPath, async (_request, signal) => new Promise((_resolve, reject) => {
      started = true; signal.addEventListener('abort', () => { aborted = true; reject(new Error('ACTION_CANCELLED')) }, { once: true })
    }))
    await server.start(); const token = (await readFile(tokenPath, 'utf8')).trim()
    const encode = (value: unknown): Buffer => { const body = Buffer.from(JSON.stringify(value)); const out = Buffer.alloc(body.length + 4); out.writeUInt32BE(body.length); body.copy(out, 4); return out }
    const socket = connect(socketPath); socket.on('error', () => {})
    await new Promise<void>((resolve) => { socket.on('connect', () => socket.write(encode({ token }))); socket.once('data', () => { socket.write(encode({ version: 1, clientInstanceId: 'client-stop', sequence: 1, requestId: 'stop-pi', amberSession: 'amber-1-2-0-pane', action: { type: 'status' } })); resolve() }) })
    await vi.waitFor(() => expect(started).toBe(true))
    server.cancelController('amber-9-9-9-other'); expect(aborted).toBe(false)
    server.cancelController('amber-1-2-0-pane'); await vi.waitFor(() => expect(aborted).toBe(true))
    socket.destroy(); await server.close()
  })

  it('retains accepted client high-water tombstones and refuses new identities at the bound', async () => {
    if (process.platform === 'win32') return
    const dir = await mkdtemp(join(tmpdir(), 'amber-browser-broker-')); cleanup.push(dir)
    const socketPath = join(dir, 'broker.sock'), tokenPath = join(dir, 'token'); let now = 1_000; let calls = 0
    const server = new TabBrowserBrokerServer(socketPath, tokenPath, async () => ({ call: ++calls }), { maxClientIdentities: 1, resultTtlMs: 10, now: () => now })
    await server.start(); const token = (await readFile(tokenPath, 'utf8')).trim()
    const encode = (value: unknown): Buffer => { const body = Buffer.from(JSON.stringify(value)); const out = Buffer.alloc(body.length + 4); out.writeUInt32BE(body.length); body.copy(out, 4); return out }
    const ask = (clientInstanceId: string, sequence: number, requestId: string): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
      const socket = connect(socketPath); let buffer = Buffer.alloc(0), welcomed = false
      socket.on('error', reject); socket.on('connect', () => socket.write(encode({ token })))
      socket.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE(0) + 4) { const size = buffer.readUInt32BE(0), reply = JSON.parse(buffer.subarray(4, 4 + size).toString()) as Record<string, unknown>; buffer = buffer.subarray(4 + size); if (!welcomed) { welcomed = true; socket.write(encode({ version: 1, clientInstanceId, sequence, requestId, amberSession: 'amber-1-2-0-pane', action: { type: 'status' } })) } else { socket.end(); resolve(reply) } } })
    })
    expect((await ask('client-one', 1, 'first'))['ok']).toBe(true)
    now += 11
    expect((await ask('client-one', 1, 'first'))['error']).toBe('ACTION_CANCELLED')
    expect((await ask('client-two', 1, 'second'))['error']).toBe('REQUEST_LIMIT')
    expect(calls).toBe(1); await server.close()
  })

  it('replays identical results but rejects changed payloads and evicted sequences', async () => {
    if (process.platform === 'win32') return
    const dir = await mkdtemp(join(tmpdir(), 'amber-browser-broker-')); cleanup.push(dir)
    const socketPath = join(dir, 'broker.sock'); const tokenPath = join(dir, 'token'); let calls = 0; let replayChecks = 0
    const server = new TabBrowserBrokerServer(socketPath, tokenPath, async (request) => ({ call: ++calls, action: request.action.type }), { authorizeReplay: () => { replayChecks += 1; return true } })
    await server.start(); const token = (await readFile(tokenPath, 'utf8')).trim()
    const encode = (value: unknown): Buffer => { const body = Buffer.from(JSON.stringify(value)); const out = Buffer.alloc(body.length + 4); out.writeUInt32BE(body.length); body.copy(out, 4); return out }
    const base = { version: 1, clientInstanceId: 'client-replay', amberSession: 'amber-1-2-0-pane' }
    const requests = [
      { ...base, sequence: 2, requestId: 'same', action: { type: 'status' } },
      { ...base, sequence: 2, requestId: 'same', action: { type: 'status' } },
      { ...base, sequence: 2, requestId: 'same', action: { type: 'stop', pageIncarnation: 'page', expectedGeneration: 1 } },
      { ...base, sequence: 1, requestId: 'old', action: { type: 'status' } },
    ]
    const replies = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const socket = connect(socketPath); let buffer = Buffer.alloc(0); const values: Record<string, unknown>[] = []
      socket.on('error', reject); socket.on('connect', () => socket.write(encode({ token })))
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE(0) + 4) {
          const size = buffer.readUInt32BE(0); values.push(JSON.parse(buffer.subarray(4, 4 + size).toString()) as Record<string, unknown>); buffer = buffer.subarray(4 + size)
          if (values.length === 1) socket.write(Buffer.concat(requests.map(encode)))
          if (values.length === 5) { socket.end(); resolve(values.slice(1)) }
        }
      })
    })
    expect((replies[0]!['result'] as { call: number }).call).toBe(1)
    expect((replies[1]!['result'] as { call: number }).call).toBe(1)
    expect(replies[2]!['error']).toBe('INVALID_REQUEST')
    expect(replies[3]!['error']).toBe('ACTION_CANCELLED')
    expect(calls).toBe(1)
    expect(replayChecks).toBe(1)
    await server.close()
  })

  it('registers queued broker work before dispatch so drain aborts and empties the whole queue', async () => {
    if (process.platform === 'win32') return
    const dir = await mkdtemp(join(tmpdir(), 'amber-browser-broker-')); cleanup.push(dir)
    const socketPath = join(dir, 'broker.sock'), tokenPath = join(dir, 'token'), operations = new BrowserOperationRegistry()
    const server = new TabBrowserBrokerServer(socketPath, tokenPath, async (_request, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('ACTION_CANCELLED')), { once: true })), { operations })
    await server.start(); const token = (await readFile(tokenPath, 'utf8')).trim()
    const encode = (value: unknown): Buffer => { const body = Buffer.from(JSON.stringify(value)); const out = Buffer.alloc(body.length + 4); out.writeUInt32BE(body.length); body.copy(out, 4); return out }
    const socket = connect(socketPath); socket.on('error', () => {})
    await new Promise<void>((resolve) => socket.once('connect', resolve)); socket.write(encode({ token }))
    await new Promise((resolve) => setTimeout(resolve, 5))
    socket.write(Buffer.concat([
      encode({ version: 1, clientInstanceId: 'drain-client', sequence: 1, requestId: 'one', amberSession: 'amber-1-2-0-pane', action: { type: 'status' } }),
      encode({ version: 1, clientInstanceId: 'drain-client', sequence: 2, requestId: 'two', amberSession: 'amber-1-2-0-pane', action: { type: 'status' } }),
    ]))
    for (let attempt = 0; attempt < 20 && operations.summary().total !== 2; attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(operations.summary()).toMatchObject({ broker: 2, total: 2 })
    operations.beginDrain(); await operations.waitForEmpty()
    expect(operations.summary().total).toBe(0)
    socket.destroy(); await server.close()
  })

  it('does not replay cached page data once broker drain begins', async () => {
    if (process.platform === 'win32') return
    const dir = await mkdtemp(join(tmpdir(), 'amber-browser-broker-')); cleanup.push(dir)
    const socketPath = join(dir, 'broker.sock'), tokenPath = join(dir, 'token'), operations = new BrowserOperationRegistry()
    const server = new TabBrowserBrokerServer(socketPath, tokenPath, async () => ({ pageData: 'cached-before-drain' }), {
      operations, authorizeReplay: () => true,
    })
    await server.start(); const token = (await readFile(tokenPath, 'utf8')).trim()
    const encode = (value: unknown): Buffer => { const body = Buffer.from(JSON.stringify(value)); const out = Buffer.alloc(body.length + 4); out.writeUInt32BE(body.length); body.copy(out, 4); return out }
    const request = { version: 1, clientInstanceId: 'drain-replay', sequence: 1, requestId: 'same', amberSession: 'amber-1-2-0-pane', action: { type: 'status' } }
    const replies = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const socket = connect(socketPath); let buffer = Buffer.alloc(0); const values: Record<string, unknown>[] = []
      socket.on('error', reject); socket.on('connect', () => socket.write(encode({ token })))
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE(0) + 4) {
          const size = buffer.readUInt32BE(0); const value = JSON.parse(buffer.subarray(4, 4 + size).toString()) as Record<string, unknown>
          buffer = buffer.subarray(4 + size); values.push(value)
          if (values.length === 1) socket.write(encode(request))
          else if (values.length === 2) { operations.beginDrain(); socket.write(encode(request)) }
          else { socket.end(); resolve(values) }
        }
      })
    })
    expect(replies[1]).toMatchObject({ ok: true, result: { pageData: 'cached-before-drain' } })
    expect(replies[2]).toMatchObject({ ok: false, error: 'BROWSER_HOST_SHUTTING_DOWN' })
    expect(replies[2]).not.toHaveProperty('result')
    await server.close()
  })

  it('serializes mutations and following observations for one browser key', async () => {
    if (process.platform === 'win32') return
    const dir = await mkdtemp(join(tmpdir(), 'amber-browser-broker-')); cleanup.push(dir)
    const socketPath = join(dir, 'broker.sock'); const tokenPath = join(dir, 'token'); const order: string[] = []
    const server = new TabBrowserBrokerServer(socketPath, tokenPath, async (request) => {
      order.push(`start:${request.requestId}`)
      if (request.requestId === 'mutation') await new Promise((resolve) => setTimeout(resolve, 20))
      order.push(`end:${request.requestId}`); return {}
    })
    await server.start(); const token = (await readFile(tokenPath, 'utf8')).trim()
    const encode = (value: unknown): Buffer => { const body = Buffer.from(JSON.stringify(value)); const out = Buffer.alloc(body.length + 4); out.writeUInt32BE(body.length); body.copy(out, 4); return out }
    const replies = await new Promise<unknown[]>((resolve, reject) => {
      const socket = connect(socketPath); let buffer = Buffer.alloc(0); const values: unknown[] = []
      socket.on('error', reject); socket.on('connect', () => socket.write(encode({ token })))
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE(0) + 4) {
          const size = buffer.readUInt32BE(0); values.push(JSON.parse(buffer.subarray(4, 4 + size).toString())); buffer = buffer.subarray(4 + size)
          if (values.length === 1) socket.write(Buffer.concat([
            encode({ version: 1, clientInstanceId: 'client-fifo', sequence: 1, requestId: 'mutation', amberSession: 'amber-1-2-0-pane', action: { type: 'stop', pageIncarnation: 'page', expectedGeneration: 1 } }),
            encode({ version: 1, clientInstanceId: 'client-fifo', sequence: 2, requestId: 'observation', amberSession: 'amber-1-2-0-pane', action: { type: 'status' } }),
          ]))
          if (values.length === 3) { socket.end(); resolve(values) }
        }
      })
    })
    expect(replies).toHaveLength(3)
    expect(order).toEqual(['start:mutation', 'end:mutation', 'start:observation', 'end:observation'])
    await server.close()
  })

  it('bounds request execution time and releases following queued work', async () => {
    if (process.platform === 'win32') return
    const dir = await mkdtemp(join(tmpdir(), 'amber-browser-broker-')); cleanup.push(dir)
    const socketPath = join(dir, 'broker.sock'); const tokenPath = join(dir, 'token')
    const server = new TabBrowserBrokerServer(socketPath, tokenPath, async (request) => {
      if (request.requestId.startsWith('slow')) await new Promise(() => {})
      return { action: request.action.type }
    }, { requestTimeoutMs: 20, operationBarrierTimeoutMs: 20 })
    await server.start()
    const token = (await readFile(tokenPath, 'utf8')).trim()
    const encode = (value: unknown): Buffer => { const body = Buffer.from(JSON.stringify(value)); const out = Buffer.alloc(body.length + 4); out.writeUInt32BE(body.length); body.copy(out, 4); return out }
    const replies = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const socket = connect(socketPath); let buffer = Buffer.alloc(0); const values: Record<string, unknown>[] = []
      socket.on('error', reject)
      socket.on('connect', () => socket.write(encode({ token })))
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE(0) + 4) {
          const size = buffer.readUInt32BE(0); values.push(JSON.parse(buffer.subarray(4, 4 + size).toString()) as Record<string, unknown>); buffer = buffer.subarray(4 + size)
          if (values.length === 1) socket.write(Buffer.concat([
            encode({ version: 1, clientInstanceId: 'client-01', sequence: 1, requestId: 'slow-one', amberSession: 'amber-1-2-0-pane', action: { type: 'status' } }),
            encode({ version: 1, clientInstanceId: 'client-01', sequence: 2, requestId: 'slow-two', amberSession: 'amber-1-2-0-pane', action: { type: 'status' } }),
            encode({ version: 1, clientInstanceId: 'client-01', sequence: 3, requestId: 'after-timeout', amberSession: 'amber-1-2-0-pane', action: { type: 'status' } }),
          ]))
          if (values.length === 4) { socket.end(); resolve(values) }
        }
      })
    })
    expect(replies.slice(1, 3).map((reply) => reply['error'])).toEqual(['ACTION_TIMEOUT', 'ACTION_TIMEOUT'])
    expect(replies[3]).toMatchObject({ ok: true, result: { action: 'status' } })
    await server.close()
  })

  it('aborts the request controller on timeout and suppresses a late nested service result', async () => {
    if (process.platform === 'win32') return
    const dir = await mkdtemp(join(tmpdir(), 'amber-browser-broker-')); cleanup.push(dir)
    const socketPath = join(dir, 'broker.sock'), tokenPath = join(dir, 'token'), operations = new BrowserOperationRegistry()
    let nestedSignal: AbortSignal | undefined
    let release!: () => void
    const server = new TabBrowserBrokerServer(socketPath, tokenPath, (_request, signal) => operations.run('broker', async () => operations.run('command', async (innerSignal) => {
      nestedSignal = innerSignal
      return new Promise((resolve) => { release = () => resolve({ secretResult: true }) })
    }, signal), signal), { operations, queueKey: async () => 'browser:test', requestTimeoutMs: 15, operationBarrierTimeoutMs: 15 })
    await server.start()
    const token = (await readFile(tokenPath, 'utf8')).trim()
    const encode = (value: unknown): Buffer => { const body = Buffer.from(JSON.stringify(value)); const out = Buffer.alloc(body.length + 4); out.writeUInt32BE(body.length); body.copy(out, 4); return out }
    const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = connect(socketPath); let buffer = Buffer.alloc(0); let welcomed = false
      socket.on('error', reject)
      socket.on('connect', () => socket.write(encode({ token })))
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE(0) + 4) {
          const size = buffer.readUInt32BE(0); const value = JSON.parse(buffer.subarray(4, 4 + size).toString()) as Record<string, unknown>; buffer = buffer.subarray(4 + size)
          if (!welcomed) {
            welcomed = true
            socket.write(encode({ version: 1, clientInstanceId: 'timeout-client', sequence: 1, requestId: 'timeout', amberSession: 'amber-1-2-0-pane', action: { type: 'status' } }))
          } else {
            socket.destroy(); resolve(value)
          }
        }
      })
    })
    expect(reply).toMatchObject({ ok: false, error: 'ACTION_TIMEOUT' })
    expect(nestedSignal?.aborted).toBe(true)
    release()
    await operations.waitForEmpty()
    await server.close()
  })

  it.each(['socket-close', 'stop-pi', 'drain'] as const)('cancels a request while queueKey is pending (%s), without losing later FIFO work', async (mode) => {
    if (process.platform === 'win32') return
    const dir = await mkdtemp(join(tmpdir(), 'amber-browser-broker-')); cleanup.push(dir)
    const socketPath = join(dir, 'broker.sock'), tokenPath = join(dir, 'token')
    const operations = new BrowserOperationRegistry()
    let handleCalls = 0
    let releaseKey!: (key: string) => void
    let queueEntered!: () => void
    const entered = new Promise<void>((resolve) => { queueEntered = resolve })
    let first = true
    const server = new TabBrowserBrokerServer(socketPath, tokenPath, async () => { handleCalls += 1; return { handled: true } }, {
      operations,
      queueKey: async () => {
        if (!first) return 'browser:test'
        first = false; queueEntered()
        return new Promise<string>((resolve) => { releaseKey = resolve })
      },
    })
    await server.start()
    const token = (await readFile(tokenPath, 'utf8')).trim()
    const encode = (value: unknown): Buffer => { const body = Buffer.from(JSON.stringify(value)); const out = Buffer.alloc(body.length + 4); out.writeUInt32BE(body.length); body.copy(out, 4); return out }
    const firstSocket = connect(socketPath); firstSocket.on('error', () => {})
    await new Promise<void>((resolve) => firstSocket.once('connect', resolve))
    firstSocket.write(encode({ token }))
    await new Promise<void>((resolve) => firstSocket.once('data', () => resolve()))
    firstSocket.write(encode({ version: 1, clientInstanceId: `cancel-${mode}`, sequence: 1, requestId: 'cancelled', amberSession: 'amber-1-2-0-pane', action: { type: 'status' } }))
    await entered
    expect(operations.summary()).toMatchObject({ broker: 1, total: 1 })

    if (mode === 'socket-close') firstSocket.destroy()
    else if (mode === 'stop-pi') server.cancelController('amber-1-2-0-pane')
    else operations.beginDrain()
    await operations.waitForEmpty()
    expect(operations.summary().total).toBe(0)
    releaseKey('browser:test')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(handleCalls).toBe(0)

    if (mode === 'drain') operations.cancelDrain()
    firstSocket.destroy()
    const later = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = connect(socketPath); let buffer = Buffer.alloc(0); let welcomed = false
      socket.on('error', reject)
      socket.on('connect', () => socket.write(encode({ token })))
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE(0) + 4) {
          const size = buffer.readUInt32BE(0); const reply = JSON.parse(buffer.subarray(4, 4 + size).toString()) as Record<string, unknown>; buffer = buffer.subarray(4 + size)
          if (!welcomed) { welcomed = true; socket.write(encode({ version: 1, clientInstanceId: `later-${mode}`, sequence: 1, requestId: 'later', amberSession: 'amber-1-2-0-pane', action: { type: 'status' } })) }
          else { socket.end(); resolve(reply) }
        }
      })
    })
    expect(later).toMatchObject({ ok: true, result: { handled: true } })
    expect(handleCalls).toBe(1)
    await server.close()
  })
})
