import { describe, expect, it, vi } from 'vitest'
import { loadOptionalWebgl } from './terminalRenderer'

describe('loadOptionalWebgl', () => {
  it('falls back to xterm DOM rendering when WebGL2 is unavailable', () => {
    const dispose = vi.fn()
    const loadAddon = vi.fn(() => { throw new Error('WebGL2 not supported') })

    expect(loadOptionalWebgl({ loadAddon }, { dispose })).toBe(false)
    expect(loadAddon).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('reports the WebGL fast path when the addon loads', () => {
    const dispose = vi.fn()
    const loadAddon = vi.fn()

    expect(loadOptionalWebgl({ loadAddon }, { dispose })).toBe(true)
    expect(dispose).not.toHaveBeenCalled()
  })
})
