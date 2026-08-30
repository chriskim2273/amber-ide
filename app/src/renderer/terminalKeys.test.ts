import { describe, expect, it } from 'vitest'
import { shiftEnterSequence } from './terminalKeys'

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
})
