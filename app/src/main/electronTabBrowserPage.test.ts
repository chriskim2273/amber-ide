import { describe, expect, it } from 'vitest'
import { projectInPageNavigation } from './electronTabBrowserPage'

describe('Electron tab browser page events', () => {
  it('projects only bounded main-frame history/hash navigation', () => {
    expect(projectInPageNavigation('https://example.test/app#next', true)).toEqual({ type: 'navigation-in-page', url: 'https://example.test/app#next' })
    expect(projectInPageNavigation('https://frame.example/', false)).toBeNull()
    const bounded = projectInPageNavigation(`https://example.test/${'x'.repeat(9000)}`, true)
    expect(bounded?.type === 'navigation-in-page' ? bounded.url.length : 0).toBe(8192)
  })
})
