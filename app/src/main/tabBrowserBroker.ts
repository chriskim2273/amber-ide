import { createServer, type Server, type Socket } from 'node:net'
import { mkdir, open, readFile, unlink, lstat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import type { LayoutFile } from '../shared/layoutFile'
import type { TabBrowserCommand } from './tabBrowserService'

export type BrokerAction =
  | { type: 'open' }
  | { type: 'status' }
  | { type: 'navigate'; url: string; pageIncarnation: string; expectedGeneration: number }
  | { type: 'stop' }
export interface BrokerRequest { version: 1; requestId: string; clientInstanceId: string; sequence: number; amberSession: string; action: BrokerAction }
export interface ControllerSession { kind: string; alive: boolean; runState?: string }
export function isEligiblePiController(session: ControllerSession | undefined): boolean {
  return !!session && session.kind === 'pi' && session.alive && session.runState !== 'shell-fallback'
}

function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value)
}
function object(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null }

export function parseBrokerRequest(value: unknown): BrokerRequest {
  const request = object(value); const action = object(request?.['action'])
  if (!request || !action || !exact(request, ['version', 'requestId', 'clientInstanceId', 'sequence', 'amberSession', 'action']) || request['version'] !== 1
      || typeof request['requestId'] !== 'string' || request['requestId'].length < 1 || request['requestId'].length > 128
      || typeof request['clientInstanceId'] !== 'string' || request['clientInstanceId'].length < 8 || request['clientInstanceId'].length > 128
      || typeof request['sequence'] !== 'number' || !Number.isSafeInteger(request['sequence']) || request['sequence'] < 1
      || typeof request['amberSession'] !== 'string' || request['amberSession'].length < 1 || request['amberSession'].length > 256) throw new Error('INVALID_REQUEST')
  if (action['type'] === 'open' || action['type'] === 'status' || action['type'] === 'stop') {
    if (!exact(action, ['type'])) throw new Error('INVALID_REQUEST')
    return { version: 1, requestId: request['requestId'], clientInstanceId: request['clientInstanceId'], sequence: request['sequence'], amberSession: request['amberSession'], action: { type: action['type'] } }
  }
  if (action['type'] === 'navigate' && exact(action, ['type', 'url', 'pageIncarnation', 'expectedGeneration'])
      && typeof action['url'] === 'string' && action['url'].length <= 8192 && typeof action['pageIncarnation'] === 'string'
      && action['pageIncarnation'].length >= 1 && action['pageIncarnation'].length <= 256
      && typeof action['expectedGeneration'] === 'number' && Number.isSafeInteger(action['expectedGeneration']) && action['expectedGeneration'] >= 0) {
    return { version: 1, requestId: request['requestId'], clientInstanceId: request['clientInstanceId'], sequence: request['sequence'], amberSession: request['amberSession'], action: { type: 'navigate', url: action['url'], pageIncarnation: action['pageIncarnation'], expectedGeneration: action['expectedGeneration'] } }
  }
  throw new Error('INVALID_REQUEST')
}

function paneLocation(name: string): { ws: number; tab: number } | null {
  const match = /^amber-(\d+)-(\d+)-(\d+)-[A-Za-z0-9]+$/.exec(name)
  if (!match) return null
  return { ws: Number(match[1]), tab: Number(match[2]) }
}

