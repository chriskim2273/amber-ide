import { describe, expect, it, vi } from 'vitest'
import { createInputEventHandlers, projectInPageNavigation } from './electronTabBrowserPage'
import { cdpKeyInput, cdpMouseInput, SyntheticInputAccounting } from './browserInput'

describe('Electron tab browser page events', () => {
  it('consumes only exact adapter callbacks and records concurrent physical keyboard, composition, and pointer input', () => {
    const accounting = new SyntheticInputAccounting(), user = vi.fn(), blur = vi.fn()
    const handlers = createInputEventHandlers(accounting, user, blur)
    accounting.expect(cdpKeyInput('keyDown', 'a', 0))
    handlers.beforeInputEvent({ preventDefault: vi.fn() }, { type: 'keyDown', key: 'b', code: 'KeyB', isAutoRepeat: false, isComposing: false, shift: false, control: false, alt: false, meta: false, location: 0, modifiers: [] })
    expect(user).toHaveBeenCalledOnce()
    handlers.beforeInputEvent({ preventDefault: vi.fn() }, { type: 'keyDown', key: 'a', code: 'KeyA', isAutoRepeat: false, isComposing: false, shift: false, control: false, alt: false, meta: false, location: 0, modifiers: [] })
    expect(user).toHaveBeenCalledOnce()

    accounting.expect(cdpKeyInput('keyDown', 'a', 0))
    handlers.beforeInputEvent({ preventDefault: vi.fn() }, { type: 'keyDown', key: 'a', code: 'KeyA', isAutoRepeat: false, isComposing: true, shift: false, control: false, alt: false, meta: false, location: 0, modifiers: [] })
    expect(user).toHaveBeenCalledTimes(2)

    accounting.expect(cdpMouseInput('mousePressed', { x: 10, y: 20, button: 'left', clickCount: 1, modifiers: 0 }))
    handlers.beforeMouseEvent({ preventDefault: vi.fn() }, { type: 'mouseDown', x: 11, y: 20, button: 'left', clickCount: 1, modifiers: [] })
    expect(user).toHaveBeenCalledTimes(3)
    handlers.beforeMouseEvent({ preventDefault: vi.fn() }, { type: 'mouseDown', x: 10, y: 20, button: 'left', clickCount: 1, modifiers: [] })
    expect(user).toHaveBeenCalledTimes(3)
  })

  it('does not leak a late callback after cancellation into the next action', () => {
    const accounting = new SyntheticInputAccounting(), user = vi.fn(), handlers = createInputEventHandlers(accounting, user, vi.fn())
    accounting.expect(cdpMouseInput('mousePressed', { x: 10, y: 20, button: 'left', clickCount: 1, modifiers: 0 }))
    accounting.clear()
    handlers.beforeMouseEvent({ preventDefault: vi.fn() }, { type: 'mouseDown', x: 10, y: 20, button: 'left', clickCount: 1, modifiers: [] })
    expect(user).toHaveBeenCalledOnce()
  })

  it('projects only bounded main-frame history/hash navigation', () => {
    expect(projectInPageNavigation('https://example.test/app#next', true)).toEqual({ type: 'navigation-in-page', url: 'https://example.test/app#next' })
    expect(projectInPageNavigation('https://frame.example/', false)).toBeNull()
    const bounded = projectInPageNavigation(`https://example.test/${'x'.repeat(9000)}`, true)
    expect(bounded?.type === 'navigation-in-page' ? bounded.url.length : 0).toBe(8192)
  })
})
