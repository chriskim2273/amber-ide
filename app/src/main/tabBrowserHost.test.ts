import { describe, expect, it, vi } from 'vitest'
import { TabBrowserHost, type TabBrowserPage, type TabBrowserPageEvent, type TabBrowserPageFactory } from './tabBrowserHost'
import { emptyBrowserState, parseBrowserState } from '../shared/tabBrowserState'
import { BrowserAutomationError } from './browserErrors'
import { BrowserAutomation, type BrowserDebuggerTransport } from './browserAutomation'
import { createInputEventHandlers } from './electronTabBrowserPage'

class FakePage implements TabBrowserPage {
  url = 'about:blank'; destroyed = false; visible = false; stopped = false
  automation?: BrowserAutomation
  async loadURL(url: string) { this.url = url }
  show() { this.visible = true }
  hide() { this.visible = false }
  stop() { this.stopped = true }
  destroy() { this.destroyed = true }
}

const userInputs = new Map<string, () => void>()
const pageEvents = new Map<string, (event: TabBrowserPageEvent) => void>()
const pagePolicies = new Map<string, (url: string) => boolean>()
const factory: TabBrowserPageFactory = { create: (id, onUserInput, onPageEvent, allowNavigation) => { userInputs.set(id, onUserInput); pageEvents.set(id, onPageEvent); pagePolicies.set(id, allowNavigation); return new FakePage() } }

