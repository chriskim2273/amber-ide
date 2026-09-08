/* Minimal DOM host for mounted React seam tests. Kept test-only: the app has no
 * dependency on a DOM test runner, but these tests still exercise delegated
 * pointer/input handlers instead of inspecting JSX props in isolation. */

export class FakeEvent {
  currentTarget: FakeNode | null = null
  defaultPrevented = false
  eventPhase = 0
  cancelBubble = false
  readonly bubbles: boolean
  readonly cancelable = true
  readonly isTrusted: boolean
  readonly timeStamp = Date.now()

  constructor(readonly type: string, options: { bubbles?: boolean; isTrusted?: boolean; target: FakeNode }) {
    this.bubbles = options.bubbles ?? true
    this.isTrusted = options.isTrusted ?? true
    this.target = options.target
  }

  readonly target: FakeNode

  preventDefault(): void { this.defaultPrevented = true }
  stopPropagation(): void { this.cancelBubble = true }
}

type Listener = (event: FakeEvent) => void

export class FakeNode {
  childNodes: FakeNode[] = []
  listeners = new Map<string, Array<{ listener: Listener; capture: boolean }>>()
  parentNode: FakeNode | null = null

  constructor(readonly nodeType: number, readonly nodeName: string, public ownerDocument: FakeDocument) {}

  get firstChild(): FakeNode | null { return this.childNodes[0] ?? null }
  get lastChild(): FakeNode | null { return this.childNodes.at(-1) ?? null }
  get parentElement(): FakeElement | null { return this.parentNode instanceof FakeElement ? this.parentNode : null }
  get textContent(): string { return this.childNodes.map((child) => child.textContent).join('') }
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
    for (let index = path.length - 1; index >= 0 && !event.cancelBubble; index -= 1) {
      event.currentTarget = path[index]!
      event.eventPhase = 1
      for (const entry of path[index]!.listeners.get(event.type) ?? []) {
        if (entry.capture) entry.listener(event)
        if (event.cancelBubble) break
      }
    }
    for (let index = 0; index < path.length && !event.cancelBubble; index += 1) {
      event.currentTarget = path[index]!
      event.eventPhase = path[index] === this ? 2 : 3
      for (const entry of path[index]!.listeners.get(event.type) ?? []) {
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
    for (let node: FakeNode | null = target; node !== null; node = node.parentNode) if (node === this) return true
    return false
  }
}

class FakeText extends FakeNode {
  constructor(public data: string, ownerDocument: FakeDocument) { super(3, '#text', ownerDocument) }
  get nodeValue(): string { return this.data }
  set nodeValue(value: string) { this.data = value }
  override get textContent(): string { return this.data }
  override set textContent(value: string) { this.data = value }
}

class FakeClassList {
  constructor(private readonly element: FakeElement) {}
  contains(token: string): boolean { return this.element.className.split(/\s+/).includes(token) }
  add(token: string): void { if (!this.contains(token)) this.element.className = `${this.element.className} ${token}`.trim() }
  remove(token: string): void { this.element.className = this.element.className.split(/\s+/).filter((part) => part !== token).join(' ') }
}

export class FakeElement extends FakeNode {
  readonly attributes = new Map<string, string>()
  readonly classList = new FakeClassList(this)
  readonly dataset: Record<string, string> = {}
  readonly namespaceURI = 'http://www.w3.org/1999/xhtml'
  readonly style = { setProperty: (name: string, value: string) => { this.styleValues[name] = value } } as Record<string, unknown> & { setProperty: (name: string, value: string) => void }
  readonly styleValues: Record<string, string> = {}
  className = ''
  clientHeight = 600
  clientWidth = 900
  private disabledValue = false
  type = 'text'
  oninput = (): void => {}
  onchange = (): void => {}
  private currentValue = ''
  tagName: string

  constructor(tagName: string, ownerDocument: FakeDocument) {
    super(1, tagName.toUpperCase(), ownerDocument)
    this.tagName = tagName.toUpperCase()
  }

  get disabled(): boolean { return this.disabledValue }
  set disabled(next: boolean) {
    this.disabledValue = Boolean(next)
    if (this.disabledValue) this.attributes.set('disabled', '')
    else this.attributes.delete('disabled')
  }
  get value(): string { return this.currentValue }
  set value(next: string) { this.currentValue = String(next) }
  get options(): FakeElement[] { return this.childNodes.filter((child): child is FakeElement => child instanceof FakeElement) }

