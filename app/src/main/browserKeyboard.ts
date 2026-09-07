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
export function virtualKey(value: string): number | undefined {
  const named: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Space: 32,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34 }
  return named[value] ?? (/^[A-Za-z0-9]$/.test(value) ? value.toUpperCase().charCodeAt(0) : undefined)
}
