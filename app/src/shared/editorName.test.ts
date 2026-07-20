import { describe, it, expect } from 'vitest'
import { formatEditorName, parseEditorName, isEditorName } from './editorName'

describe('editor id', () => {
  it('round-trips', () => {
    const n = formatEditorName({ ws: 2, tab: 3, ord: 1, id: 'abc' })
    expect(n).toBe('editor-2-3-1-abc')
    expect(parseEditorName(n)).toEqual({ ws: 2, tab: 3, ord: 1, id: 'abc' })
  })
  it('isEditorName distinguishes daemon + browser names', () => {
    expect(isEditorName('editor-1-1-0-x')).toBe(true)
    expect(isEditorName('amber-1-1-0-x')).toBe(false)
    expect(isEditorName('browser-1-1-0-x')).toBe(false)
  })
  it('rejects malformed', () => {
    expect(parseEditorName('amber-1-1-0-x')).toBeNull()
    expect(parseEditorName('editor-x-1-0-x')).toBeNull()
    expect(parseEditorName('editor-1-1-0')).toBeNull()
  })
})
