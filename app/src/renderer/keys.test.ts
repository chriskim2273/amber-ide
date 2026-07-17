import { describe, it, expect, afterEach, vi } from 'vitest'
import { appChord, chordLabel, CHORD_TABLE, modLabel } from './keys'

// keys.ts branches on navigator.platform (mac -> Cmd, else -> Ctrl+Shift). The
// tests stub the global per case; Node ships a read-only `navigator`, so use
// vi.stubGlobal (defineProperty under the hood) and restore after each test.
afterEach(() => { vi.unstubAllGlobals() })

function setPlatform(platform: string): void {
  vi.stubGlobal('navigator', { platform })
}

interface KeyInit { key: string; meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean }
const key = (i: KeyInit): { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean } => ({
  key: i.key, metaKey: !!i.meta, ctrlKey: !!i.ctrl, shiftKey: !!i.shift, altKey: !!i.alt,
})

describe('appChord (mac / Cmd modifier)', () => {
  const mac = 'MacIntel'
  it('maps every chord under Cmd', () => {
    setPlatform(mac)
    expect(appChord(key({ key: 't', meta: true }))).toEqual({ type: 'new-tab' })
    expect(appChord(key({ key: 'Enter', meta: true }))).toEqual({ type: 'new-pane' })
    expect(appChord(key({ key: 'w', meta: true }))).toEqual({ type: 'close' })
    expect(appChord(key({ key: '[', meta: true }))).toEqual({ type: 'prev-tab' })
    expect(appChord(key({ key: ']', meta: true }))).toEqual({ type: 'next-tab' })
    expect(appChord(key({ key: '1', meta: true }))).toEqual({ type: 'tab', n: 1 })
    expect(appChord(key({ key: '9', meta: true }))).toEqual({ type: 'tab', n: 9 })
  })
  it('is case-insensitive on the key', () => {
    setPlatform(mac)
    expect(appChord(key({ key: 'T', meta: true }))).toEqual({ type: 'new-tab' })
    expect(appChord(key({ key: 'W', meta: true }))).toEqual({ type: 'close' })
  })
  it('requires Cmd and rejects Cmd+Ctrl combos', () => {
    setPlatform(mac)
    expect(appChord(key({ key: 't' }))).toBeNull()
    expect(appChord(key({ key: 't', ctrl: true, shift: true }))).toBeNull()
    expect(appChord(key({ key: 't', meta: true, ctrl: true }))).toBeNull()
  })
})

describe('appChord (non-mac / Ctrl+Shift modifier)', () => {
  const linux = 'Linux x86_64'
  it('maps chords only under Ctrl+Shift', () => {
    setPlatform(linux)
    expect(appChord(key({ key: 't', ctrl: true, shift: true }))).toEqual({ type: 'new-tab' })
    expect(appChord(key({ key: 'enter', ctrl: true, shift: true }))).toEqual({ type: 'new-pane' })
    expect(appChord(key({ key: 'w', ctrl: true, shift: true }))).toEqual({ type: 'close' })
    expect(appChord(key({ key: '[', ctrl: true, shift: true }))).toEqual({ type: 'prev-tab' })
    expect(appChord(key({ key: ']', ctrl: true, shift: true }))).toEqual({ type: 'next-tab' })
    expect(appChord(key({ key: '3', ctrl: true, shift: true }))).toEqual({ type: 'tab', n: 3 })
  })
  it('rejects bare Ctrl (no Shift) and Cmd on linux', () => {
    setPlatform(linux)
    expect(appChord(key({ key: 't', ctrl: true }))).toBeNull()
    expect(appChord(key({ key: 't', meta: true }))).toBeNull()
    expect(appChord(key({ key: 't', ctrl: true, shift: true, meta: true }))).toBeNull()
  })
})

describe('appChord (shared edge cases)', () => {
  it('Alt always disqualifies a chord', () => {
    setPlatform('MacIntel')
    expect(appChord(key({ key: 't', meta: true, alt: true }))).toBeNull()
    setPlatform('Linux x86_64')
    expect(appChord(key({ key: 't', ctrl: true, shift: true, alt: true }))).toBeNull()
  })
  it('unmapped keys under the right modifier return null', () => {
    setPlatform('MacIntel')
    expect(appChord(key({ key: 'q', meta: true }))).toBeNull()
    expect(appChord(key({ key: 'Tab', meta: true }))).toBeNull()
  })
})

