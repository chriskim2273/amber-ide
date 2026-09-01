import { describe, expect, it } from 'vitest'
import { diagnosticRows } from './RouterPanel'
import type { RouterStatus } from '../shared/routerStatus'

const base: RouterStatus = {
  managed: true,
  unit: 'active',
  port: 7719,
  url: 'http://127.0.0.1:7719/v1',
  alias: 'auto',
  hasToken: true,
  pi: 'installed',
  slots: [
    {
      id: 'a',
      name: 'alpha',
      baseUrl: 'https://a.example/v1',
      model: 'm',
      enabled: true,
      hasKey: true,
      keyHint: '••••1111',
    },
  ],
  keys: [],
  queueAvailable: 256,
  uptimeSecs: 31,
  error: null,
}

describe('diagnosticRows', () => {
  it('is all green on a healthy router', () => {
    expect(diagnosticRows(base).every((r) => r.ok)).toBe(true)
  })

  it('names the reason when the service is down', () => {
    const rows = diagnosticRows({ ...base, unit: 'inactive', error: 'router unreachable' })
    expect(rows.find((r) => r.label === 'Service')?.value).toBe('not running')
    expect(rows.find((r) => r.label === 'Reachable')?.value).toBe('router unreachable')
  })

  it('distinguishes a stale Pi registration from a missing one', () => {
    expect(diagnosticRows({ ...base, pi: 'stale' }).find((r) => r.label === 'Pi provider')?.value)
      .toMatch(/out of date/)
    expect(diagnosticRows({ ...base, pi: 'missing' }).find((r) => r.label === 'Pi provider')?.value)
      .toBe('not registered')
    expect(
      diagnosticRows({ ...base, pi: 'no-config' }).find((r) => r.label === 'Pi provider')?.value,
    ).toMatch(/no Pi config/)
  })

  it('tells the user how to get a token rather than just failing', () => {
    const row = diagnosticRows({ ...base, hasToken: false }).find((r) => r.label === 'Token')
    expect(row?.ok).toBe(false)
    expect(row?.value).toMatch(/start the router/)
  })

  it('counts only enabled slots as routing', () => {
    const disabled = { ...base, slots: [{ ...base.slots[0]!, enabled: false }] }
    const row = diagnosticRows(disabled).find((r) => r.label === 'Slots enabled')
    expect(row?.value).toBe('0 of 1')
    expect(row?.ok).toBe(false)
  })

  it('never renders a key or a token', () => {
    const text = JSON.stringify(diagnosticRows(base))
    expect(text).not.toContain('1111')
  })
})
