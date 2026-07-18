import { describe, it, expect } from 'vitest'
import { isClaudeSessionId } from './ids'

describe('isClaudeSessionId (reload-claude command-injection guard)', () => {
  it('accepts a real UUID session id', () => {
    expect(isClaudeSessionId('91b9f942-914d-4ea0-8c29-cef2c8b3b984')).toBe(true)
    expect(isClaudeSessionId('1818A7D5-E580-4B1A-A37D-023F8EBFBE52')).toBe(true) // case-insensitive
  })

  it('rejects anything with shell metacharacters or wrong shape', () => {
    expect(isClaudeSessionId('91b9f942-914d-4ea0-8c29-cef2c8b3b984; rm -rf ~')).toBe(false)
    expect(isClaudeSessionId('$(reboot)')).toBe(false)
    expect(isClaudeSessionId('`id`')).toBe(false)
    expect(isClaudeSessionId('abc && curl evil')).toBe(false)
    expect(isClaudeSessionId('')).toBe(false)
    expect(isClaudeSessionId('not-a-uuid')).toBe(false)
    // right hex charset but wrong length/shape must still fail.
    expect(isClaudeSessionId('91b9f942914d4ea08c29cef2c8b3b984')).toBe(false)
  })
})