describe('appChord (font size)', () => {
  it('maps Cmd += / - / 0 on mac (and shift-alias forms)', () => {
    setPlatform('MacIntel')
    expect(appChord(key({ key: '=', meta: true }))).toEqual({ type: 'font-bigger' })
    expect(appChord(key({ key: '+', meta: true }))).toEqual({ type: 'font-bigger' })
    expect(appChord(key({ key: '-', meta: true }))).toEqual({ type: 'font-smaller' })
    expect(appChord(key({ key: '_', meta: true }))).toEqual({ type: 'font-smaller' })
    expect(appChord(key({ key: '0', meta: true }))).toEqual({ type: 'font-reset' })
    expect(appChord(key({ key: ')', meta: true }))).toEqual({ type: 'font-reset' })
  })
  it('maps Ctrl+Shift chords (shift renames the key) on linux', () => {
    setPlatform('Linux x86_64')
    // Shift is held for the modifier, so '=' arrives as '+', '-' as '_', '0' as ')'.
    expect(appChord(key({ key: '+', ctrl: true, shift: true }))).toEqual({ type: 'font-bigger' })
    expect(appChord(key({ key: '_', ctrl: true, shift: true }))).toEqual({ type: 'font-smaller' })
    expect(appChord(key({ key: ')', ctrl: true, shift: true }))).toEqual({ type: 'font-reset' })
  })
  it('renders labels matching the brief', () => {
    setPlatform('MacIntel')
    expect(chordLabel('font-bigger')).toBe('⌘=')
    expect(chordLabel('font-smaller')).toBe('⌘-')
    expect(chordLabel('font-reset')).toBe('⌘0')
    setPlatform('Linux x86_64')
    expect(chordLabel('font-bigger')).toBe('Ctrl+Shift+=')
    expect(chordLabel('font-smaller')).toBe('Ctrl+Shift+-')
    expect(chordLabel('font-reset')).toBe('Ctrl+Shift+0')
  })
})

describe('appChord (directional focus)', () => {
  it('maps Cmd+Arrow to focus chords on mac', () => {
    setPlatform('MacIntel')
    expect(appChord(key({ key: 'ArrowLeft', meta: true }))).toEqual({ type: 'focus-left' })
    expect(appChord(key({ key: 'ArrowRight', meta: true }))).toEqual({ type: 'focus-right' })
    expect(appChord(key({ key: 'ArrowUp', meta: true }))).toEqual({ type: 'focus-up' })
    expect(appChord(key({ key: 'ArrowDown', meta: true }))).toEqual({ type: 'focus-down' })
  })
  it('maps Ctrl+Shift+Arrow to focus chords on linux', () => {
    setPlatform('Linux x86_64')
    expect(appChord(key({ key: 'ArrowLeft', ctrl: true, shift: true }))).toEqual({ type: 'focus-left' })
    expect(appChord(key({ key: 'ArrowDown', ctrl: true, shift: true }))).toEqual({ type: 'focus-down' })
  })
})

describe('appChord (find)', () => {
  it('maps Cmd+F (and Cmd+Shift+F form) to find on mac', () => {
    setPlatform('MacIntel')
    expect(appChord(key({ key: 'f', meta: true }))).toEqual({ type: 'find' })
    expect(appChord(key({ key: 'F', meta: true, shift: true }))).toEqual({ type: 'find' })
  })
  it('maps Ctrl+Shift+F to find on linux', () => {
    setPlatform('Linux x86_64')
    expect(appChord(key({ key: 'f', ctrl: true, shift: true }))).toEqual({ type: 'find' })
    expect(appChord(key({ key: 'F', ctrl: true, shift: true }))).toEqual({ type: 'find' })
  })
  it('renders the find label per platform', () => {
    setPlatform('MacIntel')
    expect(chordLabel('find')).toBe('⌘F')
    setPlatform('Linux x86_64')
    expect(chordLabel('find')).toBe('Ctrl+Shift+F')
  })
})

describe('appChord (help)', () => {
  it('maps Cmd+/ (and Cmd+Shift+? form) on mac', () => {
    setPlatform('MacIntel')
    expect(appChord(key({ key: '/', meta: true }))).toEqual({ type: 'help' })
    expect(appChord(key({ key: '?', meta: true }))).toEqual({ type: 'help' })
  })
  it('maps Ctrl+Shift+/ (arriving as ?) on linux', () => {
    setPlatform('Linux x86_64')
    expect(appChord(key({ key: '?', ctrl: true, shift: true }))).toEqual({ type: 'help' })
    expect(appChord(key({ key: '/', ctrl: true, shift: true }))).toEqual({ type: 'help' })
  })
})

describe('CHORD_TABLE (single source of truth)', () => {
  it('every entry is matched by appChord under the platform modifier', () => {
    setPlatform('MacIntel')
    for (const entry of CHORD_TABLE) {
      const k = entry.keys[0]!
      expect(appChord(key({ key: k, meta: true }))).toEqual({ type: entry.action })
    }
  })
  it('exposes action/label/keys for every entry', () => {
    for (const entry of CHORD_TABLE) {
      expect(typeof entry.action).toBe('string')
      expect(typeof entry.label).toBe('string')
      expect(Array.isArray(entry.keys)).toBe(true)
      expect(entry.keys.length).toBeGreaterThan(0)
    }
  })
})

describe('chordLabel / modLabel', () => {
  it('renders the mac Cmd label', () => {
    setPlatform('MacIntel')
    expect(chordLabel('new-pane')).toBe('⌘Enter')
    expect(chordLabel('new-tab')).toBe('⌘T')
    expect(chordLabel('focus-left')).toBe('⌘←')
    expect(modLabel('1–9')).toBe('⌘1–9')
  })
  it('renders the non-mac Ctrl+Shift label', () => {
    setPlatform('Linux x86_64')
    expect(chordLabel('new-pane')).toBe('Ctrl+Shift+Enter')
    expect(chordLabel('new-tab')).toBe('Ctrl+Shift+T')
    expect(chordLabel('close')).toBe('Ctrl+Shift+W')
    expect(chordLabel('help')).toBe('Ctrl+Shift+/')
    expect(modLabel('1–9')).toBe('Ctrl+Shift+1–9')
  })
})
