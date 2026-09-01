import { Children, act, createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const overlayCapture = vi.hoisted(() => ({
  element: null as ReactElement | null,
  props: null as { text: string; active: boolean; onResume: () => void } | null,
}))

const paneCapture = vi.hoisted(() => ({
  lastActivateSeq: null as number | null,
}))

vi.mock('react', async (importOriginal) => {
  const React = await importOriginal<typeof import('react')>()
  return {
    ...React,
    // Server rendering has no ResizeObserver effect to seed SplitView's stage
    // dimensions. Keep its real hook, only seed its initial zero-size rect so
    // the real pane/overlay branch is rendered.
    useState: (initial: unknown) => React.useState(
      initial && typeof initial === 'object'
        && (initial as { x?: unknown; y?: unknown; w?: unknown; h?: unknown }).x === 0
        && (initial as { x?: unknown; y?: unknown; w?: unknown; h?: unknown }).y === 0
        && (initial as { x?: unknown; y?: unknown; w?: unknown; h?: unknown }).w === 0
        && (initial as { x?: unknown; y?: unknown; w?: unknown; h?: unknown }).h === 0
        ? { x: 0, y: 0, w: 900, h: 600 }
        : initial,
    ),
  }
})

vi.mock('./Pane', () => ({
  Pane: (props: { activateSeq: number; session: string }): JSX.Element => {
    paneCapture.lastActivateSeq = props.activateSeq
    return createElement('div', { className: 'xterm' },
      createElement('textarea', { 'data-session': props.session }))
  },
}))

vi.mock('./KeyBar', () => ({ KeyBar: (): JSX.Element => createElement('div') }))

vi.mock('./PressureBanners', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./PressureBanners')>()
  return {
    ...actual,
    ParkedOverlay: (props: { text: string; active: boolean; onResume: () => void }): JSX.Element => {
      overlayCapture.props = props
      overlayCapture.element = actual.ParkedOverlay(props)
      return overlayCapture.element
    },
  }
})

import { ParkedOverlay, ResourcePressureBanner } from './PressureBanners'
import { shouldDismissContextMenu, SplitView } from './SplitView'
import type { Node } from './layout'

const PANE = 'amber-1-1-0-a'
const TREE: Node = { kind: 'leaf', paneId: PANE }

beforeEach(() => {
  overlayCapture.element = null
  overlayCapture.props = null
  paneCapture.lastActivateSeq = null
})

function splitView(active: boolean, onPaneFocus: () => void): JSX.Element {
  return createElement(SplitView, {
    tree: TREE, deadCodes: {}, meta: { [PANE]: { kind: 'claude', title: 'agent', cwd: '/tmp', runState: 'resource-suspended' } }, active,
    epoch: 0, portEpoch: 0, fontSize: 13, mobile: false, onPaneTitle: () => {}, onPaneFocus,
    onSetRatio: () => {}, onSplit: () => {}, onMove: () => {}, onMoveTo: () => {}, onClose: () => {},
    editors: {}, onEditorPath: () => {}, onEditorViewState: () => {},
    onEditorDirty: () => {}, onEditorReady: () => {}, zoomedPane: null, onToggleZoom: () => {},
    frozen: {}, onFreeze: () => {}, onUnfreeze: () => {},
  })
}

function resumeButton(): ReactElement<{ onClick: (event: { isTrusted: boolean }) => void }> {
  const overlay = overlayCapture.element
  if (!overlay) throw new Error('SplitView did not render ParkedOverlay')
  const button = Children.toArray(overlay.props.children)[1]
  if (!button || typeof button !== 'object') throw new Error('ParkedOverlay did not render Resume')
  return button as ReactElement<{ onClick: (event: { isTrusted: boolean }) => void }>
}

type Listener = (event: FakeEvent) => void

class FakeEvent {
  currentTarget: FakeNode | null = null
  defaultPrevented = false
  eventPhase = 0
  target: FakeNode
  timeStamp = Date.now()

  constructor(
    readonly type: string,
    options: { bubbles?: boolean; isTrusted?: boolean; target: FakeNode },
  ) {
    this.bubbles = options.bubbles ?? true
    this.isTrusted = options.isTrusted ?? false
    this.target = options.target
  }

  bubbles: boolean
  cancelBubble = false
  isTrusted: boolean

