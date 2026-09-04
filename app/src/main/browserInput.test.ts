import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SyntheticInputAccounting,
  cdpKeyInput,
  cdpMouseInput,
  electronKeyInput,
  electronMouseInput,
  type SyntheticInputToken,
} from './browserInput'

describe('source-aware synthetic input accounting', () => {
  afterEach(() => vi.useRealTimers())

  it('consumes only the exact next keyboard or pointer dispatch', () => {
    const accounting = new SyntheticInputAccounting()
    accounting.expect(cdpKeyInput('keyDown', 'a', 0))
    expect(accounting.observe(electronKeyInput({ type: 'keyDown', key: 'b', code: 'KeyB', modifiers: [], isAutoRepeat: false, isComposing: false, location: 0 }))).toBe(false)
    expect(accounting.pendingCount()).toBe(1)
    expect(accounting.observe(electronKeyInput({ type: 'keyDown', key: 'a', code: 'KeyA', modifiers: [], isAutoRepeat: false, isComposing: false, location: 0 }))).toBe(true)
    expect(accounting.pendingCount()).toBe(0)

    accounting.expect(cdpMouseInput('mousePressed', { x: 10, y: 20, button: 'left', clickCount: 1, modifiers: 0 }))
    expect(accounting.observe(electronMouseInput({ type: 'mouseDown', x: 11, y: 20, button: 'left', clickCount: 1, modifiers: [] }))).toBe(false)
    expect(accounting.observe(electronMouseInput({ type: 'mouseDown', x: 10, y: 20, button: 'left', clickCount: 1, modifiers: [] }))).toBe(true)
  })

  it('does not suppress physical composition or pointer input during an action', () => {
    const accounting = new SyntheticInputAccounting()
    accounting.expect(cdpKeyInput('keyDown', 'a', 0))
    expect(accounting.observe(electronKeyInput({ type: 'keyDown', key: 'a', code: 'KeyA', modifiers: [], isAutoRepeat: false, isComposing: true, location: 0 }))).toBe(false)
    expect(accounting.observe(electronMouseInput({ type: 'mouseMove', x: 20, y: 20, button: 'none', clickCount: 0, modifiers: [] }))).toBe(false)
    expect(accounting.pendingCount()).toBe(1)
  })

  it('keeps drag tokens ordered across a multi-event dispatch sequence', () => {
    const accounting = new SyntheticInputAccounting()
    const events = [
      cdpMouseInput('mouseMoved', { x: 1, y: 2, button: 'none', clickCount: 0, modifiers: 0 }),
      cdpMouseInput('mousePressed', { x: 1, y: 2, button: 'left', clickCount: 1, modifiers: 0 }),
      cdpMouseInput('mouseMoved', { x: 100, y: 200, button: 'left', clickCount: 0, modifiers: 0 }),
      cdpMouseInput('mouseReleased', { x: 100, y: 200, button: 'left', clickCount: 1, modifiers: 0 }),
    ]
    events.forEach((event) => accounting.expect(event))
    expect(accounting.observe(electronMouseInput({ type: 'mousePressed', x: 1, y: 2, button: 'left', clickCount: 1, modifiers: [] }))).toBe(false)
    expect(accounting.pendingCount()).toBe(4)
    expect(accounting.observe(electronMouseInput({ type: 'mouseMove', x: 1, y: 2, button: 'none', clickCount: 0, modifiers: [] }))).toBe(true)
    expect(accounting.observe(electronMouseInput({ type: 'mouseDown', x: 1, y: 2, button: 'left', clickCount: 1, modifiers: [] }))).toBe(true)
    expect(accounting.observe(electronMouseInput({ type: 'mouseMove', x: 100, y: 200, button: 'left', clickCount: 0, modifiers: ['leftbuttondown'] }))).toBe(true)
    expect(accounting.observe(electronMouseInput({ type: 'mouseUp', x: 100, y: 200, button: 'left', clickCount: 1, modifiers: [] }))).toBe(true)
    expect(accounting.pendingCount()).toBe(0)
  })

  it('clears cancelled/error tokens and expires late tokens without leaking into a next action', () => {
    vi.useFakeTimers()
    const accounting = new SyntheticInputAccounting()
    const token = accounting.expect(cdpKeyInput('keyDown', 'a', 0))
    expect(accounting.pendingCount()).toBe(1)
    token.clear()
    expect(accounting.pendingCount()).toBe(0)
    expect(accounting.observe(electronKeyInput({ type: 'keyDown', key: 'a', code: 'KeyA', modifiers: [], isAutoRepeat: false, isComposing: false, location: 0 }))).toBe(false)

    accounting.expect(cdpMouseInput('mousePressed', { x: 1, y: 1, button: 'left', clickCount: 1, modifiers: 0 }))
    vi.advanceTimersByTime(1_000)
    expect(accounting.pendingCount()).toBe(0)
    expect(accounting.observe(electronMouseInput({ type: 'mouseDown', x: 1, y: 1, button: 'left', clickCount: 1, modifiers: [] }))).toBe(false)
  })

  it('bounds outstanding expected events even when an adapter never calls back', () => {
    const accounting = new SyntheticInputAccounting()
    const tokens: SyntheticInputToken[] = []
    for (let index = 0; index < 100; index++) tokens.push(accounting.expect(cdpKeyInput('keyDown', String(index % 10), 0)))
    expect(accounting.pendingCount()).toBeLessThanOrEqual(64)
    tokens.forEach((token) => token.clear())
    expect(accounting.pendingCount()).toBe(0)
  })
})
