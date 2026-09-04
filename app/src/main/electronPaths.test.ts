import { describe, expect, it } from 'vitest'
import { electronPaths } from './electronPaths'

describe('Electron private path overrides', () => {
  it('uses the validation overrides without changing the production defaults', () => {
    expect(electronPaths({ AMBER_ELECTRON_USER_DATA: '/tmp/user', AMBER_ELECTRON_CACHE: '/tmp/session' }, { userData: '/default/user', sessionData: '/default/session' })).toEqual({ userData: '/tmp/user', sessionData: '/tmp/session' })
    expect(electronPaths({}, { userData: '/default/user', sessionData: '/default/session' })).toEqual({ userData: '/default/user', sessionData: '/default/session' })
  })
})
