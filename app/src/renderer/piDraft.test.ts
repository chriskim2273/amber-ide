import { describe, expect, it } from 'vitest'
import { canClearPiDraft, clearPiDraft, piDraftKey, readPiDraft, writePiDraft, type PiDraftStorage } from './piDraft'

function fakeStorage(overrides: Partial<PiDraftStorage> = {}): PiDraftStorage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
    ...overrides,
  }
}

describe('Pi draft storage', () => {
  it('scopes drafts by origin and session and clears explicitly', () => {
    const store = fakeStorage()
    expect(piDraftKey('a', 'https://phone')).not.toBe(piDraftKey('b', 'https://phone'))
    expect(writePiDraft('a', 'keep this', store)).toBe(true)
    expect(readPiDraft('a', store)).toBe('keep this')
    expect(readPiDraft('b', store)).toBe('')
    expect(clearPiDraft('a', store)).toBe(true)
    expect(readPiDraft('a', store)).toBe('')
  })

  it('does not let a late receipt clear a newer edit', () => {
    expect(canClearPiDraft('same', 'same', 2, 2)).toBe(true)
    expect(canClearPiDraft('newer', 'same', 3, 2)).toBe(false)
    expect(canClearPiDraft('same', 'same', 3, 2)).toBe(false)
  })

  it('treats denied and quota storage as a best-effort feature', () => {
    const denied = fakeStorage({ getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('quota') } })
    expect(readPiDraft('a', denied)).toBe('')
    expect(writePiDraft('a', 'draft', denied)).toBe(false)
    expect(writePiDraft('a', 'x'.repeat(256 * 1024 + 1), fakeStorage())).toBe(false)
  })
})
