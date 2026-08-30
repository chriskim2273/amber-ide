import { describe, expect, it } from 'vitest'
import { KeyboardInputModeTracker, shiftEnterSequence } from './terminalKeys'

describe('shiftEnterSequence', () => {
  it('reports a real Shift+Enter to Pi using CSI-u', () => {
    expect(shiftEnterSequence('pi')).toBe('\x1b[13;2u')
  })

  it('keeps the negotiation-free Meta+Enter fallback for Claude Code', () => {
    expect(shiftEnterSequence('claude')).toBe('\x1b\r')
  })

  it('keeps the legacy fallback for other terminal programs', () => {
    expect(shiftEnterSequence('shell')).toBe('\x1b\r')
  })

  it('follows split modifyOtherKeys negotiation from Pi launched in a shell pane', () => {
    const tracker = new KeyboardInputModeTracker()
    tracker.feed(new TextEncoder().encode('\x1b[>7u\x1b[?u\x1b[c\x1b[>4;'))
    tracker.feed(new TextEncoder().encode('2m'))
    expect(shiftEnterSequence('shell', tracker.current)).toBe('\x1b[27;2;13~')

    tracker.feed(new TextEncoder().encode('\x1b[<u\x1b[>4;0m'))
    expect(shiftEnterSequence('shell', tracker.current)).toBe('\x1b\r')
  })

  it('uses CSI-u while an application has requested Kitty keyboard mode', () => {
    const tracker = new KeyboardInputModeTracker()
    tracker.feed(new TextEncoder().encode('\x1b[>7u'))
    expect(shiftEnterSequence('shell', tracker.current)).toBe('\x1b[13;2u')
    tracker.feed(new TextEncoder().encode('\x1b[<u'))
    expect(shiftEnterSequence('shell', tracker.current)).toBe('\x1b\r')
  })
})
