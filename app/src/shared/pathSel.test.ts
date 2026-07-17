import { describe, it, expect } from 'vitest'
import { pathCandidates } from './pathSel'

describe('pathCandidates', () => {
  it('returns the trimmed selection as-is', () => {
    expect(pathCandidates('  breathing-card.png  ')).toEqual(['breathing-card.png'])
  })
  it('strips surrounding quotes', () => {
    expect(pathCandidates('"my file.png"')).toEqual(['my file.png'])
    expect(pathCandidates("'src/app.ts'")).toEqual(['src/app.ts'])
  })
  it('peels a trailing :line and :line:col as a fallback candidate', () => {
    expect(pathCandidates('src/app.ts:42')).toEqual(['src/app.ts:42', 'src/app.ts'])
    expect(pathCandidates('src/app.ts:42:7')).toEqual(['src/app.ts:42:7', 'src/app.ts'])
  })
  it('does not peel when there is no :line suffix', () => {
    expect(pathCandidates('/etc/hosts')).toEqual(['/etc/hosts'])
  })
  it('returns nothing for an empty/whitespace selection', () => {
    expect(pathCandidates('   ')).toEqual([])
    expect(pathCandidates('""')).toEqual([])
  })
})
