import { describe, it, expect } from 'vitest'
import { isMobileViewport, MOBILE_MAX_WIDTH } from './mobile'

describe('isMobileViewport', () => {
  it('is true for a phone: narrow AND coarse', () => {
    expect(isMobileViewport(390, true)).toBe(true)
  })

  it('is false for a narrow DESKTOP window', () => {
    // Capability, not size alone: shrinking a desktop window must not swap in
    // a key bar and long-press drags for a mouse user.
    expect(isMobileViewport(390, false)).toBe(false)
  })

  it('is false for a large touchscreen', () => {
    // A touch laptop or a desk monitor with a digitizer is coarse-pointered but
    // has room for the real chrome.
    expect(isMobileViewport(1200, true)).toBe(false)
  })

  it('treats the boundary as inclusive', () => {
    expect(isMobileViewport(MOBILE_MAX_WIDTH, true)).toBe(true)
    expect(isMobileViewport(MOBILE_MAX_WIDTH + 1, true)).toBe(false)
  })
})
