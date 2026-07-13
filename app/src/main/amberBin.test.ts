import { describe, it, expect } from 'vitest'
import { resolveAmberBinary } from './amberBin'

describe('resolveAmberBinary', () => {
  it('honors AMBER_BIN override', () => {
    expect(resolveAmberBinary({ AMBER_BIN: '/x/amber' }, true, '/res')).toBe('/x/amber')
  })
  it('uses the bundled resources path when packaged', () => {
    expect(resolveAmberBinary({}, true, '/app/resources')).toBe('/app/resources/bin/amber')
  })
  it('falls back to PATH lookup in dev', () => {
    expect(resolveAmberBinary({}, false, '/app/resources')).toBe('amber')
  })
})
