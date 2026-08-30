import { describe, it, expect } from 'vitest'
import {
  applyViewportMode,
  desktopControlSize,
  DESKTOP_VIEWPORT_CONTENT,
  isMobileMode,
  isMobileViewport,
  MOBILE_MAX_WIDTH,
  MOBILE_VIEWPORT_CONTENT,
} from './mobile'

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

describe('isMobileMode', () => {
  it('lets an explicit user choice override transient viewport measurements', () => {
    expect(isMobileMode(false, 'pocket')).toBe(true)
    expect(isMobileMode(true, 'desktop')).toBe(false)
    expect(isMobileMode(true, 'auto')).toBe(true)
    expect(isMobileMode(false, 'auto')).toBe(false)
  })
})

describe('desktopControlSize', () => {
  it('keeps the return control at a physical 48px through page scaling', () => {
    expect(desktopControlSize(1)).toBe(48)
    expect(desktopControlSize(0.4) * 0.4).toBeCloseTo(48)
    expect(desktopControlSize(0)).toBe(48)
  })
})

describe('applyViewportMode', () => {
  it('switches between a fitted desktop canvas and the normal device-width viewport', () => {
    let content = ''
    const doc = {
      querySelector: (selector: string) => selector === 'meta[name="viewport"]'
        ? { setAttribute: (name: string, value: string) => { if (name === 'content') content = value } }
        : null,
    }

    expect(applyViewportMode(doc, true)).toBe(true)
    expect(content).toBe(DESKTOP_VIEWPORT_CONTENT)
    expect(applyViewportMode(doc, false)).toBe(true)
    expect(content).toBe(MOBILE_VIEWPORT_CONTENT)
  })

  it('declines safely when the host page has no viewport metadata', () => {
    expect(applyViewportMode({ querySelector: () => null }, true)).toBe(false)
  })
})
