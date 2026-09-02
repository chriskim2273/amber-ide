import { describe, expect, it } from 'vitest'
import { BrowserAutomation, redactBrowserText, sanitizeBrowserUrl, type BrowserDebuggerTransport } from './browserAutomation'

class FakeDebugger implements BrowserDebuggerTransport {
  attached = false
  listeners: Array<(method: string, params: Record<string, unknown>) => void> = []
  calls: string[] = []
  attachCalls = 0
  async attach(): Promise<void> { this.attachCalls += 1; this.attached = true }
  detach(): void { this.attached = false }
  isAttached(): boolean { return this.attached }
  onMessage(listener: (method: string, params: Record<string, unknown>) => void): void { this.listeners.push(listener) }
  async send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push(method)
    if (method === 'DOM.performSearch') return { searchId: 'search-1', resultCount: 3 }
    if (method === 'DOM.getSearchResults') return { nodeIds: [101, 102, 103].slice(params?.['fromIndex'] as number, params?.['toIndex'] as number) }
    if (method === 'Accessibility.getPartialAXTree') {
      const nodeId = params?.['nodeId']
      if (nodeId === 101) return { nodes: [{ role: { value: 'RootWebArea' }, name: { value: 'Demo' }, backendDOMNodeId: 1 }] }
      if (nodeId === 102) return { nodes: [{ role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 2 }] }
      return { nodes: [{ role: { value: 'textbox' }, name: { value: 'Password' }, value: { value: 'hunter2' }, backendDOMNodeId: 3 }] }
    }
    if (method === 'DOM.pushNodesByBackendIdsToFrontend') return { nodeIds: [22] }
    if (method === 'DOM.describeNode' && params?.['nodeId'] === 101) return { node: { nodeName: 'HTML', backendNodeId: 1 } }
    if (method === 'DOM.describeNode' && params?.['nodeId'] === 102) return { node: { nodeName: 'BUTTON', parentId: 101, backendNodeId: 2 } }
    if (method === 'DOM.describeNode' && params?.['nodeId'] === 103) return { node: { nodeName: 'INPUT', parentId: 101, backendNodeId: 3 } }
    if (method === 'DOM.describeNode' && params?.['nodeId'] === 10) return { node: { nodeName: 'DIV', attributes: ['id', 'container', 'data-secret', 'never'] } }
    if (method === 'DOM.describeNode') return { node: { nodeName: 'BUTTON', parentId: 10, attributes: ['id', 'submit', 'value', 'secret', 'aria-label', 'Submit'] } }
    if (method === 'CSS.getComputedStyleForNode') return { computedStyle: [{ name: 'display', value: 'block' }, { name: 'background-image', value: 'url(https://secret.test/token)' }] }
    if (method === 'DOM.getBoxModel') return { model: { border: [0, 0, 100, 0, 100, 20, 0, 20] } }
    if (method === 'Page.captureScreenshot') {
      const png = Buffer.alloc(24); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png); png.write('IHDR', 12, 'ascii'); png.writeUInt32BE(800, 16); png.writeUInt32BE(600, 20)
      return { data: png.toString('base64') }
    }
    if (method === 'Page.getLayoutMetrics') return { cssContentSize: { x: 0, y: 0, width: 800, height: 600 } }
    return {}
  }
}

const lease = { browserId: 'browser-1', pageIncarnation: 'page-1', generation: 7 }

