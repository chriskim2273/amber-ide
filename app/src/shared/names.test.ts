import { describe, it, expect } from 'vitest'
import { parseName, formatName, makeId } from './names'

describe('names', () => {
  it('parses a well-formed name', () => {
    expect(parseName('amber-1-2-0-abc')).toEqual({ ws: 1, tab: 2, ord: 0, id: 'abc' })
  })
  it('formats and round-trips', () => {
    const p = { ws: 3, tab: 1, ord: 5, id: 'x9y' }
    expect(parseName(formatName(p))).toEqual(p)
  })
  it('rejects malformed names', () => {
    for (const bad of ['', 'amber', 'amber-1-2-3', 'nope-1-2-3-x', 'amber-a-b-c-d', 'amber-1-2-3-'])
      expect(parseName(bad)).toBeNull()
  })
  it('makeId is non-empty and url-safe', () => {
    const id = makeId()
    expect(id).toMatch(/^[a-z0-9]+$/)
    expect(id.length).toBeGreaterThan(0)
  })
})
