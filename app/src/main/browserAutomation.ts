import { randomBytes } from 'node:crypto'
import type { BrowserElementRef, BrowserViewport, ConsoleLevel, FindQuery, SnapshotLimits, WaitCondition } from './browserToolProtocol'

const SCREENSHOT_MAX_BYTES = 10 * 1024 * 1024
const SCREENSHOT_MAX_DIMENSION = 4096
const SAFE_ATTRIBUTES = new Set(['id', 'class', 'role', 'aria-label', 'aria-labelledby', 'aria-describedby', 'name', 'type', 'placeholder', 'title', 'alt'])
const SAFE_COMPUTED_STYLES = new Set(['display', 'visibility', 'position', 'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height', 'width', 'height', 'overflow', 'opacity'])
const ENABLE_METHODS = ['Accessibility.enable', 'DOM.enable', 'CSS.enable', 'Page.enable', 'Runtime.enable', 'Network.enable'] as const

export interface BrowserDebuggerTransport {
  isAttached(): boolean
  attach(version?: string): Promise<void> | void
  detach?(): void
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
  onMessage(listener: (method: string, params: Record<string, unknown>) => void): void
}
export interface BrowserAutomationLease { browserId: string; pageIncarnation: string; generation: number }
export interface BrowserAutomationOptions { ringItems?: number; ringBytes?: number }
export interface BrowserAutomationControls {
  reload?(ignoreCache: boolean): void
  history?(direction: 'back' | 'forward'): void
}
export interface AccessibilityNodeResult { ref: string; depth: number; role: string; name: string; disabled?: boolean; focused?: boolean }
export interface SnapshotResult { snapshotId: string; url: string; nodes: AccessibilityNodeResult[]; truncated: boolean }
export interface BrowserBinaryAttachment { mediaType: 'image/png'; data: Buffer; width?: number; height?: number; browserId?: string; pageIncarnation?: string; generation?: number }

type AXNode = {
  nodeId?: string; parentId?: string; backendDOMNodeId?: number; ignored?: boolean
  role?: { value?: unknown }; name?: { value?: unknown }; value?: { value?: unknown }
  properties?: Array<{ name?: string; value?: { value?: unknown } }>
}
type SnapshotEntry = AccessibilityNodeResult & { backendDOMNodeId?: number }
interface SnapshotCache { lease: BrowserAutomationLease; snapshotId: string; entries: Map<string, SnapshotEntry>; nodes: AccessibilityNodeResult[] }
interface RingEntry { cursor: number; bytes: number; value: Record<string, unknown> }

class BoundedRing {
  private entries: RingEntry[] = []
  private bytes = 0
  private cursor = 0
  private dropped = 0
  constructor(private readonly maxItems: number, private readonly maxBytes: number) {}
  push(value: Record<string, unknown>): void {
    const bytes = Buffer.byteLength(JSON.stringify(value))
    if (bytes > this.maxBytes) { this.dropped += 1; return }
    const entry = { cursor: ++this.cursor, bytes, value }
    this.entries.push(entry); this.bytes += bytes
    while (this.entries.length > this.maxItems || this.bytes > this.maxBytes) {
      const removed = this.entries.shift()!; this.bytes -= removed.bytes; this.dropped += 1
    }
  }
  since(cursor: string | undefined, limit: number, filter?: (entry: Record<string, unknown>) => boolean): { cursor: string; items: Record<string, unknown>[]; dropped: number; truncated: boolean } {
    const numeric = cursor === undefined ? 0 : Number(cursor)
    const first = this.entries[0]?.cursor ?? this.cursor + 1
    const lost = numeric > 0 && numeric < first - 1 ? first - numeric - 1 : 0
    const eligible = this.entries.filter((entry) => entry.cursor > numeric && (!filter || filter(entry.value)))
    const candidates = eligible.slice(-limit), selected: RingEntry[] = []; let bytes = 0
    for (let index = candidates.length - 1; index >= 0; index--) {
      const entry = candidates[index]!
      if (bytes + entry.bytes > 256 * 1024) break
      selected.unshift(entry); bytes += entry.bytes
    }
    return { cursor: String(this.cursor), items: selected.map((entry) => entry.value), dropped: this.dropped + lost, truncated: selected.length < eligible.length }
  }
}

