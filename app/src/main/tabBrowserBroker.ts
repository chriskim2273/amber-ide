import { connect, createServer, type Server, type Socket } from 'node:net'
import { open, rename, unlink, lstat } from 'node:fs/promises'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { TextDecoder } from 'node:util'
import type { LayoutFile } from '../shared/layoutFile'
import type { TabBrowserCommand } from './tabBrowserService'
import { parseBrowserToolAction, type BrowserToolAction } from './browserToolProtocol'
import type { BrowserBinaryAttachment } from './browserAutomation'
import { ensurePrivateRuntimeDirectory } from './browserHostPaths'
import type { BrowserOperationRegistry } from './browserOperationRegistry'
import { readSafeTextFile, SafeFileReadError } from './safeFileReader'

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

export async function dispatchAttachedBrokerAction(
  action: BrokerAction,
  id: string,
  signal: AbortSignal,
  stillAuthorized: () => boolean | Promise<boolean>,
  dispatch: (command: TabBrowserCommand, signal?: AbortSignal, validate?: () => boolean | Promise<boolean>) => Promise<unknown>,
  authorizationPollMs = 100,
): Promise<unknown> {
  let command: TabBrowserCommand
  if (action.type === 'status') command = { type: 'status', id }
  else if (action.type === 'stop') command = { type: 'stop', id, pageIncarnation: action.pageIncarnation, expectedGeneration: action.expectedGeneration }
  else if (action.type === 'navigate') command = { type: 'navigate', id, url: action.url, pageIncarnation: action.pageIncarnation, expectedGeneration: action.expectedGeneration }
  else if (action.type !== 'open') command = { type: 'automation', id, action }
  else throw new Error('INVALID_REQUEST')

  const controller = new AbortController(); let revoked = false; let checking = false
  const abortFromCaller = (): void => controller.abort()
  signal.addEventListener('abort', abortFromCaller, { once: true })
  if (signal.aborted) controller.abort()
  const checkAuthority = async (): Promise<boolean> => {
    try { return await stillAuthorized() } catch { return false }
  }
  const timer = setInterval(() => {
    if (checking || controller.signal.aborted) return
    checking = true
    void checkAuthority().then((valid) => { if (!valid) { revoked = true; controller.abort() } }).finally(() => { checking = false })
  }, Math.max(1, authorizationPollMs))
  timer.unref()
  try {
    let result: unknown
    try { result = await dispatch(command, controller.signal, checkAuthority) }
    catch (error) {
      if (revoked && error instanceof Error && error.message.endsWith('_NO_ROLLBACK')) throw error
      if (revoked) throw new Error('STALE_BROWSER_CONTEXT')
      throw error
    }
    if (!(await checkAuthority())) { revoked = true; controller.abort(); throw new Error(action.type === 'interact' ? 'STALE_BROWSER_CONTEXT_NO_ROLLBACK' : 'STALE_BROWSER_CONTEXT') }
    return result
  } finally {
    clearInterval(timer); signal.removeEventListener('abort', abortFromCaller)
  }
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
/** Generated browser-host tokens are 32 random bytes in base64url (43 chars). */
export const BROWSER_HOST_TOKEN_MAX_BYTES = 128
const BROWSER_HOST_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const FATAL_UTF8 = new TextDecoder('utf-8', { fatal: true })
function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value))
  const out = Buffer.allocUnsafe(body.length + 4); out.writeUInt32BE(body.length); body.copy(out, 4); return out
}
function binaryFrameHeader(value: Buffer): Buffer {
  if (value.length > MAX_BINARY_FRAME) throw new Error('REQUEST_LIMIT')
  const out = Buffer.allocUnsafe(4); out.writeUInt32BE(value.length); return out
}
export function brokerRequestDigest(request: Pick<BrokerRequest, 'sequence' | 'amberSession' | 'action'>): string {
  return createHash('sha256').update(JSON.stringify({ sequence: request.sequence, amberSession: request.amberSession, action: request.action })).digest('hex')
}
export function safeBrokerError(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'INTERNAL_ERROR'
  return /^[A-Z][A-Z0-9_]{1,63}$/.test(raw) ? raw : 'INTERNAL_ERROR'
}
function binaryAttachment(value: unknown): value is BrowserBinaryAttachment {
  const candidate = value as Partial<BrowserBinaryAttachment> | null
  return !!candidate && candidate.mediaType === 'image/png' && Buffer.isBuffer(candidate.data)
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

function browserTokenError(code: string, detail = code): Error {
  return Object.assign(new Error(`${code}: ${detail}`), { code })
}

/** Parse the complete on-disk token without trimming attacker-controlled data. */
export function parseBrowserHostToken(text: string): string {
  const token = text.endsWith('\n') ? text.slice(0, -1).replace(/\r$/, '') : text
  if (!BROWSER_HOST_TOKEN_RE.test(token)) throw browserTokenError('BROWSER_HOST_TOKEN_INVALID')
  return token
}

async function tokenFile(path: string): Promise<string> {
  const parent = dirname(path), uid = process.getuid?.() ?? -1
  await ensurePrivateRuntimeDirectory(parent, uid)
  let tokenText: string | null
  try {
    const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (metadata && (metadata.isSymbolicLink() || !metadata.isFile() || (uid >= 0 && metadata.uid !== uid) || (metadata.mode & 0o077) !== 0)) {
      throw browserTokenError('BROWSER_HOST_TOKEN_UNSAFE', 'invalid browser host token file')
    }
    tokenText = await readSafeTextFile(path, { maxBytes: BROWSER_HOST_TOKEN_MAX_BYTES, ...(uid >= 0 ? { owner: uid } : {}) })
  } catch (error) {
    if (error instanceof SafeFileReadError) {
      const code = error.code === 'FILE_TOO_LARGE' ? 'BROWSER_HOST_TOKEN_TOO_LARGE'
        : error.code === 'INVALID_UTF8' ? 'BROWSER_HOST_TOKEN_INVALID_UTF8'
          : error.code === 'SYMLINK' ? 'BROWSER_HOST_TOKEN_UNSAFE'
            : error.code === 'NOT_REGULAR' ? 'BROWSER_HOST_TOKEN_UNSAFE'
              : error.code === 'WRONG_OWNER' ? 'BROWSER_HOST_TOKEN_UNSAFE'
                : error.code === 'FILE_CHANGED' ? 'BROWSER_HOST_TOKEN_CHANGED' : 'BROWSER_HOST_TOKEN_READ_FAILED'
      throw browserTokenError(code)
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') tokenText = null
    else throw error
  }
  if (tokenText !== null) return parseBrowserHostToken(tokenText)

  // Only an actually absent file reaches allocation. Invalid, oversized, or
  // unsafe files are fatal above; rotating one would hide corruption and could
  // make a caller transmit a credential that no longer matches its owner.
  const token = randomBytes(32).toString('base64url')
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(`${token}\n`); await handle.sync() } finally { await handle.close() }
  try {
    await rename(temporary, path)
    await syncDirectory(parent)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
  return token
}

export interface TabBrowserBrokerOptions {
  requestTimeoutMs?: number
  socketTimeoutMs?: number
  /** Grace for an adapter that ignored AbortSignal before its queue is released. */
  operationBarrierTimeoutMs?: number
  resultTtlMs?: number
  maxClientIdentities?: number
  now?: () => number
  authorizeReplay?: (request: BrokerRequest) => boolean | Promise<boolean>
  /** Resolve the FIFO identity only after the request is authenticated and
   * authorized. A request id is never a queue key. */
  queueKey?: (request: BrokerRequest) => string | Promise<string>
  operations?: BrowserOperationRegistry
}

async function rejectLiveSocket(path: string): Promise<void> {
  let metadata
  try { metadata = await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  if (!metadata.isSocket()) throw new Error('INVALID_BROWSER_HOST_ENDPOINT')
  const live = await new Promise<boolean>((resolve) => {
    const socket = connect(path)
    const timer = setTimeout(() => { socket.destroy(); resolve(true) }, 250)
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true) })
    socket.once('error', (error: NodeJS.ErrnoException) => { clearTimeout(timer); resolve(error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT') })
  })
  if (live) throw new Error('BROWSER_HOST_ALREADY_RUNNING')
  await unlink(path)
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('ACTION_CANCELLED'))
  let onAbort: (() => void) | undefined
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error('ACTION_CANCELLED'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  return Promise.race([promise, cancelled]).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  })
}

function boundedBarrier(promise: Promise<void>, releaseSignal: AbortSignal, timeoutMs: number): Promise<void> {
  // Healthy operations keep strict FIFO for their whole duration. The grace
  // timer starts only after cancellation/timeout, so a slow-but-cooperating
  // navigation cannot be overtaken by the next request.
  return new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout | undefined
    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      if (timer) clearTimeout(timer)
      releaseSignal.removeEventListener('abort', release)
      resolve()
    }
    const release = (): void => {
      if (finished || timer) return
      if (timeoutMs <= 0) { finish(); return }
      timer = setTimeout(finish, timeoutMs); timer.unref()
    }
    promise.then(finish, finish)
    releaseSignal.addEventListener('abort', release, { once: true })
    if (releaseSignal.aborted) release()
  })
}