export function dispatchAttachedBrokerAction(
  action: BrokerAction,
  id: string,
  signal: AbortSignal,
  stillAuthorized: () => boolean | Promise<boolean>,
  dispatch: (command: TabBrowserCommand, signal?: AbortSignal, validate?: () => boolean | Promise<boolean>) => Promise<unknown>,
): Promise<unknown> {
  if (action.type === 'status') return dispatch({ type: 'status', id })
  if (action.type === 'stop') return dispatch({ type: 'stop', id }, signal, stillAuthorized)
  if (action.type === 'navigate') return dispatch({ type: 'navigate', id, url: action.url, pageIncarnation: action.pageIncarnation, expectedGeneration: action.expectedGeneration }, signal, stillAuthorized)
  return Promise.reject(new Error('INVALID_REQUEST'))
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

export interface TabBrowserBrokerOptions { requestTimeoutMs?: number; socketTimeoutMs?: number }

export class TabBrowserBrokerServer {
  private server: Server | null = null
  private connections = 0
  private inFlight = 0
  private readonly sockets = new Set<Socket>()
  private readonly highWater = new Map<string, number>()
  private readonly results = new Map<string, { digest: string; promise: Promise<unknown> }>()
  private readonly queues = new Map<string, Promise<void>>()
  constructor(
    private readonly socketPath: string,
    private readonly tokenPath: string,
    private readonly handle: (request: BrokerRequest, signal: AbortSignal) => Promise<unknown>,
    private readonly options: TabBrowserBrokerOptions = {},
  ) {}
  async start(): Promise<void> {
    if (process.platform === 'win32') throw new Error('BROWSER_HOST_UNAVAILABLE')
    const token = await tokenFile(this.tokenPath)
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 })
    await unlink(this.socketPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
    this.server = createServer((socket) => {
      if (this.connections >= 8) { socket.destroy(); return }
      this.connections += 1; this.sockets.add(socket); this.accept(socket, token)
      socket.once('close', () => { this.connections -= 1; this.sockets.delete(socket) })
    })
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(this.socketPath, resolve) })
  }
  private accept(socket: Socket, token: string): void {
    let authenticated = false; let buffer = Buffer.alloc(0); let chain = Promise.resolve(); let queued = 0
    const active = new Set<AbortController>()
    const safeWrite = (value: unknown): void => { if (!socket.destroyed && socket.writable) socket.write(frame(value)) }
    socket.on('error', () => {})
    socket.once('close', () => { for (const controller of active) controller.abort(); active.clear() })
    socket.setTimeout(this.options.socketTimeoutMs ?? 10_000, () => socket.destroy())
    socket.on('data', (chunk: Buffer) => {
      if (buffer.length + chunk.length > MAX_FRAME * 17) { socket.destroy(); return }
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0)
        if (length > MAX_FRAME) { socket.destroy(); return }
        if (buffer.length < length + 4) return
        const body = Buffer.from(buffer.subarray(4, length + 4)); buffer = buffer.subarray(length + 4)
        queued += 1
        if (queued > 16) { safeWrite({ ok: false, error: 'REQUEST_LIMIT' }); socket.destroySoon(); return }
        chain = chain.then(async () => {
          let requestId: string | undefined
          try {
            const value: unknown = JSON.parse(body.toString('utf8'))
            if (!authenticated) {
              const hello = object(value)
              if (!hello || !exact(hello, ['token']) || hello['token'] !== token) throw new Error('UNAUTHORIZED')
              authenticated = true; safeWrite({ ok: true }); return
            }
            const request = parseBrokerRequest(value); requestId = request.requestId
            const cacheKey = `${request.clientInstanceId}:${request.requestId}`
            const digest = JSON.stringify({ sequence: request.sequence, amberSession: request.amberSession, action: request.action })
            const cached = this.results.get(cacheKey)
            let result: unknown
            if (cached) {
              if (cached.digest !== digest) throw new Error('INVALID_REQUEST')
              result = await cached.promise
            } else {
              const previousSequence = this.highWater.get(request.clientInstanceId) ?? 0
              if (request.sequence <= previousSequence) throw new Error('ACTION_CANCELLED')
              this.highWater.set(request.clientInstanceId, request.sequence)
              if (this.highWater.size > 1024) this.highWater.delete(this.highWater.keys().next().value!)
              const controller = new AbortController(); active.add(controller)
              const execute = async (): Promise<unknown> => {
                if (controller.signal.aborted) throw new Error('ACTION_CANCELLED')
                if (this.inFlight >= 32) throw new Error('REQUEST_LIMIT')
                this.inFlight += 1
                try {
                  const timeoutMs = this.options.requestTimeoutMs ?? 30_000
                  let timer: NodeJS.Timeout | undefined
                  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('ACTION_TIMEOUT')), timeoutMs) })
                  try { return await Promise.race([this.handle(request, controller.signal), timeout]) }
                  catch (error) { if (error instanceof Error && error.message === 'ACTION_TIMEOUT') controller.abort(); throw error }
                  finally { if (timer) clearTimeout(timer) }
                } finally { active.delete(controller); this.inFlight -= 1 }
              }
              const prior = this.queues.get(request.amberSession) ?? Promise.resolve()
              const promise = prior.catch(() => {}).then(execute)
              this.queues.set(request.amberSession, promise.then(() => {}, () => {}))
              this.results.set(cacheKey, { digest, promise })
              if (this.results.size > 256) this.results.delete(this.results.keys().next().value!)
              result = await promise
            }
            safeWrite({ version: 1, requestId: request.requestId, ok: true, result })
          } catch (error) {
            const message = error instanceof Error ? error.message : 'INTERNAL_ERROR'
            safeWrite({ ...(requestId ? { version: 1, requestId } : {}), ok: false, error: message })
            if (!authenticated || (message === 'INVALID_REQUEST' && !requestId)) socket.destroySoon()
          } finally { queued -= 1 }
        })
      }
    })
  }
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()))
    this.server = null; await unlink(this.socketPath).catch(() => {})
  }
}
