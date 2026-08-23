// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResourcePressureBanner } from './PressureBanners'
import { SplitView } from './SplitView'
import type { Node } from './layout'

vi.mock('./Pane', () => ({
  Pane: (): JSX.Element => createElement('div', { className: 'xterm' }, createElement('textarea')),
}))

vi.mock('./KeyBar', () => ({ KeyBar: (): JSX.Element => createElement('div') }))

const PANE = 'amber-1-1-0-a'
const TREE: Node = { kind: 'leaf', paneId: PANE }

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 900 })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 })
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(): void { this.callback([], this as unknown as ResizeObserver) }
    disconnect(): void {}
  } })
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (cb: FrameRequestCallback) => { cb(0); return 0 } })
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

function renderParked(active: boolean, runState: 'memory-suspended' | 'resource-suspended', onPaneFocus = vi.fn()): ReturnType<typeof vi.fn> {
  act(() => root.render(createElement(SplitView, {
    tree: TREE, deadCodes: {}, meta: { [PANE]: { kind: 'claude', title: 'agent', cwd: '/tmp', runState } }, active,
    epoch: 0, portEpoch: 0, fontSize: 13, onPaneTitle: () => {}, onPaneFocus,
    onSetRatio: () => {}, onSplit: () => {}, onMove: () => {}, onMoveTo: () => {}, onClose: () => {},
    browsers: {}, onBrowserNav: () => {}, editors: {}, onEditorPath: () => {}, onEditorViewState: () => {},
    onEditorDirty: () => {}, onEditorReady: () => {}, zoomedPane: null, onToggleZoom: () => {},
    frozen: {}, onFreeze: () => {}, onUnfreeze: () => {},
  })))
  return onPaneFocus
}

describe('resource-pressure renderer UI', () => {
  it('renders every critical pressure cause in the banner', () => {
    act(() => root.render(createElement(ResourcePressureBanner, {
      pressure: { level: 'critical', causes: ['cpu', 'io'], blocked: false },
    })))
    const banner = host.querySelector('[role="alert"]')
    expect(banner?.textContent).toBe('Amber CPU and I/O pressure is critical. Idle agent panes may be parked.')
  })

  it('renders exact resource and legacy parked overlay copy', () => {
    renderParked(true, 'resource-suspended')
    expect(host.querySelector('.memory-parked-overlay')?.textContent).toBe('Parked to protect system resourcesResume')
    renderParked(true, 'memory-suspended')
    expect(host.querySelector('.memory-parked-overlay')?.textContent).toBe('Parked to protect system memoryResume')
  })

  it('does not resume a parked pane when a background tab activates', () => {
    const onPaneFocus = renderParked(false, 'resource-suspended')
    renderParked(true, 'resource-suspended', onPaneFocus)
    expect(onPaneFocus).not.toHaveBeenCalled()
  })

  it('resumes a visible parked pane from the explicit overlay action', () => {
    const onPaneFocus = renderParked(true, 'resource-suspended')
    const resume = host.querySelector('.memory-parked-overlay button') as HTMLButtonElement
    act(() => resume.click())
    expect(onPaneFocus).toHaveBeenCalledWith(PANE)
  })
})
