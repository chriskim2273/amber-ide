import { createHash, randomBytes } from 'node:crypto'
import { isPointerInteraction, type BrowserPoint, type BrowserElementRef, type BrowserInteraction, type BrowserTarget, type BrowserViewport, type ConsoleLevel, type FindQuery, type SnapshotLimits, type WaitCondition } from './browserToolProtocol'
import { BrowserObservations, mapScreenshotPoint, sameViewport, type ScreenshotObservation, type EffectiveBrowserViewport } from './browserObservations'
import { BrowserAgentCursor } from './browserAgentCursor'
import { dispatchPointer } from './browserPointer'
import { modifierMask, virtualKey, keyText, editingCommands } from './browserKeyboard'
import type { InteractionTargetMetadata } from './browserApproval'
import { parseBrowserViewport } from '../shared/browserViewport'
import { BrowserAutomationError, safeBrowserCode } from './browserErrors'
import { BrowserDomRelations } from './browserDomRelations'
import { quadBounds, visibleQuadPoints } from './browserGeometry'
export { BrowserAutomationError } from './browserErrors'

const SCREENSHOT_MAX_BYTES = 10 * 1024 * 1024
const SCREENSHOT_MAX_DIMENSION = 4096
// Include ordinary rendered text nodes, while excluding whitespace-only and
// non-content containers before CDP returns any node ids. CSS/ARIA-hidden nodes
// are filtered again by their ignored accessibility projection.
const SNAPSHOT_SEARCH_XPATH = "//*[not(self::script or self::style or self::noscript or self::template) and not(ancestor::script or ancestor::style or ancestor::noscript or ancestor::template)] | //text()[normalize-space(.) != '' and not(ancestor::script or ancestor::style or ancestor::noscript or ancestor::template)]"
const INTERACTIVE_SEARCH_XPATH = "//input | //textarea | //select | //button | //a[@href] | //*[@role and @role != 'generic' and @role != 'presentation'] | //*[@contenteditable='true'] | //*[@tabindex]"
const SAFE_ATTRIBUTES = new Set(['id', 'class', 'role', 'aria-label', 'aria-labelledby', 'aria-describedby', 'name', 'type', 'placeholder', 'title', 'alt'])
const SAFE_COMPUTED_STYLES = new Set(['display', 'visibility', 'position', 'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height', 'width', 'height', 'overflow', 'opacity'])
const ENABLE_METHODS = ['Accessibility.enable', 'DOM.enable', 'CSS.enable', 'Page.enable', 'Runtime.enable', 'Network.enable'] as const
type CdpMouseInputType = 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel'

function keyCodeFor(value: string): string {
  if (/^[A-Za-z]$/.test(value)) return `Key${value.toUpperCase()}`
  if (/^[0-9]$/.test(value)) return `Digit${value}`
  return value
}

export interface BrowserDebuggerTransport {
  isAttached(): boolean
  attach(version?: string): Promise<void> | void
  detach?(): void
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
  onMessage(listener: (method: string, params: Record<string, unknown>) => void): void
}
export interface BrowserAutomationLease { browserId: string; pageIncarnation: string; generation: number; controller?: string; documentEpoch?: number }
export interface BrowserAutomationOptions { ringItems?: number; ringBytes?: number }
export interface BrowserAutomationControls {
  deviceScaleFactor?: () => number
  reload?(ignoreCache: boolean): boolean | void
  history?(direction: 'back' | 'forward'): boolean | void
  dialog?(dialog: { type: string; message: string }): Promise<{ accept: boolean; promptText?: string }>
  onDiagnostics?(diagnostics: { consoleIssues: number; networkFailures: number }): void
}
export interface AccessibilityNodeResult { ref: string; depth: number; role: string; name: string; disabled?: boolean; focused?: boolean }
export interface SnapshotResult { snapshotId: string; url: string; nodes: AccessibilityNodeResult[]; truncated: boolean; truncationReasons: string[]; ordering: 'interactive-first'; depthIsApproximate: true }
export interface BrowserBinaryAttachment { mediaType: 'image/png'; data: Buffer; width?: number; height?: number; browserId?: string; pageIncarnation?: string; generation?: number; observation?: ScreenshotObservation; actionResult?: Record<string, unknown> }

type AXNode = {
  nodeId?: string; parentId?: string; backendDOMNodeId?: number; ignored?: boolean
  role?: { value?: unknown }; name?: { value?: unknown }; value?: { value?: unknown }
  properties?: Array<{ name?: string; value?: { value?: unknown } }>
}
type SnapshotEntry = AccessibilityNodeResult & { backendDOMNodeId?: number; metadata: InteractionTargetMetadata }
interface SnapshotCache { lease: BrowserAutomationLease; snapshotId: string; entries: Map<string, SnapshotEntry>; nodes: AccessibilityNodeResult[] }
export interface PreparedBrowserInteraction { lease: BrowserAutomationLease; operation: BrowserInteraction; primary?: SnapshotEntry; secondary?: SnapshotEntry; target: InteractionTargetMetadata; secondaryTarget?: InteractionTargetMetadata; grounded?: { observation: ScreenshotObservation; points: BrowserPoint[]; fingerprints: string[]; receiverFingerprints: string[] } }
interface RingEntry { cursor: number; bytes: number; value: Record<string, unknown> }

