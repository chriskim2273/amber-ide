import { describe, expect, it } from 'vitest'
import { formatLastPiAction, secondsRemaining } from './browserRailModel'

describe('browser rail approval/action presentation', () => {
  it('counts a 60 second approval down live without going negative', () => {
    expect(secondsRemaining(61_000, 1_000)).toBe(60)
    expect(secondsRemaining(61_000, 60_100)).toBe(1)
    expect(secondsRemaining(61_000, 61_001)).toBe(0)
  })

  it('renders started, completed, and stable failed action summaries', () => {
    expect(formatLastPiAction({ action: 'click', phase: 'started' })).toBe('Pi click: started')
    expect(formatLastPiAction({ action: 'click', phase: 'completed' })).toBe('Pi click: completed')
    expect(formatLastPiAction({ action: 'click', phase: 'failed', error: 'TARGET_OCCLUDED' })).toBe('Pi click: failed (TARGET_OCCLUDED)')
  })
})
