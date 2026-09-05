import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { BrowserRail, browserCommandNeedsContext, shouldRevokeDesignatedPi } from './BrowserRail'

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
})

describe('BrowserRail accessibility contract', () => {
  it('renders keyboard-addressable navigation, focus, viewport, controller, recovery, and resize controls', () => {
    const html = renderToStaticMarkup(createElement(BrowserRail, { ...props, designatedPi: 'amber-1-1-0-pi', sharedWithPi: true }))
    expect(html).toContain('aria-label="Browser navigation"')
    expect(html).toContain('aria-label="Browser address"')
    expect(html).toContain('aria-label="Browser mode"')
    expect(html).toContain('aria-label="Pi browser controller"')
    expect(html).toContain('aria-label="Focus browser page"')
    expect(html).toContain('>Recovery<')
    expect(html).toContain('role="separator"')
    expect(html).toContain('aria-orientation="vertical"')
    expect(html).toContain('aria-valuenow="420"')
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