export function sanitizeBrowserUrl(input: string): string {
  try {
    const url = new URL(input)
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'about:') return '[blocked-url]'
    if (url.protocol === 'about:') return url.pathname === 'blank' ? 'about:blank' : '[blocked-url]'
    url.username = ''; url.password = ''; url.search = ''; url.hash = ''
    return url.toString().replace(/\/$/, url.pathname === '/' ? '/' : '')
  } catch { return '[invalid-url]' }
}
export function redactBrowserText(input: string): string {
  return input.slice(0, 8192)
    .replace(/\b(authorization\s*[:=]\s*(?:bearer|basic)\s+)\S+/gi, '$1[REDACTED]')
    .replace(/\b(cookie|set-cookie|password|passwd|token|api[_-]?key|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/https?:\/\/[^\s]+/gi, (url) => sanitizeBrowserUrl(url))
}
function text(value: unknown, max = 4096): string { return typeof value === 'string' ? value.slice(0, max) : '' }
function abort(signal: AbortSignal): void { if (signal.aborted) throw new Error('ACTION_CANCELLED') }
function property(node: AXNode, name: string): boolean | undefined {
  const value = node.properties?.find((item) => item.name === name)?.value?.value
  return typeof value === 'boolean' ? value : undefined
}
function sameLease(a: BrowserAutomationLease, b: BrowserAutomationLease): boolean {
  return a.browserId === b.browserId && a.pageIncarnation === b.pageIncarnation && a.generation === b.generation
}
function pngDimensions(data: Buffer): { width: number; height: number } | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (data.length < 24 || !data.subarray(0, 8).equals(signature) || data.toString('ascii', 12, 16) !== 'IHDR') return null
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20)
  return width > 0 && height > 0 ? { width, height } : null
}

