import { describe, it, expect } from 'vitest'
import { keyboardInset, keyboardOpen, terminalLift, KEYBOARD_MIN_PX } from './keyboardViewport'

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

  it('accounts for a visual viewport shifted down by browser chrome', () => {
    // Visible bottom = 8 + 500 = 508, so the keyboard covers 336px, not 344px.
    expect(keyboardInset(844, 500, 8)).toBe(336)
    expect(keyboardOpen(844, 500, 8)).toBe(true)
  })
})

describe('terminalLift', () => {
  it('raises the cursor above both the keyboard and terminal key bar', () => {
    expect(terminalLift({
      hostTop: 120,
      cursorRow: 40,
      cellHeight: 15,
      visibleBottom: 508,
      dockHeight: 56,
    })).toBe(291)
  })

  it('does not move a cursor that is already visible', () => {
    expect(terminalLift({
      hostTop: 80,
      cursorRow: 8,
      cellHeight: 15,
      visibleBottom: 508,
      dockHeight: 56,
    })).toBe(0)
  })

  it('rejects invalid geometry instead of producing a transform', () => {
    expect(terminalLift({
      hostTop: 80,
      cursorRow: 8,
      cellHeight: 0,
      visibleBottom: 508,
      dockHeight: 56,
    })).toBe(0)
  })
})
