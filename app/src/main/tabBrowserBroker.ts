import { createServer, type Server, type Socket } from 'node:net'
import { mkdir, open, readFile, unlink, lstat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import type { LayoutFile } from '../shared/layoutFile'

export type BrokerAction =
  | { type: 'open' }
  | { type: 'status' }
  | { type: 'navigate'; url: string; pageIncarnation: string; expectedGeneration: number }
  | { type: 'stop' }
export interface BrokerRequest { version: 1; requestId: string; amberSession: string; action: BrokerAction }

function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value)
}
function object(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null }

export function parseBrokerRequest(value: unknown): BrokerRequest {
  const request = object(value); const action = object(request?.['action'])
  if (!request || !action || !exact(request, ['version', 'requestId', 'amberSession', 'action']) || request['version'] !== 1
      || typeof request['requestId'] !== 'string' || request['requestId'].length < 1 || request['requestId'].length > 128
      || typeof request['amberSession'] !== 'string' || request['amberSession'].length > 256) throw new Error('INVALID_REQUEST')
  if (action['type'] === 'open' || action['type'] === 'status' || action['type'] === 'stop') {
    if (!exact(action, ['type'])) throw new Error('INVALID_REQUEST')
    return { version: 1, requestId: request['requestId'], amberSession: request['amberSession'], action: { type: action['type'] } }
  }
  if (action['type'] === 'navigate' && exact(action, ['type', 'url', 'pageIncarnation', 'expectedGeneration'])
      && typeof action['url'] === 'string' && action['url'].length <= 8192 && typeof action['pageIncarnation'] === 'string'
      && typeof action['expectedGeneration'] === 'number' && Number.isSafeInteger(action['expectedGeneration'])) {
    return { version: 1, requestId: request['requestId'], amberSession: request['amberSession'], action: { type: 'navigate', url: action['url'], pageIncarnation: action['pageIncarnation'], expectedGeneration: action['expectedGeneration'] } }
  }
  throw new Error('INVALID_REQUEST')
}

function paneLocation(name: string): { ws: number; tab: number } | null {
  const match = /^amber-(\d+)-(\d+)-(\d+)-[A-Za-z0-9]+$/.exec(name)
  if (!match) return null
  return { ws: Number(match[1]), tab: Number(match[2]) }
}

export function authorizeBrowserRequest(layout: LayoutFile, amberSession: string, solicitation = false): { ws: number; tab: number; browserId?: string } {
  const location = paneLocation(amberSession)
  if (!location) throw new Error('NOT_DESIGNATED_CONTROLLER')
  const tab = layout.workspaces[String(location.ws)]?.tabs[String(location.tab)]
  if (!tab) throw new Error('NOT_DESIGNATED_CONTROLLER')
  if (solicitation && !tab.browser) return location
  if (!tab.browser) throw new Error('NO_BROWSER_FOR_TAB')
  if (tab.browser.designatedPi !== amberSession) throw new Error('NOT_DESIGNATED_CONTROLLER')
  if (!tab.browser.sharedWithPi) throw new Error('NOT_SHARED')
  return { ...location, browserId: tab.browser.id }
}

const MAX_FRAME = 256 * 1024
function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value))
  const out = Buffer.allocUnsafe(body.length + 4); out.writeUInt32BE(body.length); body.copy(out, 4); return out
}

async function tokenFile(path: string): Promise<string> {
  try {
    const stat = await lstat(path)
    if (stat.isSymbolicLink() || !stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error('invalid browser host token file')
    const token = (await readFile(path, 'utf8')).trim()
    if (/^[A-Za-z0-9_-]{43}$/.test(token)) return token
    throw new Error('invalid browser host token')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const token = randomBytes(32).toString('base64url')
  const handle = await open(path, 'wx', 0o600)
  try { await handle.writeFile(`${token}\n`); await handle.sync() } finally { await handle.close() }
  return token
}

export class TabBrowserBrokerServer {
  private server: Server | null = null
  private connections = 0
  constructor(private readonly socketPath: string, private readonly tokenPath: string, private readonly handle: (request: BrokerRequest) => Promise<unknown>) {}
  async start(): Promise<void> {
    if (process.platform === 'win32') throw new Error('BROWSER_HOST_UNAVAILABLE')
    const token = await tokenFile(this.tokenPath)
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 })
    await unlink(this.socketPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
    this.server = createServer((socket) => {
      if (this.connections >= 8) { socket.destroy(); return }
      this.connections += 1; this.accept(socket, token); socket.once('close', () => { this.connections -= 1 })
    })
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(this.socketPath, resolve) })
  }
  private accept(socket: Socket, token: string): void {
    let authenticated = false; let buffer = Buffer.alloc(0); let chain = Promise.resolve()
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0)
        if (length > MAX_FRAME) { socket.destroy(); return }
        if (buffer.length < length + 4) return
        const body = buffer.subarray(4, length + 4); buffer = buffer.subarray(length + 4)
        chain = chain.then(async () => {
          try {
            const value: unknown = JSON.parse(body.toString('utf8'))
            if (!authenticated) {
              const hello = object(value)
              if (!hello || !exact(hello, ['token']) || hello['token'] !== token) throw new Error('UNAUTHORIZED')
              authenticated = true; socket.write(frame({ ok: true })); return
            }
            const request = parseBrokerRequest(value)
            socket.write(frame({ version: 1, requestId: request.requestId, ok: true, result: await this.handle(request) }))
          } catch (error) {
            const message = error instanceof Error ? error.message : 'INTERNAL_ERROR'
            socket.write(frame({ ok: false, error: message }))
            if (!authenticated || message === 'INVALID_REQUEST') socket.destroySoon()
          }
        })
      }
    })
  }
  async close(): Promise<void> {
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()))
    this.server = null; await unlink(this.socketPath).catch(() => {})
  }
}
