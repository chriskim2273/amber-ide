import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { authorizeBrowserRequest, parseBrokerRequest, TabBrowserBrokerServer } from './tabBrowserBroker'
import type { LayoutFile } from '../shared/layoutFile'

const cleanup: string[] = []
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }) })

const layout: LayoutFile = { version: 2, activeWorkspace: 1, workspaces: { '1': { activeTab: 1, tabs: { '2': { tree: null, browser: { id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', width: 420, collapsed: false, designatedPi: 'amber-1-2-0-pane', sharedWithPi: true } } } } } }

describe('tab browser broker boundary', () => {
  it('strictly parses bounded typed requests', () => {
    expect(parseBrokerRequest({ version: 1, requestId: 'r1', amberSession: 'amber-1-2-0-pane', action: { type: 'status' } }).action).toEqual({ type: 'status' })
    expect(() => parseBrokerRequest({ version: 1, requestId: 'r1', amberSession: 'amber-1-2-0-pane', action: { type: 'cdp' } })).toThrow('INVALID_REQUEST')
  })
  it('authorizes only the designated shared controller in its current tab', () => {
    expect(authorizeBrowserRequest(layout, 'amber-1-2-0-pane')).toEqual({ ws: 1, tab: 2, browserId: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
    expect(() => authorizeBrowserRequest(layout, 'amber-1-2-1-other')).toThrow('NOT_DESIGNATED_CONTROLLER')
  })
  it('allows an open-only solicitation from a Pi-shaped current tab without sharing', () => {    const unshared: LayoutFile = { version: 1, activeWorkspace: 1, workspaces: { '1': { activeTab: 2, tabs: { '2': { tree: null } } } } }
    expect(authorizeBrowserRequest(unshared, 'amber-1-2-0-pane', true)).toEqual({ ws: 1, tab: 2 })
    expect(() => authorizeBrowserRequest(unshared, 'amber-1-2-0-pane')).toThrow('NO_BROWSER_FOR_TAB')
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
          if (values.length === 1) socket.write(encode({ version: 1, requestId: 'x', amberSession: 'amber-1-2-0-pane', action: { type: 'status' } }))
          if (values.length === 2) { socket.end(); resolve(values) }
        }
      })
    })
    expect(replies).toEqual([{ ok: true }, { version: 1, requestId: 'x', ok: true, result: { action: 'status' } }])
    await server.close()
  })
})
