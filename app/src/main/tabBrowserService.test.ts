import { describe, expect, it } from 'vitest'
import { parseTabBrowserCommand } from './tabBrowserService'

describe('parseTabBrowserCommand', () => {
  it('accepts the bounded renderer command surface', () => {
    expect(parseTabBrowserCommand({ type: 'open' })).toEqual({ type: 'open' })
    expect(parseTabBrowserCommand({ type: 'show', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', bounds: { x: 1, y: 2, width: 3, height: 4 } })).toEqual({ type: 'show', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', bounds: { x: 1, y: 2, width: 3, height: 4 } })
  })
  it('rejects generic methods, unknown keys, invalid ids, and unsafe geometry', () => {
    expect(() => parseTabBrowserCommand({ type: 'cdp', method: 'Runtime.evaluate' })).toThrow('INVALID_REQUEST')
    expect(() => parseTabBrowserCommand({ type: 'open', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })).toThrow('INVALID_REQUEST')
    expect(() => parseTabBrowserCommand({ type: 'status', id: 'browser-a' })).toThrow('INVALID_REQUEST')
    expect(() => parseTabBrowserCommand({ type: 'bounds', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', bounds: { x: 0, y: 0, width: NaN, height: 2 } })).toThrow('INVALID_REQUEST')
    expect(() => parseTabBrowserCommand({ type: 'bounds', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', bounds: { x: 0, y: 0, width: 100_000, height: 2 } })).toThrow('INVALID_REQUEST')
  })
})
