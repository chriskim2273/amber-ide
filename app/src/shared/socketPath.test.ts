import { describe, it, expect } from 'vitest'
import { resolveSocketPath } from './socketPath'

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
