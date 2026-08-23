import { describe, it, expect } from 'vitest'
import {
  arrowSeq, keyBytes, KEY_BAR, takeWholeLines, altScrollKeys, MAX_ALT_KEYS,
} from './touchInput'

describe('arrowSeq', () => {
  it('uses CSI in normal mode and SS3 in application mode', () => {
    // A TUI sets application cursor mode; the wrong form types literal junk
    // into the prompt instead of moving the cursor.
    expect(arrowSeq('up', false)).toBe('\x1b[A')
    expect(arrowSeq('up', true)).toBe('\x1bOA')
    expect(arrowSeq('left', false)).toBe('\x1b[D')
    expect(arrowSeq('right', true)).toBe('\x1bOC')
  })

  it('uses the CSI modifier form for ctrl+arrow in either mode', () => {
    expect(arrowSeq('down', true, true)).toBe('\x1b[1;5B')
    expect(arrowSeq('down', false, true)).toBe('\x1b[1;5B')
  })
})

describe('keyBytes', () => {
  it('sends the plain control keys', () => {
    expect(keyBytes('esc', false, false)).toBe('\x1b')
    expect(keyBytes('tab', false, false)).toBe('\t')
    expect(keyBytes('enter', false, false)).toBe('\r')
    expect(keyBytes('slash', false, false)).toBe('/')
    expect(keyBytes('ctrl-c', false, false)).toBe('\x03')
  })

  it('sends CSI Z for shift-tab', () => {
    // claude's mode cycle. A key bar without this fails the primary use case.
    expect(keyBytes('shift-tab', false, false)).toBe('\x1b[Z')
  })

  it('turns a letter into its control code under sticky ctrl', () => {
    expect(keyBytes('c', false, true)).toBe('\x03')
    expect(keyBytes('d', false, true)).toBe('\x04')
    expect(keyBytes('c', false, false)).toBe('c')
  })

  it('sends nothing for the modifier itself', () => {
    expect(keyBytes('ctrl', false, false)).toBe('')
  })
})

describe('KEY_BAR', () => {
  it('carries every key a TUI session needs from a thumb', () => {
    const keys = KEY_BAR.map((k) => k.key)
    for (const need of ['esc', 'tab', 'shift-tab', 'ctrl', 'up', 'down', 'left', 'right', 'enter', 'slash', 'ctrl-c']) {
      expect(keys).toContain(need)
    }
  })
})

describe('takeWholeLines', () => {
  it('carries the remainder so a slow drag still moves eventually', () => {
    expect(takeWholeLines(0.6)).toEqual({ whole: 0, rest: 0.6 })
    expect(takeWholeLines(1.4)).toEqual({ whole: 1, rest: expect.closeTo(0.4) })
  })

  it('rounds towards zero in both directions', () => {
    expect(takeWholeLines(-1.4).whole).toBe(-1)
    expect(takeWholeLines(-0.4).whole).toBe(0)
  })
})

describe('altScrollKeys', () => {
  it('sends one arrow per line, in the direction of travel', () => {
    expect(altScrollKeys(3, false)).toBe('\x1b[B'.repeat(3))
    expect(altScrollKeys(-2, false)).toBe('\x1b[A'.repeat(2))
    expect(altScrollKeys(2, true)).toBe('\x1bOB'.repeat(2))
  })

  it('caps one gesture so a flick cannot spray hundreds of keys at a TUI', () => {
    expect(altScrollKeys(500, false)).toBe('\x1b[B'.repeat(MAX_ALT_KEYS))
  })

  it('sends nothing for no movement', () => {
    expect(altScrollKeys(0, false)).toBe('')
  })
})
