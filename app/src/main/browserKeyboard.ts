export type BrowserModifier = 'Alt' | 'Control' | 'Meta' | 'Shift'
const MODIFIERS: BrowserModifier[] = ['Alt', 'Control', 'Meta', 'Shift']
export function parseModifiers(value: unknown, key?: string): BrowserModifier[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 4 || value.some(item => !MODIFIERS.includes(item)) || new Set(value).size !== value.length) throw new Error('INVALID_REQUEST')
  const modifiers = MODIFIERS.filter(item => value.includes(item))
  if (key && modifiers.length) {
    const command = modifiers.includes('Control') || modifiers.includes('Meta')
    if (modifiers.includes('Alt') || (modifiers.includes('Control') && modifiers.includes('Meta'))) throw new Error('INVALID_REQUEST')
    if (command && !/^(?:[AaZzYy]|Arrow(?:Left|Right|Up|Down)|Home|End|Backspace|Delete)$/.test(key)) throw new Error('INVALID_REQUEST')
    if (!command && !/^(?:[A-Za-z0-9]|Tab|Arrow(?:Left|Right|Up|Down)|Home|End|Page(?:Up|Down))$/.test(key)) throw new Error('INVALID_REQUEST')
  }
  return modifiers
}
export function modifierMask(modifiers: readonly BrowserModifier[] = []): number {
  return modifiers.reduce((mask, key) => mask | ({ Alt: 1, Control: 2, Meta: 4, Shift: 8 }[key]), 0)
}
export function keyText(value: string, modifiers: number): string | undefined {
  if (modifiers & 7) return undefined
  if (value === 'Space') return ' '
  if (value === 'Enter') return '\r'
  if (/^[A-Za-z0-9]$/.test(value)) {
    if (!(modifiers & 8)) return value
    return /^[0-9]$/.test(value) ? ')!@#$%^&*('[Number(value)] : value.toUpperCase()
  }
  return undefined
}
/** CDP does not run Cocoa's key binding translation. Fixed editing commands only;
 * never clipboard/kill-ring commands or caller-provided command names. */
export function editingCommands(value: string, modifiers: number, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'darwin' || ![0, 2, 4, 8, 10, 12].includes(modifiers)) return []
  const shift = !!(modifiers & 8), control = !!(modifiers & 2), meta = !!(modifiers & 4)
  const selected = shift ? 'AndModifySelection' : ''
  const key = value.toLowerCase()
  if (meta && key === 'a' && !shift) return ['selectAll']
  if (meta && key === 'z') return [shift ? 'redo' : 'undo']
  if (control && key === 'a') return ['moveToBeginningOfParagraph' + selected]
  if (value === 'Backspace') return [meta ? 'deleteToBeginningOfLine' : control ? 'deleteBackwardByDecomposingPreviousCharacter' : 'deleteBackward']
  if (value === 'Delete' && !meta && !control) return ['deleteForward']
  const arrow = /^Arrow(Left|Right|Up|Down)$/.exec(value)?.[1]
  if (arrow) {
    if ((meta || control) && (arrow === 'Left' || arrow === 'Right')) return ['moveTo' + arrow + 'EndOfLine' + selected]
    if (meta) return [(arrow === 'Up' ? 'moveToBeginningOfDocument' : 'moveToEndOfDocument') + selected]
    if (control) return [arrow === 'Up' ? 'scrollPageUp' : 'scrollPageDown']
    return ['move' + arrow + selected]
  }
  if (!meta && !control && (value === 'Home' || value === 'End')) {
    const edge = value === 'Home' ? 'Beginning' : 'End'
    return [shift ? 'moveTo' + edge + 'OfDocumentAndModifySelection' : 'scrollTo' + edge + 'OfDocument']
  }
  if (!meta && !control && (value === 'PageUp' || value === 'PageDown')) return [shift ? 'page' + value.slice(4) + selected : 'scroll' + value]
  return []
}
export function virtualKey(value: string): number | undefined {
  const named: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Space: 32,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34 }
  return named[value] ?? (/^[A-Za-z0-9]$/.test(value) ? value.toUpperCase().charCodeAt(0) : undefined)
}
