import { describe, it, expect } from 'vitest'
import { backoffDelay, launchIfAbsent, nextAttempt, shouldRelaunchClient } from './clientSupervisor'

const cfg = { baseMs: 100, maxMs: 2000 }

describe('backoffDelay', () => {
  it('grows exponentially from the base', () => {
    expect(backoffDelay(0, cfg)).toBe(100)
    expect(backoffDelay(1, cfg)).toBe(200)
    expect(backoffDelay(2, cfg)).toBe(400)
    expect(backoffDelay(3, cfg)).toBe(800)
  })
  it('caps at maxMs', () => {
    expect(backoffDelay(5, cfg)).toBe(2000)
    expect(backoffDelay(50, cfg)).toBe(2000)
  })
  it('clamps a negative attempt to the base', () => {
    expect(backoffDelay(-3, cfg)).toBe(100)
  })
})

describe('nextAttempt', () => {
  it('resets to 0 after a child that stayed up past the stable threshold', () => {
    expect(nextAttempt(4, 10_000, 5_000)).toBe(0)
    expect(nextAttempt(0, 5_000, 5_000)).toBe(0) // exactly at threshold
  })
  it('grows on an instant crash so backoff widens', () => {
    expect(nextAttempt(0, 0, 5_000)).toBe(1)
    expect(nextAttempt(1, 20, 5_000)).toBe(2)
    expect(nextAttempt(2, 200, 5_000)).toBe(3)
  })
  it('a fork-then-die loop keeps climbing (never resets)', () => {
    let a = 0
    for (let i = 0; i < 6; i++) a = nextAttempt(a, 5, 5_000)
    expect(a).toBe(6)
    // and the delay it feeds is capped, not unbounded
    expect(backoffDelay(a, cfg)).toBe(2000)
  })
})

describe('launchIfAbsent', () => {
  it('keeps one active client when startup is requested twice', () => {
    let launches = 0
    const first = launchIfAbsent<object>(null, () => {
      launches += 1
      return { id: launches }
    })
    const second = launchIfAbsent(first, () => {
      launches += 1
      return { id: launches }
    })

    expect(second).toBe(first)
    expect(launches).toBe(1)
  })
})

describe('shouldRelaunchClient', () => {
  it('relaunches while its owning window and app remain active', () => {
    expect(shouldRelaunchClient({
      quitting: false,
      windowClosed: false,
      windowDestroyed: false,
    })).toBe(true)
  })

  it('does not relaunch after its owning window closes', () => {
    expect(shouldRelaunchClient({
      quitting: false,
      windowClosed: true,
      windowDestroyed: false,
    })).toBe(false)
  })

  it.each([
    { quitting: true, windowClosed: false, windowDestroyed: false },
    { quitting: false, windowClosed: false, windowDestroyed: true },
  ])('does not relaunch for inactive app/window state %#', (state) => {
    expect(shouldRelaunchClient(state)).toBe(false)
  })
})