  setAttribute(name: string, value: string): void {
    const text = String(value)
    this.attributes.set(name, text)
    if (name === 'class') this.className = text
    if (name === 'disabled') this.disabled = true
    if (name === 'type') this.type = text
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = text
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name)
    if (name === 'class') this.className = ''
    if (name === 'disabled') this.disabled = false
  }
  getAttribute(name: string): string | null { return name === 'class' ? this.className : this.attributes.get(name) ?? null }
  getAttributeNames(): string[] { return [...this.attributes.keys()] }
  hasAttribute(name: string): boolean { return this.attributes.has(name) }
  attachEvent(): void {}
  detachEvent(): void {}

  scrollIntoView(): void {}

  focus(): void {
    this.ownerDocument.activeElement = this
    this.dispatchEvent(new FakeEvent('focusin', { target: this, bubbles: true, isTrusted: false }))
  }
  blur(): void {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body
    this.dispatchEvent(new FakeEvent('focusout', { target: this, bubbles: true, isTrusted: false }))
  }
  click(): void { this.dispatchEvent(new FakeEvent('click', { target: this })) }
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
    return { left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight }
  }

  querySelector(selector: string): FakeElement | null { return this.querySelectorAll(selector)[0] ?? null }
  querySelectorAll(selector: string): FakeElement[] {
    const attribute = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector)
    const matches = (node: FakeNode): node is FakeElement => {
      if (!(node instanceof FakeElement)) return false
      if (selector.startsWith('.')) return node.classList.contains(selector.slice(1))
      if (attribute) return node.attributes.has(attribute[1]!) && (attribute[2] === undefined || node.attributes.get(attribute[1]!) === attribute[2])
      return node.tagName.toLowerCase() === selector.toLowerCase()
    }
    const found: FakeElement[] = []
    const visit = (node: FakeNode): void => { if (matches(node)) found.push(node); for (const child of node.childNodes) visit(child) }
    visit(this)
    return found
  }
}

export class FakeDocument extends FakeNode {
  activeElement: FakeElement
  readonly body: FakeElement
  defaultView: Record<string, unknown>
  readonly documentElement: FakeElement

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
  createElement(tagName: string): FakeElement { return new FakeElement(tagName, this) }
  createElementNS(_namespace: string, tagName: string): FakeElement { return new FakeElement(tagName, this) }
  createTextNode(data: string): FakeText { return new FakeText(data, this) }
}

export interface FakeDomHandle { container: FakeElement; restore: () => void }

export function installFakeDom(coarse = false): FakeDomHandle {
  const previous: Record<string, unknown> = {}
  for (const key of ['document', 'window', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLIFrameElement', 'SVGElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    previous[key] = (globalThis as Record<string, unknown>)[key]
  }
  previous['IS_REACT_ACT_ENVIRONMENT'] = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT

  const document = new FakeDocument()
  const window = {
    document,
    Element: FakeElement,
    HTMLElement: FakeElement,
    HTMLIFrameElement: class FakeHTMLIFrameElement extends FakeElement {},
    SVGElement: FakeElement,
    Node: FakeNode,
    Event: FakeEvent,
    MouseEvent: FakeEvent,
    KeyboardEvent: FakeEvent,
    addEventListener: document.addEventListener.bind(document),
    removeEventListener: document.removeEventListener.bind(document),
    dispatchEvent: document.dispatchEvent.bind(document),
    getComputedStyle: () => ({}),
    innerWidth: 390,
    matchMedia: (query: string) => ({ matches: coarse && query.includes('pointer: coarse'), addEventListener: () => {}, removeEventListener: () => {} }),
  }
  document.defaultView = window
  const globals: Record<string, unknown> = {
    document, window, navigator: { userAgent: 'fake-mounted-dom' }, Node: FakeNode, Element: FakeElement,
    HTMLElement: FakeElement, HTMLIFrameElement: window.HTMLIFrameElement, SVGElement: FakeElement,
    Event: FakeEvent, MouseEvent: FakeEvent, KeyboardEvent: FakeEvent,
    ResizeObserver: class { observe(): void {} disconnect(): void {} },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number,
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  }
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value })
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

export async function withFakeDom<T>(body: (dom: FakeDomHandle) => Promise<T>, coarse = false): Promise<T> {
  const dom = installFakeDom(coarse)
  try { return await body(dom) } finally { dom.restore() }
}
