import { describe, expect, it, vi } from 'vitest'
import { BrowserAutomation, redactBrowserText, sanitizeBrowserUrl, type BrowserDebuggerTransport } from './browserAutomation'
import type { BrowserInteraction } from './browserToolProtocol'

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
    if (method === 'Page.getLayoutMetrics') return { cssContentSize: { x: 0, y: 0, width: 800, height: 600 }, cssVisualViewport: { clientWidth: 800, clientHeight: 600 } }
    if (method === 'DOM.getNodeForLocation') return { backendNodeId: 2 }
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

  it('keeps the DOM backend identity when the AX response reports a different backend id', async () => {
    class MismatchedBackendDebugger extends FakeDebugger {
      boxBackends: number[] = []
      override async send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
        if (method === 'Accessibility.getPartialAXTree' && params?.['nodeId'] === 102) {
          return { nodes: [{ role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 999 }] }
        }
        if (method === 'DOM.getBoxModel' && typeof params?.['backendNodeId'] === 'number') this.boxBackends.push(params['backendNodeId'])
        return super.send(method, params)
      }
    }
    const transport = new MismatchedBackendDebugger()
    const automation = new BrowserAutomation(transport, () => 'about:blank', () => false)
    const snapshot = await automation.snapshot(lease, { maxDepth: 20, maxNodes: 20, maxBytes: 256 * 1024 }, new AbortController().signal)
    await automation.inspect(lease, { snapshotId: snapshot.snapshotId, ref: snapshot.nodes[1]!.ref }, new AbortController().signal)
    expect(transport.boxBackends).toContain(2)
    expect(transport.boxBackends).not.toContain(999)
  })

  it('includes ordinary StaticText for snapshot and text wait without script, style, whitespace, hidden, or duplicate output', async () => {
    class TextPageDebugger extends FakeDebugger {
      query = ''
      override async send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
        this.calls.push(method)
        if (method === 'DOM.getDocument') return { root: { nodeId: 200, backendNodeId: 200, nodeName: '#document' } }
        if (method === 'DOM.performSearch') {
          this.query = String(params?.['query'] ?? '')
          return { searchId: 'text-page', resultCount: this.query.includes('//text()') ? 6 : 3 }
        }
        if (method === 'DOM.getSearchResults') return { nodeIds: [201, 202, 203, 204, 205, 206].slice(params?.['fromIndex'] as number, params?.['toIndex'] as number) }
        if (method === 'DOM.describeNode') {
          const nodeId = params?.['nodeId'] as number
          const nodes: Record<number, Record<string, unknown>> = {
            201: { nodeName: 'HTML', backendNodeId: 201 },
            202: { nodeName: 'BODY', parentId: 201, backendNodeId: 202 },
            203: { nodeName: 'P', parentId: 202, backendNodeId: 203 },
            204: { nodeName: '#text', parentId: 203, backendNodeId: 204, nodeValue: 'Ready' },
            205: { nodeName: '#text', parentId: 202, backendNodeId: 205, nodeValue: 'Hidden secret' },
            206: { nodeName: '#text', parentId: 203, backendNodeId: 204, nodeValue: 'Ready' },
          }
          return { node: nodes[nodeId] }
        }
        if (method === 'Accessibility.getPartialAXTree') {
          const nodeId = params?.['nodeId'] as number
          if (nodeId === 201) return { nodes: [{ nodeId: 'ax-root', role: { value: 'RootWebArea' }, name: { value: 'Fixture' }, backendDOMNodeId: 201 }] }
          if (nodeId === 202) return { nodes: [{ nodeId: 'ax-body', ignored: true }] }
          if (nodeId === 203) return { nodes: [{ nodeId: 'ax-p', role: { value: 'paragraph' }, name: { value: '' }, backendDOMNodeId: 203 }] }
          if (nodeId === 205) return { nodes: [{ nodeId: 'ax-hidden', ignored: true }] }
          return { nodes: [{ nodeId: 'ax-ready', role: { value: 'StaticText' }, name: { value: 'Ready' }, backendDOMNodeId: 204 }] }
        }
        if (method === 'DOM.discardSearchResults') return {}
        return super.send(method, params)
      }
    }
    const transport = new TextPageDebugger()
    const automation = new BrowserAutomation(transport, () => 'https://example.test/text', () => false)
    const snapshot = await automation.snapshot(lease, { maxDepth: 20, maxNodes: 20, maxBytes: 256 * 1024 }, new AbortController().signal)
    expect(snapshot.nodes.filter((node) => node.role === 'StaticText')).toEqual([expect.objectContaining({ name: 'Ready', depth: 3 })])
    expect(snapshot.nodes).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Hidden secret' })]))
    expect(transport.calls.indexOf('DOM.getDocument')).toBeGreaterThanOrEqual(0)
    expect(transport.calls.indexOf('DOM.getDocument')).toBeLessThan(transport.calls.indexOf('DOM.performSearch'))
    expect(transport.query).toContain('//text()')
    expect(transport.query).toContain('normalize-space(.)')
    expect(transport.query).toContain('ancestor::script')
    expect(transport.query).toContain('ancestor::style')
    await expect(automation.wait(lease, { kind: 'text', value: 'Ready' }, 500, new AbortController().signal)).resolves.toMatchObject({ matched: true })
  })

  it('never materializes a hostile full AX tree and stops incremental traversal at hard budgets', async () => {
    class HostileWideDebugger extends FakeDebugger {
      override async send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
        if (method === 'DOM.performSearch') { this.calls.push(method); return { searchId: 'wide', resultCount: 1_000_000 } }
        if (method === 'DOM.getSearchResults') { this.calls.push(method); return { nodeIds: Array.from({ length: 32 }, (_, index) => index + 1) } }
        if (method === 'DOM.describeNode') { this.calls.push(method); return { node: { nodeName: '#text', backendNodeId: params?.['nodeId'] } } }
        if (method === 'Accessibility.getPartialAXTree') { this.calls.push(method); return { nodes: [{ nodeId: `ax-${String(params?.['nodeId'])}`, role: { value: 'StaticText' }, name: { value: 'wide text' }, backendDOMNodeId: params?.['nodeId'] }] } }
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

    class HostileDocumentDebugger extends HostileWideDebugger {
      override async send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
        if (method === 'DOM.getDocument') { this.calls.push(method); return { root: { nodeName: '#document', attackerData: 'x'.repeat(600_000) } } }
        return super.send(method, params)
      }
    }
    const documentTransport = new HostileDocumentDebugger()
    const documentSnapshot = await new BrowserAutomation(documentTransport, () => 'about:blank', () => false).snapshot(lease, { maxDepth: 20, maxNodes: 2, maxBytes: 4096 }, new AbortController().signal)
    expect(documentSnapshot.nodes).toEqual([])
    expect(documentSnapshot.truncated).toBe(true)
    expect(documentTransport.calls).not.toContain('DOM.performSearch')

    class HostileDeepTextDebugger extends HostileWideDebugger {
      override async send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
        if (method === 'DOM.performSearch') { this.calls.push(method); return { searchId: 'deep-text', resultCount: 1_000_000 } }
        if (method === 'DOM.describeNode') {
          this.calls.push(method)
          const nodeId = params?.['nodeId'] as number
          return { node: { nodeName: '#text', ...(nodeId === 1 ? {} : { parentId: nodeId - 1 }), backendNodeId: nodeId } }
        }
        return super.send(method, params)
      }
    }
    const deepTransport = new HostileDeepTextDebugger()
    const deepSnapshot = await new BrowserAutomation(deepTransport, () => 'about:blank', () => false).snapshot(lease, { maxDepth: 2, maxNodes: 5, maxBytes: 4096 }, new AbortController().signal)
    expect(deepSnapshot.nodes).toHaveLength(3)
    expect(deepSnapshot.truncated).toBe(true)
    expect(deepTransport.calls.filter((method) => method === 'DOM.describeNode')).toHaveLength(5)
    expect(deepTransport.calls.filter((method) => method === 'Accessibility.getPartialAXTree')).toHaveLength(3)
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

  it('revalidates actionability and semantic fingerprints before fixed Input-domain interactions', async () => {
    class InteractionDebugger extends FakeDebugger {
      changed = false
      occluded = false
      offscreen = false
      descendantHit = false
      formChanged = false
      override async send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
        this.calls.push(method)
        if (method === 'DOM.getDocument') return { root: { nodeId: 300, nodeName: '#document' } }
        if (method === 'DOM.performSearch') return { searchId: 'interaction', resultCount: 4 }
        if (method === 'DOM.getSearchResults') return { nodeIds: [301, 302, 303, 304] }
        if (method === 'DOM.describeNode') { const id = params?.['nodeId'] ?? params?.['backendNodeId']; if (id === 300) return { node: { nodeName: 'FORM', backendNodeId: 300, attributes: ['action', this.formChanged ? '/profile/delete' : '/profile/save', 'method', 'post'] } }; if (id === 999) return { node: { nodeName: 'SPAN', parentId: 777, backendNodeId: 999 } }; if (id === 777) return { node: { nodeName: 'INPUT', parentId: 300, backendNodeId: 301, attributes: ['type', 'text'] } }; return { node: { nodeName: id === 302 ? 'BUTTON' : id === 304 ? 'SELECT' : 'INPUT', parentId: 300, backendNodeId: id, attributes: ['type', id === 302 ? 'button' : id === 303 ? 'checkbox' : 'text'] } } }
        if (method === 'Accessibility.getPartialAXTree') {
          const id = params?.['nodeId'] ?? params?.['backendDOMNodeId']; const button = id === 302, checkbox = id === 303, select = id === 304
          return { nodes: [{ nodeId: `ax-${id}`, role: { value: button ? 'button' : checkbox ? 'checkbox' : select ? 'combobox' : 'textbox' }, name: { value: this.changed ? 'Changed' : button ? 'Drop target' : checkbox ? 'Remember me' : select ? 'Country' : 'Search' }, backendDOMNodeId: id, properties: [{ name: 'checked', value: { value: false } }] }] }
        }
        if (method === 'DOM.pushNodesByBackendIdsToFrontend') return { nodeIds: [42] }
        if (method === 'CSS.getComputedStyleForNode') return { computedStyle: [{ name: 'display', value: 'block' }, { name: 'visibility', value: 'visible' }, { name: 'opacity', value: '1' }, { name: 'pointer-events', value: 'auto' }] }
        if (method === 'DOM.getBoxModel') { const id = params?.['backendNodeId']; const x = this.offscreen ? 900 : id === 302 ? 100 : id === 303 ? 200 : id === 304 ? 300 : 0; return { model: { border: [x, 0, x + 80, 0, x + 80, 20, x, 20] } } }
        if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } }
        if (method === 'DOM.getNodeForLocation') { const x = Number(params?.['x']); return { backendNodeId: this.occluded ? 998 : this.descendantHit ? 999 : x >= 300 ? 304 : x >= 200 ? 303 : x >= 100 ? 302 : 301 } }
        return {}
      }
    }
    const transport = new InteractionDebugger(), automation = new BrowserAutomation(transport, () => 'https://example.test/form', () => false)
    const snapshot = await automation.snapshot(lease, { maxDepth: 20, maxNodes: 20, maxBytes: 256 * 1024 }, new AbortController().signal)
    const input = { snapshotId: snapshot.snapshotId, role: 'textbox', name: 'Search' }, button = { snapshotId: snapshot.snapshotId, ref: 'n2' }, checkbox = { snapshotId: snapshot.snapshotId, ref: 'n3' }, select = { snapshotId: snapshot.snapshotId, ref: 'n4' }
    for (const operation of [
      { kind: 'click', target: input }, { kind: 'doubleClick', target: input }, { kind: 'hover', target: input },
      { kind: 'fill', target: input, text: 'hello' }, { kind: 'type', target: input, text: 'x' }, { kind: 'press', target: input, key: 'Enter' },
      { kind: 'select', target: select, values: ['Canada'] }, { kind: 'check', target: checkbox }, { kind: 'uncheck', target: checkbox },
      { kind: 'scroll', target: input, deltaX: 0, deltaY: 10 }, { kind: 'drag', source: input, target: button },
    ] as BrowserInteraction[]) {
      const prepared = await automation.prepareInteraction(lease, operation, new AbortController().signal)
      expect(prepared.target).toMatchObject({ formAction: '/profile/save', formMethod: 'post' })
      await expect(automation.executeInteraction(prepared, new AbortController().signal)).resolves.toEqual({ dispatched: true, rollbackPossible: false })
    }
    expect(transport.calls).toContain('Input.dispatchMouseEvent')
    expect(transport.calls).toContain('Input.dispatchKeyEvent')
    expect(transport.calls).toContain('Input.insertText')
    transport.descendantHit = true
    await expect(automation.executeInteraction(await automation.prepareInteraction(lease, { kind: 'click', target: input }, new AbortController().signal), new AbortController().signal)).resolves.toMatchObject({ dispatched: true })
    transport.descendantHit = false; transport.occluded = true
    const prepared = await automation.prepareInteraction(lease, { kind: 'click', target: input }, new AbortController().signal)
    const dispatches = transport.calls.filter((call) => call === 'Input.dispatchMouseEvent').length
    await expect(automation.executeInteraction(prepared, new AbortController().signal)).rejects.toThrow('TARGET_OCCLUDED')
    expect(transport.calls.filter((call) => call === 'Input.dispatchMouseEvent')).toHaveLength(dispatches)
    transport.occluded = false; transport.offscreen = true
    await expect(automation.executeInteraction(prepared, new AbortController().signal)).rejects.toThrow('TARGET_NOT_ACTIONABLE')
    transport.offscreen = false; transport.formChanged = true
    await expect(automation.executeInteraction(prepared, new AbortController().signal)).rejects.toThrow('STALE_GENERATION')
    transport.formChanged = false; transport.changed = true
    await expect(automation.prepareInteraction(lease, { kind: 'click', target: input }, new AbortController().signal)).rejects.toThrow('STALE_GENERATION')
  })

  it('keeps the dispatched interaction pending until its browser dialog is handled', async () => {
    let decide!: (decision: { accept: boolean }) => void
    const decision = new Promise<{ accept: boolean }>((resolve) => { decide = resolve })
    class DialogInteractionDebugger extends FakeDebugger {
      override async send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
        if (method === 'DOM.describeNode' && params?.['backendNodeId'] === 2) return { node: { nodeName: 'BUTTON', parentId: 101, backendNodeId: 2 } }
        if (method === 'Accessibility.getPartialAXTree' && params?.['backendDOMNodeId'] === 2) return { nodes: [{ role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 2 }] }
        if (method === 'DOM.pushNodesByBackendIdsToFrontend') return { nodeIds: [22] }
        if (method === 'Input.dispatchMouseEvent' && params?.['type'] === 'mouseReleased') this.listeners.forEach((listener) => listener('Page.javascriptDialogOpening', { type: 'confirm', message: 'Continue?' }))
        return super.send(method, params)
      }
    }
    const transport = new DialogInteractionDebugger(), automation = new BrowserAutomation(transport, () => 'about:blank', () => false, {}, { dialog: () => decision })
    const snapshot = await automation.snapshot(lease, { maxDepth: 20, maxNodes: 20, maxBytes: 256 * 1024 }, new AbortController().signal)
    const prepared = await automation.prepareInteraction(lease, { kind: 'click', target: { snapshotId: snapshot.snapshotId, ref: 'n2' } }, new AbortController().signal)
    let settled = false
    const execution = automation.executeInteraction(prepared, new AbortController().signal).finally(() => { settled = true })
    await vi.waitFor(() => expect(transport.calls).toContain('Input.dispatchMouseEvent'))
    await new Promise((resolve) => setImmediate(resolve)); expect(settled).toBe(false)
    decide({ accept: false })
    await expect(execution).resolves.toMatchObject({ dispatched: true })
    expect(transport.calls).toContain('Page.handleJavaScriptDialog')
  })

  it('reports cancellation after dispatch as no-rollback truth', async () => {
    const controller = new AbortController()
    class CancellingDebugger extends FakeDebugger {
      override async send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
        if (method === 'DOM.describeNode' && params?.['backendNodeId'] === 2) return { node: { nodeName: 'BUTTON', parentId: 101, backendNodeId: 2 } }
        if (method === 'Accessibility.getPartialAXTree' && params?.['backendDOMNodeId'] === 2) return { nodes: [{ role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 2 }] }
        if (method === 'DOM.pushNodesByBackendIdsToFrontend') return { nodeIds: [22] }
        if (method === 'Input.dispatchMouseEvent') { controller.abort(); return {} }
        return super.send(method, params)
      }
    }
    const transport = new CancellingDebugger(), automation = new BrowserAutomation(transport, () => 'about:blank', () => false)
    const snapshot = await automation.snapshot(lease, { maxDepth: 20, maxNodes: 20, maxBytes: 256 * 1024 }, new AbortController().signal)
    const prepared = await automation.prepareInteraction(lease, { kind: 'click', target: { snapshotId: snapshot.snapshotId, ref: 'n2' } }, new AbortController().signal)
    await expect(automation.executeInteraction(prepared, controller.signal)).rejects.toThrow('ACTION_CANCELLED_NO_ROLLBACK')
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

  it('batches diagnostics events instead of emitting one update per console/network event', async () => {
    vi.useFakeTimers()
    try {
      const transport = new FakeDebugger(), diagnostics = vi.fn()
      const automation = new BrowserAutomation(transport, () => 'about:blank', () => false, {}, { onDiagnostics: diagnostics })
      await automation.ensureAttached()
      const emit = transport.listeners[0]!
      for (let index = 0; index < 20; index++) emit('Runtime.consoleAPICalled', { type: 'warning', args: [{ value: `warning ${index}` }] })
      emit('Network.requestWillBeSent', { requestId: 'failed', request: { url: 'https://example.test', method: 'GET' }, type: 'XHR' })
      emit('Network.loadingFailed', { requestId: 'failed', errorText: 'failed' })
      expect(diagnostics).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(250)
      expect(diagnostics).toHaveBeenCalledOnce()
      expect(diagnostics).toHaveBeenCalledWith({ consoleIssues: 20, networkFailures: 1 })
      automation.dispose()
    } finally { vi.useRealTimers() }
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

  it('waits for a browser-scoped dialog decision and reports only bounded redacted metadata', async () => {
    let handled: Record<string, unknown> | undefined
    class DialogDebugger extends FakeDebugger { override async send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> { if (method === 'Page.handleJavaScriptDialog') handled = params; return super.send(method, params) } }
    const transport = new DialogDebugger(), dialog = vi.fn(async (_dialog: { type: string; message: string }) => ({ accept: true, promptText: 'bounded response' }))
    const automation = new BrowserAutomation(transport, () => 'about:blank', () => false, {}, { dialog })
    await automation.ensureAttached()
    transport.listeners[0]!('Page.javascriptDialogOpening', { type: 'confirm', message: `token=secret ${'x'.repeat(5000)}` })
    await vi.waitFor(() => expect(transport.calls).toContain('Page.handleJavaScriptDialog'))
    expect(dialog).toHaveBeenCalledWith({ type: 'confirm', message: expect.not.stringContaining('secret') })
    expect(handled).toEqual({ accept: true, promptText: 'bounded response' })
    expect((dialog.mock.calls[0]?.[0] as { message: string }).message.length).toBeLessThanOrEqual(1024)
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