  preventDefault(): void {
    this.defaultPrevented = true
  }

  stopPropagation(): void {
    this.cancelBubble = true
  }
}

class FakeNode {
  childNodes: FakeNode[] = []
  listeners = new Map<string, Array<{ listener: Listener; capture: boolean }>>()
  parentNode: FakeNode | null = null

  constructor(
    readonly nodeType: number,
    readonly nodeName: string,
    public ownerDocument: FakeDocument,
  ) {}

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null
  }

  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null
  }

  get parentElement(): FakeElement | null {
    return this.parentNode instanceof FakeElement ? this.parentNode : null
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join('')
  }

  set textContent(value: string) {
    this.childNodes = value ? [new FakeText(value, this.ownerDocument)] : []
    for (const child of this.childNodes) child.parentNode = this
  }

  appendChild<T extends FakeNode>(child: T): T {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }

  insertBefore<T extends FakeNode>(child: T, before: FakeNode | null): T {
    if (before === null) return this.appendChild(child)
    const index = this.childNodes.indexOf(before)
    if (index < 0) throw new Error('insertBefore target is not a child')
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.childNodes.splice(index, 0, child)
    return child
  }

  removeChild<T extends FakeNode>(child: T): T {
    const index = this.childNodes.indexOf(child)
    if (index < 0) throw new Error('removeChild target is not a child')
    this.childNodes.splice(index, 1)
    child.parentNode = null
    return child
  }

  addEventListener(type: string, listener: Listener, options?: boolean | { capture?: boolean }): void {
    const capture = typeof options === 'boolean' ? options : options?.capture === true
    const listeners = this.listeners.get(type) ?? []
    listeners.push({ listener, capture })
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: Listener, options?: boolean | { capture?: boolean }): void {
    const capture = typeof options === 'boolean' ? options : options?.capture === true
    const listeners = this.listeners.get(type) ?? []
    this.listeners.set(type, listeners.filter((entry) => entry.listener !== listener || entry.capture !== capture))
  }

  dispatchEvent(event: FakeEvent): boolean {
    const path: FakeNode[] = []
    for (let node: FakeNode | null = this; node !== null; node = node.parentNode) path.push(node)
    if (!path.includes(this.ownerDocument)) path.push(this.ownerDocument)

    for (let i = path.length - 1; i >= 0 && !event.cancelBubble; i -= 1) {
      event.currentTarget = path[i]!
      event.eventPhase = 1
      for (const entry of path[i]!.listeners.get(event.type) ?? []) {
        if (entry.capture) entry.listener(event)
        if (event.cancelBubble) break
      }
    }
    for (let i = 0; i < path.length && !event.cancelBubble; i += 1) {
      event.currentTarget = path[i]!
      event.eventPhase = path[i] === this ? 2 : 3
      for (const entry of path[i]!.listeners.get(event.type) ?? []) {
        if (!entry.capture) entry.listener(event)
        if (event.cancelBubble) break
      }
      if (!event.bubbles) break
    }
    event.currentTarget = null
    event.eventPhase = 0
    return !event.defaultPrevented
  }

  contains(target: FakeNode | null): boolean {
    for (let node = target; node !== null; node = node.parentNode) if (node === this) return true
    return false
  }
}

class FakeText extends FakeNode {
  constructor(public data: string, ownerDocument: FakeDocument) {
    super(3, '#text', ownerDocument)
  }

  get nodeValue(): string {
    return this.data
  }

  set nodeValue(value: string) {
    this.data = value
  }

  override get textContent(): string {
    return this.data
  }

  override set textContent(value: string) {
    this.data = value
  }
}

class FakeClassList {
  constructor(private readonly element: FakeElement) {}

  contains(token: string): boolean {
    return this.element.className.split(/\s+/).includes(token)
  }

  add(token: string): void {
    if (!this.contains(token)) this.element.className = `${this.element.className} ${token}`.trim()
  }

  remove(token: string): void {
    this.element.className = this.element.className.split(/\s+/).filter((part) => part !== token).join(' ')
  }
}