class BoundedRing {
  private entries: RingEntry[] = []
  private bytes = 0
  private cursor = 0
  constructor(private readonly maxItems: number, private readonly maxBytes: number) {}
  push(value: Record<string, unknown>): void {
    const cursor = ++this.cursor
    const bytes = Buffer.byteLength(JSON.stringify(value))
    if (bytes > this.maxBytes) return
    const entry = { cursor, bytes, value }
    this.entries.push(entry); this.bytes += bytes
    while (this.entries.length > this.maxItems || this.bytes > this.maxBytes) {
      const removed = this.entries.shift()!; this.bytes -= removed.bytes
    }
  }
  since(cursor: string | undefined, limit: number, filter?: (entry: Record<string, unknown>) => boolean): { cursor: string; items: Record<string, unknown>[]; dropped: number; truncated: boolean } {
    const numeric = cursor === undefined ? 0 : Number(cursor)
    const retainedAfterCursor = this.entries.filter((entry) => entry.cursor > numeric)
    const dropped = Math.max(0, this.cursor - numeric - retainedAfterCursor.length)
    const eligible = retainedAfterCursor.filter((entry) => !filter || filter(entry.value))
    const candidates = eligible.slice(-limit), selected: RingEntry[] = []; let bytes = 0
    for (let index = candidates.length - 1; index >= 0; index--) {
      const entry = candidates[index]!
      if (bytes + entry.bytes > 256 * 1024) break
      selected.unshift(entry); bytes += entry.bytes
    }
    return { cursor: String(this.cursor), items: selected.map((entry) => entry.value), dropped, truncated: selected.length < eligible.length }
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
function boundedResponse(value: Record<string, unknown>, maxBytes = 64 * 1024): Record<string, unknown> {
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) throw new Error('REQUEST_LIMIT')
  return value
}
function abort(signal: AbortSignal): void { if (signal.aborted) throw new Error('ACTION_CANCELLED') }
function property(node: AXNode, name: string): boolean | undefined {
  const value = node.properties?.find((item) => item.name === name)?.value?.value
  return typeof value === 'boolean' ? value : undefined
}
function domAttributes(node: Record<string, unknown> | undefined): Record<string, string> {
  const raw = Array.isArray(node?.['attributes']) ? node!['attributes'] as unknown[] : [], out: Record<string, string> = {}
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const key = text(raw[index], 64).toLocaleLowerCase()
    if (['type', 'autocomplete', 'formaction', 'formmethod', 'action', 'method', 'readonly'].includes(key)) out[key] = text(raw[index + 1], 1024)
  }
  return out
}
function targetMetadata(node: AXNode, domNode: Record<string, unknown> | undefined, role: string, name: string, backendDOMNodeId: number | undefined, form?: { action?: string; method?: string }): InteractionTargetMetadata {
  const attributes = domAttributes(domNode), tag = text(domNode?.['nodeName'], 128).toLocaleLowerCase(), type = attributes['type'] ?? ''
  const basis = { role, name, tag, type, backendDOMNodeId: backendDOMNodeId ?? 0, autocomplete: attributes['autocomplete'] ?? '', formAction: attributes['formaction'] ?? form?.action ?? '', formMethod: attributes['formmethod'] ?? form?.method ?? '' }
  return { role, name, tag, type, fingerprint: createHash('sha256').update(JSON.stringify(basis)).digest('hex'), ...(basis.autocomplete ? { autocomplete: basis.autocomplete } : {}), ...(basis.formAction ? { formAction: basis.formAction } : {}), ...(basis.formMethod ? { formMethod: basis.formMethod } : {}) }
}
function sameLease(a: BrowserAutomationLease, b: BrowserAutomationLease): boolean {
  return a.browserId === b.browserId && a.pageIncarnation === b.pageIncarnation && a.generation === b.generation && a.controller === b.controller && a.documentEpoch === b.documentEpoch
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
  private readonly domRelations = new BrowserDomRelations()
  private readonly observations = new BrowserObservations()
  private measuredViewport: EffectiveBrowserViewport | undefined
  private viewportRevision = 0
  private emulatedScaleFactor: number | undefined
  private captureScale(width: number, height: number, limit = 2048): number {
    const dpr = this.emulatedScaleFactor ?? this.controls.deviceScaleFactor?.() ?? 1
    if (!Number.isFinite(dpr) || dpr <= 0) throw new Error('REQUEST_LIMIT')
    return Math.min(1, limit / (Math.max(width, height) * dpr))
  }
  private readonly cursor: BrowserAgentCursor
  private readonly consoleRing: BoundedRing
  private readonly networkRing: BoundedRing
  private readonly requests = new Map<string, { url: string; method: string; type: string; started: number; status?: number }>()
  private activeRequests = 0
  private lastNetworkActivity = Date.now()
  private dialogBarrier: Promise<void> | null = null
  private diagnosticsTimer: NodeJS.Timeout | null = null
  private consoleIssues = 0
  private networkFailures = 0
  private disposed = false
  constructor(
    private readonly transport: BrowserDebuggerTransport,
    private readonly currentUrl: () => string,
    private readonly loading: () => boolean,
    options: BrowserAutomationOptions = {},
    private readonly controls: BrowserAutomationControls = {},
  ) {
    this.cursor = new BrowserAgentCursor(transport, () => this.controls.deviceScaleFactor?.() ?? 1)
    this.consoleRing = new BoundedRing(options.ringItems ?? 1_000, options.ringBytes ?? 1024 * 1024)
    this.networkRing = new BoundedRing(options.ringItems ?? 1_000, options.ringBytes ?? 1024 * 1024)
  }
  invalidate(): void { this.snapshotCache = null; this.observations.clear() }
  hideCursor(): void { void this.cursor.hide() }
  dispose(): void {
    this.disposed = true; this.cursor.dispose(); this.observations.clear(); this.snapshotCache = null; this.domRelations.clear(); this.requests.clear(); this.activeRequests = 0
    if (this.diagnosticsTimer) clearTimeout(this.diagnosticsTimer); this.diagnosticsTimer = null
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
  private scheduleDiagnostics(): void {
    if (!this.controls.onDiagnostics || this.diagnosticsTimer || this.disposed) return
    this.diagnosticsTimer = setTimeout(() => {
      this.diagnosticsTimer = null
      if (!this.disposed) this.controls.onDiagnostics?.({ consoleIssues: this.consoleIssues, networkFailures: this.networkFailures })
    }, 250)
    this.diagnosticsTimer.unref()
  }
  private onMessage(method: string, params: Record<string, unknown>): void {
    if (this.disposed) return
    this.domRelations.onMessage(method, params)
    if (method === 'Page.javascriptDialogOpening') {
      const type = text(params['type'], 32), message = redactBrowserText(text(params['message'], 1024)).slice(0, 1024)
      const decision = this.controls.dialog?.({ type, message }) ?? Promise.reject(new Error('DIALOG_UNAVAILABLE'))
      const handling = decision.then((result) => this.transport.send('Page.handleJavaScriptDialog', { accept: result.accept, ...(result.accept && result.promptText !== undefined ? { promptText: result.promptText.slice(0, 4096) } : {}) }),
        () => this.transport.send('Page.handleJavaScriptDialog', { accept: false })).then(() => {})
      this.dialogBarrier = handling
      void handling.catch(() => {}).finally(() => { if (this.dialogBarrier === handling) this.dialogBarrier = null })
      return
    }
    if (method === 'Runtime.consoleAPICalled') {
      const args = Array.isArray(params['args']) ? params['args'] as Array<Record<string, unknown>> : []
      const message = args.map((arg) => redactBrowserText(text(arg['value'] ?? arg['description'], 2048))).join(' ').slice(0, 8192)
      const rawLevel = params['type']; const level: ConsoleLevel = rawLevel === 'error' ? 'error' : rawLevel === 'warning' ? 'warning' : rawLevel === 'info' ? 'info' : 'log'
      this.consoleRing.push({ level, message, timestamp: typeof params['timestamp'] === 'number' ? params['timestamp'] : Date.now() })
      if (level === 'error' || level === 'warning') { this.consoleIssues = Math.min(10_000, this.consoleIssues + 1); this.scheduleDiagnostics() }
      return
    }
    if (method === 'Runtime.exceptionThrown') {
      const details = params['exceptionDetails'] as Record<string, unknown> | undefined
      this.consoleRing.push({ level: 'error', message: redactBrowserText(text(details?.['text'] ?? 'Uncaught exception')), timestamp: Date.now() })
      this.consoleIssues = Math.min(10_000, this.consoleIssues + 1); this.scheduleDiagnostics()
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
      if (status >= 400) { this.networkFailures = Math.min(10_000, this.networkFailures + 1); this.scheduleDiagnostics() }
      this.requests.delete(id); this.activeRequests = Math.max(0, this.activeRequests - 1); this.lastNetworkActivity = Date.now()
      return
    }
    if (method === 'Network.loadingFailed') {
      const id = text(params['requestId'], 256); const pending = this.requests.get(id)
      if (!pending) return
      this.networkRing.push({ url: pending.url, method: pending.method, type: pending.type, status: 0, failed: true, error: redactBrowserText(text(params['errorText'], 512)), durationMs: Date.now() - pending.started })
      this.networkFailures = Math.min(10_000, this.networkFailures + 1); this.scheduleDiagnostics()
      this.requests.delete(id); this.activeRequests = Math.max(0, this.activeRequests - 1); this.lastNetworkActivity = Date.now()
    }
  }
  async snapshot(lease: BrowserAutomationLease, limits: SnapshotLimits, signal: AbortSignal): Promise<SnapshotResult> {
    abort(signal); await this.ensureAttached(); abort(signal)
    // CDP's getFullAXTree materializes an attacker-controlled tree before a
    // caller can apply limits. Search DOM node ids in small pages, then ask for
    // one node's partial AX projection at a time. No response is accumulated
    // into the snapshot until it fits the hard input and output budgets.
    const snapshotId = randomBytes(12).toString('base64url'), entries = new Map<string, SnapshotEntry>(), nodes: AccessibilityNodeResult[] = []
    const depthByNodeId = new Map<number, number>(), seenAXNodes = new Set<string>()
    const safeUrl = sanitizeBrowserUrl(this.currentUrl()), inputLimit = Math.min(512 * 1024, Math.max(16 * 1024, limits.maxBytes * 2))
    this.domRelations.clear()
    const document = await this.transport.send('DOM.getDocument', { depth: 0, pierce: false }); abort(signal)
    let inputBytes = Buffer.byteLength(JSON.stringify(document))
    if (inputBytes > inputLimit) {
      this.snapshotCache = { lease: { ...lease }, snapshotId, entries, nodes }
      return { snapshotId, url: safeUrl, nodes, truncated: true, truncationReasons: ['input-byte-budget'], ordering: 'interactive-first', depthIsApproximate: true }
    }
    const truncationReasons = new Set<string>()
    let used = 512 + Buffer.byteLength(safeUrl), scanned = 0, truncated = false
    for (const query of [INTERACTIVE_SEARCH_XPATH, SNAPSHOT_SEARCH_XPATH]) {
    if (truncated || scanned >= limits.maxNodes) { truncated = true; break }
    const search = await this.transport.send('DOM.performSearch', { query, includeUserAgentShadowDOM: false }); abort(signal)
    const searchId = text(search['searchId'], 256), resultCount = typeof search['resultCount'] === 'number' && Number.isSafeInteger(search['resultCount']) ? Math.max(0, search['resultCount']) : 0
    if (!searchId) throw new Error('UNSUPPORTED_PAGE')
    let searchScanned = 0
    inputBytes += Buffer.byteLength(JSON.stringify(search))
    try {
      if (inputBytes > inputLimit) truncated = true
      outer: for (let start = 0; !truncated && start < resultCount && scanned < limits.maxNodes; start += 32) {
        abort(signal)
        const page = await this.transport.send('DOM.getSearchResults', { searchId, fromIndex: start, toIndex: Math.min(resultCount, start + 32) }); abort(signal)
        inputBytes += Buffer.byteLength(JSON.stringify(page))
        if (inputBytes > inputLimit) { truncated = true; break }
        const nodeIds = Array.isArray(page['nodeIds']) ? page['nodeIds'].filter((id): id is number => typeof id === 'number').slice(0, 32) : []
        for (const nodeId of nodeIds) {
          if (scanned >= limits.maxNodes) { truncated = true; break outer }
          scanned += 1; searchScanned += 1; abort(signal)
          const described = await this.transport.send('DOM.describeNode', { nodeId, depth: 0, pierce: false }); abort(signal)
          inputBytes += Buffer.byteLength(JSON.stringify(described))
          if (inputBytes > inputLimit) { truncated = true; break outer }
          const domNode = described['node'] as Record<string, unknown> | undefined
          const parentId = typeof domNode?.['parentId'] === 'number' ? domNode['parentId'] : this.domRelations.parentOf(nodeId)
          const depth = parentId === undefined ? 0 : (depthByNodeId.get(parentId) ?? -1) + 1
          depthByNodeId.set(nodeId, depth)
          if (depth > limits.maxDepth) { truncationReasons.add('depth-limit'); continue }
          const partial = await this.transport.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false }); abort(signal)
          inputBytes += Buffer.byteLength(JSON.stringify(partial))
          if (inputBytes > inputLimit) { truncated = true; break outer }
          const candidates = Array.isArray(partial['nodes']) ? partial['nodes'] as AXNode[] : []
          const node = candidates.find((candidate) => !candidate.ignored)
          if (!node) continue
          // DOM search identifies the requested element; prefer its backend id
          // over AX's related identity, which can point at a containing node on
          // Electron 43 after the page has been restored or reattached.
          const backendDOMNodeId = typeof domNode?.['backendNodeId'] === 'number' ? domNode['backendNodeId'] : (typeof node.backendDOMNodeId === 'number' ? node.backendDOMNodeId : undefined)
          const axNodeId = typeof node.nodeId === 'string' && node.nodeId ? createHash('sha256').update(node.nodeId).digest('base64url') : ''
          const identity = axNodeId ? `ax:${axNodeId}` : (backendDOMNodeId === undefined ? '' : `dom:${backendDOMNodeId}`)
          if (identity && seenAXNodes.has(identity)) continue
          const role = text(node.role?.value, 256), name = redactBrowserText(text(node.name?.value, 4096)), ref = `n${nodes.length + 1}`
          const disabled = property(node, 'disabled'), focused = property(node, 'focused')
          const publicNode: AccessibilityNodeResult = { ref, depth, role, name, ...(disabled === undefined ? {} : { disabled }), ...(focused === undefined ? {} : { focused }) }
          const estimated = Buffer.byteLength(JSON.stringify(publicNode)) + 1
          if (nodes.length >= limits.maxNodes || used + estimated > limits.maxBytes) { truncationReasons.add(nodes.length >= limits.maxNodes ? 'node-budget' : 'output-byte-budget'); truncated = true; break outer }
          if (identity) seenAXNodes.add(identity)
          entries.set(ref, { ...publicNode, ...(backendDOMNodeId === undefined ? {} : { backendDOMNodeId }), metadata: targetMetadata(node, domNode, role, name, backendDOMNodeId) }); nodes.push(publicNode); used += estimated
        }
      }
      if (searchScanned < resultCount) truncated = true
    } finally { await this.transport.send('DOM.discardSearchResults', { searchId }).catch(() => {}) }
    }
    this.snapshotCache = { lease: { ...lease }, snapshotId, entries, nodes }
    if (inputBytes > inputLimit) truncationReasons.add('input-byte-budget')
    if (scanned >= limits.maxNodes) truncationReasons.add('node-scan-budget')
    if (truncated && !truncationReasons.size) truncationReasons.add('search-results-remaining')
    return { snapshotId, url: safeUrl, nodes, truncated: truncated || truncationReasons.size > 0, truncationReasons: [...truncationReasons], ordering: 'interactive-first', depthIsApproximate: true }
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
    let parentId = typeof node?.['parentId'] === 'number' ? node['parentId'] : nodeId === undefined ? undefined : this.domRelations.parentOf(nodeId)
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
        parentId = typeof parent['parentId'] === 'number' ? parent['parentId'] : this.domRelations.parentOf(parentId)
      } catch { break }
    }
    let box: Record<string, number> | undefined
    try { const result = await this.transport.send('DOM.getBoxModel', { backendNodeId: entry.backendDOMNodeId }); const border = (result['model'] as Record<string, unknown> | undefined)?.['border']; if (Array.isArray(border) && border.length === 8 && border.every((n) => typeof n === 'number')) box = { ...quadBounds(border as number[]) } } catch { /* detached nodes have no box */ }
    return { snapshotId: target.snapshotId, ref: target.ref, tag: text(node?.['nodeName'], 128).toLocaleLowerCase(), role: entry.role, name: entry.name, attributes, computedStyle, ancestry, ...(box ? { box } : {}) }
  }
  private resolveTarget(lease: BrowserAutomationLease, target: BrowserTarget): SnapshotEntry {
    const cache = this.snapshotCache
    if (!cache || !sameLease(cache.lease, lease) || cache.snapshotId !== target.snapshotId) throw new Error('STALE_GENERATION')
    if ('ref' in target) return this.resolve(lease, target)
    const matches = [...cache.entries.values()].filter((entry) => entry.role.toLocaleLowerCase() === target.role.toLocaleLowerCase() && (target.name === undefined || entry.name === target.name))
    if (matches.length === 0) throw new Error('TARGET_NOT_FOUND')
    if (matches.length !== 1) throw new Error('TARGET_AMBIGUOUS')
    return matches[0]!
  }
  private async formSemantics(domNode: Record<string, unknown> | undefined, signal: AbortSignal): Promise<{ action?: string; method?: string }> {
    let parentId = typeof domNode?.['parentId'] === 'number' ? domNode['parentId'] : this.domRelations.parentOf(Number(domNode?.['nodeId']))
    for (let depth = 0; parentId !== undefined && depth < 8; depth++) {
      abort(signal)
      const described = boundedResponse(await this.transport.send('DOM.describeNode', { nodeId: parentId, depth: 0, pierce: false })); abort(signal)
      const parent = described['node'] as Record<string, unknown> | undefined
      if (!parent) break
      if (text(parent['nodeName'], 32).toLocaleLowerCase() === 'form') {
        const attributes = domAttributes(parent)
        return { ...(attributes['formaction'] || attributes['action'] ? { action: attributes['formaction'] ?? attributes['action'] } : {}), ...(attributes['formmethod'] || attributes['method'] ? { method: attributes['formmethod'] ?? attributes['method'] } : {}) }
      }
      parentId = typeof parent['parentId'] === 'number' ? parent['parentId'] : this.domRelations.parentOf(parentId)
    }
    return {}
  }
  private async actionable(entry: SnapshotEntry, signal: AbortSignal, editable = false, scroll = false): Promise<{ x: number; y: number; quad: number[]; focused: boolean; checked?: boolean; metadata: InteractionTargetMetadata }> {
    abort(signal)
    if (!entry.backendDOMNodeId) throw new Error('UNSUPPORTED_PAGE')
    const described = boundedResponse(await this.transport.send('DOM.describeNode', { backendNodeId: entry.backendDOMNodeId, depth: 0, pierce: false })); abort(signal)
    const domNode = described['node'] as Record<string, unknown> | undefined
    const partial = boundedResponse(await this.transport.send('Accessibility.getPartialAXTree', { backendNodeId: entry.backendDOMNodeId, fetchRelatives: false })); abort(signal)
    const node = Array.isArray(partial['nodes']) ? (partial['nodes'] as AXNode[]).find((candidate) => !candidate.ignored) : undefined
    if (!node || property(node, 'disabled') === true) throw new Error('TARGET_NOT_ACTIONABLE')
    if (editable && (property(node, 'readonly') === true || 'readonly' in domAttributes(domNode))) throw new Error('TARGET_NOT_ACTIONABLE')
    const role = text(node.role?.value, 256), name = redactBrowserText(text(node.name?.value, 4096))
    const base = targetMetadata(node, domNode, role, name, entry.backendDOMNodeId)
    if (base.fingerprint !== entry.metadata.fingerprint) throw new Error('STALE_GENERATION')
    const current = targetMetadata(node, domNode, role, name, entry.backendDOMNodeId, await this.formSemantics(domNode, signal))
    const pushed = await this.transport.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [entry.backendDOMNodeId] }); abort(signal)
    const nodeId = Array.isArray(pushed['nodeIds']) && typeof pushed['nodeIds'][0] === 'number' ? pushed['nodeIds'][0] : undefined
    if (!nodeId) throw new Error('TARGET_NOT_ACTIONABLE')
    const styles = boundedResponse(await this.transport.send('CSS.getComputedStyleForNode', { nodeId })); abort(signal)
    const style = new Map((Array.isArray(styles['computedStyle']) ? styles['computedStyle'] as Array<Record<string, unknown>> : []).map((item) => [text(item['name'], 64), text(item['value'], 128)]))
    if (style.get('display') === 'none' || style.get('visibility') === 'hidden' || style.get('pointer-events') === 'none' || Number(style.get('opacity') ?? '1') <= 0) throw new Error('TARGET_NOT_ACTIONABLE')
    if (scroll) { await this.transport.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: entry.backendDOMNodeId }); abort(signal) }
    const box = boundedResponse(await this.transport.send('DOM.getBoxModel', { backendNodeId: entry.backendDOMNodeId })); abort(signal)
    const border = (box['model'] as Record<string, unknown> | undefined)?.['border']
    if (!Array.isArray(border) || border.length !== 8 || !border.every((value) => typeof value === 'number' && Number.isFinite(value))) throw new Error('TARGET_NOT_ACTIONABLE')
    const { x, y, width, height } = quadBounds(border as number[])
    if (width < 1 || height < 1 || width > 16_384 || height > 16_384) throw new Error('TARGET_NOT_ACTIONABLE')
    const checked = property(node, 'checked')
    return { x: x + width / 2, y: y + height / 2, quad: border as number[], focused: property(node, 'focused') === true, ...(checked === undefined ? {} : { checked }), metadata: current }
  }
  private async effectiveViewport(signal: AbortSignal): Promise<EffectiveBrowserViewport> {
    const metrics = boundedResponse(await this.transport.send('Page.getLayoutMetrics')); abort(signal)
    const view = (metrics['cssVisualViewport'] ?? metrics['cssLayoutViewport']) as Record<string, unknown> | undefined
    const result = { width: Number(view?.['clientWidth'] ?? view?.['width']), height: Number(view?.['clientHeight'] ?? view?.['height']), pageX: Number(view?.['pageX'] ?? 0), pageY: Number(view?.['pageY'] ?? 0) }
    if (!Object.values(result).every(Number.isFinite) || result.width < 1 || result.height < 1 || result.width > 4096 || result.height > 4096) throw new Error('REQUEST_LIMIT')
    if (!this.measuredViewport || !sameViewport(this.measuredViewport, result)) { this.measuredViewport = { ...result }; this.viewportRevision++ }
    return result
  }
  private async verifyObservation(observation: ScreenshotObservation, signal: AbortSignal): Promise<void> {
    if (!this.observations.isFresh(observation) || !sameViewport(observation.viewport, await this.effectiveViewport(signal)) || observation.viewportRevision !== this.viewportRevision) throw new Error('STALE_GENERATION')
  }
  private async pointerReceiver(point: BrowserPoint, viewport: EffectiveBrowserViewport, signal: AbortSignal, pixels = true): Promise<InteractionTargetMetadata> {
    const hit = await this.transport.send('DOM.getNodeForLocation', { x: Math.floor(point.x + viewport.pageX), y: Math.floor(point.y + viewport.pageY), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false }); abort(signal)
    const backend = hit['backendNodeId']
    if (typeof backend !== 'number') throw new Error('TARGET_NOT_ACTIONABLE')
    const described = boundedResponse(await this.transport.send('DOM.describeNode', { backendNodeId: backend, depth: 0, pierce: false })); abort(signal)
    const partial = boundedResponse(await this.transport.send('Accessibility.getPartialAXTree', { backendNodeId: backend, fetchRelatives: false })); abort(signal)
    const node = (partial['nodes'] as AXNode[] | undefined)?.find(item => !item.ignored) ?? {}
    const dom = described['node'] as Record<string, unknown> | undefined
    const metadata = targetMetadata(node, dom, text(node.role?.value, 256), redactBrowserText(text(node.name?.value, 4096)), backend)
    if (!pixels) return { ...metadata, receiverFingerprint: metadata.fingerprint }
    await this.cursor.hide()
    const width = Math.min(64, viewport.width), height = Math.min(64, viewport.height)
    const x = Math.min(Math.max(0, point.x - width / 2), viewport.width - width), y = Math.min(Math.max(0, point.y - height / 2), viewport.height - height)
    const crop = await this.transport.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false,
      clip: { x: viewport.pageX + x, y: viewport.pageY + y, width, height, scale: this.captureScale(width, height, 256) } }); abort(signal)
    if (typeof crop['data'] !== 'string' || crop['data'].length > 512 * 1024) throw new Error('REQUEST_LIMIT')
    const digest = createHash('sha256').update(crop['data']).digest('hex')
    const semantic = ['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'option', 'menuitem', 'tab'].includes(metadata.role.toLowerCase())
    return { ...metadata, receiverFingerprint: metadata.fingerprint, fingerprint: semantic ? metadata.fingerprint : createHash('sha256').update(metadata.fingerprint + digest).digest('hex'), visualPreview: `data:image/png;base64,${crop['data']}` }
  }
  private async preparePointer(lease: BrowserAutomationLease, operation: Extract<BrowserInteraction, { screenshotId: string }>, signal: AbortSignal): Promise<PreparedBrowserInteraction> {
    const observation = this.observations.resolve(lease, operation.screenshotId)
    await this.verifyObservation(observation, signal)
    if (operation.kind === 'typeFocused') {
      await this.snapshot(lease, { maxDepth: 20, maxNodes: 1000, maxBytes: 128 * 1024 }, signal)
      const focused = [...(this.snapshotCache?.entries.values() ?? [])].filter(entry => entry.focused && ['textbox', 'searchbox', 'combobox'].includes(entry.role.toLowerCase()))
      if (focused.length !== 1) throw new Error('TARGET_NOT_ACTIONABLE')
      const primary = focused[0]!, current = await this.actionable(primary, signal, true)
      if (current.metadata.type === 'file') throw new Error('TARGET_NOT_ACTIONABLE')
      return { lease: { ...lease }, operation, primary, target: current.metadata, grounded: { observation, points: [], fingerprints: [], receiverFingerprints: [] } }
    }
    const points = (operation.kind === 'mouseDrag' ? operation.path : ('path' in operation && operation.path ? operation.path : [{ x: operation.x, y: operation.y }])).map(point => mapScreenshotPoint(observation, point))
    if (operation.kind === 'mouseClick' || operation.kind === 'mouseDrag') {
      const endpoints = operation.kind === 'mouseDrag' ? [points[0]!, points.at(-1)!] : [points.at(-1)!]
      const targets: InteractionTargetMetadata[] = []
      for (const point of endpoints) targets.push(await this.pointerReceiver(point, observation.viewport, signal))
      return { lease: { ...lease }, operation, target: targets[0]!, ...(targets[1] ? { secondaryTarget: targets[1] } : {}), grounded: { observation, points, fingerprints: targets.map(target => target.fingerprint), receiverFingerprints: targets.map(target => target.receiverFingerprint!) } }
    }
    return { lease: { ...lease }, operation, target: { role: 'document', name: 'Browser pointer', tag: 'body', type: '', fingerprint: createHash('sha256').update(JSON.stringify(points)).digest('hex') }, grounded: { observation, points, fingerprints: [], receiverFingerprints: [] } }
  }
  async prepareInteraction(lease: BrowserAutomationLease, operation: BrowserInteraction, signal: AbortSignal): Promise<PreparedBrowserInteraction> {
    abort(signal); await this.ensureAttached(); abort(signal)
    if (isPointerInteraction(operation)) return this.preparePointer(lease, operation, signal)
    const primaryTarget = operation.kind === 'drag' ? operation.source : ('target' in operation ? operation.target : undefined)
    const primary = primaryTarget ? this.resolveTarget(lease, primaryTarget) : undefined
    const secondary = operation.kind === 'drag' ? this.resolveTarget(lease, operation.target) : undefined
    const primaryCurrent = primary ? await this.actionable(primary, signal, operation.kind === 'fill' || operation.kind === 'type', true) : undefined
    const secondaryCurrent = secondary ? await this.actionable(secondary, signal) : undefined
    const metadata = primaryCurrent?.metadata
    if ((operation.kind === 'fill' || operation.kind === 'type') && (!metadata || (!['textbox', 'searchbox', 'combobox'].includes(metadata.role.toLocaleLowerCase()) && !['input', 'textarea'].includes(metadata.tag)) || metadata.type === 'file')) throw new Error('TARGET_NOT_ACTIONABLE')
    if (operation.kind === 'select' && (!metadata || (!['combobox', 'listbox'].includes(metadata.role.toLocaleLowerCase()) && metadata.tag !== 'select'))) throw new Error('TARGET_NOT_ACTIONABLE')
    if ((operation.kind === 'check' || operation.kind === 'uncheck') && (!metadata || !['checkbox', 'switch', 'radio'].includes(metadata.role.toLocaleLowerCase()))) throw new Error('TARGET_NOT_ACTIONABLE')
    if (operation.kind === 'uncheck' && metadata?.role.toLocaleLowerCase() === 'radio') throw new Error('TARGET_NOT_ACTIONABLE')
    const target = metadata ?? { role: 'document', name: '', tag: 'body', type: '', fingerprint: createHash('sha256').update('document').digest('hex') }
    return { lease: { ...lease }, operation, ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}), target, ...(secondaryCurrent ? { secondaryTarget: secondaryCurrent.metadata } : {}) }
  }
  private async hitTest(entry: SnapshotEntry, point: { x: number; y: number; quad?: number[] }, signal: AbortSignal): Promise<{ x: number; y: number }> {
    if (!entry.backendDOMNodeId || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('TARGET_NOT_ACTIONABLE')
    const metrics = boundedResponse(await this.transport.send('Page.getLayoutMetrics')); abort(signal)
    const viewport = (metrics['cssVisualViewport'] ?? metrics['cssLayoutViewport']) as Record<string, unknown> | undefined
    const width = typeof viewport?.['clientWidth'] === 'number' ? viewport['clientWidth'] : viewport?.['width']
    const height = typeof viewport?.['clientHeight'] === 'number' ? viewport['clientHeight'] : viewport?.['height']
    if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > 16_384 || height > 16_384) throw new Error('TARGET_NOT_ACTIONABLE')
    const candidates = point.quad ? visibleQuadPoints(point.quad, width, height) : [point]
    for (const candidate of candidates) {
    if (candidate.x < 0 || candidate.y < 0 || candidate.x >= width || candidate.y >= height) continue
    const exactPoint = { x: Math.floor(candidate.x), y: Math.floor(candidate.y) }
    // DOM hit locations use document coordinates; Input dispatch uses viewport
    // coordinates. A scrolled native fixture proves these are not interchangeable.
    const layout = (metrics['cssLayoutViewport'] ?? viewport) as Record<string, unknown>
    const pageX = Number(layout['pageX'] ?? 0), pageY = Number(layout['pageY'] ?? 0)
    if (!Number.isFinite(pageX) || !Number.isFinite(pageY)) throw new Error('TARGET_NOT_ACTIONABLE')
    const hit = boundedResponse(await this.transport.send('DOM.getNodeForLocation', { x: Math.floor(exactPoint.x + pageX), y: Math.floor(exactPoint.y + pageY), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false })); abort(signal)
    let backend = typeof hit['backendNodeId'] === 'number' ? hit['backendNodeId'] : undefined
    let nodeId = typeof hit['nodeId'] === 'number' ? hit['nodeId'] : undefined
    for (let depth = 0; depth < 32 && (backend !== undefined || nodeId !== undefined); depth++) {
      if (backend === entry.backendDOMNodeId || (nodeId !== undefined && this.domRelations.isWithin(nodeId, entry.backendDOMNodeId))) return exactPoint
      let described: Record<string, unknown>
      try { described = boundedResponse(await this.transport.send('DOM.describeNode', { ...(nodeId !== undefined ? { nodeId } : { backendNodeId: backend }), depth: 0, pierce: false })) }
      catch (error) {
        // A transient covering node can disappear after the hit reply. Only
        // this measured missing-node error is recoverable; never replay input.
        if (error instanceof Error && error.message === 'Could not find node with given id') break
        throw error
      }
      abort(signal)
      const node = described['node'] as Record<string, unknown> | undefined
      if (!node) break
      backend = typeof node['backendNodeId'] === 'number' ? node['backendNodeId'] : undefined
      if (backend === entry.backendDOMNodeId) return exactPoint
      nodeId = typeof node['parentId'] === 'number' ? node['parentId'] : nodeId === undefined ? undefined : this.domRelations.parentOf(nodeId)
      backend = undefined
    }
    }
    throw new BrowserAutomationError('TARGET_OCCLUDED', false, { reason: 'occluded', targetRef: entry.ref, attemptedPoints: candidates.length })
  }
  private pause(ms: number, signal: AbortSignal): Promise<void> {
    abort(signal)
    return new Promise((resolve, reject) => {
      const onAbort = (): void => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(new Error('ACTION_CANCELLED')) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }
  async executeInteraction(prepared: PreparedBrowserInteraction, signal: AbortSignal, stillCurrent: (dispatched: boolean, phase?: 'dispatch' | 'finish' | 'cleanup') => boolean = () => true): Promise<{ dispatched: true; rollbackPossible: false; receiver?: { role: string; tag: string; point?: BrowserPoint } }> {
    let dispatched = false
    let gestureStartedAt: number | undefined
    const heldKeys = new Map<string, Record<string, unknown>>()
    const heldButtons = new Map<string, Record<string, unknown>>()
    const asAutomationError = (error: unknown): BrowserAutomationError => {
      if (error instanceof BrowserAutomationError) return dispatched && !error.dispatched ? new BrowserAutomationError(error.code, true, error.diagnostics) : error
      const code = safeBrowserCode(error instanceof Error ? error.message : undefined)
      return new BrowserAutomationError(code, dispatched)
    }
    const ensure = (phase: 'dispatch' | 'finish' = 'dispatch'): void => {
      if (signal.aborted || (phase === 'dispatch' && gestureStartedAt !== undefined && performance.now() - gestureStartedAt >= 2000)) throw new BrowserAutomationError('ACTION_CANCELLED', dispatched)
      // Input callbacks may advance generation after dispatch. Further input
      // must nevertheless remain in the same document, not merely WebContents.
      if (!stillCurrent(dispatched, phase)) throw new BrowserAutomationError('STALE_GENERATION', dispatched)
    }
    const sendIrreversible = async (method: 'Input.dispatchMouseEvent' | 'Input.dispatchKeyEvent' | 'Input.insertText', params: Record<string, unknown>): Promise<void> => {
      ensure()
      const keyId = String(params['code'] ?? params['key'] ?? '')
      const button = String(params['button'] ?? 'none')
      if (method === 'Input.dispatchMouseEvent' && params['type'] === 'mousePressed' && button !== 'none') heldButtons.set(button, { ...params, type: 'mouseReleased', buttons: 0, clickCount: 0 })
      if (method === 'Input.dispatchKeyEvent' && params['type'] === 'keyDown') heldKeys.set(keyId, { ...params, type: 'keyUp', text: '', commands: [] })
      if (method === 'Input.dispatchMouseEvent' && params['type'] === 'mouseMoved') {
        for (const [held, release] of heldButtons) heldButtons.set(held, { ...release, x: params['x'], y: params['y'] })
      }
      if (isPointerInteraction(prepared.operation) && gestureStartedAt === undefined) gestureStartedAt = performance.now()
      // A lost/error response does not prove that Chromium ignored the input.
      dispatched = true
      try {
        await this.transport.send(method, params)
        if (method === 'Input.dispatchKeyEvent' && params['type'] === 'keyUp') heldKeys.delete(keyId)
        if (method === 'Input.dispatchMouseEvent' && params['type'] === 'mouseReleased') heldButtons.delete(button)
      } catch (error) {
        throw asAutomationError(error)
      }
    }
    const pointFor = async (entry: SnapshotEntry, expected: InteractionTargetMetadata): Promise<{ x: number; y: number; focused?: boolean; checked?: boolean }> => {
      const deadline = performance.now() + 2000
      for (;;) {
        ensure()
        try {
          const editable = prepared.operation.kind === 'fill' || prepared.operation.kind === 'type'
          const first = await this.actionable(entry, signal, editable)
          if (!dispatched) {
            await this.pause(25, signal)
            // DOM geometry can precede compositor hit regions after navigation.
            // A one-pixel readback fences the frame without injecting page code;
            // the real HTTP fixture otherwise silently drops every input event.
            const viewport = await this.effectiveViewport(signal)
            await this.transport.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false,
              clip: { x: viewport.pageX, y: viewport.pageY, width: 1, height: 1, scale: 1 } })
            ensure()
          }
          const point = dispatched ? first : await this.actionable(entry, signal, editable)
          if (point.metadata.fingerprint !== expected.fingerprint) throw new BrowserAutomationError('STALE_GENERATION', dispatched)
          if (Math.abs(first.x - point.x) > 0.5 || Math.abs(first.y - point.y) > 0.5) throw new BrowserAutomationError('TARGET_UNSTABLE', dispatched, { reason: 'unstable', targetRef: entry.ref, attemptedPoints: 0 })
          ensure(); const exactPoint = await this.hitTest(entry, point, signal); ensure()
          return { ...point, ...exactPoint }
        } catch (error) {
          const code = error instanceof Error ? error.message : ''
          if (dispatched || !['TARGET_OCCLUDED', 'TARGET_UNSTABLE'].includes(code) || performance.now() >= deadline) throw error
          await this.pause(Math.min(100, Math.max(1, deadline - performance.now())), signal)
        }
      }
    }
    const mouse = async (type: CdpMouseInputType, point: { x: number; y: number }, extra: Record<string, unknown> = {}): Promise<void> => {
      const params = { type, x: point.x, y: point.y, button: 'none', clickCount: 0, modifiers: 0, buttons: type === 'mousePressed' ? 1 : 0, ...extra }
      await sendIrreversible('Input.dispatchMouseEvent', params)
    }
    const key = async (type: 'keyDown' | 'keyUp', value: string, modifiers = 0): Promise<void> => {
      const text = keyText(value, modifiers)
      const key = value === 'Space' ? ' ' : (text && /^[A-Za-z0-9]$/.test(value) ? text : value)
      await sendIrreversible('Input.dispatchKeyEvent', { type, key, code: keyCodeFor(value), modifiers, windowsVirtualKeyCode: virtualKey(value), ...(type === 'keyDown' ? { commands: editingCommands(value, modifiers), ...(text !== undefined ? { text } : {}) } : {}) })
    }
    const operation = prepared.operation
    try {
      if (isPointerInteraction(operation)) {
        const grounded = prepared.grounded
        if (!grounded) throw new Error('STALE_GENERATION')
        const verify = async (release = false): Promise<void> => {
          ensure()
          await this.verifyObservation(grounded.observation, signal)
          if (prepared.primary) {
            const current = await this.actionable(prepared.primary, signal, true)
            if (current.metadata.fingerprint !== prepared.target.fingerprint) throw new Error('STALE_GENERATION')
            const partial = await this.transport.send('Accessibility.getPartialAXTree', { backendNodeId: prepared.primary.backendDOMNodeId, fetchRelatives: false })
            if (!(partial['nodes'] as AXNode[] | undefined)?.some(node => property(node, 'focused') === true)) throw new Error('STALE_GENERATION')
          } else if (grounded.fingerprints.length) {
            const endpoints = operation.kind === 'mouseDrag' && !release ? [grounded.points[0]!, grounded.points.at(-1)!] : [grounded.points.at(-1)!]
            for (let i = 0; i < endpoints.length; i++) {
              const receiver = await this.pointerReceiver(endpoints[i]!, grounded.observation.viewport, signal, !release)
              const expected = release ? grounded.receiverFingerprints.at(-1) : grounded.fingerprints[i]
              if ((release ? receiver.receiverFingerprint : receiver.fingerprint) !== expected) throw new Error('STALE_GENERATION')
            }
          }
          ensure()
        }
        await this.verifyObservation(grounded.observation, signal)
        await dispatchPointer(operation, grounded.points, {
          mouse: async (type, point, extra) => { await mouse(type, point, extra); this.cursor.show(point) },
          text: async value => { await sendIrreversible('Input.insertText', { text: value }) },
          verify, pause: ms => this.pause(ms, signal),
        })
      } else {
      const click = async (point: { x: number; y: number }, count = 1): Promise<void> => { await mouse('mousePressed', point, { button: 'left', clickCount: count }); await mouse('mouseReleased', point, { button: 'left', clickCount: count }) }
      const primaryPoint = prepared.primary ? await pointFor(prepared.primary, prepared.target) : undefined
      if ((operation.kind === 'click' || operation.kind === 'doubleClick') && primaryPoint) await click(primaryPoint, operation.kind === 'doubleClick' ? 2 : 1)
      else if (operation.kind === 'hover' && primaryPoint) await mouse('mouseMoved', primaryPoint)
      else if ((operation.kind === 'fill' || operation.kind === 'type') && primaryPoint) {
        if (!primaryPoint.focused) await click(primaryPoint)
        if (operation.kind === 'fill') { const modifier = process.platform === 'darwin' ? 4 : 2; await key('keyDown', 'a', modifier); await key('keyUp', 'a', modifier) }
        await sendIrreversible('Input.insertText', { text: operation.text })
      } else if (operation.kind === 'press') {
        if (primaryPoint && !primaryPoint.focused) await click(primaryPoint)
        await key('keyDown', operation.key, modifierMask(operation.modifiers)); await key('keyUp', operation.key, modifierMask(operation.modifiers))
      } else if (operation.kind === 'select' && primaryPoint) {
        if (operation.values.length !== 1) throw new BrowserAutomationError('UNSUPPORTED_PAGE', dispatched)
        await click(primaryPoint); await sendIrreversible('Input.insertText', { text: operation.values[0] }); await key('keyDown', 'Enter'); await key('keyUp', 'Enter')
      } else if ((operation.kind === 'check' || operation.kind === 'uncheck') && primaryPoint) {
        const desired = operation.kind === 'check'
        if (primaryPoint.checked === undefined) throw new BrowserAutomationError('TARGET_NOT_ACTIONABLE', dispatched)
        if (primaryPoint.checked !== desired) await click(primaryPoint)
      } else if (operation.kind === 'scroll') {
        const point = primaryPoint ?? { x: 1, y: 1 }; await mouse('mouseWheel', point, { deltaX: operation.deltaX, deltaY: operation.deltaY })
      } else if (operation.kind === 'drag' && primaryPoint && prepared.secondary && prepared.secondaryTarget) {
        await mouse('mouseMoved', primaryPoint); await mouse('mousePressed', primaryPoint, { button: 'left', clickCount: 1 })
        // A failed destination must use the owned-input cleanup below. Releasing
        // over the source would turn a failed drag into an activation click.
        const secondaryPoint = await pointFor(prepared.secondary, prepared.secondaryTarget)
        await mouse('mouseMoved', secondaryPoint, { button: 'left' }); await mouse('mouseReleased', secondaryPoint, { button: 'left', clickCount: 1 })
      } else throw new BrowserAutomationError('TARGET_NOT_ACTIONABLE', dispatched)
      }
      // CDP may deliver javascriptDialogOpening immediately after the Input
      // command resolves. Keep the owning broker request alive through that task
      // so disconnect/cancel remains the dialog's cancellation owner.
      await new Promise<void>((resolve) => setImmediate(resolve))
      const dialogBarrier = this.dialogBarrier; if (dialogBarrier) await dialogBarrier
      ensure('finish')
      const receiver = prepared.secondaryTarget ?? prepared.target
      const point = prepared.grounded?.points.at(-1)
      return { dispatched: true, rollbackPossible: false, ...(isPointerInteraction(operation) && (prepared.primary || prepared.grounded?.fingerprints.length) ? { receiver: { role: receiver.role, tag: receiver.tag, ...(point ? { point } : {}) } } : {}) }
    } catch (error) {
      throw asAutomationError(error)
    } finally {
      // Release only this operation's inputs, even after cancellation/navigation.
      // No text, activation retry or freshly resolved target is allowed here.
      if (stillCurrent(dispatched, 'cleanup') && this.transport.isAttached()) {
        // Releasing at the pressed control completes a native click, even with
        // clickCount:0 (real Electron regression). Release outside web content;
        // these are renderer-local CDP coordinates, never desktop coordinates.
        for (const params of heldButtons.values()) await this.transport.send('Input.dispatchMouseEvent', { ...params, x: -1, y: -1, buttons: 0, clickCount: 0 }).catch(() => {})
        if (signal.aborted || heldButtons.size || heldKeys.size) await this.cursor.hide()
        for (const params of [...heldKeys.values()].reverse()) await this.transport.send('Input.dispatchKeyEvent', params).catch(() => {})
      }
    }
  }
  async screenshot(lease: BrowserAutomationLease, target: BrowserElementRef | undefined, fullPage: boolean, signal: AbortSignal): Promise<BrowserBinaryAttachment> {
    abort(signal); await this.ensureAttached(); let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined
    let viewport: EffectiveBrowserViewport | undefined
    if (target) { const entry = this.resolve(lease, target); if (!entry.backendDOMNodeId) throw new Error('UNSUPPORTED_PAGE'); const box = await this.transport.send('DOM.getBoxModel', { backendNodeId: entry.backendDOMNodeId }); const border = (box['model'] as Record<string, unknown> | undefined)?.['border'] as number[] | undefined; if (!border || border.length !== 8) throw new Error('UNSUPPORTED_PAGE'); clip = { ...quadBounds(border), scale: 1 } }
    else {
      const metrics = await this.transport.send('Page.getLayoutMetrics')
      const size = (fullPage ? metrics['cssContentSize'] : (metrics['cssVisualViewport'] ?? metrics['cssLayoutViewport'] ?? metrics['cssContentSize'])) as Record<string, unknown> | undefined
      const width = typeof size?.['clientWidth'] === 'number' ? size['clientWidth'] : size?.['width']
      const height = typeof size?.['clientHeight'] === 'number' ? size['clientHeight'] : size?.['height']
      if (typeof width !== 'number' || typeof height !== 'number' || width < 1 || height < 1 || width > SCREENSHOT_MAX_DIMENSION || height > SCREENSHOT_MAX_DIMENSION) throw new Error('REQUEST_LIMIT')
      if (fullPage) clip = { x: 0, y: 0, width, height, scale: 1 }
      else { viewport = await this.effectiveViewport(signal); clip = { x: viewport.pageX, y: viewport.pageY, width: viewport.width, height: viewport.height, scale: 1 } }
    }
    if (clip && (clip.width < 1 || clip.height < 1 || clip.width > SCREENSHOT_MAX_DIMENSION || clip.height > SCREENSHOT_MAX_DIMENSION)) throw new Error('REQUEST_LIMIT')
    if (clip) clip.scale = this.captureScale(clip.width, clip.height)
    const restoreCursor = await this.cursor.suspend()
    let result: Record<string, unknown>
    try { result = await this.transport.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: fullPage, ...(clip ? { clip } : {}) }); abort(signal) }
    finally { if (!signal.aborted) restoreCursor() }
    if (typeof result['data'] !== 'string') throw new Error('INTERNAL_ERROR')
    const data = Buffer.from(result['data'], 'base64'); if (data.length > SCREENSHOT_MAX_BYTES) throw new Error('REQUEST_LIMIT')
    const dimensions = pngDimensions(data)
    if (!dimensions) throw new Error('INTERNAL_ERROR')
    if (dimensions.width > SCREENSHOT_MAX_DIMENSION || dimensions.height > SCREENSHOT_MAX_DIMENSION) throw new Error('REQUEST_LIMIT')
    if (viewport && !sameViewport(viewport, await this.effectiveViewport(signal))) throw new Error('STALE_GENERATION')
    const observation = viewport ? this.observations.issue({ ...lease, imageWidth: dimensions.width, imageHeight: dimensions.height, viewport, viewportRevision: this.viewportRevision }) : undefined
    return { mediaType: 'image/png', data, ...dimensions, ...(observation ? { observation } : {}) }
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
  reload(ignoreCache: boolean): { accepted: boolean } { this.invalidate(); return { accepted: this.controls.reload?.(ignoreCache) !== false } }
  history(direction: 'back' | 'forward'): { accepted: boolean } { this.invalidate(); return { accepted: this.controls.history?.(direction) !== false } }
  async setViewport(viewport: BrowserViewport, signal: AbortSignal): Promise<{ viewport: BrowserViewport }> { const size = parseBrowserViewport(viewport); if (!size) throw new Error('INVALID_REQUEST'); abort(signal); await this.ensureAttached(); const scale = viewport.deviceScaleFactor ?? 1; this.emulatedScaleFactor = Math.max(this.emulatedScaleFactor ?? this.controls.deviceScaleFactor?.() ?? 1, scale); await this.transport.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: scale, mobile: viewport.mobile ?? false, screenWidth: size.width, screenHeight: size.height }); this.emulatedScaleFactor = scale; abort(signal); this.invalidate(); return { viewport: { ...viewport, ...size } } }
}
