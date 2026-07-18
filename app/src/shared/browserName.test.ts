import { describe, it, expect } from 'vitest'
import { formatBrowserName, parseBrowserName, isBrowserName, normalizeUrl } from './browserName'

describe('browser id', () => {
  it('round-trips', () => {
    const n = formatBrowserName({ ws: 2, tab: 3, ord: 1, id: 'abc' })
    expect(n).toBe('browser-2-3-1-abc')
    expect(parseBrowserName(n)).toEqual({ ws: 2, tab: 3, ord: 1, id: 'abc' })
  })
  it('isBrowserName distinguishes daemon names', () => {
    expect(isBrowserName('browser-1-1-0-x')).toBe(true)
    expect(isBrowserName('amber-1-1-0-x')).toBe(false)
  })
  it('rejects malformed', () => {
    expect(parseBrowserName('amber-1-1-0-x')).toBeNull()
    expect(parseBrowserName('browser-x-1-0-x')).toBeNull()
    expect(parseBrowserName('browser-1-1-0')).toBeNull()
  })
})

describe('normalizeUrl', () => {
  it('keeps schemed urls', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com')
    expect(normalizeUrl('http://localhost:3000')).toBe('http://localhost:3000')
    expect(normalizeUrl('about:blank')).toBe('about:blank')
  })
  it('http for localhost/loopback host:port', () => {
    expect(normalizeUrl('localhost:3000')).toBe('http://localhost:3000')
    expect(normalizeUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
  })
  it('https for a bare domain', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com')
    expect(normalizeUrl('foo.dev/path')).toBe('https://foo.dev/path')
  })
  it('trims + returns "" for empty', () => {
    expect(normalizeUrl('  ')).toBe('')
  })
})