export class TabBrowserBrokerServer {
  private server: Server | null = null
  private connections = 0
  private inFlight = 0
  private readonly sockets = new Set<Socket>()
  private readonly highWater = new Map<string, number>()
  private readonly results = new Map<string, { digest: string; promise: Promise<unknown>; acceptedAt: number }>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly queueDepth = new Map<string, number>()
  private readonly activeRequests = new Map<AbortController, string>()
  constructor(
    private readonly socketPath: string,
    private readonly tokenPath: string,
    private readonly handle: (request: BrokerRequest, signal: AbortSignal) => Promise<unknown>,
    private readonly options: TabBrowserBrokerOptions = {},
  ) {}
  async start(): Promise<void> {
    if (process.platform === 'win32') throw new Error('BROWSER_HOST_UNAVAILABLE')
    const uid = process.getuid?.() ?? -1
    await ensurePrivateRuntimeDirectory(dirname(this.socketPath), uid)
    const token = await tokenFile(this.tokenPath)
    await rejectLiveSocket(this.socketPath)
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
    const connectionResults = new Set<string>()
    const safeWrite = (value: unknown): void => { if (!socket.destroyed && socket.writable) socket.write(frame(value)) }
    const safeWriteResult = (requestId: string, result: unknown): void => {
      if (binaryAttachment(result)) {
        safeWrite({ version: 1, requestId, ok: true, result: { contentTrust: 'untrusted-browser-content', mediaType: result.mediaType, ...(result.width === undefined ? {} : { width: result.width }), ...(result.height === undefined ? {} : { height: result.height }), ...(result.browserId === undefined ? {} : { browserId: result.browserId }), ...(result.pageIncarnation === undefined ? {} : { pageIncarnation: result.pageIncarnation }), ...(result.generation === undefined ? {} : { generation: result.generation }), attachment: { encoding: 'binary-frame', byteLength: result.data.length } } })
        if (!socket.destroyed && socket.writable) { socket.write(binaryFrameHeader(result.data)); socket.write(result.data) }
      } else safeWrite({ version: 1, requestId, ok: true, result })
    }
    const idleTimeoutMs = this.options.socketTimeoutMs ?? 10_000
    socket.on('error', () => {})
    socket.once('close', () => {
      for (const controller of active) controller.abort()
      active.clear()
      for (const key of connectionResults) this.results.delete(key)
      connectionResults.clear()
    })
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
          let requestId: string | undefined, cacheKey: string | undefined, completionDeferred = false
          try {
            let value: unknown
            try { value = JSON.parse(FATAL_UTF8.decode(body)) }
            catch { throw new Error('INVALID_REQUEST') }
            if (!authenticated) {
              const hello = object(value)
              if (!hello || !exact(hello, ['token']) || hello['token'] !== token) throw new Error('UNAUTHORIZED')
              authenticated = true; safeWrite({ ok: true }); return
            }
            const request = parseBrokerRequest(value); requestId = request.requestId
            cacheKey = `${request.clientInstanceId}:${request.requestId}`
            const now = this.options.now ?? Date.now, resultTtl = this.options.resultTtlMs ?? 5 * 60_000
            for (const [key, entry] of this.results) if (now() - entry.acceptedAt >= resultTtl) this.results.delete(key)
            const digest = brokerRequestDigest(request)
            const cached = this.results.get(cacheKey)
            const deferReply = (promise: Promise<unknown>, signal?: AbortSignal): void => {
              completionDeferred = true
              const guarded = signal && this.options.operations
                ? promise.then((result) => { this.options.operations!.assertDispatch(signal); return result })
                : promise
              void guarded.then((result) => {
                safeWriteResult(request.requestId, result)
                if (binaryAttachment(result) && cacheKey) this.results.delete(cacheKey)
              }, (error) => {
                const code = safeBrokerError(error)
                // A cancelled/timed-out action did not produce a replayable
                // result. Keeping its promise in the five-minute cache would
                // retain request/controller closures and make a retry replay a
                // cancellation forever.
                if ((code === 'ACTION_CANCELLED' || code === 'ACTION_TIMEOUT' || code === 'BROWSER_HOST_SHUTTING_DOWN') && cacheKey) this.results.delete(cacheKey)
                safeWrite({ version: 1, requestId: request.requestId, ok: false, error: code })
              })
                .finally(() => { queued -= 1; if (cacheKey) connectionResults.delete(cacheKey) })
            }
            if (cached) {
              if (cached.digest !== digest) throw new Error('INVALID_REQUEST')
              if (this.options.operations) {
                // A cached result is still page data. It must cross the same
                // drain barrier as a fresh request; otherwise an already
                // resolved replay can write after Quit has revoked the host.
                let replaySignal: AbortSignal | undefined
                const replay = this.options.operations.runDetached('broker', async (signal) => {
                  replaySignal = signal
                  this.options.operations!.assertDispatch(signal)
                  if (this.options.authorizeReplay && !(await this.options.authorizeReplay(request))) throw new Error('STALE_BROWSER_CONTEXT')
                  this.options.operations!.assertDispatch(signal)
                  const aborted = new Promise<never>((_resolve, reject) => {
                    const onAbort = (): void => reject(new Error('ACTION_CANCELLED'))
                    signal.addEventListener('abort', onAbort, { once: true })
                    cached.promise.finally(() => signal.removeEventListener('abort', onAbort)).catch(() => {})
                  })
                  const result = await Promise.race([cached.promise, aborted])
                  this.options.operations!.assertDispatch(signal)
                  return result
                })
                deferReply(replay, replaySignal)
              } else {
                if (this.options.authorizeReplay && !(await this.options.authorizeReplay(request))) throw new Error('STALE_BROWSER_CONTEXT')
                deferReply(cached.promise)
              }
              return
            } else {
              const knownClient = this.highWater.has(request.clientInstanceId)
              const previousSequence = this.highWater.get(request.clientInstanceId) ?? 0
              if (request.sequence <= previousSequence) throw new Error('ACTION_CANCELLED')
              if (!knownClient && this.highWater.size >= (this.options.maxClientIdentities ?? 1024)) throw new Error('REQUEST_LIMIT')
              this.highWater.set(request.clientInstanceId, request.sequence)
              // Admission can perform asynchronous authorization before the
              // request has a queue key. Own the controller first: socket
              // close, Stop Pi, and broker drain must be able to cancel that
              // await just like they cancel queued/active work.
              const controller = new AbortController(); active.add(controller); this.activeRequests.set(controller, request.amberSession)
              const unregister = (): void => { active.delete(controller); this.activeRequests.delete(controller) }
              controller.signal.addEventListener('abort', unregister, { once: true })
              let operationBarrier: Promise<void> = Promise.resolve()
              let timedOut = false
              const execute = async (): Promise<unknown> => {
                if (controller.signal.aborted) { unregister(); throw new Error('ACTION_CANCELLED') }
                if (this.inFlight >= 32) { unregister(); throw new Error('REQUEST_LIMIT') }
                this.inFlight += 1
                try {
                  const timeoutMs = this.options.requestTimeoutMs ?? (request.action.type === 'wait' ? Math.min(121_000, request.action.timeoutMs + 1_000) : 30_000)
                  socket.setTimeout(Math.max(idleTimeoutMs, timeoutMs + 2_000))
                  let timer: NodeJS.Timeout | undefined
                  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('ACTION_TIMEOUT')), timeoutMs) })
                  const executionController = new AbortController()
                  const releaseController = new AbortController()
                  const relayAbort = (): void => { executionController.abort(); releaseController.abort() }
                  controller.signal.addEventListener('abort', relayAbort, { once: true })
                  const operation = this.handle(request, executionController.signal)
                  const rawBarrier = operation.then(() => {}, () => {})
                  operationBarrier = boundedBarrier(rawBarrier, releaseController.signal, this.options.operationBarrierTimeoutMs ?? 1_000)
                  let cancelExecution: (() => void) | undefined
                  const cancelled = new Promise<never>((_resolve, reject) => {
                    cancelExecution = () => reject(new Error('ACTION_CANCELLED'))
                    controller.signal.addEventListener('abort', cancelExecution, { once: true })
                  })
                  try { return await Promise.race([operation, timeout, cancelled]) }
                  catch (error) {
                    if (error instanceof Error && error.message === 'ACTION_TIMEOUT') {
                      // The request controller is the signal inherited by the
                      // production broker -> service call chain. Aborting
                      // only the adapter's signal leaves nested registry work
                      // alive after the broker has already timed out.
                      timedOut = true
                      controller.abort()
                      executionController.abort()
                      releaseController.abort()
                    }
                    throw error
                  }
                  finally {
                    controller.signal.removeEventListener('abort', relayAbort)
                    if (cancelExecution) controller.signal.removeEventListener('abort', cancelExecution)
                    if (timer) clearTimeout(timer); socket.setTimeout(idleTimeoutMs)
                  }
                } finally { unregister(); this.inFlight -= 1 }
              }
              const preserveTimeout = <T>(promise: Promise<T>): Promise<T> => promise.catch((error) => {
                // Aborting the request controller is required to stop nested
                // service work, but the client-facing classification remains a
                // timeout rather than being rewritten as cancellation.
                if (timedOut && safeBrokerError(error) === 'ACTION_CANCELLED') throw new Error('ACTION_TIMEOUT')
                throw error
              })
              // With the default session queue key there is no asynchronous
              // admission step. Keep this path's scheduling shape unchanged so
              // replay replies retain their established FIFO ordering.
              if (!this.options.queueKey) {
                const key = `session:${request.amberSession}`
                if (key.length < 1 || key.length > 512) { unregister(); throw new Error('INVALID_REQUEST') }
                const depth = this.queueDepth.get(key) ?? 0
                if (depth >= 16) { unregister(); throw new Error('REQUEST_LIMIT') }
                this.queueDepth.set(key, depth + 1)
                const prior = this.queues.get(key) ?? Promise.resolve()
                const scheduled = this.options.operations
                  ? this.options.operations.runDetached('broker', async (signal) => {
                      const abortOwned = (): void => controller.abort()
                      signal.addEventListener('abort', abortOwned, { once: true })
                      try { await prior.catch(() => {}); this.options.operations!.assertDispatch(signal); return await execute() }
                      finally { signal.removeEventListener('abort', abortOwned) }
                    }, controller.signal)
                  : prior.catch(() => {}).then(execute)
                const promise = !this.options.operations && depth === 0
                  ? scheduled
                  : preserveTimeout(depth > 0 ? abortable(scheduled, controller.signal) : scheduled)
                const tail = scheduled.then(() => {}, () => {}).then(() => operationBarrier)
                this.queues.set(key, tail)
                void tail.then(() => {}, () => {}).finally(() => {
                  const remaining = (this.queueDepth.get(key) ?? 1) - 1
                  if (remaining <= 0) this.queueDepth.delete(key); else this.queueDepth.set(key, remaining)
                  if (this.queues.get(key) === tail) this.queues.delete(key)
                })
                // A drain may reject the registry before it invokes its work
                // callback. The request controller was already registered with
                // the socket/global maps, so clean those maps on that path too.
                void scheduled.then(() => {}, () => unregister())
                this.results.set(cacheKey, { digest, promise, acceptedAt: now() })
                connectionResults.add(cacheKey)
                if (this.results.size > 256) this.results.delete(this.results.keys().next().value!)
                deferReply(promise, controller.signal); return
              }
              let entered = false
              let depth = 0
              const finishRequest = (): void => { unregister() }
              const afterKey = (key: string, signal: AbortSignal): Promise<unknown> => {
                if (key.length < 1 || key.length > 512) throw new Error('INVALID_REQUEST')
                depth = this.queueDepth.get(key) ?? 0
                if (depth >= 16) throw new Error('REQUEST_LIMIT')
                this.queueDepth.set(key, depth + 1)
                const prior = this.queues.get(key) ?? Promise.resolve()
                // The client-facing promise must settle on cancellation even
                // if it is still waiting behind an older request. The queue
                // tail is separate and remains FIFO until that older work
                // reaches the bounded adapter barrier.
                const work = prior.catch(() => {}).then(() => {
                  this.options.operations?.assertDispatch(signal)
                  return execute()
                })
                const tail = work.then(() => {}, () => {}).then(() => operationBarrier)
                this.queues.set(key, tail)
                void tail.then(() => {}, () => {}).finally(() => {
                  const remaining = (this.queueDepth.get(key) ?? 1) - 1
                  if (remaining <= 0) this.queueDepth.delete(key); else this.queueDepth.set(key, remaining)
                  if (this.queues.get(key) === tail) this.queues.delete(key)
                })
                void work.then(finishRequest, finishRequest)
                return work
              }
              const queueAndExecute = (signal: AbortSignal): Promise<unknown> => {
                entered = true
                if (!this.options.queueKey) {
                  try { return afterKey(`session:${request.amberSession}`, signal) }
                  catch (error) { finishRequest(); return Promise.reject(error) }
                }
                return abortable(Promise.resolve().then(() => this.options.queueKey!(request)), signal)
                  .then((key) => afterKey(key, signal))
                  .catch((error) => { finishRequest(); throw error })
              }
              let scheduled: Promise<unknown>
              try {
                scheduled = this.options.operations
                  ? this.options.operations.runWithControllerDetached('broker', controller, queueAndExecute)
                  : queueAndExecute(controller.signal)
              } catch (error) {
                unregister(); throw error
              }
              // If drain started in the tiny gap between controller creation
              // and registration, runWithController rejects before invoking
              // the callback. Do not leave the broker's own registries behind.
              void scheduled.then(() => {}, () => { if (!entered) unregister() })
              // A cancelled client gets its error immediately, even while it
              // is waiting behind an older request. Following work still uses
              // the separate queue tail and cannot overtake that operation.
              const promise = preserveTimeout(abortable(scheduled, controller.signal))
              this.results.set(cacheKey, { digest, promise, acceptedAt: now() })
              connectionResults.add(cacheKey)
              if (this.results.size > 256) this.results.delete(this.results.keys().next().value!)
              deferReply(promise, controller.signal); return
            }
          } catch (error) {
            // Only stable error codes cross into Pi. Debugger/Node exception
            // text can contain URLs, local paths, headers, or page content.
            const message = safeBrokerError(error)
            safeWrite({ ...(requestId ? { version: 1, requestId } : {}), ok: false, error: message })
            if (!authenticated || (message === 'INVALID_REQUEST' && !requestId)) socket.destroySoon()
          } finally { if (!completionDeferred) queued -= 1 }
        })
      }
    })
  }
  cancelController(amberSession: string): void {
    for (const [controller, session] of this.activeRequests) if (session === amberSession) controller.abort()
  }
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()))
    this.server = null
    // Socket close aborts each request, but the queue tails may still be
    // waiting for an adapter that ignored cancellation. Drop all registries
    // owned by this server now; bounded tails are only for ordering and must
    // not keep a closed broker alive.
    this.queues.clear(); this.queueDepth.clear(); this.results.clear(); this.highWater.clear(); this.activeRequests.clear()
    await unlink(this.socketPath).catch(() => {})
  }
}
