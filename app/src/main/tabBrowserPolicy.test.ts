import { describe, expect, it } from 'vitest'
import { BrowserCapacity, browserWebPreferences, isAllowedBrowserUrl } from './tabBrowserPolicy'

describe('browser security policy', () => {
  it('creates hardened remote preferences', () => {
    expect(browserWebPreferences('persist:amber-browser')).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, partition: 'persist:amber-browser' })
    expect(browserWebPreferences('persist:amber-browser')).not.toHaveProperty('preload')
  })
  it('allows only HTTP(S) and exact about:blank', () => {
    expect(isAllowedBrowserUrl('https://example.test/a')).toBe(true)
    expect(isAllowedBrowserUrl('about:blank')).toBe(true)
    expect(isAllowedBrowserUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedBrowserUrl('javascript:alert(1)')).toBe(false)
  })
})

describe('four-live capacity', () => {
  it('freezes the eligible least-recent browser', () => {
    const c = new BrowserCapacity(4)
    for (let i = 1; i <= 4; i++) c.markLive(`b${i}`, i)
    c.protect('b1', true)
    expect(c.activate('b5', 5)).toEqual({ freeze: 'b2' })
    expect(c.liveIds()).toEqual(['b1', 'b3', 'b4', 'b5'])
  })
  it('fails boundedly when all live pages are protected', () => {
    const c = new BrowserCapacity(2)
    c.markLive('a', 1); c.markLive('b', 2); c.protect('a', true); c.protect('b', true)
    expect(c.activate('c', 3)).toEqual({ busy: true })
  })
})