class FakeElement extends FakeNode {
  attributes = new Map<string, string>()
  className = ''
  classList = new FakeClassList(this)
  clientHeight = 600
  clientWidth = 900
  dataset: Record<string, string> = {}
  focusCount = 0
  namespaceURI = 'http://www.w3.org/1999/xhtml'
  style: Record<string, string | number | undefined> = {}
  tagName: string

  constructor(tagName: string, ownerDocument: FakeDocument) {
    super(1, tagName.toUpperCase(), ownerDocument)
    this.tagName = tagName.toUpperCase()
  }

  setAttribute(name: string, value: string): void {
    const text = String(value)
    this.attributes.set(name, text)
    if (name === 'class') this.className = text
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = text
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
    if (name === 'class') this.className = ''
  }

  attachEvent(): void {}

  detachEvent(): void {}

  getAttribute(name: string): string | null {
    if (name === 'class') return this.className
    return this.attributes.get(name) ?? null
  }

  focus(): void {
    this.focusCount += 1
    this.ownerDocument.activeElement = this
    this.dispatchEvent(new FakeEvent('focusin', { target: this, bubbles: true, isTrusted: false }))
  }

  blur(): void {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body
    this.dispatchEvent(new FakeEvent('focusout', { target: this, bubbles: true, isTrusted: false }))
  }

  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
    return { left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight }
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches = (node: FakeNode): node is FakeElement => {
      if (!(node instanceof FakeElement)) return false
      if (selector.startsWith('.')) return node.classList.contains(selector.slice(1))
      if (selector.startsWith('[') && selector.endsWith(']')) return node.attributes.has(selector.slice(1, -1))
      return node.tagName.toLowerCase() === selector.toLowerCase()
    }
    const out: FakeElement[] = []
    const visit = (node: FakeNode): void => {
      if (matches(node)) out.push(node)
      for (const child of node.childNodes) visit(child)
    }
    visit(this)
    return out
  }

  closest(selector: string): FakeElement | null {
    for (let node: FakeNode | null = this; node !== null; node = node.parentNode) {
      if (!(node instanceof FakeElement)) continue
      if (selector.startsWith('.') && node.classList.contains(selector.slice(1))) return node
      if (selector.startsWith('[') && selector.endsWith(']') && node.attributes.has(selector.slice(1, -1))) return node
      if (node.tagName.toLowerCase() === selector.toLowerCase()) return node
    }
    return null
  }
}

class FakeDocument extends FakeNode {
  activeElement: FakeElement
  body: FakeElement
  defaultView: Record<string, unknown>
  documentElement: FakeElement

  constructor() {
    super(9, '#document', null as unknown as FakeDocument)
    this.ownerDocument = this
    this.documentElement = new FakeElement('html', this)
    this.body = new FakeElement('body', this)
    this.activeElement = this.body
    this.documentElement.appendChild(this.body)
    this.appendChild(this.documentElement)
    this.defaultView = {}
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this)
  }

  createElementNS(_namespace: string, tagName: string): FakeElement {
    return new FakeElement(tagName, this)
  }

  createTextNode(data: string): FakeText {
    return new FakeText(data, this)
  }
}

class FakeResizeObserver {
  constructor(private readonly callback: () => void) {}
  observe(): void {
    this.callback()
  }
  disconnect(): void {}
}

function installFakeDom(): { container: FakeElement; restore: () => void } {
  const previous = {
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    HTMLIFrameElement: globalThis.HTMLIFrameElement,
    Node: globalThis.Node,
    ResizeObserver: globalThis.ResizeObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    window: globalThis.window,
    navigator: globalThis.navigator,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  }
  const document = new FakeDocument()
  const window = {
    document,
    Element: FakeElement,
    HTMLElement: FakeElement,
    HTMLIFrameElement: class FakeHTMLIFrameElement extends FakeElement {},
    Node: FakeNode,
    addEventListener: document.addEventListener.bind(document),
    removeEventListener: document.removeEventListener.bind(document),
    dispatchEvent: document.dispatchEvent.bind(document),
    getComputedStyle: () => ({}),
    innerWidth: 900,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  }
  document.defaultView = window
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'fake-dom' } })
  Object.defineProperty(globalThis, 'Node', { configurable: true, value: FakeNode })
  Object.defineProperty(globalThis, 'Element', { configurable: true, value: FakeElement })
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: FakeElement })
  Object.defineProperty(globalThis, 'HTMLIFrameElement', { configurable: true, value: window.HTMLIFrameElement })
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: FakeResizeObserver })
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number,
  })
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id: number) => clearTimeout(id) })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

  const container = document.createElement('div')
  document.body.appendChild(container)
  return {
    container,
    restore: () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) Reflect.deleteProperty(globalThis, key)
        else Object.defineProperty(globalThis, key, { configurable: true, value })
      }
    },
  }
}

