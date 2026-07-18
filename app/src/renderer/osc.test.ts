import { describe, it, expect } from 'vitest'
import { decodeOsc52Payload } from './osc'

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')

describe('decodeOsc52Payload', () => {
  it('decodes a clipboard-write payload (selection ; base64)', () => {
    expect(decodeOsc52Payload(`c;${b64('hello world')}`)).toBe('hello world')
    // any selection char (p = primary, s, 0-7) works — we only split on the ';'.
    expect(decodeOsc52Payload(`p;${b64('primary')}`)).toBe('primary')
  })

  it('round-trips UTF-8 (accents/emoji)', () => {
    expect(decodeOsc52Payload(`c;${b64('café — 🚀')}`)).toBe('café — 🚀')
  })

  it('denies a clipboard-READ request ("?") — never leaks the clipboard', () => {
    expect(decodeOsc52Payload('c;?')).toBeNull()
    expect(decodeOsc52Payload('p;?')).toBeNull()
  })

  it('ignores malformed input', () => {
    expect(decodeOsc52Payload('no-semicolon')).toBeNull()   // no selection separator
    expect(decodeOsc52Payload('c;')).toBeNull()             // empty payload
    expect(decodeOsc52Payload('c;@@@not-base64@@@')).toBeNull()
  })
})
