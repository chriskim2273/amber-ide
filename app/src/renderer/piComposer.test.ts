import { describe, expect, it } from 'vitest'
import { shouldSubmitComposerKey } from './PiComposer'

describe('Pi composer key policy', () => {
  it('submits plain Enter but preserves Shift+Enter and IME composition', () => {
    expect(shouldSubmitComposerKey('Enter', false, false)).toBe(true)
    expect(shouldSubmitComposerKey('Enter', true, false)).toBe(false)
    expect(shouldSubmitComposerKey('Enter', false, true)).toBe(false)
    expect(shouldSubmitComposerKey('a', false, false)).toBe(false)
  })
})
