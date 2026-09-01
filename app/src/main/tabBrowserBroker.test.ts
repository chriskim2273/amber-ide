import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { authorizeBrowserRequest, isEligiblePiController, parseBrokerRequest, TabBrowserBrokerServer } from './tabBrowserBroker'
import type { LayoutFile } from '../shared/layoutFile'

const cleanup: string[] = []
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }) })

const layout: LayoutFile = { version: 2, activeWorkspace: 1, workspaces: { '1': { activeTab: 1, tabs: { '2': { tree: null, browser: { id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', width: 420, collapsed: false, designatedPi: 'amber-1-2-0-pane', sharedWithPi: true } } } } } }

describe('tab browser broker boundary', () => {
  it('strictly parses bounded typed requests', () => {
    expect(parseBrokerRequest({ version: 1, clientInstanceId: 'client-01', sequence: 1, requestId: 'r1', amberSession: 'amber-1-2-0-pane', action: { type: 'status' } }).action).toEqual({ type: 'status' })
    expect(() => parseBrokerRequest({ version: 1, clientInstanceId: 'client-01', sequence: 1, requestId: 'r1', amberSession: 'amber-1-2-0-pane', action: { type: 'cdp' } })).toThrow('INVALID_REQUEST')
    expect(() => parseBrokerRequest({ version: 1, clientInstanceId: 'client-01', sequence: 1, requestId: 'r1', amberSession: '', action: { type: 'status' } })).toThrow('INVALID_REQUEST')
    expect(() => parseBrokerRequest({ version: 1, clientInstanceId: 'client-01', sequence: 1, requestId: 'r1', amberSession: 'amber-1-2-0-pane', action: { type: 'navigate', url: 'https://example.test', pageIncarnation: 'x'.repeat(257), expectedGeneration: 0 } })).toThrow('INVALID_REQUEST')
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

  it('replays identical results but rejects changed payloads and evicted sequences', async () => {
    if (process.platform === 'win32') return
    const dir = await mkdtemp(join(tmpdir(), 'amber-browser-broker-')); cleanup.push(dir)
    const socketPath = join(dir, 'broker.sock'); const tokenPath = join(dir, 'token'); let calls = 0
    const server = new TabBrowserBrokerServer(socketPath, tokenPath, async (request) => ({ call: ++calls, action: request.action.type }))
    await server.start(); const token = (await readFile(tokenPath, 'utf8')).trim()
    const encode = (value: unknown): Buffer => { const body = Buffer.from(JSON.stringify(value)); const out = Buffer.alloc(body.length + 4); out.writeUInt32BE(body.length); body.copy(out, 4); return out }
    const base = { version: 1, clientInstanceId: 'client-replay', amberSession: 'amber-1-2-0-pane' }
    const requests = [
      { ...base, sequence: 2, requestId: 'same', action: { type: 'status' } },
      { ...base, sequence: 2, requestId: 'same', action: { type: 'status' } },
      { ...base, sequence: 2, requestId: 'same', action: { type: 'stop' } },
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
            encode({ version: 1, clientInstanceId: 'client-fifo', sequence: 1, requestId: 'mutation', amberSession: 'amber-1-2-0-pane', action: { type: 'stop' } }),
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

  it('bounds request execution time and rejects replayed request ids', async () => {
    if (process.platform === 'win32') return
    const dir = await mkdtemp(join(tmpdir(), 'amber-browser-broker-')); cleanup.push(dir)
    const socketPath = join(dir, 'broker.sock'); const tokenPath = join(dir, 'token')
    const server = new TabBrowserBrokerServer(socketPath, tokenPath, async (request) => {
      if (request.requestId === 'slow') await new Promise(() => {})
      return { action: request.action.type }
    }, { requestTimeoutMs: 20 })
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
            encode({ version: 1, clientInstanceId: 'client-01', sequence: 1, requestId: 'slow', amberSession: 'amber-1-2-0-pane', action: { type: 'status' } }),
            encode({ version: 1, clientInstanceId: 'client-01', sequence: 1, requestId: 'slow', amberSession: 'amber-1-2-0-pane', action: { type: 'status' } }),
          ]))
          if (values.length === 3) { socket.end(); resolve(values) }
        }
      })
    })
    expect(replies.slice(1).map((reply) => reply['error'])).toEqual(['ACTION_TIMEOUT', 'ACTION_TIMEOUT'])
    await server.close()
  })
})
