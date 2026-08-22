import { describe, it, expect } from 'vitest'
import { diagnosticRows } from './RemoteAccess'
import type { WebStatus } from '../main/webService'

const base: WebStatus = {
  unit: 'active',
  port: 7717,
  url: 'https://d.ts.net/app',
  tailscale: 'serving',
  host: 'd.ts.net',
  hasToken: true,
  clients: [],
  sessions: 0,
  uptimeSecs: 1,
  error: null,
}

describe('diagnosticRows', () => {
  it('is all-green when the unit is active and tailscale is serving', () => {
    expect(diagnosticRows(base).every((r) => r.ok)).toBe(true)
  })

  it('names the fix for each tailscale failure instead of a dead red row', () => {
    for (const [state, needle] of [
      ['not-installed', 'install'],
      ['not-logged-in', 'tailscale up'],
      ['not-running', 'start'],
      ['serve-not-mapped', 'serve'],
    ] as const) {
      const row = diagnosticRows({ ...base, tailscale: state }).find((r) => r.label === 'tailscale')
      expect(row?.ok).toBe(false)
      expect(row?.hint.toLowerCase()).toContain(needle)
    }
  })

  it('flags an inactive unit', () => {
    const row = diagnosticRows({ ...base, unit: 'inactive' }).find((r) => r.label === 'service')
    expect(row?.ok).toBe(false)
  })

  it('flags an unreachable server separately from a stopped unit', () => {
    const row = diagnosticRows({ ...base, sessions: null }).find((r) => r.label === 'daemon')
    expect(row?.ok).toBe(false)
    expect(row?.hint).toContain('unreachable')
  })

  it('flags a missing token', () => {
    const row = diagnosticRows({ ...base, hasToken: false }).find((r) => r.label === 'token')
    expect(row?.ok).toBe(false)
  })
})
