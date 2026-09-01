import { describe, expect, it } from 'vitest'
import { parseTabBrowserCommand } from './tabBrowserService'

describe('parseTabBrowserCommand', () => {
  it('accepts the bounded renderer command surface', () => {
    expect(parseTabBrowserCommand({ type: 'open' })).toEqual({ type: 'open' })
    expect(parseTabBrowserCommand({ type: 'show', id: 'browser-a', bounds: { x: 1, y: 2, width: 3, height: 4 } })).toEqual({ type: 'show', id: 'browser-a', bounds: { x: 1, y: 2, width: 3, height: 4 } })
  })
  it('rejects generic methods and malformed geometry', () => {
    expect(() => parseTabBrowserCommand({ type: 'cdp', method: 'Runtime.evaluate' })).toThrow('INVALID_REQUEST')
    expect(() => parseTabBrowserCommand({ type: 'bounds', id: 'x', bounds: { x: 0, y: 0, width: NaN, height: 2 } })).toThrow('INVALID_REQUEST')
  })
})
