import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { BrowserRail } from './BrowserRail'

const props = {
  id: '0123456789ABCDEFGHJKMNPQRS', width: 420, collapsed: false,
  controllers: [{ name: 'amber-1-1-0-pi', label: 'Pi' }],
  onWidth: vi.fn(), onCollapsed: vi.fn(), onClose: vi.fn(), onRecovery: vi.fn(), onPolicy: vi.fn(),
  ensureContext: async () => {},
}

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

  it('labels collapsed and terminal-zoom states without mounting a page slot', () => {
    const collapsed = renderToStaticMarkup(createElement(BrowserRail, { ...props, collapsed: true }))
    expect(collapsed).toContain('aria-label="Tab browser collapsed"')
    expect(collapsed).not.toContain('tab-browser-page-slot')
    const zoomed = renderToStaticMarkup(createElement(BrowserRail, { ...props, temporarilyHidden: true }))
    expect(zoomed).toContain('aria-label="Tab browser hidden while terminal is zoomed"')
    expect(zoomed).toContain('Terminal zoom')
  })
})
