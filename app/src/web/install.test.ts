import { describe, expect, it } from 'vitest'
import { webMachineName } from './install'

describe('webMachineName', () => {
  it('keeps an IPv4 literal whole', () => {
    // Splitting on '.' rendered the phone's header as "127".
    expect(webMachineName('127.0.0.1')).toBe('127.0.0.1')
    expect(webMachineName('192.168.1.42')).toBe('192.168.1.42')
  })

  it('keeps an IPv6 literal whole', () => {
    expect(webMachineName('::1')).toBe('::1')
    expect(webMachineName('fd7a:115c:a1e0::1')).toBe('fd7a:115c:a1e0::1')
  })

  it('shortens a real host to its first label', () => {
    expect(webMachineName('teapot-dev.tail3d57b4.ts.net')).toBe('teapot-dev')
    expect(webMachineName('teapot-dev')).toBe('teapot-dev')
  })

  it('falls back when there is no hostname', () => {
    expect(webMachineName('')).toBe('amber')
  })
})
