import { describe, expect, it, vi } from 'vitest'
import { createInputEventHandlers, projectInPageNavigation } from './electronTabBrowserPage'

describe('Electron tab browser page events', () => {
  it('advances generation for every keyboard, mouse, drag, and composition callback', () => {
    const input = vi.fn(), blur = vi.fn()
    const handlers = createInputEventHandlers(input, blur)
    const event = { preventDefault: vi.fn() }
    const key = { type: 'keyDown', key: 'a', code: 'KeyA', isAutoRepeat: false, isComposing: false, shift: false, control: false, alt: false, meta: false, location: 0, modifiers: [] }
    const composing = { ...key, isComposing: true }
    handlers.beforeInputEvent(event, key)
    handlers.beforeInputEvent(event, composing)
    // A CDP callback and an identical physical callback are indistinguishable;
    // both are real page input and both advance the generation.
    handlers.beforeInputEvent(event, key)
    const drag = [
      { type: 'mouseMove', x: 10, y: 20, clickCount: 0, modifiers: [] },
      { type: 'mouseDown', x: 10, y: 20, button: 'left', clickCount: 1, modifiers: [] },
      { type: 'mouseMove', x: 100, y: 200, button: 'left', clickCount: 0, modifiers: [] },
      { type: 'mouseUp', x: 100, y: 200, button: 'left', clickCount: 1, modifiers: [] },
    ] as const
    drag.forEach((mouse) => handlers.beforeMouseEvent(event, mouse as unknown as Parameters<typeof handlers.beforeMouseEvent>[1]))
    expect(input).toHaveBeenCalledTimes(7)
    expect(blur).not.toHaveBeenCalled()
  })

  it('counts reserved shortcuts before preventing them and does not suppress late or out-of-order callbacks', () => {
    const input = vi.fn(), blur = vi.fn(), preventDefault = vi.fn()
    const handlers = createInputEventHandlers(input, blur)
    const event = { preventDefault }
    const shortcut = { type: 'keyDown', key: 'b', code: 'KeyB', isAutoRepeat: false, isComposing: false, shift: true, control: true, alt: false, meta: false, location: 0, modifiers: [] }
    handlers.beforeInputEvent(event, shortcut)
    expect(input).toHaveBeenCalledOnce()
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(blur).toHaveBeenCalledOnce()

    // These may belong to an earlier CDP action, but they still represent
    // observed input and cannot consume state belonging to a later action.
    handlers.beforeMouseEvent(event, { type: 'mouseUp', x: 1, y: 1, button: 'left', clickCount: 1, modifiers: [] })
    handlers.beforeInputEvent(event, { ...shortcut, key: 'a', code: 'KeyA', shift: false, control: false })
    expect(input).toHaveBeenCalledTimes(3)
  })

  it('projects only bounded main-frame history/hash navigation', () => {
    expect(projectInPageNavigation('https://example.test/app#next', true)).toEqual({ type: 'navigation-in-page', url: 'https://example.test/app#next' })
    expect(projectInPageNavigation('https://frame.example/', false)).toBeNull()
    const bounded = projectInPageNavigation(`https://example.test/${'x'.repeat(9000)}`, true)
    expect(bounded?.type === 'navigation-in-page' ? bounded.url.length : 0).toBe(8192)
  })
})
