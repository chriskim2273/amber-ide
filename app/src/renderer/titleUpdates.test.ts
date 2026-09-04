import { describe, expect, it } from 'vitest'
import { titleUpdateMatches } from './titleUpdates'

describe('titleUpdateMatches', () => {
  it('accepts only the submitted name and normalized title', () => {
    const request = { name: 'amber-1-1-0-a', title: 'Build' }
    expect(titleUpdateMatches(request, { name: 'amber-1-1-0-a', title: 'Build' })).toBe(true)
    expect(titleUpdateMatches(request, { name: 'amber-1-1-0-a', title: null })).toBe(false)
    expect(titleUpdateMatches(request, { name: 'other', title: 'Build' })).toBe(false)
  })

  it('treats absent authoritative titles as a cleared title', () => {
    expect(titleUpdateMatches({ name: 'a', title: null }, { name: 'a', title: undefined })).toBe(true)
  })
})
