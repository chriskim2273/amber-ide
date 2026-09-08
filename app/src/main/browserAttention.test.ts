import { describe, expect, it, vi } from 'vitest'
import { requestBrowserAttention } from './browserAttention'

describe('background browser approval attention', () => {
  it('signals only living local windows without activating them', () => {
    const live = { isDestroyed: () => false, flashFrame: vi.fn(), focus: vi.fn(), show: vi.fn() }
    const dead = { isDestroyed: () => true, flashFrame: vi.fn() }
    const remote = { isDestroyed: () => false, flashFrame: vi.fn() }
    requestBrowserAttention([{ local: true, window: live }, { local: true, window: dead }, { local: false, window: remote }])
    expect(live.flashFrame).toHaveBeenCalledWith(true)
    expect(dead.flashFrame).not.toHaveBeenCalled()
    expect(remote.flashFrame).not.toHaveBeenCalled()
    expect(live.show).not.toHaveBeenCalled()
    expect(live.focus).not.toHaveBeenCalled()
  })
})
