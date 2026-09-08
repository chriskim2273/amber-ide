import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { BrowserRail, browserCommandNeedsContext, hasRemoteBrowserFrame, mapFramePoint, shouldRevokeDesignatedPi } from './BrowserRail'

const props = {
  id: '0123456789ABCDEFGHJKMNPQRS', width: 420, collapsed: false,
  controllers: [{ name: 'amber-1-1-0-pi', label: 'Pi' }],
  onWidth: vi.fn(), onCollapsed: vi.fn(), onClose: vi.fn(), onRecovery: vi.fn(), onPolicy: vi.fn(),
  ensureContext: async () => {},
}

describe('BrowserRail command context', () => {
  it('waits for the first daemon session list before revoking a persisted controller', () => {
    expect(shouldRevokeDesignatedPi('amber-1-1-pi', [], false)).toBe(false)
    expect(shouldRevokeDesignatedPi('amber-1-1-pi', [], true)).toBe(true)
    expect(shouldRevokeDesignatedPi('amber-1-1-pi', [{ name: 'amber-1-1-pi' }], true)).toBe(false)
  })
  it('does not re-acknowledge the surface while resolving a visible approval or dialog', () => {
    expect(browserCommandNeedsContext({ type: 'resolveApproval' })).toBe(false)
    expect(browserCommandNeedsContext({ type: 'resolveDialog' })).toBe(false)
    expect(browserCommandNeedsContext({ type: 'navigate' })).toBe(true)
  })
  it('maps remote frame clicks into image pixels and detects a web frame API', () => {
    expect(mapFramePoint(50, 60, { left: 10, top: 10, width: 100, height: 50 }, 200, 100)).toEqual({ x: 80, y: 100 })
    expect(mapFramePoint(-1, 0, { left: 0, top: 0, width: 100, height: 100 }, 100, 100)).toBeNull()
    expect(hasRemoteBrowserFrame({ browserFrame: async () => ({}) })).toBe(true)
    expect(hasRemoteBrowserFrame({})).toBe(false)
  })
})

describe('BrowserRail accessibility contract', () => {
  it('replaces controller option text when a pane is renamed after the rail is open', () => {
    const html = renderToStaticMarkup(createElement(BrowserRail, {
      ...props,
      controllers: [{ name: 'amber-1-1-0-pi', label: '#4 IOTNation' }],
    }))
    expect(html).toContain('#4 IOTNation')
    const renamed = renderToStaticMarkup(createElement(BrowserRail, {
      ...props,
      controllers: [{ name: 'amber-1-1-0-pi', label: '#4 Auth refactor' }],
    }))
    expect(renamed).toContain('#4 Auth refactor')
    expect(renamed).not.toContain('#4 IOTNation')
  })

  it('renders each Pi controller option with the identity label, not a colliding brand', () => {
    const html = renderToStaticMarkup(createElement(BrowserRail, {
      ...props,
      controllers: [
        { name: 'amber-1-1-0-a', label: '#3 Auth refactor' },
        { name: 'amber-1-1-1-b', label: '#7 Tests' },
      ],
    }))
    expect(html).toContain('#3 Auth refactor')
    expect(html).toContain('#7 Tests')
    expect(html).not.toContain('>Pi<')
  })

  it('renders keyboard-addressable navigation, focus, viewport, controller, recovery, and resize controls', () => {
    const html = renderToStaticMarkup(createElement(BrowserRail, { ...props, designatedPi: 'amber-1-1-0-pi', sharedWithPi: true }))
    expect(html).toContain('aria-label="Browser navigation"')
    expect(html).toContain('aria-label="Browser address"')
    expect(html).toContain('aria-label="Browser mode"')
    expect(html).toContain('aria-label="Viewport mode"')
    expect(html).toContain('Fit to rail')
    expect(html).toContain('Fixed viewport')
    expect(html).toContain('not real-device')
    expect(html).toContain('aria-label="Pi browser controller"')
    expect(html).toContain('aria-label="Focus browser page"')
    expect(html).toContain('>Recovery<')
    expect(html).toContain('role="separator"')
    expect(html).toContain('aria-orientation="vertical"')
    expect(html).toContain('aria-valuenow="420"')
    expect(html).toContain('aria-label="Full access"')
    expect(html).not.toMatch(/aria-label="Full access"[^>]*disabled/)
    expect(html).not.toMatch(/aria-label="Full access"[^>]*checked/)
  })

  it('enables Full access only after Share with Pi and does not let the agent self-grant', () => {
    const unshared = renderToStaticMarkup(createElement(BrowserRail, { ...props, designatedPi: 'amber-1-1-0-pi' }))
    expect(unshared).toMatch(/aria-label="Full access"[^>]*disabled/)
    const shared = renderToStaticMarkup(createElement(BrowserRail, { ...props, designatedPi: 'amber-1-1-0-pi', sharedWithPi: true, fullAccess: true }))
    expect(shared).toContain('aria-label="Full access"')
    expect(shared).toContain('Full access')
    expect(shared).not.toMatch(/aria-label="Full access"[^>]*disabled/)
    expect(shared).toMatch(/aria-label="Full access"[^>]*checked/)
  })

  it('renders style and ARIA from the same clamped width metrics', () => {
    const html = renderToStaticMarkup(createElement(BrowserRail, { ...props, width: 5000 }))
    expect(html).toContain('width:900px')
    expect(html).toContain('min-width:280px')
    expect(html).toContain('max-width:900px')
    expect(html).toContain('aria-valuemax="900"')
    expect(html).toContain('aria-valuenow="900"')
    expect(html).toContain('aria-valuetext="900 pixels"')
  })

  it('labels collapsed and terminal-zoom states without mounting a page slot', () => {
    const collapsed = renderToStaticMarkup(createElement(BrowserRail, { ...props, collapsed: true }))
    expect(collapsed).toContain('aria-label="Tab browser collapsed"')
    expect(collapsed).not.toContain('tab-browser-page-slot')
    const zoomed = renderToStaticMarkup(createElement(BrowserRail, { ...props, temporarilyHidden: true }))
    expect(zoomed).toContain('aria-label="Tab browser hidden while terminal is zoomed"')
    expect(zoomed).toContain('Terminal zoom')
  })
})
