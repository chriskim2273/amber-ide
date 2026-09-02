import { createServer, type Server, type Socket } from 'node:net'
import { mkdir, open, readFile, unlink, lstat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import type { LayoutFile } from '../shared/layoutFile'
import type { TabBrowserCommand } from './tabBrowserService'
import { parseBrowserToolAction, type BrowserToolAction } from './browserToolProtocol'
import type { BrowserBinaryAttachment } from './browserAutomation'

export type BrokerAction =
  | { type: 'open' }
  | { type: 'status' }
  | { type: 'navigate'; url: string; pageIncarnation: string; expectedGeneration: number }
  | { type: 'stop'; pageIncarnation: string; expectedGeneration: number }
  | BrowserToolAction
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
  if (action['type'] === 'open' || action['type'] === 'status') {
    if (!exact(action, ['type'])) throw new Error('INVALID_REQUEST')
    return { version: 1, requestId: request['requestId'], clientInstanceId: request['clientInstanceId'], sequence: request['sequence'], amberSession: request['amberSession'], action: { type: action['type'] } }
  }
  if (action['type'] === 'stop' && exact(action, ['type', 'pageIncarnation', 'expectedGeneration'])
      && typeof action['pageIncarnation'] === 'string' && action['pageIncarnation'].length >= 1 && action['pageIncarnation'].length <= 256
      && typeof action['expectedGeneration'] === 'number' && Number.isSafeInteger(action['expectedGeneration']) && action['expectedGeneration'] >= 0) {
    return { version: 1, requestId: request['requestId'], clientInstanceId: request['clientInstanceId'], sequence: request['sequence'], amberSession: request['amberSession'], action: { type: 'stop', pageIncarnation: action['pageIncarnation'], expectedGeneration: action['expectedGeneration'] } }
  }
  if (action['type'] === 'navigate' && exact(action, ['type', 'url', 'pageIncarnation', 'expectedGeneration'])
      && typeof action['url'] === 'string' && action['url'].length <= 8192 && typeof action['pageIncarnation'] === 'string'
      && action['pageIncarnation'].length >= 1 && action['pageIncarnation'].length <= 256
      && typeof action['expectedGeneration'] === 'number' && Number.isSafeInteger(action['expectedGeneration']) && action['expectedGeneration'] >= 0) {
    return { version: 1, requestId: request['requestId'], clientInstanceId: request['clientInstanceId'], sequence: request['sequence'], amberSession: request['amberSession'], action: { type: 'navigate', url: action['url'], pageIncarnation: action['pageIncarnation'], expectedGeneration: action['expectedGeneration'] } }
  }
  return { version: 1, requestId: request['requestId'], clientInstanceId: request['clientInstanceId'], sequence: request['sequence'], amberSession: request['amberSession'], action: parseBrowserToolAction(action) }
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
  if (action.type === 'stop') return dispatch({ type: 'stop', id, pageIncarnation: action.pageIncarnation, expectedGeneration: action.expectedGeneration }, signal, stillAuthorized)
  if (action.type === 'navigate') return dispatch({ type: 'navigate', id, url: action.url, pageIncarnation: action.pageIncarnation, expectedGeneration: action.expectedGeneration }, signal, stillAuthorized)
  if (action.type !== 'open') return dispatch({ type: 'automation', id, action }, signal, stillAuthorized)
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

const MAX_FRAME = 1024 * 1024
const MAX_BINARY_FRAME = 10 * 1024 * 1024
function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value))
  const out = Buffer.allocUnsafe(body.length + 4); out.writeUInt32BE(body.length); body.copy(out, 4); return out
}
function binaryFrameHeader(value: Buffer): Buffer {
  if (value.length > MAX_BINARY_FRAME) throw new Error('REQUEST_LIMIT')
  const out = Buffer.allocUnsafe(4); out.writeUInt32BE(value.length); return out
}
export function safeBrokerError(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'INTERNAL_ERROR'
  return /^[A-Z][A-Z0-9_]{1,63}$/.test(raw) ? raw : 'INTERNAL_ERROR'
}
function binaryAttachment(value: unknown): value is BrowserBinaryAttachment {
  const candidate = value as Partial<BrowserBinaryAttachment> | null
  return !!candidate && candidate.mediaType === 'image/png' && Buffer.isBuffer(candidate.data)
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
  private readonly queueDepth = new Map<string, number>()
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
    const safeWriteResult = (requestId: string, result: unknown): void => {
      if (binaryAttachment(result)) {
        safeWrite({ version: 1, requestId, ok: true, result: { mediaType: result.mediaType, ...(result.width === undefined ? {} : { width: result.width }), ...(result.height === undefined ? {} : { height: result.height }), ...(result.browserId === undefined ? {} : { browserId: result.browserId }), ...(result.pageIncarnation === undefined ? {} : { pageIncarnation: result.pageIncarnation }), ...(result.generation === undefined ? {} : { generation: result.generation }), attachment: { encoding: 'binary-frame', byteLength: result.data.length } } })
        if (!socket.destroyed && socket.writable) { socket.write(binaryFrameHeader(result.data)); socket.write(result.data) }
      } else safeWrite({ version: 1, requestId, ok: true, result })
    }
    const idleTimeoutMs = this.options.socketTimeoutMs ?? 10_000
    socket.on('error', () => {})
    socket.once('close', () => { for (const controller of active) controller.abort(); active.clear() })
    socket.setTimeout(idleTimeoutMs, () => socket.destroy())
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
          let requestId: string | undefined, cacheKey: string | undefined
          try {
            const value: unknown = JSON.parse(body.toString('utf8'))
            if (!authenticated) {
              const hello = object(value)
              if (!hello || !exact(hello, ['token']) || hello['token'] !== token) throw new Error('UNAUTHORIZED')
              authenticated = true; safeWrite({ ok: true }); return
            }
            const request = parseBrokerRequest(value); requestId = request.requestId
            cacheKey = `${request.clientInstanceId}:${request.requestId}`
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
              let operationBarrier: Promise<void> = Promise.resolve()
              const execute = async (): Promise<unknown> => {
                if (controller.signal.aborted) throw new Error('ACTION_CANCELLED')
                if (this.inFlight >= 32) throw new Error('REQUEST_LIMIT')
                this.inFlight += 1
                try {
                  const timeoutMs = this.options.requestTimeoutMs ?? (request.action.type === 'wait' ? Math.min(121_000, request.action.timeoutMs + 1_000) : 30_000)
                  socket.setTimeout(Math.max(idleTimeoutMs, timeoutMs + 2_000))
                  let timer: NodeJS.Timeout | undefined
                  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('ACTION_TIMEOUT')), timeoutMs) })
                  const operation = this.handle(request, controller.signal)
                  operationBarrier = operation.then(() => {}, () => {})
                  try { return await Promise.race([operation, timeout]) }
                  catch (error) { if (error instanceof Error && error.message === 'ACTION_TIMEOUT') controller.abort(); throw error }
                  finally { if (timer) clearTimeout(timer); socket.setTimeout(idleTimeoutMs) }
                } finally { active.delete(controller); this.inFlight -= 1 }
              }
              const key = request.amberSession, depth = this.queueDepth.get(key) ?? 0
              if (depth >= 16) throw new Error('REQUEST_LIMIT')
              this.queueDepth.set(key, depth + 1)
              const prior = this.queues.get(key) ?? Promise.resolve()
              const promise = prior.catch(() => {}).then(execute)
              // A timed-out client gets its error immediately, but following
              // work cannot overtake the still-unwinding operation.
              const tail = promise.then(() => {}, () => {}).then(() => operationBarrier)
              this.queues.set(key, tail)
              void tail.finally(() => {
                const remaining = (this.queueDepth.get(key) ?? 1) - 1
                if (remaining <= 0) this.queueDepth.delete(key); else this.queueDepth.set(key, remaining)
                if (this.queues.get(key) === tail) this.queues.delete(key)
              })
              this.results.set(cacheKey, { digest, promise })
              if (this.results.size > 256) this.results.delete(this.results.keys().next().value!)
              result = await promise
            }
            safeWriteResult(request.requestId, result)
            // Binary attachments are ephemeral and can be 10 MiB each. Keep
            // only concurrent duplicate joining; release immediately after
            // delivery so the 256-entry replay cache cannot pin gigabytes.
            if (binaryAttachment(result) && cacheKey) this.results.delete(cacheKey)
          } catch (error) {
            // Only stable error codes cross into Pi. Debugger/Node exception
            // text can contain URLs, local paths, headers, or page content.
            const message = safeBrokerError(error)
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
