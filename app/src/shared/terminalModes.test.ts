import { describe, expect, it } from 'vitest'
import {
  ALT_SCREEN_EXIT,
  MOUSE_RESET,
  isLiveTuiRunState,
  settleReplayedModes,
  shouldSettleReplayedModes,
} from './terminalModes'

describe('isLiveTuiRunState', () => {
  it('is the exact inverse of shouldSettleReplayedModes', () => {
    for (const s of [undefined, '', 'claude', 'suspend-failed', 'claude-retrying', 'suspended', 'shell-fallback', 'bogus']) {
      expect(isLiveTuiRunState(s)).toBe(!shouldSettleReplayedModes(s))
    }
  })
})

describe('shouldSettleReplayedModes', () => {
  it('settles shells and unknown states (nothing alive owns the modes)', () => {
    expect(shouldSettleReplayedModes(undefined)).toBe(true)
    expect(shouldSettleReplayedModes('')).toBe(true)
    expect(shouldSettleReplayedModes('bogus-future-state')).toBe(true)
  })

  it('settles parked, retrying, and fallback agents (TUI dead; a relaunch re-enables)', () => {
    for (const s of ['claude-retrying', 'suspended', 'shell-fallback']) {
      expect(shouldSettleReplayedModes(s)).toBe(true)
    }
  })

  it('skips live agent TUIs (they never re-assert their modes)', () => {
    expect(shouldSettleReplayedModes('claude')).toBe(false)
    expect(shouldSettleReplayedModes('suspend-failed')).toBe(false)
  })
})

describe('settleReplayedModes', () => {
  it('exits alt-screen first, then clears every tracking mode', () => {
    const writes: string[] = []
    settleReplayedModes({ write: (d: string) => writes.push(d) }, undefined)
    expect(writes).toEqual([ALT_SCREEN_EXIT, MOUSE_RESET])
  })

  it('writes nothing for a live agent TUI', () => {
    const writes: string[] = []
    settleReplayedModes({ write: (d: string) => writes.push(d) }, 'claude')
    expect(writes).toEqual([])
  })

  it('pins the exact escape coverage (a missing mode is hover spam again)', () => {
    expect(ALT_SCREEN_EXIT).toBe('\x1b[?1049l')
    for (const mode of [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1015, 1016]) {
      expect(MOUSE_RESET).toContain(`\x1b[?${mode}l`)
    }
    // Bracketed paste is the shell's own negotiation (bash enables it); the
    // settle must never touch it.
    expect(MOUSE_RESET).not.toContain('?2004l')
  })
})
