import { describe, it, expect } from 'vitest'
import { resolveSocketPath, windowsPipePath } from './socketPath'

describe('resolveSocketPath', () => {
  it('prefers XDG_RUNTIME_DIR', () => {
    expect(resolveSocketPath({ XDG_RUNTIME_DIR: '/run/user/1000' }))
      .toBe('/run/user/1000/amber-ide/amberd.sock')
  })
  it('falls back to XDG_STATE_HOME when runtime dir is empty', () => {
    expect(resolveSocketPath({ XDG_RUNTIME_DIR: '', XDG_STATE_HOME: '/x/state' }))
      .toBe('/x/state/amber-ide/amberd.sock')
  })
  it('falls back to HOME/.local/state when neither set', () => {
    expect(resolveSocketPath({ HOME: '/home/u' }))
      .toBe('/home/u/.local/state/amber-ide/amberd.sock')
  })
})

// The Windows pipe name must byte-match the Rust daemon's
// `#[cfg(windows)] default_socket()` (alphanumeric sanitization).
describe('windowsPipePath', () => {
  it('builds a per-user pipe name from USERNAME', () => {
    expect(windowsPipePath({ USERNAME: 'alice' })).toBe('\\\\.\\pipe\\amber-ide-alice')
  })
  it('sanitizes non-alphanumeric chars to dashes (matches the Rust daemon)', () => {
    expect(windowsPipePath({ USERNAME: 'DOMAIN\\Jörg 2' })).toBe(
      '\\\\.\\pipe\\amber-ide-DOMAIN-J-rg-2',
    )
  })
  it('falls back to "user" when USERNAME is unset', () => {
    expect(windowsPipePath({})).toBe('\\\\.\\pipe\\amber-ide-user')
  })
})
