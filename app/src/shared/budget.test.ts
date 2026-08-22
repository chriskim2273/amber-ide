import { describe, it, expect } from 'vitest'
import { parseBudgetInput, formatKb } from './budget'

describe('parseBudgetInput', () => {
  it('parses binary units and bare MiB', () => {
    expect(parseBudgetInput('20G')).toEqual({ kind: 'mib', mb: 20480 })
    expect(parseBudgetInput('1536M')).toEqual({ kind: 'mib', mb: 1536 })
    expect(parseBudgetInput('20480')).toEqual({ kind: 'mib', mb: 20480 })
    expect(parseBudgetInput(' 20 g ')).toEqual({ kind: 'mib', mb: 20480 })
  })

  it('understands auto case-insensitively', () => {
    expect(parseBudgetInput('auto')).toEqual({ kind: 'auto' })
    expect(parseBudgetInput('Auto')).toEqual({ kind: 'auto' })
  })

  it('rejects malformed input as null so nothing is sent', () => {
    expect(parseBudgetInput('12X')).toBeNull()
    expect(parseBudgetInput('G')).toBeNull()
    expect(parseBudgetInput('-5G')).toBeNull()
    expect(parseBudgetInput('')).toBeNull()
  })

  it('rounds sub-MiB K values up to at least 1 MiB', () => {
    expect(parseBudgetInput('512K')).toEqual({ kind: 'mib', mb: 1 })
    expect(parseBudgetInput('0K')).toEqual({ kind: 'mib', mb: 0 })
  })
})

describe('formatKb', () => {
  it('shows whole GiB in GiB and everything else in MiB', () => {
    expect(formatKb(8 * 1024 * 1024)).toBe('8 GiB')
    expect(formatKb(4 * 1024 * 1024 + 512 * 1024)).toBe('4608 MiB')
    expect(formatKb(0)).toBe('0 MiB')
  })
})