describe('TabBrowserHost', () => {
  it('normalizes persisted live records to frozen until a renderer is recreated', () => {
    const state = emptyBrowserState(1)
    state.records['browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'] = {
      id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', profileId: 'global', mode: 'browse', safeRestoreUrl: 'https://example.test/', title: '',
      viewport: { width: 800, height: 600 }, lifecycle: 'live', stateRevision: 1, lastUsedAt: 1, lastFocusedAt: 1,
    }
    const host = new TabBrowserHost(state, factory)
    expect(host.status('browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').lifecycle).toBe('frozen')
  })

  it('reports the final generation when input overlaps a dispatched interaction', async () => {
    const host = new TabBrowserHost(emptyBrowserState(1), factory)
    const opened = await host.open({ visible: true })
    const page = opened.page as FakePage
    const target = { role: 'button', name: 'Open', tag: 'button', type: 'button', fingerprint: 'fingerprint' }
    page.automation = {
      invalidate: vi.fn(),
      prepareInteraction: vi.fn(async () => ({ lease: { browserId: opened.status.id, pageIncarnation: opened.status.pageIncarnation, generation: opened.status.generation }, operation: { kind: 'click', target: { snapshotId: 'snapshot', ref: 'n1' } }, target })),
      executeInteraction: vi.fn(async () => { expect(host.status(opened.status.id).generation).toBe(1); userInputs.get(opened.status.id)!(); return { dispatched: true, rollbackPossible: false } }),
    } as unknown as BrowserAutomation
    const before = opened.status.generation
    const result = await host.runAutomation(opened.status.id, { type: 'interact', pageIncarnation: opened.status.pageIncarnation, expectedGeneration: before, operation: { kind: 'click', target: { snapshotId: 'snapshot', ref: 'n1' } } }, new AbortController().signal)
    expect(result).toMatchObject({ dispatched: true, generation: before + 2, pageIncarnation: opened.status.pageIncarnation, interleaved: true })
  })

  it('keeps drag and multi-dispatch typing successful while Electron callbacks advance generation', async () => {
    let host!: TabBrowserHost
    const observedGenerations: number[] = []
    class InputDebugger implements BrowserDebuggerTransport {
      private attached = false
      private readonly handlers
      constructor(onUserInput: () => void) {
        this.handlers = createInputEventHandlers(onUserInput, () => {})
      }
      isAttached(): boolean { return this.attached }
      attach(): void { this.attached = true }
      onMessage(): void {}
      async send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
        const preventable = { preventDefault: () => {} }
        if (method === 'Input.dispatchMouseEvent') {
          this.handlers.beforeMouseEvent(preventable, params as never)
          return {}
        }
        if (method === 'Input.dispatchKeyEvent' || method === 'Input.insertText') {
          this.handlers.beforeInputEvent(preventable, {
            type: String(params['type'] ?? 'keyDown'), key: String(params['key'] ?? params['text'] ?? ''), code: String(params['code'] ?? ''),
            isAutoRepeat: false, isComposing: false, shift: false, control: false, alt: false, meta: false, location: 0, modifiers: [],
          })
          return {}
        }
        if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
        if (method === 'DOM.performSearch') return { searchId: 'search', resultCount: 1 }
        if (method === 'DOM.getSearchResults') return { nodeIds: [2] }
        if (method === 'DOM.describeNode') return { node: { nodeName: 'INPUT', backendNodeId: 2, attributes: ['type', 'text'] } }
        if (method === 'Accessibility.getPartialAXTree') return { nodes: [{ nodeId: 'ax-input', role: { value: 'textbox' }, name: { value: 'Editor' }, backendDOMNodeId: 2 }] }
        if (method === 'DOM.pushNodesByBackendIdsToFrontend') return { nodeIds: [22] }
        if (method === 'CSS.getComputedStyleForNode') return { computedStyle: [{ name: 'display', value: 'block' }, { name: 'visibility', value: 'visible' }, { name: 'opacity', value: '1' }, { name: 'pointer-events', value: 'auto' }] }
        if (method === 'DOM.getBoxModel') return { model: { border: [10, 10, 110, 10, 110, 30, 10, 30] } }
        if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } }
        if (method === 'DOM.getNodeForLocation') return { backendNodeId: 2 }
        return {}
      }
    }
    const factory: TabBrowserPageFactory = {
      create: (id, onUserInput) => {
        const transport = new InputDebugger(() => { observedGenerations.push(host.status(id).generation); onUserInput() })
        const automation = new BrowserAutomation(transport, () => 'about:blank', () => false)
        return Object.assign(new FakePage(), { automation })
      },
    }
    host = new TabBrowserHost(emptyBrowserState(1), factory)
    const opened = await host.open({ visible: true }), id = opened.status.id
    const snapshot = async (): Promise<{ snapshotId: string; ref: string }> => {
      const status = host.status(id)
      const result = await host.runAutomation(id, { type: 'snapshot', pageIncarnation: status.pageIncarnation, expectedGeneration: status.generation, limits: { maxDepth: 20, maxNodes: 20, maxBytes: 4096 } }, new AbortController().signal) as { snapshotId: string; nodes: Array<{ ref: string }> }
      return { snapshotId: result.snapshotId, ref: result.nodes[0]!.ref }
    }
    const runInteraction = async (operation: { kind: 'drag'; source: { snapshotId: string; ref: string }; target: { snapshotId: string; ref: string } } | { kind: 'type' | 'fill'; target: { snapshotId: string; ref: string }; text: string }) => {
      const status = host.status(id)
      return await host.runAutomation(id, { type: 'interact', pageIncarnation: status.pageIncarnation, expectedGeneration: status.generation, operation }, new AbortController().signal) as { generation: number; pageIncarnation: string; interleaved: boolean }
    }

    let target = await snapshot(), status = host.status(id), dragStart = status.generation
    const dragResult = await runInteraction({ kind: 'drag', source: target, target })
    expect(observedGenerations).toEqual([dragStart + 1, dragStart + 2, dragStart + 3, dragStart + 4])
    expect(dragResult).toMatchObject({ generation: dragStart + 5, pageIncarnation: status.pageIncarnation, interleaved: true })

    target = await snapshot(); status = host.status(id); const typeStart = status.generation
    observedGenerations.length = 0
    const typeResult = await runInteraction({ kind: 'type', target, text: 'multi-key type' })
    expect(observedGenerations).toEqual([typeStart + 1, typeStart + 2, typeStart + 3])
    expect(typeResult).toMatchObject({ generation: typeStart + 4, pageIncarnation: status.pageIncarnation, interleaved: true })

    target = await snapshot(); status = host.status(id); const fillStart = status.generation
    observedGenerations.length = 0
    const fillResult = await runInteraction({ kind: 'fill', target, text: 'multi-dispatch fill' })
    expect(observedGenerations).toEqual([fillStart + 1, fillStart + 2, fillStart + 3, fillStart + 4, fillStart + 5])
    expect(fillResult).toMatchObject({ generation: fillStart + 6, pageIncarnation: status.pageIncarnation, interleaved: true })
  })

  it('keeps a late callback from a prior action as a new generation during the next FIFO action', async () => {
    const host = new TabBrowserHost(emptyBrowserState(1), factory)
    const opened = await host.open({ visible: true })
    let releaseSecond!: () => void; let calls = 0
    const target = { role: 'button', name: 'Open', tag: 'button', type: 'button', fingerprint: 'fingerprint' }
    const executeInteraction = vi.fn(async () => {
      calls += 1
      if (calls === 2) await new Promise<void>((resolve) => { releaseSecond = resolve })
      return { dispatched: true, rollbackPossible: false }
    })
    const page = opened.page as FakePage
    page.automation = {
      invalidate: vi.fn(),
      prepareInteraction: vi.fn(async () => ({ lease: { browserId: opened.status.id, pageIncarnation: opened.status.pageIncarnation, generation: host.status(opened.status.id).generation }, operation: { kind: 'click', target: { snapshotId: 'snapshot', ref: 'n1' } }, target })),
      executeInteraction,
    } as unknown as BrowserAutomation
    const action = (): { type: 'interact'; pageIncarnation: string; expectedGeneration: number; operation: { kind: 'click'; target: { snapshotId: string; ref: string } } } => ({ type: 'interact', pageIncarnation: host.status(opened.status.id).pageIncarnation, expectedGeneration: host.status(opened.status.id).generation, operation: { kind: 'click', target: { snapshotId: 'snapshot', ref: 'n1' } } })
    const first = await host.runAutomation(opened.status.id, action(), new AbortController().signal)
    const second = host.runAutomation(opened.status.id, action(), new AbortController().signal)
    await vi.waitFor(() => expect(releaseSecond).toBeTypeOf('function'))
    // This callback could be a delayed CDP event from the first action. It is
    // still input, so it advances the generation independently of the second.
    userInputs.get(opened.status.id)!()
    releaseSecond()
    await expect(second).resolves.toMatchObject({ dispatched: true, generation: (first as { generation: number }).generation + 2, interleaved: true })
  })

  it('converts a typed adapter failure after the first accepted input to a stable no-rollback error', async () => {
    const host = new TabBrowserHost(emptyBrowserState(1), factory)
    const opened = await host.open({ visible: true }), page = opened.page as FakePage
    const target = { role: 'button', name: 'Open', tag: 'button', type: 'button', fingerprint: 'fingerprint' }
    page.automation = {
      invalidate: vi.fn(),
      prepareInteraction: vi.fn(async () => ({ lease: { browserId: opened.status.id, pageIncarnation: opened.status.pageIncarnation, generation: opened.status.generation }, operation: { kind: 'click', target: { snapshotId: 'snapshot', ref: 'n1' } }, target })),
      executeInteraction: vi.fn(async () => {
        userInputs.get(opened.status.id)!()
        throw new BrowserAutomationError('ACTION_CANCELLED', true)
      }),
    } as unknown as BrowserAutomation
    const error = await host.runAutomation(opened.status.id, { type: 'interact', pageIncarnation: opened.status.pageIncarnation, expectedGeneration: 0, operation: { kind: 'click', target: { snapshotId: 'snapshot', ref: 'n1' } } }, new AbortController().signal).catch((value: unknown) => value)
    expect(error).toMatchObject({ code: 'ACTION_FAILED_NO_ROLLBACK', retryable: false, dispatched: true, snapshotHint: true, pageIncarnation: opened.status.pageIncarnation, generation: 2 })
    expect((error as Error).message).toContain('fresh browser snapshot')
  })

  it('reports the current identity and generation when a dispatched interaction loses its page', async () => {
    const host = new TabBrowserHost(emptyBrowserState(1), factory)
    const opened = await host.open({ visible: true }), page = opened.page as FakePage
    const target = { role: 'button', name: 'Open', tag: 'button', type: 'button', fingerprint: 'fingerprint' }
    page.automation = {
      invalidate: vi.fn(),
      prepareInteraction: vi.fn(async () => ({ lease: { browserId: opened.status.id, pageIncarnation: opened.status.pageIncarnation, generation: opened.status.generation }, operation: { kind: 'click', target: { snapshotId: 'snapshot', ref: 'n1' } }, target })),
      executeInteraction: vi.fn(async () => {
        userInputs.get(opened.status.id)!()
        pageEvents.get(opened.status.id)!({ type: 'crashed', reason: 'test' })
        throw new BrowserAutomationError('PAGE_CLOSED', true)
      }),
    } as unknown as BrowserAutomation
    const error = await host.runAutomation(opened.status.id, { type: 'interact', pageIncarnation: opened.status.pageIncarnation, expectedGeneration: 0, operation: { kind: 'click', target: { snapshotId: 'snapshot', ref: 'n1' } } }, new AbortController().signal).catch((value: unknown) => value)
    expect(error).toMatchObject({ code: 'ACTION_FAILED_NO_ROLLBACK', retryable: false, dispatched: true, generation: 3, pageIncarnation: opened.status.pageIncarnation })
  })

  it('rechecks generation after approval before dispatching a consequential interaction', async () => {
    const host = new TabBrowserHost(emptyBrowserState(1), factory)
    const opened = await host.open({ visible: true }), page = opened.page as FakePage
    const target = { role: 'button', name: 'Delete account', tag: 'button', type: 'submit', fingerprint: 'fingerprint' }
    const executeInteraction = vi.fn()
    page.automation = {
      invalidate: vi.fn(),
      prepareInteraction: vi.fn(async () => ({ lease: { browserId: opened.status.id, pageIncarnation: opened.status.pageIncarnation, generation: opened.status.generation }, operation: { kind: 'click', target: { snapshotId: 'snapshot', ref: 'n1' } }, target })),
      executeInteraction,
    } as unknown as BrowserAutomation
    const approval = vi.fn(async () => { userInputs.get(opened.status.id)!() })
    await expect(host.runAutomation(opened.status.id, { type: 'interact', pageIncarnation: opened.status.pageIncarnation, expectedGeneration: 0, operation: { kind: 'click', target: { snapshotId: 'snapshot', ref: 'n1' } } }, new AbortController().signal, approval)).rejects.toThrow('STALE_GENERATION')
    expect(executeInteraction).not.toHaveBeenCalled()
    expect(host.status(opened.status.id).generation).toBe(1)
  })

  it('creates visibly before navigation and advances generation', async () => {
    const host = new TabBrowserHost(emptyBrowserState(1), factory, () => 10, () => new Uint8Array(16).fill(2))
    const opened = await host.open({ visible: true })
    expect((opened.page as FakePage).visible).toBe(true)
    expect((opened.page as FakePage).url).toBe('about:blank')
    const before = opened.status.generation
    await host.navigate(opened.status.id, 'https://example.test/a?secret=x', opened.status.pageIncarnation, before)
    expect((opened.page as FakePage).url).toBe('https://example.test/a?secret=x')
    expect(host.status(opened.status.id).generation).toBe(before + 1)
    expect(host.status(opened.status.id).safeRestoreUrl).toBe('https://example.test/a')
  })

  it('projects bounded user-only URL, focus, diagnostics, mode, and thaw state through host events', async () => {
    const events: unknown[] = [], host = new TabBrowserHost(emptyBrowserState(1), factory, Date.now, undefined, () => {}, (event) => events.push(event))
    const opened = await host.open({ visible: true })
    pageEvents.get(opened.status.id)!({ type: 'navigation-committed', url: 'https://example.test/private?token=secret#part' })
    pageEvents.get(opened.status.id)!({ type: 'focus', focused: true })
    pageEvents.get(opened.status.id)!({ type: 'diagnostics', consoleIssues: 3, networkFailures: 2 })
    host.setMode(opened.status.id, 'preview')
    expect(host.status(opened.status.id)).toMatchObject({
      currentUrl: 'https://example.test/private?token=secret#part', safeRestoreUrl: 'https://example.test/private',
      focused: true, diagnostics: { consoleIssues: 3, networkFailures: 2 }, mode: 'preview', visible: true,
    })
    expect(events.filter((event) => (event as { type?: string }).type === 'runtime').length).toBeGreaterThanOrEqual(3)
    host.freeze(opened.status.id)
    const thawed = await host.thaw(opened.status.id)
    expect(thawed).toMatchObject({ lifecycle: 'live', restoredAfterFreeze: true, currentUrl: 'https://example.test/private' })
  })

  it('projects bounded main-frame in-page navigation and persists its safe restore URL', async () => {
    const changes = vi.fn(), host = new TabBrowserHost(emptyBrowserState(1), factory, () => 50, undefined, changes)
    const opened = await host.open({ visible: true }); const before = opened.status.generation
    pageEvents.get(opened.status.id)!({ type: 'navigation-in-page', url: 'https://example.test/app/next?token=secret#section' })
    expect(host.status(opened.status.id)).toMatchObject({ currentUrl: 'https://example.test/app/next?token=secret#section', safeRestoreUrl: 'https://example.test/app/next', generation: before + 1 })
    expect(changes).toHaveBeenCalled()
  })

  it('enforces Preview policy for user selections, broker requests, redirects, and mode changes', async () => {
    const host = new TabBrowserHost(emptyBrowserState(1), factory)
    const opened = await host.open({ visible: true }); const id = opened.status.id
    host.setMode(id, 'preview')
    await expect(host.navigate(id, 'https://dev.example/app', host.status(id).pageIncarnation, host.status(id).generation, undefined, 'broker')).rejects.toThrow('NAVIGATION_BLOCKED')
    await host.navigate(id, 'https://dev.example/app', host.status(id).pageIncarnation, host.status(id).generation, undefined, 'user')
    expect(host.snapshot().records[id]?.previewOrigins).toEqual(['https://dev.example'])
    const beforeSpa = host.status(id).generation
    pageEvents.get(id)!({ type: 'navigation-in-page', url: 'https://dev.example/spa?secret=1#route' })
    expect(host.status(id)).toMatchObject({ generation: beforeSpa + 1, currentUrl: 'https://dev.example/spa?secret=1#route', safeRestoreUrl: 'https://dev.example/spa' })
    expect(pagePolicies.get(id)!('https://dev.example/redirected')).toBe(true)
    expect(pagePolicies.get(id)!('https://other.example/redirected')).toBe(false)
    expect(pagePolicies.get(id)!('http://localhost:4000/path')).toBe(true)
    host.setMode(id, 'browse')
    expect(pagePolicies.get(id)!('https://other.example/path')).toBe(true)
    host.setMode(id, 'preview')
    expect(() => host.setMode(id, 'browse', 'broker')).toThrow('NAVIGATION_BLOCKED')
    expect(pagePolicies.get(id)!('https://dev.example/path')).toBe(true)
    expect(pagePolicies.get(id)!('https://other.example/path')).toBe(false)
    pageEvents.get(id)!({ type: 'navigation-committed', url: 'https://other.example/escaped' })
    expect(host.status(id)).toMatchObject({ lifecycle: 'frozen', safeRestoreUrl: 'https://dev.example/spa', restoreError: 'Navigation blocked by browser mode' })
  })

  it('projects a dialog with an exact response channel and invalidates page generation', async () => {
    const events: unknown[] = [], host = new TabBrowserHost(emptyBrowserState(1), factory, Date.now, undefined, () => {}, (event) => events.push(event))
    const opened = await host.open({ visible: true }); const respond = vi.fn()
    pageEvents.get(opened.status.id)!({ type: 'dialog', dialogType: 'confirm', message: 'Continue?', respond })
    const event = events.find((candidate) => (candidate as { type?: string }).type === 'dialog-request')
    expect(event).toMatchObject({ type: 'dialog-request', id: opened.status.id, dialogType: 'confirm', message: 'Continue?', generation: 1, respond })
    expect(host.status(opened.status.id).generation).toBe(1)
  })

  it('rejects stale mutations, including after physical user input', async () => {
    const host = new TabBrowserHost(emptyBrowserState(1), factory)
    const opened = await host.open({ visible: true })
    await expect(host.navigate(opened.status.id, 'https://example.test', 'stale', 0)).rejects.toThrow('STALE_GENERATION')
    expect(() => host.stop(opened.status.id, 'stale', 0)).toThrow('STALE_GENERATION')
    userInputs.get(opened.status.id)!()
    await expect(host.navigate(opened.status.id, 'https://example.test', opened.status.pageIncarnation, opened.status.generation)).rejects.toThrow('STALE_GENERATION')
  })

  it('binds automation to browser/incarnation/generation and rejects a result invalidated during dispatch', async () => {
    let release!: () => void
    const snapshot = vi.fn(async () => { await new Promise<void>((resolve) => { release = resolve }); return { snapshotId: 'snap', nodes: [], truncated: false, url: 'about:blank' } })
    const automation = { snapshot, invalidate: vi.fn() } as unknown as BrowserAutomation
    let input!: () => void
    const localFactory: TabBrowserPageFactory = { create: (_id, onUserInput) => { input = onUserInput; return Object.assign(new FakePage(), { automation }) } }
    const host = new TabBrowserHost(emptyBrowserState(1), localFactory)
    const opened = await host.open({ visible: true })
    const action = { type: 'snapshot' as const, pageIncarnation: opened.status.pageIncarnation, expectedGeneration: opened.status.generation, limits: { maxDepth: 20, maxNodes: 2000, maxBytes: 262144 } }
    const pending = host.runAutomation(opened.status.id, action, new AbortController().signal)
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalled())
    input()
    release()
    await expect(pending).rejects.toThrow('STALE_GENERATION')
    expect(snapshot).toHaveBeenCalledWith(expect.objectContaining({ browserId: opened.status.id, pageIncarnation: opened.status.pageIncarnation }), action.limits, expect.any(AbortSignal))
  })

  it('approves consequential interactions while occluded and increments generation before irreversible dispatch', async () => {
    let host!: TabBrowserHost, release!: () => void
    const target = { role: 'button', name: 'Delete account', tag: 'button', type: 'submit', fingerprint: 'fp' }
    const prepareInteraction = vi.fn(async (_lease, operation) => ({ lease: _lease, operation, primary: { metadata: target }, target }))
    const executeInteraction = vi.fn(async () => {
      expect(host.status(opened.status.id).generation).toBe(1)
      return { dispatched: true as const, rollbackPossible: false as const }
    })
    const automation = { prepareInteraction, executeInteraction, invalidate: vi.fn() } as unknown as BrowserAutomation
    const page = Object.assign(new FakePage(), { automation })
    host = new TabBrowserHost(emptyBrowserState(1), { create: () => page })
    const opened = await host.open({ visible: true })
    const action = { type: 'interact' as const, pageIncarnation: opened.status.pageIncarnation, expectedGeneration: 0,
      operation: { kind: 'click' as const, target: { snapshotId: 'snap', ref: 'n1' } } }
    const approval = vi.fn(async () => { expect(page.visible).toBe(true); await new Promise<void>((resolve) => { release = resolve }) })
    const pending = host.runAutomation(opened.status.id, action, new AbortController().signal, approval)
    await vi.waitFor(() => expect(approval).toHaveBeenCalledWith(expect.objectContaining({ classification: expect.objectContaining({ category: 'destructive' }) }), expect.any(AbortSignal)))
    // Service-level approval protection detaches the native view; Host itself
    // keeps the adapter contract independent of renderer presentation.
    release(); const result = await pending as { generation: number; rollbackPossible: false }
    expect(result).toMatchObject({ generation: 1, rollbackPossible: false })
    expect(executeInteraction).toHaveBeenCalledOnce()
  })

  it('fails consequential interactions closed when no approval coordinator is present', async () => {
    const target = { role: 'textbox', name: 'Password', tag: 'input', type: 'password', fingerprint: 'secret-target' }
    const automation = { prepareInteraction: vi.fn(async (_lease, operation) => ({ lease: _lease, operation, primary: { metadata: target }, target })), executeInteraction: vi.fn(), invalidate: vi.fn() } as unknown as BrowserAutomation
    const host = new TabBrowserHost(emptyBrowserState(1), { create: () => Object.assign(new FakePage(), { automation }) })
    const opened = await host.open({ visible: true })
    await expect(host.runAutomation(opened.status.id, { type: 'interact', pageIncarnation: opened.status.pageIncarnation, expectedGeneration: 0,
      operation: { kind: 'fill', target: { snapshotId: 'snap', ref: 'n1' }, text: 'do-not-return-me' } }, new AbortController().signal)).rejects.toThrow('APPROVAL_REQUIRED')
    expect(automation.executeInteraction).not.toHaveBeenCalled()
    expect(host.status(opened.status.id).generation).toBe(0)
  })

  it('physically detaches the native page while an approval or dialog surface is visible', async () => {
    const host = new TabBrowserHost(emptyBrowserState(1), factory), opened = await host.open({ visible: true }), page = opened.page as FakePage
    expect(page.visible).toBe(true); host.protectApproval(opened.status.id, true); expect(page.visible).toBe(false)
    host.protectApproval(opened.status.id, false); expect(page.visible).toBe(true)
  })

  it('invalidates snapshots and generation immediately on Share revoke or Stop Pi', async () => {
    const invalidate = vi.fn(), automation = { invalidate } as unknown as BrowserAutomation
    const host = new TabBrowserHost(emptyBrowserState(1), { create: () => Object.assign(new FakePage(), { automation }) })
    const opened = await host.open({ visible: true }); host.revokePi(opened.status.id)
    expect(host.status(opened.status.id).generation).toBe(1); expect(invalidate).toHaveBeenCalledOnce()
  })

  it('counts synchronous and asynchronous reload navigation events exactly once', async () => {
    for (const timing of ['synchronous', 'asynchronous'] as const) {
      let emit!: (event: TabBrowserPageEvent) => void
      let deferredEvent: (() => void) | undefined
      const automation = {
        invalidate: vi.fn(),
        reload: vi.fn(() => {
          const navigate = () => emit({ type: 'navigation-started' })
          if (timing === 'synchronous') navigate(); else deferredEvent = navigate
          return { accepted: true }
        }),
      } as unknown as BrowserAutomation
      const localFactory: TabBrowserPageFactory = { create: (_id, _input, onEvent) => { emit = onEvent; return Object.assign(new FakePage(), { automation }) } }
      const host = new TabBrowserHost(emptyBrowserState(1), localFactory)
      const opened = await host.open({ visible: true })
      const result = await host.runAutomation(opened.status.id, { type: 'reload', pageIncarnation: opened.status.pageIncarnation, expectedGeneration: 0, ignoreCache: false }, new AbortController().signal) as { generation: number }
      expect(result.generation).toBe(1)
      deferredEvent?.()
      expect(host.status(opened.status.id).generation).toBe(1)
    }
  })

  it('does not advance generation when back/forward has no history entry', async () => {
    const automation = { invalidate: vi.fn(), history: vi.fn(() => ({ accepted: false })) } as unknown as BrowserAutomation
    const localFactory: TabBrowserPageFactory = { create: () => Object.assign(new FakePage(), { automation }) }
    const host = new TabBrowserHost(emptyBrowserState(1), localFactory)
    const opened = await host.open({ visible: true })
    const result = await host.runAutomation(opened.status.id, { type: 'history', direction: 'back', pageIncarnation: opened.status.pageIncarnation, expectedGeneration: 0 }, new AbortController().signal) as { generation: number; accepted: boolean }
    expect(result).toMatchObject({ generation: 0, accepted: false })
    expect(host.status(opened.status.id).generation).toBe(0)
  })

  it('does not choose the visible renderer as the LRU victim', async () => {
    let time = 0
    const host = new TabBrowserHost(emptyBrowserState(1), factory, () => ++time)
    const visible = await host.open({ visible: true })
    for (let i = 0; i < 4; i++) await host.open({ visible: false })
    expect(host.status(visible.status.id).lifecycle).toBe('live')
  })

  it('restores a crashed browser explicitly with a new incarnation and durable URL', async () => {
    const pages: FakePage[] = []
    const localFactory: TabBrowserPageFactory = { create: (id, onUserInput, onPageEvent, allowNavigation) => { userInputs.set(id, onUserInput); pageEvents.set(id, onPageEvent); pagePolicies.set(id, allowNavigation); const page = new FakePage(); pages.push(page); return page } }
    const host = new TabBrowserHost(emptyBrowserState(1), localFactory)
    const opened = await host.open({ visible: true }); const originalIncarnation = opened.status.pageIncarnation
    await host.navigate(opened.status.id, 'https://restore.example/path?private=1', originalIncarnation, opened.status.generation, undefined, 'user')
    pageEvents.get(opened.status.id)!({ type: 'crashed', reason: 'crashed' })
    expect(host.status(opened.status.id)).toMatchObject({ lifecycle: 'frozen', safeRestoreUrl: 'https://restore.example/path' })
    await host.thaw(opened.status.id); host.show(opened.status.id, { x: 1, y: 2, width: 400, height: 500 })
    expect(host.status(opened.status.id)).toMatchObject({ lifecycle: 'live', currentUrl: 'https://restore.example/path', restoredAfterFreeze: true, visible: true })
    expect(host.status(opened.status.id).pageIncarnation).not.toBe(originalIncarnation)
    expect(pages.at(-1)?.url).toBe('https://restore.example/path')
  })

  it('keeps a failed explicit restore frozen with a stable recovery error', async () => {
    const id = 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const, state = emptyBrowserState(1)
    state.records[id] = { id, profileId: 'global', mode: 'browse', safeRestoreUrl: 'https://restore.example/path', title: '', viewport: { width: 800, height: 600 }, lifecycle: 'frozen', stateRevision: 1, lastUsedAt: 1, lastFocusedAt: 1 }
    const pages: TabBrowserPageFactory = { create: () => ({ loadURL: async () => { throw new Error('secret transport detail') }, show: () => {}, hide: () => {}, stop: () => {}, destroy: () => {} }) }
    const host = new TabBrowserHost(state, pages)
    await expect(host.thaw(id)).rejects.toThrow('BROWSER_RESTORE_FAILED')
    expect(host.status(id)).toMatchObject({ lifecycle: 'frozen', restoreError: 'Browser restore failed', safeRestoreUrl: 'https://restore.example/path' })
  })

  it('reapplies the exact minimum persisted viewport after parse, restart, and thaw', async () => {
    const id = 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const
    const raw = emptyBrowserState(1); raw.records[id] = { id, profileId: 'global', mode: 'browse', safeRestoreUrl: 'about:blank', title: '', viewport: { width: 200, height: 200 }, lifecycle: 'live', stateRevision: 1, lastUsedAt: 1, lastFocusedAt: 1 }
    const restored = parseBrowserState(JSON.stringify(raw)), setViewport = vi.fn(async (viewport: { width: number; height: number }) => ({ viewport }))
    const localFactory: TabBrowserPageFactory = { create: () => { const page = new FakePage() as FakePage & { automation: BrowserAutomation }; page.automation = { setViewport } as unknown as BrowserAutomation; return page } }
    const host = new TabBrowserHost(restored, localFactory)
    expect(host.status(id)).toMatchObject({ lifecycle: 'frozen', viewport: { width: 200, height: 200 } })
    await host.thaw(id)
    expect(setViewport).toHaveBeenCalledWith({ width: 200, height: 200 }, expect.any(AbortSignal))
    expect(host.status(id).viewport).toEqual({ width: 200, height: 200 })
  })

  it('freezes the eligible LRU fifth page and changes incarnation on thaw', async () => {
    let time = 0
    const host = new TabBrowserHost(emptyBrowserState(1), factory, () => ++time)
    const opened = []
    for (let i = 0; i < 5; i++) opened.push(await host.open({ visible: i === 4 }))
    expect(host.status(opened[0]!.status.id).lifecycle).toBe('frozen')
    const incarnation = host.status(opened[0]!.status.id).pageIncarnation
    await host.thaw(opened[0]!.status.id)
    expect(host.status(opened[0]!.status.id).pageIncarnation).not.toBe(incarnation)
  })

  it('emits capacity-wait state and cancels a queued activation', async () => {
    const events: Array<{ type: string; id: string; waiting?: boolean; status?: unknown }> = []
    const host = new TabBrowserHost(emptyBrowserState(1), factory, Date.now, undefined, () => {}, (event) => events.push(event))
    const opened = []
    for (let i = 0; i < 4; i++) {
      const page = await host.open({ visible: false }); opened.push(page)
      host.protectApproval(page.status.id, true)
    }
    const controller = new AbortController()
    const pending = host.open({ visible: false }, controller.signal)
    await Promise.resolve()
    const waiting = events.find((event) => event.waiting)
    expect(waiting).toBeTruthy()
    expect(host.status(waiting!.id).capacityWaiting).toBe(true)
    controller.abort()
    await expect(pending).rejects.toThrow('ACTION_CANCELLED')
    expect(events.at(-1)).toMatchObject({ id: waiting!.id, waiting: false })
  })

  it('tracks user navigation, loading, and title events as host state', async () => {
    const host = new TabBrowserHost(emptyBrowserState(1), factory)
    const opened = await host.open({ visible: true })
    const event = pageEvents.get(opened.status.id)!
    event({ type: 'navigation-started' })
    expect(host.status(opened.status.id).loading).toBe(true)
    expect(host.status(opened.status.id).generation).toBe(1)
    event({ type: 'navigation-committed', url: 'https://example.test/path?secret=yes' })
    event({ type: 'title', title: 'A title' })
    expect(host.status(opened.status.id)).toMatchObject({ loading: false, safeRestoreUrl: 'https://example.test/path', title: 'A title' })
  })

  it('cancels a navigation by stopping the page load', async () => {
    const host = new TabBrowserHost(emptyBrowserState(1), {
      create: (_id, _input, _event) => {
        const page = new FakePage()
        page.loadURL = async () => new Promise<void>(() => {})
        return page
      },
    })
    const opened = await host.open({ visible: true })
    const controller = new AbortController()
    const navigation = host.navigate(opened.status.id, 'https://example.test', opened.status.pageIncarnation, opened.status.generation, controller.signal)
    controller.abort()
    await expect(navigation).rejects.toThrow('ACTION_CANCELLED')
    expect((opened.page as FakePage).stopped).toBe(true)
  })

  it('imports a workspace browser frozen without controller/share authority', () => {
    const host = new TabBrowserHost(emptyBrowserState(1), factory, () => 20)
    const status = host.importFrozen('browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
      mode: 'preview', safeRestoreUrl: 'https://u:p@example.test/a?q=x', viewport: { width: 900, height: 700 }, collapsed: true, width: 500,
    })
    expect(status).toMatchObject({ lifecycle: 'frozen', mode: 'preview', safeRestoreUrl: 'https://example.test/a', viewport: { width: 900, height: 700 } })
    expect(status).not.toHaveProperty('sharedWithPi')
    expect(status).not.toHaveProperty('designatedPi')
    expect(() => host.importWorkspace([
      { id: 'browser-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', browser: { mode: 'browse', safeRestoreUrl: 'https://new.test' } },
      { id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', browser: { mode: 'browse', safeRestoreUrl: 'about:blank' } },
    ], [])).toThrow('BROWSER_ID_COLLISION')
    expect(() => host.status('browser-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')).toThrow('NO_BROWSER_FOR_TAB')
  })

  it('lists, attaches, and deletes bounded recovery items', () => {
    const state = emptyBrowserState(1)
    state.migrationRecovery = [
      { id: 'recovery-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', workspace: 1, tab: 2, safeRestoreUrl: 'https://one.test/' },
      { id: 'recovery-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', workspace: 1, tab: 3, safeRestoreUrl: 'https://two.test/' },
    ]
    const host = new TabBrowserHost(state, factory)
    expect(host.recoveryItems()).toHaveLength(2)
    host.attachRecovery('recovery-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'browser-cccccccccccccccccccccccccccccccc')
    expect(host.status('browser-cccccccccccccccccccccccccccccccc').safeRestoreUrl).toBe('https://one.test/')
    host.deleteRecovery('recovery-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    expect(host.recoveryItems()).toEqual([])
  })

  it('revalidates a queued thaw before creating or attaching a page', async () => {
    const id = 'browser-cccccccccccccccccccccccccccccccc' as const
    const state = emptyBrowserState(1); state.records[id] = { id, profileId: 'global', mode: 'browse', safeRestoreUrl: 'https://stale.test/', title: '', viewport: { width: 800, height: 600 }, lifecycle: 'frozen', stateRevision: 1, lastUsedAt: 1, lastFocusedAt: 0 }
    let creates = 0
    const host = new TabBrowserHost(state, { create: (...args) => { creates += 1; return factory.create(...args) } })
    await expect(host.thaw(id, undefined, () => false)).rejects.toThrow('STALE_BROWSER_CONTEXT')
    expect(creates).toBe(0)
    expect(host.status(id).lifecycle).toBe('frozen')
  })

  it('cancels an in-flight load when Stop advances its exact generation', async () => {
    let release!: () => void
    const localFactory: TabBrowserPageFactory = { create: () => ({ loadURL: () => new Promise<void>((resolve) => { release = resolve }), show: () => {}, hide: () => {}, stop: () => release(), destroy: () => {} }) }
    const host = new TabBrowserHost(emptyBrowserState(1), localFactory)
    const opened = await host.open({ visible: true }); host.setMode(opened.status.id, 'preview')
    const current = host.status(opened.status.id)
    const navigating = host.navigate(opened.status.id, 'https://dev.example/', current.pageIncarnation, current.generation)
    host.stop(opened.status.id, opened.status.pageIncarnation, opened.status.generation + 1)
    await expect(navigating).rejects.toThrow('ACTION_CANCELLED')
    expect(host.status(opened.status.id)).toMatchObject({ lifecycle: 'live', currentUrl: 'about:blank', loading: false })
    expect(host.snapshot().records[opened.status.id]?.previewOrigins).toBeUndefined()
  })

  it.each(['close', 'crash'] as const)('does not resurrect an admission victim after deferred validation and %s', async (failure) => {
    let now = 0
    const host = new TabBrowserHost(emptyBrowserState(1), factory, () => ++now)
    const initial = [] as Array<{ id: string }>
    for (let index = 0; index < 4; index++) initial.push((await host.open({ visible: false })).status)
    const victim = initial[0]!.id
    let resolveValidation!: (valid: boolean) => void
    const pending = host.open({ visible: false }, undefined, () => new Promise<boolean>((resolve) => { resolveValidation = resolve }))
    await vi.waitFor(() => expect(resolveValidation).toBeTypeOf('function'))
    if (failure === 'close') host.close(victim)
    else pageEvents.get(victim)!({ type: 'crashed', reason: 'simulated crash' })
    resolveValidation(true)
    const admitted = await pending
    const expected = [...initial.slice(1).map((entry) => entry.id), admitted.status.id].sort()
    expect(host.liveIds().sort()).toEqual(expected)
    const next = (await host.open({ visible: false })).status.id
    expect(new Set(host.liveIds())).toEqual(new Set([initial[2]!.id, initial[3]!.id, admitted.status.id, next]))
    if (failure === 'close') expect(() => host.status(victim)).toThrow('NO_BROWSER_FOR_TAB')
    else expect(host.status(victim).lifecycle).toBe('frozen')
  })

  it.each(['close', 'crash'] as const)('completes a queued thaw when its selected victim %s before validation', async (failure) => {
    let now = 0
    const host = new TabBrowserHost(emptyBrowserState(1), factory, () => ++now)
    const initial = [] as Array<{ id: string }>
    for (let index = 0; index < 4; index++) initial.push((await host.open({ visible: false })).status)
    const thawId = initial[0]!.id
    host.freeze(thawId)
    const filled = (await host.open({ visible: false })).status.id
    expect(host.liveIds()).toContain(filled)

    let resolveValidation!: (valid: boolean) => void
    const pending = host.thaw(thawId, undefined, () => new Promise<boolean>((resolve) => { resolveValidation = resolve }))
    await vi.waitFor(() => expect(resolveValidation).toBeTypeOf('function'))
    const victim = initial[1]!.id
    if (failure === 'close') host.close(victim)
    else pageEvents.get(victim)!({ type: 'crashed', reason: 'simulated crash' })
    resolveValidation(true)
    await expect(pending).resolves.toMatchObject({ id: thawId, lifecycle: 'live', restoredAfterFreeze: true })
    expect(new Set(host.liveIds())).toEqual(new Set([initial[2]!.id, initial[3]!.id, filled, thawId]))
    const next = await host.open({ visible: false })
    expect(new Set(host.liveIds())).toEqual(new Set([initial[3]!.id, filled, thawId, next.status.id]))
    if (failure === 'close') expect(() => host.status(victim)).toThrow('NO_BROWSER_FOR_TAB')
    else expect(host.status(victim).lifecycle).toBe('frozen')
  })

  it('stops an active page load without closing the browser', async () => {
    const host = new TabBrowserHost(emptyBrowserState(1), factory)
    const opened = await host.open({ visible: true })
    host.stop(opened.status.id)
    expect((opened.page as FakePage).stopped).toBe(true)
    expect(host.status(opened.status.id).lifecycle).toBe('live')
  })
})
