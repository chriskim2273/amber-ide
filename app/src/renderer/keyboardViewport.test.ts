import { describe, it, expect } from 'vitest'
import { keyboardOpen, KEYBOARD_MIN_PX } from './keyboardViewport'

describe('keyboardOpen', () => {
  it('detects a soft keyboard eating the bottom of the viewport', () => {
    // iPhone 13: 844pt tall, keyboard ~336pt.
    expect(keyboardOpen(844, 508)).toBe(true)
  })

  it('ignores a small overlay like a collapsing URL bar', () => {
    expect(keyboardOpen(844, 844 - (KEYBOARD_MIN_PX - 1))).toBe(false)
  })

  it('is false when nothing is covering the page', () => {
    expect(keyboardOpen(844, 844)).toBe(false)
  })

  it('is false where visualViewport does not exist', () => {
    // Desktop Electron and older browsers: never pin rows there.
    expect(keyboardOpen(844, null)).toBe(false)
  })

  it('does NOT fire for an orientation change, which moves both heights', () => {
    // Landscape: innerHeight AND visualViewport.height both become 390. The
    // terminal really did change shape, so it must be allowed to re-fit —
    // pinning rows here would leave the pane the wrong size until reload.
    expect(keyboardOpen(390, 390)).toBe(false)
  })
})
