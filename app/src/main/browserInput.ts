export const SYNTHETIC_INPUT_TOKEN_LIMIT = 64
export const SYNTHETIC_INPUT_TOKEN_TTL_MS = 250

export type SyntheticKeyboardInput = {
  kind: 'keyboard'
  type: 'keyDown' | 'keyUp'
  key: string
  code: string
  modifiers: string[]
  isAutoRepeat: boolean
  isComposing: boolean
  location: number
}

export type SyntheticMouseInput = {
  kind: 'mouse'
  type: 'mouseDown' | 'mouseUp' | 'mouseMove' | 'mouseWheel'
  x: number
  y: number
  button: string
  clickCount: number
  modifiers: string[]
  deltaX?: number
  deltaY?: number
}

export type SyntheticInput = SyntheticKeyboardInput | SyntheticMouseInput
export interface SyntheticInputToken { clear(): void }

export interface ElectronKeyboardInput {
  type: string
  key: string
  code: string
  modifiers?: readonly string[]
  isAutoRepeat?: boolean
  isComposing?: boolean
  location?: number
}

export interface ElectronMouseInput {
  type: string
  x: number
  y: number
  button?: string
  clickCount?: number
  modifiers?: readonly string[]
  deltaX?: number
  deltaY?: number
}

export type CdpMouseInputType = 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel'

const MODIFIER_ALIASES: Record<string, string> = {
  alt: 'alt',
  control: 'control',
  ctrl: 'control',
  meta: 'meta',
  command: 'meta',
  cmd: 'meta',
  shift: 'shift',
}

/** Keep only modifier bits observable and reproducible in both input APIs. */
export function canonicalInputModifiers(modifiers: readonly string[]): string[] {
  return [...new Set(modifiers.map((modifier) => MODIFIER_ALIASES[modifier.toLocaleLowerCase()]).filter((modifier): modifier is string => !!modifier))].sort()
}

export function cdpModifierNames(modifiers: number): string[] {
  const names: string[] = []
  if ((modifiers & 1) !== 0) names.push('alt')
  if ((modifiers & 2) !== 0) names.push('control')
  if ((modifiers & 4) !== 0) names.push('meta')
  if ((modifiers & 8) !== 0) names.push('shift')
  return canonicalInputModifiers(names)
}

export function keyCode(key: string): string {
  if (/^[A-Za-z]$/.test(key)) return `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return `Digit${key}`
  const named: Record<string, string> = {
    Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete', Space: 'Space',
    ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  }
  return named[key] ?? key
}

export function cdpKeyInput(type: 'keyDown' | 'keyUp', value: string, modifiers: number): SyntheticKeyboardInput {
  const key = value === 'Space' ? ' ' : value
  return { kind: 'keyboard', type, key, code: keyCode(value), modifiers: cdpModifierNames(modifiers), isAutoRepeat: false, isComposing: false, location: 0 }
}

export function electronKeyInput(input: ElectronKeyboardInput): SyntheticKeyboardInput {
  return {
    kind: 'keyboard',
    type: input.type === 'keyUp' ? 'keyUp' : 'keyDown',
    key: input.key.slice(0, 128),
    code: input.code.slice(0, 128),
    modifiers: canonicalInputModifiers(input.modifiers ?? []),
    isAutoRepeat: input.isAutoRepeat === true,
    isComposing: input.isComposing === true,
    location: Number.isSafeInteger(input.location) ? input.location! : 0,
  }
}

function mouseType(type: CdpMouseInputType | string): SyntheticMouseInput['type'] {
  if (type === 'mouseReleased') return 'mouseUp'
  if (type === 'mouseMoved') return 'mouseMove'
  if (type === 'mouseWheel') return 'mouseWheel'
  return 'mouseDown'
}

export function cdpMouseInput(type: CdpMouseInputType, params: Record<string, unknown>): SyntheticMouseInput {
  const eventType = mouseType(type)
  const button = typeof params['button'] === 'string' ? params['button'] : 'none'
  const clickCount = typeof params['clickCount'] === 'number' && Number.isSafeInteger(params['clickCount']) && params['clickCount'] >= 0 ? params['clickCount'] : 0
  const input: SyntheticMouseInput = {
    kind: 'mouse', type: eventType,
    x: typeof params['x'] === 'number' ? params['x'] : 0,
    y: typeof params['y'] === 'number' ? params['y'] : 0,
    button, clickCount,
    modifiers: cdpModifierNames(typeof params['modifiers'] === 'number' ? params['modifiers'] : 0),
  }
  if (eventType === 'mouseWheel') {
    input.deltaX = typeof params['deltaX'] === 'number' ? params['deltaX'] : 0
    input.deltaY = typeof params['deltaY'] === 'number' ? params['deltaY'] : 0
  }
  return input
}

export function electronMouseInput(input: ElectronMouseInput): SyntheticMouseInput {
  const type = input.type === 'mouseUp' ? 'mouseUp' : input.type === 'mouseMove' ? 'mouseMove' : input.type === 'mouseWheel' ? 'mouseWheel' : 'mouseDown'
  const normalized: SyntheticMouseInput = {
    kind: 'mouse', type,
    x: input.x,
    y: input.y,
    button: input.button ?? 'none',
    clickCount: typeof input.clickCount === 'number' && Number.isSafeInteger(input.clickCount) && input.clickCount >= 0 ? input.clickCount : 0,
    modifiers: canonicalInputModifiers(input.modifiers ?? []),
  }
  if (type === 'mouseWheel') {
    normalized.deltaX = typeof input.deltaX === 'number' ? input.deltaX : 0
    normalized.deltaY = typeof input.deltaY === 'number' ? input.deltaY : 0
  }
  return normalized
}

function sameInput(left: SyntheticInput, right: SyntheticInput): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

interface PendingInputToken {
  input: SyntheticInput
  timer: ReturnType<typeof setTimeout>
}

/**
 * Matches the bounded, ordered callbacks produced by CDP Input commands.
 *
 * Electron does not expose an origin bit on before-input/before-mouse events,
 * so matching is deliberately exact and one-shot: a physical event with a
 * different signature remains user input, and an unmatched/late event never
 * consumes a later dispatch token. The adapter clears this ledger on a page
 * invalidation or failed action; successful tokens expire shortly after their
 * command in case Chromium delivers the callback on a later task.
 */
export class SyntheticInputAccounting {
  private readonly pending: PendingInputToken[] = []

  expect(input: SyntheticInput): SyntheticInputToken {
    while (this.pending.length >= SYNTHETIC_INPUT_TOKEN_LIMIT) this.remove(0)
    const pending: PendingInputToken = { input: structuredClone(input), timer: setTimeout(() => this.removeToken(pending), SYNTHETIC_INPUT_TOKEN_TTL_MS) }
    pending.timer.unref?.()
    this.pending.push(pending)
    return { clear: () => this.removeToken(pending) }
  }

  /** Returns true only for the next exact callback of the same input family. */
  observe(input: SyntheticInput): boolean {
    const index = this.pending.findIndex((pending) => pending.input.kind === input.kind)
    if (index < 0 || !sameInput(this.pending[index]!.input, input)) return false
    this.remove(index)
    return true
  }

  clear(): void {
    while (this.pending.length > 0) this.remove(0)
  }

  pendingCount(): number { return this.pending.length }

  private removeToken(token: PendingInputToken): void {
    const index = this.pending.indexOf(token)
    if (index >= 0) this.remove(index)
  }

  private remove(index: number): void {
    const token = this.pending.splice(index, 1)[0]
    if (token) clearTimeout(token.timer)
  }
}
