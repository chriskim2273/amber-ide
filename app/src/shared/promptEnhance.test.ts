import { describe, expect, it } from 'vitest'
import { ENHANCE_MAX_CHARS, parseEnhanceResult, validateEnhanceInput } from './promptEnhance'

describe('validateEnhanceInput', () => {
  it('trims and accepts a normal prompt', () => {
    expect(validateEnhanceInput('  make it better  ')).toEqual({ ok: true, prompt: 'make it better' })
  })

  it('rejects blank and non-string input', () => {
    expect(validateEnhanceInput('   ').ok).toBe(false)
    expect(validateEnhanceInput('').ok).toBe(false)
    expect(validateEnhanceInput(undefined).ok).toBe(false)
    expect(validateEnhanceInput(42).ok).toBe(false)
    expect(validateEnhanceInput({ prompt: 'x' }).ok).toBe(false)
  })

  it('rejects an oversize prompt before any subprocess spawns', () => {
    const res = validateEnhanceInput('x'.repeat(ENHANCE_MAX_CHARS + 1))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/too long/)
  })
})

describe('parseEnhanceResult', () => {
  it('reads the text field', () => {
    expect(parseEnhanceResult(JSON.stringify({ text: '  Do it clearly.  ' })))
      .toEqual({ ok: true, text: 'Do it clearly.' })
  })

  it('never throws on CLI-shaped failures', () => {
    expect(parseEnhanceResult('not json').ok).toBe(false)
    expect(parseEnhanceResult('').ok).toBe(false)
    expect(parseEnhanceResult(JSON.stringify({ text: '   ' })).ok).toBe(false)
    expect(parseEnhanceResult(JSON.stringify({})).ok).toBe(false)
    expect(parseEnhanceResult(JSON.stringify({ text: 42 })).ok).toBe(false)
  })
})
