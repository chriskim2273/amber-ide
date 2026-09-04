import { describe, expect, it } from 'vitest'
import { projectInPageNavigation } from './electronTabBrowserPage'
import { shouldRecordUserInput } from './browserInput'

describe('Electron tab browser page events', () => {
  it('does not treat adapter-generated input as a second user generation change', () => {
    expect(shouldRecordUserInput(false)).toBe(true)
    expect(shouldRecordUserInput(true)).toBe(false)
  })

  it('projects only bounded main-frame history/hash navigation', () => {
    expect(projectInPageNavigation('https://example.test/app#next', true)).toEqual({ type: 'navigation-in-page', url: 'https://example.test/app#next' })
    expect(projectInPageNavigation('https://frame.example/', false)).toBeNull()
    const bounded = projectInPageNavigation(`https://example.test/${'x'.repeat(9000)}`, true)
    expect(bounded?.type === 'navigation-in-page' ? bounded.url.length : 0).toBe(8192)
  })
})