describe('browser automation', () => {
  it('creates accessibility-first bounded snapshots and scoped opaque references', async () => {
    const debuggerTransport = new FakeDebugger()
    const automation = new BrowserAutomation(debuggerTransport, () => 'https://example.test/path?token=secret#x', () => false)
    const snapshot = await automation.snapshot(lease, { maxDepth: 20, maxNodes: 2, maxBytes: 256 * 1024 }, new AbortController().signal)
    expect(snapshot.nodes).toHaveLength(2)
    expect(snapshot.truncated).toBe(true)
    expect(snapshot.url).toBe('https://example.test/path')
    expect(snapshot.nodes[1]).toMatchObject({ role: 'button', name: 'Submit' })
    expect(snapshot.nodes[1]?.ref).toMatch(/^n\d+$/)
    expect(JSON.stringify(snapshot)).not.toContain('hunter2')
  })

  it('never materializes a hostile full AX tree and stops incremental traversal at hard budgets', async () => {
    class HostileWideDebugger extends FakeDebugger {
      override async send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
        if (method === 'DOM.performSearch') { this.calls.push(method); return { searchId: 'wide', resultCount: 1_000_000 } }
        if (method === 'DOM.getSearchResults') { this.calls.push(method); return { nodeIds: Array.from({ length: 32 }, (_, index) => index + 1) } }
        if (method === 'DOM.describeNode') { this.calls.push(method); return { node: { nodeName: 'DIV', backendNodeId: params?.['nodeId'] } } }
        if (method === 'Accessibility.getPartialAXTree') { this.calls.push(method); return { nodes: [{ role: { value: 'button' }, name: { value: 'wide' }, backendDOMNodeId: params?.['nodeId'] }] } }
        return super.send(method, params)
      }
    }
    const transport = new HostileWideDebugger()
    const automation = new BrowserAutomation(transport, () => 'about:blank', () => false)
    const snapshot = await automation.snapshot(lease, { maxDepth: 20, maxNodes: 2, maxBytes: 4096 }, new AbortController().signal)
    expect(snapshot.nodes).toHaveLength(2)
    expect(snapshot.truncated).toBe(true)
    expect(transport.calls).not.toContain('Accessibility.getFullAXTree')
    expect(transport.calls.filter((method) => method === 'Accessibility.getPartialAXTree')).toHaveLength(2)

    class HostileTextDebugger extends HostileWideDebugger {
      override async send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
        if (method === 'Accessibility.getPartialAXTree') { this.calls.push(method); return { nodes: [{ role: { value: 'button' }, name: { value: 'x'.repeat(600_000) } }] } }
        return super.send(method, params)
      }
    }
    const textAutomation = new BrowserAutomation(new HostileTextDebugger(), () => 'about:blank', () => false)
    const textSnapshot = await textAutomation.snapshot(lease, { maxDepth: 20, maxNodes: 2, maxBytes: 4096 }, new AbortController().signal)
    expect(textSnapshot.nodes).toEqual([])
    expect(textSnapshot.truncated).toBe(true)
  })

  it('fails closed on references from another snapshot, generation, incarnation, or browser', async () => {
    const automation = new BrowserAutomation(new FakeDebugger(), () => 'about:blank', () => false)
    const snapshot = await automation.snapshot(lease, { maxDepth: 20, maxNodes: 20, maxBytes: 256 * 1024 }, new AbortController().signal)
    const target = { snapshotId: snapshot.snapshotId, ref: snapshot.nodes[1]!.ref }
    await expect(automation.inspect({ ...lease, generation: 8 }, target, new AbortController().signal)).rejects.toThrow('STALE_GENERATION')
    await expect(automation.inspect({ ...lease, pageIncarnation: 'page-2' }, target, new AbortController().signal)).rejects.toThrow('STALE_GENERATION')
    await expect(automation.inspect({ ...lease, browserId: 'browser-2' }, target, new AbortController().signal)).rejects.toThrow('STALE_GENERATION')
    await expect(automation.inspect(lease, { snapshotId: 'wrong', ref: target.ref }, new AbortController().signal)).rejects.toThrow('STALE_GENERATION')
  })

  it('allowlists inspection attributes and never returns form values', async () => {
    const automation = new BrowserAutomation(new FakeDebugger(), () => 'about:blank', () => false)
    const snapshot = await automation.snapshot(lease, { maxDepth: 20, maxNodes: 20, maxBytes: 256 * 1024 }, new AbortController().signal)
    const result = await automation.inspect(lease, { snapshotId: snapshot.snapshotId, ref: snapshot.nodes[1]!.ref }, new AbortController().signal)
    expect(result.attributes).toEqual({ id: 'submit', 'aria-label': 'Submit' })
    expect(result.computedStyle).toEqual({ display: 'block' })
    expect(result.ancestry).toEqual([{ tag: 'div', id: 'container' }])
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('returns screenshot bytes in memory and rejects oversized captures', async () => {
    const transport = new FakeDebugger()
    const automation = new BrowserAutomation(transport, () => 'about:blank', () => false)
    const image = await automation.screenshot(lease, undefined, false, new AbortController().signal)
    expect(image.data.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(image).toMatchObject({ width: 800, height: 600 })
    expect(image).not.toHaveProperty('path')
    transport.send = async (method) => { if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } }; const png = Buffer.alloc(24); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png); png.write('IHDR', 12, 'ascii'); png.writeUInt32BE(4097, 16); png.writeUInt32BE(600, 20); return { data: png.toString('base64') } }
    await expect(automation.screenshot(lease, undefined, false, new AbortController().signal)).rejects.toThrow('REQUEST_LIMIT')
    transport.send = async (method) => method === 'Page.getLayoutMetrics' ? { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } } : { data: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') }
    await expect(automation.screenshot(lease, undefined, false, new AbortController().signal)).rejects.toThrow('REQUEST_LIMIT')
  })

  it('bounds and redacts console/network rings with cursor loss reporting', async () => {
    const transport = new FakeDebugger()
    const automation = new BrowserAutomation(transport, () => 'about:blank', () => false, { ringItems: 2, ringBytes: 1024 })
    await automation.ensureAttached()
    for (const listener of transport.listeners) {
      listener('Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'Authorization: Bearer top-secret' }] })
      listener('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'cookie=session-secret' }] })
      listener('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'safe' }] })
      listener('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://user:pass@example.test/a?token=secret#hash', method: 'GET', headers: { Authorization: 'never' } }, type: 'XHR' })
      listener('Network.responseReceived', { requestId: 'r1', response: { status: 200, headers: { 'set-cookie': 'never' } } })
      listener('Network.loadingFinished', { requestId: 'r1' })
    }
    const consoleResult = automation.consoleSince(undefined, undefined, 20)
    expect(consoleResult.dropped).toBeGreaterThan(0)
    expect(JSON.stringify(consoleResult)).not.toMatch(/top-secret|session-secret/)
    const network = automation.networkSince(undefined, 20, false)
    expect(JSON.stringify(network)).toContain('https://example.test/a')
    expect(JSON.stringify(network)).not.toMatch(/user:pass|token=|Authorization|never/)
  })

  it('coalesces concurrent debugger setup onto one target-scoped attachment', async () => {
    const transport = new FakeDebugger()
    const automation = new BrowserAutomation(transport, () => 'about:blank', () => false)
    await Promise.all([automation.ensureAttached(), automation.ensureAttached()])
    expect(transport.attachCalls).toBe(1)
    expect(transport.listeners).toHaveLength(1)
  })

  it('reports cursor-relative ring gaps without double-counting prior evictions', async () => {
    const transport = new FakeDebugger()
    const automation = new BrowserAutomation(transport, () => 'about:blank', () => false, { ringItems: 2, ringBytes: 1024 })
    await automation.ensureAttached()
    const emit = (value: string) => transport.listeners.forEach((listener) => listener('Runtime.consoleAPICalled', { type: 'log', args: [{ value }] }))
    emit('one'); emit('two'); emit('three')
    expect(automation.consoleSince('0', undefined, 20)).toMatchObject({ dropped: 1, items: [{ message: 'two' }, { message: 'three' }] })
    expect(automation.consoleSince('1', undefined, 20)).toMatchObject({ dropped: 0, items: [{ message: 'two' }, { message: 'three' }] })
    const cursor = automation.consoleSince(undefined, undefined, 20).cursor
    emit('four')
    expect(automation.consoleSince(cursor, undefined, 20)).toMatchObject({ dropped: 0, items: [{ message: 'four' }] })

    const tinyTransport = new FakeDebugger()
    const tiny = new BrowserAutomation(tinyTransport, () => 'about:blank', () => false, { ringItems: 2, ringBytes: 100 })
    await tiny.ensureAttached()
    tinyTransport.listeners.at(-1)!('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'x'.repeat(1000) }] })
    expect(tiny.consoleSince('0', undefined, 20)).toMatchObject({ dropped: 1, items: [] })
  })

  it('uses only a fixed allowlist of debugger methods and supports cancellation', async () => {
    const transport = new FakeDebugger()
    const automation = new BrowserAutomation(transport, () => 'about:blank', () => false)
    const controller = new AbortController(); controller.abort()
    await expect(automation.snapshot(lease, { maxDepth: 20, maxNodes: 20, maxBytes: 4096 }, controller.signal)).rejects.toThrow('ACTION_CANCELLED')
    await automation.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 }, new AbortController().signal)
    expect(transport.calls).not.toContain('Runtime.evaluate')
    expect(transport.calls).not.toContain('Network.getResponseBody')
    expect(transport.calls).toContain('Emulation.setDeviceMetricsOverride')
    automation.dispose()
    expect(transport.attached).toBe(false)
    await expect(automation.snapshot(lease, { maxDepth: 1, maxNodes: 1, maxBytes: 1024 }, new AbortController().signal)).rejects.toThrow('PAGE_CLOSED')
  })
})

describe('browser output redaction', () => {
  it('removes URL credentials/query/fragments and common credential canaries', () => {
    expect(sanitizeBrowserUrl('https://u:p@example.test/a?token=abc#x')).toBe('https://example.test/a')
    expect(redactBrowserText('Authorization: Bearer abc Cookie: sid=secret password=hunter2')).not.toMatch(/abc|secret|hunter2/)
  })
})