async function withFakeDom<T>(body: (dom: { container: FakeElement }) => Promise<T>): Promise<T> {
  const dom = installFakeDom()
  try {
    return await body(dom)
  } finally {
    dom.restore()
  }
}

describe('resource-pressure renderer UI', () => {
  it('keeps the context menu mounted through a pointer press on a menu action', async () => {
    await withFakeDom(async (dom) => {
      const menu = dom.container.ownerDocument.createElement('div')
      menu.setAttribute('class', 'ctx-menu')
      const action = dom.container.ownerDocument.createElement('button')
      menu.appendChild(action)
      dom.container.appendChild(menu)

      expect(shouldDismissContextMenu(action as unknown as EventTarget)).toBe(false)
      expect(shouldDismissContextMenu(dom.container as unknown as EventTarget)).toBe(true)
    })
  })

  it('renders every critical pressure cause in the banner', () => {
    const html = renderToStaticMarkup(createElement(ResourcePressureBanner, {
      pressure: { level: 'critical', causes: ['cpu', 'io'], blocked: false },
    }))
    expect(html).toContain('Amber CPU and I/O pressure is critical. Idle agent panes may be parked.')
    expect(html).toContain('role="alert"')
  })

  it('renders exact resource and legacy parked overlay copy', () => {
    const resource = renderToStaticMarkup(createElement(ParkedOverlay, {
      text: 'Parked to protect system resources', active: true, onResume: () => {},
    }))
    const legacy = renderToStaticMarkup(createElement(ParkedOverlay, {
      text: 'Parked to protect system memory', active: true, onResume: () => {},
    }))
    expect(resource).toContain('Parked to protect system resources')
    expect(legacy).toContain('Parked to protect system memory')
  })

  it('wires real SplitView overlays to resume only active trusted interactions', () => {
    const onPaneFocus = vi.fn()
    const background = renderToStaticMarkup(splitView(false, onPaneFocus))
    expect(background).toContain('Parked to protect system resources')
    expect(overlayCapture.props).toMatchObject({ active: false, text: 'Parked to protect system resources' })
    resumeButton().props.onClick({ isTrusted: true })
    expect(onPaneFocus).not.toHaveBeenCalled()

    renderToStaticMarkup(splitView(true, onPaneFocus))
    expect(overlayCapture.props).toMatchObject({ active: true, text: 'Parked to protect system resources' })
    resumeButton().props.onClick({ isTrusted: false })
    expect(onPaneFocus).not.toHaveBeenCalled()
    resumeButton().props.onClick({ isTrusted: true })
    expect(onPaneFocus).toHaveBeenCalledWith(PANE)
  })

  it('restores fake DOM globals if client setup fails before root creation', async () => {
    const previousDocument = globalThis.document

    await expect(withFakeDom(async () => {
      throw new Error('setup failed before createRoot')
    })).rejects.toThrow('setup failed before createRoot')

    expect(globalThis.document).toBe(previousDocument)
  })

  it('suppresses the programmatic focus caused by keep-alive activation', async () => {
    await withFakeDom(async (dom) => {
      const { createRoot } = await import('react-dom/client')
      const onPaneFocus = vi.fn()
      const root = createRoot(dom.container as unknown as Element)
      try {
        await act(async () => {
          root.render(splitView(false, onPaneFocus))
        })
        const textarea = dom.container.querySelector('textarea')
        expect(textarea?.focusCount).toBe(0)
        expect(paneCapture.lastActivateSeq).toBe(0)

        await act(async () => {
          root.render(splitView(true, onPaneFocus))
        })

        expect(paneCapture.lastActivateSeq).toBe(1)
        expect(textarea?.focusCount).toBe(1)
        expect(onPaneFocus).not.toHaveBeenCalled()
      } finally {
        await act(async () => {
          root.unmount()
        })
      }
    })
  })
})
