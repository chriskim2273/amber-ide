import { describe, expect, it } from 'vitest'
import { titleCreateComplete, titleUpdateMatches } from './titleUpdates'

describe('titleCreateComplete', () => {
  it('requires both Created and matching TitleSet acknowledgements', () => {
    expect(titleCreateComplete({ created: false, acknowledged: true })).toBe(false)
    expect(titleCreateComplete({ created: true, acknowledged: false })).toBe(false)
    expect(titleCreateComplete({ created: true, acknowledged: true })).toBe(true)
  })
})

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
