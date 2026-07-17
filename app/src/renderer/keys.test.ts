import { describe, it, expect, afterEach, vi } from 'vitest'
import { appChord, chordLabel } from './keys'

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
    expect(appChord(key({ key: '0', meta: true }))).toBeNull()
    expect(appChord(key({ key: 'Tab', meta: true }))).toBeNull()
  })
})

describe('chordLabel', () => {
  it('renders the mac Cmd label', () => {
    setPlatform('MacIntel')
    expect(chordLabel('new-pane')).toBe('⌘Enter')
    expect(chordLabel('new-tab')).toBe('⌘T')
  })
  it('renders the non-mac Ctrl+Shift label', () => {
    setPlatform('Linux x86_64')
    expect(chordLabel('new-pane')).toBe('Ctrl+Shift+Enter')
    expect(chordLabel('new-tab')).toBe('Ctrl+Shift+T')
    expect(chordLabel('close')).toBe('Ctrl+Shift+W')
  })
})