export class BrowserAutomation {
  private attachedByUs = false
  private listenerInstalled = false
  private domainsEnabled = false
  private setupPromise: Promise<void> | null = null
  private snapshotCache: SnapshotCache | null = null
  private readonly consoleRing: BoundedRing
  private readonly networkRing: BoundedRing
  private readonly requests = new Map<string, { url: string; method: string; type: string; started: number; status?: number }>()
  private activeRequests = 0
  private lastNetworkActivity = Date.now()
  private disposed = false
  constructor(
    private readonly transport: BrowserDebuggerTransport,
    private readonly currentUrl: () => string,
    private readonly loading: () => boolean,
    options: BrowserAutomationOptions = {},
    private readonly controls: BrowserAutomationControls = {},
  ) {
    this.consoleRing = new BoundedRing(options.ringItems ?? 1_000, options.ringBytes ?? 1024 * 1024)
    this.networkRing = new BoundedRing(options.ringItems ?? 1_000, options.ringBytes ?? 1024 * 1024)
  }
  invalidate(): void { this.snapshotCache = null }
  dispose(): void {
    this.disposed = true; this.snapshotCache = null; this.requests.clear(); this.activeRequests = 0
    if (this.attachedByUs && this.transport.isAttached()) { try { this.transport.detach?.() } catch { /* page teardown is best-effort */ } }
  }
  ensureAttached(): Promise<void> {
    if (this.setupPromise) return this.setupPromise
    const setup = this.attachAndEnable()
    this.setupPromise = setup
    void setup.then(() => { if (this.setupPromise === setup) this.setupPromise = null }, () => { if (this.setupPromise === setup) this.setupPromise = null })
    return setup
  }
  private async attachAndEnable(): Promise<void> {
    if (this.disposed) throw new Error('PAGE_CLOSED')
    let newlyAttached = false
    if (!this.transport.isAttached()) { await this.transport.attach('1.3'); if (this.disposed) { this.transport.detach?.(); throw new Error('PAGE_CLOSED') }; this.attachedByUs = true; newlyAttached = true; this.domainsEnabled = false }
    else if (!this.attachedByUs) throw new Error('UNSUPPORTED_PAGE')
    if (!this.listenerInstalled) { this.listenerInstalled = true; this.transport.onMessage((method, params) => this.onMessage(method, params)) }
    if (newlyAttached || !this.domainsEnabled) { for (const method of ENABLE_METHODS) await this.transport.send(method); this.domainsEnabled = true }
  }
  private onMessage(method: string, params: Record<string, unknown>): void {
    if (this.disposed) return
    if (method === 'Runtime.consoleAPICalled') {
      const args = Array.isArray(params['args']) ? params['args'] as Array<Record<string, unknown>> : []
      const message = args.map((arg) => redactBrowserText(text(arg['value'] ?? arg['description'], 2048))).join(' ').slice(0, 8192)
      const rawLevel = params['type']; const level: ConsoleLevel = rawLevel === 'error' ? 'error' : rawLevel === 'warning' ? 'warning' : rawLevel === 'info' ? 'info' : 'log'
      this.consoleRing.push({ level, message, timestamp: typeof params['timestamp'] === 'number' ? params['timestamp'] : Date.now() })
      return
    }
    if (method === 'Runtime.exceptionThrown') {
      const details = params['exceptionDetails'] as Record<string, unknown> | undefined
      this.consoleRing.push({ level: 'error', message: redactBrowserText(text(details?.['text'] ?? 'Uncaught exception')), timestamp: Date.now() })
      return
    }
    if (method === 'Network.requestWillBeSent') {
      const request = params['request'] as Record<string, unknown> | undefined; const id = text(params['requestId'], 256)
      if (!request || !id) return
      if (!this.requests.has(id)) {
        if (this.requests.size >= 1_000) { this.requests.delete(this.requests.keys().next().value!); this.activeRequests = Math.max(0, this.activeRequests - 1) }
        this.activeRequests += 1
      }
      this.lastNetworkActivity = Date.now()
      this.requests.set(id, { url: sanitizeBrowserUrl(text(request['url'], 8192)), method: text(request['method'], 32), type: text(params['type'], 64), started: Date.now() })
      return
    }
    if (method === 'Network.responseReceived') {
      const id = text(params['requestId'], 256); const pending = this.requests.get(id); const response = params['response'] as Record<string, unknown> | undefined
      if (!pending || !response) return
      pending.status = typeof response['status'] === 'number' ? response['status'] : 0
      return
    }
    if (method === 'Network.loadingFinished') {
      const id = text(params['requestId'], 256); const pending = this.requests.get(id)
      if (!pending) return
      const status = pending.status ?? 0
      this.networkRing.push({ url: pending.url, method: pending.method, type: pending.type, status, failed: status >= 400, durationMs: Date.now() - pending.started })
      this.requests.delete(id); this.activeRequests = Math.max(0, this.activeRequests - 1); this.lastNetworkActivity = Date.now()
      return
    }
    if (method === 'Network.loadingFailed') {
      const id = text(params['requestId'], 256); const pending = this.requests.get(id)
      if (!pending) return
      this.networkRing.push({ url: pending.url, method: pending.method, type: pending.type, status: 0, failed: true, error: redactBrowserText(text(params['errorText'], 512)), durationMs: Date.now() - pending.started })
      this.requests.delete(id); this.activeRequests = Math.max(0, this.activeRequests - 1); this.lastNetworkActivity = Date.now()
    }
  }
  async snapshot(lease: BrowserAutomationLease, limits: SnapshotLimits, signal: AbortSignal): Promise<SnapshotResult> {
    abort(signal); await this.ensureAttached(); abort(signal)
    const response = await this.transport.send('Accessibility.getFullAXTree', { depth: limits.maxDepth }); abort(signal)
    const raw = Array.isArray(response['nodes']) ? response['nodes'] as AXNode[] : []
    const byId = new Map(raw.flatMap((node) => node.nodeId ? [[node.nodeId, node] as const] : []))
    const depthOf = (node: AXNode): number => { let depth = 0, parent = node.parentId; const seen = new Set<string>(); while (parent && depth <= limits.maxDepth) { if (seen.has(parent)) break; seen.add(parent); depth += 1; parent = byId.get(parent)?.parentId } return depth }
    const snapshotId = randomBytes(12).toString('base64url'), entries = new Map<string, SnapshotEntry>(), nodes: AccessibilityNodeResult[] = []
    let used = 512 + Buffer.byteLength(sanitizeBrowserUrl(this.currentUrl())), truncated = false
    for (const node of raw) {
      if (node.ignored) continue
      const depth = depthOf(node); if (depth > limits.maxDepth) { truncated = true; continue }
      const role = text(node.role?.value, 256), name = redactBrowserText(text(node.name?.value, 4096))
      const ref = `n${nodes.length + 1}`
      const disabled = property(node, 'disabled'), focused = property(node, 'focused')
      const publicNode: AccessibilityNodeResult = { ref, depth, role, name, ...(disabled === undefined ? {} : { disabled }), ...(focused === undefined ? {} : { focused }) }
      const estimated = Buffer.byteLength(JSON.stringify(publicNode)) + 1
      if (nodes.length >= limits.maxNodes || used + estimated > limits.maxBytes) { truncated = true; break }
      const entry: SnapshotEntry = { ...publicNode, ...(node.backendDOMNodeId === undefined ? {} : { backendDOMNodeId: node.backendDOMNodeId }) }
      entries.set(ref, entry); nodes.push(publicNode); used += estimated
    }
    this.snapshotCache = { lease: { ...lease }, snapshotId, entries, nodes }
    return { snapshotId, url: sanitizeBrowserUrl(this.currentUrl()), nodes, truncated }
  }
  private resolve(lease: BrowserAutomationLease, target: BrowserElementRef): SnapshotEntry {
    const cache = this.snapshotCache
    if (!cache || !sameLease(cache.lease, lease) || cache.snapshotId !== target.snapshotId) throw new Error('STALE_GENERATION')
    const entry = cache.entries.get(target.ref); if (!entry) throw new Error('STALE_GENERATION')
    return entry
  }
  find(lease: BrowserAutomationLease, snapshotId: string, query: FindQuery): { snapshotId: string; matches: AccessibilityNodeResult[]; truncated: boolean } {
    const cache = this.snapshotCache
    if (!cache || !sameLease(cache.lease, lease) || cache.snapshotId !== snapshotId) throw new Error('STALE_GENERATION')
    const regex = query.regex ? new RegExp(query.regex, 'iu') : null
    const matches = cache.nodes.filter((node) => (!query.text || `${node.name} ${node.role}`.toLocaleLowerCase().includes(query.text.toLocaleLowerCase())) && (!regex || regex.test(`${node.name} ${node.role}`)) && (!query.role || node.role.toLocaleLowerCase() === query.role.toLocaleLowerCase()) && (!query.name || node.name.toLocaleLowerCase().includes(query.name.toLocaleLowerCase())))
    return { snapshotId, matches: matches.slice(0, query.limit), truncated: matches.length > query.limit }
  }
  async inspect(lease: BrowserAutomationLease, target: BrowserElementRef, signal: AbortSignal): Promise<Record<string, unknown>> {
    abort(signal); await this.ensureAttached(); const entry = this.resolve(lease, target)
    if (!entry.backendDOMNodeId) throw new Error('UNSUPPORTED_PAGE')
    const pushed = await this.transport.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [entry.backendDOMNodeId] }); abort(signal)
    const nodeId = Array.isArray(pushed['nodeIds']) && typeof pushed['nodeIds'][0] === 'number' ? pushed['nodeIds'][0] : undefined
    const described = await this.transport.send('DOM.describeNode', { ...(nodeId === undefined ? { backendNodeId: entry.backendDOMNodeId } : { nodeId }), depth: 0, pierce: false }); abort(signal)
    const node = described['node'] as Record<string, unknown> | undefined; const attrs = Array.isArray(node?.['attributes']) ? node!['attributes'] as unknown[] : []
    const attributes: Record<string, string> = {}
    for (let index = 0; index + 1 < attrs.length; index += 2) { const key = text(attrs[index], 128).toLocaleLowerCase(); if (SAFE_ATTRIBUTES.has(key)) attributes[key] = redactBrowserText(text(attrs[index + 1], 2048)) }
    const computedStyle: Record<string, string> = {}
    if (nodeId !== undefined) {
      try {
        const computed = await this.transport.send('CSS.getComputedStyleForNode', { nodeId })
        for (const item of Array.isArray(computed['computedStyle']) ? computed['computedStyle'] as Array<Record<string, unknown>> : []) {
          const name = text(item['name'], 128)
          if (SAFE_COMPUTED_STYLES.has(name)) computedStyle[name] = redactBrowserText(text(item['value'], 512))
        }
      } catch { /* a detached node may have no computed style */ }
    }
    const ancestry: Array<{ tag: string; id?: string; role?: string }> = []
    let parentId = typeof node?.['parentId'] === 'number' ? node['parentId'] : undefined
    for (let depth = 0; parentId !== undefined && depth < 8; depth++) {
      try {
        const parent = (await this.transport.send('DOM.describeNode', { nodeId: parentId, depth: 0, pierce: false }))['node'] as Record<string, unknown> | undefined
        if (!parent) break
        const parentAttrs = Array.isArray(parent['attributes']) ? parent['attributes'] as unknown[] : []
        const summary: { tag: string; id?: string; role?: string } = { tag: text(parent['nodeName'], 128).toLocaleLowerCase() }
        for (let index = 0; index + 1 < parentAttrs.length; index += 2) {
          const key = text(parentAttrs[index], 32).toLocaleLowerCase(), value = redactBrowserText(text(parentAttrs[index + 1], 256))
          if (key === 'id') summary.id = value
          if (key === 'role') summary.role = value
        }
        ancestry.push(summary)
        parentId = typeof parent['parentId'] === 'number' ? parent['parentId'] : undefined
      } catch { break }
    }
    let box: Record<string, number> | undefined
    try { const result = await this.transport.send('DOM.getBoxModel', { backendNodeId: entry.backendDOMNodeId }); const border = (result['model'] as Record<string, unknown> | undefined)?.['border']; if (Array.isArray(border) && border.length === 8 && border.every((n) => typeof n === 'number')) box = { x: Math.min(...border as number[]), y: Math.min((border as number[])[1]!, (border as number[])[3]!, (border as number[])[5]!, (border as number[])[7]!), width: Math.max(...border as number[]) - Math.min(...border as number[]), height: Math.max((border as number[])[1]!, (border as number[])[3]!, (border as number[])[5]!, (border as number[])[7]!) - Math.min((border as number[])[1]!, (border as number[])[3]!, (border as number[])[5]!, (border as number[])[7]!) } } catch { /* detached nodes have no box */ }
    return { snapshotId: target.snapshotId, ref: target.ref, tag: text(node?.['nodeName'], 128).toLocaleLowerCase(), role: entry.role, name: entry.name, attributes, computedStyle, ancestry, ...(box ? { box } : {}) }
  }
  async screenshot(lease: BrowserAutomationLease, target: BrowserElementRef | undefined, fullPage: boolean, signal: AbortSignal): Promise<BrowserBinaryAttachment> {
    abort(signal); await this.ensureAttached(); let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined
    if (target) { const entry = this.resolve(lease, target); if (!entry.backendDOMNodeId) throw new Error('UNSUPPORTED_PAGE'); const box = await this.transport.send('DOM.getBoxModel', { backendNodeId: entry.backendDOMNodeId }); const border = (box['model'] as Record<string, unknown> | undefined)?.['border'] as number[] | undefined; if (!border || border.length !== 8) throw new Error('UNSUPPORTED_PAGE'); clip = { x: Math.min(border[0]!, border[2]!, border[4]!, border[6]!), y: Math.min(border[1]!, border[3]!, border[5]!, border[7]!), width: Math.max(border[0]!, border[2]!, border[4]!, border[6]!) - Math.min(border[0]!, border[2]!, border[4]!, border[6]!), height: Math.max(border[1]!, border[3]!, border[5]!, border[7]!) - Math.min(border[1]!, border[3]!, border[5]!, border[7]!), scale: 1 } }
    else if (fullPage) { const metrics = await this.transport.send('Page.getLayoutMetrics'); const size = metrics['cssContentSize'] as Record<string, unknown> | undefined; if (!size || typeof size['width'] !== 'number' || typeof size['height'] !== 'number' || size['width'] > SCREENSHOT_MAX_DIMENSION || size['height'] > SCREENSHOT_MAX_DIMENSION) throw new Error('REQUEST_LIMIT'); clip = { x: 0, y: 0, width: size['width'], height: size['height'], scale: 1 } }
    if (clip && (clip.width < 1 || clip.height < 1 || clip.width > SCREENSHOT_MAX_DIMENSION || clip.height > SCREENSHOT_MAX_DIMENSION)) throw new Error('REQUEST_LIMIT')
    const result = await this.transport.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: fullPage, ...(clip ? { clip } : {}) }); abort(signal)
    if (typeof result['data'] !== 'string') throw new Error('INTERNAL_ERROR')
    const data = Buffer.from(result['data'], 'base64'); if (data.length > SCREENSHOT_MAX_BYTES) throw new Error('REQUEST_LIMIT')
    const dimensions = pngDimensions(data)
    if (!dimensions) throw new Error('INTERNAL_ERROR')
    if (dimensions.width > SCREENSHOT_MAX_DIMENSION || dimensions.height > SCREENSHOT_MAX_DIMENSION) throw new Error('REQUEST_LIMIT')
    return { mediaType: 'image/png', data, ...dimensions }
  }
  consoleSince(cursor: string | undefined, levels: ConsoleLevel[] | undefined, limit: number): { cursor: string; items: Record<string, unknown>[]; dropped: number; truncated: boolean } { const wanted = levels ? new Set(levels) : null; return this.consoleRing.since(cursor, limit, wanted ? (entry) => wanted.has(entry['level'] as ConsoleLevel) : undefined) }
  networkSince(cursor: string | undefined, limit: number, failedOnly: boolean): { cursor: string; items: Record<string, unknown>[]; dropped: number; truncated: boolean } { return this.networkRing.since(cursor, limit, failedOnly ? (entry) => entry['failed'] === true : undefined) }
  async wait(lease: BrowserAutomationLease, condition: WaitCondition, timeoutMs: number, signal: AbortSignal, stillCurrent: () => boolean = () => true): Promise<{ matched: boolean; elapsedMs: number }> {
    const start = Date.now()
    if (condition.kind === 'networkIdle') { await this.ensureAttached(); this.lastNetworkActivity = start }
    while (Date.now() - start < timeoutMs) {
      abort(signal)
      if (!stillCurrent()) throw new Error('STALE_GENERATION')
      if (condition.kind === 'url' && sanitizeBrowserUrl(this.currentUrl()).includes(condition.value)) return { matched: true, elapsedMs: Date.now() - start }
      if (condition.kind === 'networkIdle' && !this.loading() && this.activeRequests === 0 && Date.now() - this.lastNetworkActivity >= 500) return { matched: true, elapsedMs: Date.now() - start }
      if (condition.kind === 'text' || condition.kind === 'role') {
        const snapshot = await this.snapshot(lease, { maxDepth: 20, maxNodes: 2_000, maxBytes: 256 * 1024 }, signal)
        const match = snapshot.nodes.some((node) => condition.kind === 'text' ? node.name.includes(condition.value) : node.role.toLocaleLowerCase() === condition.value.toLocaleLowerCase() && (!condition.name || node.name.includes(condition.name)))
        if (match) return { matched: true, elapsedMs: Date.now() - start }
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => { clearTimeout(timer); reject(new Error('ACTION_CANCELLED')) }
        const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, 100)
        signal.addEventListener('abort', onAbort, { once: true })
      })
    }
    throw new Error('ACTION_TIMEOUT')
  }
  reload(ignoreCache: boolean): { accepted: true } { this.invalidate(); this.controls.reload?.(ignoreCache); return { accepted: true } }
  history(direction: 'back' | 'forward'): { accepted: true } { this.invalidate(); this.controls.history?.(direction); return { accepted: true } }
  async setViewport(viewport: BrowserViewport, signal: AbortSignal): Promise<{ viewport: BrowserViewport }> { abort(signal); await this.ensureAttached(); await this.transport.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.deviceScaleFactor ?? 1, mobile: viewport.mobile ?? false, screenWidth: viewport.width, screenHeight: viewport.height }); abort(signal); this.invalidate(); return { viewport } }
}
