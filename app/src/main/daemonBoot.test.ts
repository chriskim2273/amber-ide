import { describe, it, expect } from 'vitest'
import { ensureDaemon, isSocketAbsentError } from './daemonBoot'

describe('ensureDaemon', () => {
  it('returns immediately when the daemon already answers', async () => {
    let installs = 0
    await ensureDaemon('/x.sock', {
      probe: async () => true,
      install: async () => { installs += 1 },
      delayMs: () => 0,
      attempts: 5,
    })
    expect(installs).toBe(0)
  })

  it('runs a preflight even when the daemon already answers', async () => {
    let preflights = 0
    let installs = 0
    await ensureDaemon('/x.sock', {
      preflight: async () => { preflights += 1 },
      probe: async () => true,
      install: async () => { installs += 1 },
      delayMs: () => 0,
      attempts: 5,
    })
    expect(preflights).toBe(1)
    expect(installs).toBe(0)
  })

  it('installs then retries until the daemon answers', async () => {
    let installs = 0
    const answers = [false, false, true]
    let i = 0
    await ensureDaemon('/x.sock', {
      probe: async () => answers[i++] ?? true,
      install: async () => { installs += 1 },
      delayMs: () => 0,
      attempts: 5,
    })
    expect(installs).toBe(1)
  })

  it('throws after exhausting attempts', async () => {
    await expect(ensureDaemon('/x.sock', {
      probe: async () => false,
      install: async () => {},
      delayMs: () => 0,
      attempts: 3,
    })).rejects.toThrow()
  })
})

describe('isSocketAbsentError', () => {
  it('accepts only Node\'s exact missing-endpoint code', () => {
    expect(isSocketAbsentError(Object.assign(new Error('missing'), { code: 'ENOENT' }))).toBe(true)
    expect(isSocketAbsentError(Object.assign(new Error('denied'), { code: 'EACCES' }))).toBe(false)
    expect(isSocketAbsentError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))).toBe(false)
  })
})
