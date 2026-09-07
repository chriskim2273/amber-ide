import { expect, it } from 'vitest'
import { editingCommands } from './browserKeyboard'
it('supplies macOS editing commands for selection, undo and line navigation', () => {
  expect(editingCommands('a', 4, 'darwin')).toEqual(['selectAll'])
  expect(editingCommands('z', 4, 'darwin')).toEqual(['undo'])
  expect(editingCommands('z', 12, 'darwin')).toEqual(['redo'])
  expect(editingCommands('ArrowLeft', 12, 'darwin')).toEqual(['moveToLeftEndOfLineAndModifySelection'])
  expect(editingCommands('a', 2, 'darwin')).toEqual(['moveToBeginningOfParagraph'])
  expect(editingCommands('a', 2, 'linux')).toEqual([])
})
it('never synthesizes clipboard, kill-ring or text-insertion commands', () => {
  for (const key of ['c', 'x', 'v', 'y', 'Enter', 'Tab', 'paste']) {
    for (const mask of [0, 2, 4, 6, 12]) expect(editingCommands(key, mask, 'darwin')).toEqual([])
  }
})
