import { Children, createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const overlayCapture = vi.hoisted(() => ({
  element: null as ReactElement | null,
  props: null as { text: string; active: boolean; onResume: () => void } | null,
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
  Pane: (): JSX.Element => createElement('div', { className: 'xterm' }, createElement('textarea')),
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
import { SplitView } from './SplitView'
import type { Node } from './layout'

const PANE = 'amber-1-1-0-a'
const TREE: Node = { kind: 'leaf', paneId: PANE }

beforeEach(() => {
  overlayCapture.element = null
  overlayCapture.props = null
})

function splitView(active: boolean, onPaneFocus: () => void): JSX.Element {
  return createElement(SplitView, {
    tree: TREE, deadCodes: {}, meta: { [PANE]: { kind: 'claude', title: 'agent', cwd: '/tmp', runState: 'resource-suspended' } }, active,
    epoch: 0, portEpoch: 0, fontSize: 13, onPaneTitle: () => {}, onPaneFocus,
    onSetRatio: () => {}, onSplit: () => {}, onMove: () => {}, onMoveTo: () => {}, onClose: () => {},
    browsers: {}, onBrowserNav: () => {}, editors: {}, onEditorPath: () => {}, onEditorViewState: () => {},
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

describe('resource-pressure renderer UI', () => {
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
})
