import { describe, expect, it, vi } from 'vitest'
import {
  browserWindowCanRemoveChildView,
  closeGuestWebContents,
  createInputEventHandlers,
  documentCanArmBrowserDebugger,
  guestWebContentsCloseFinished,
  noteGuestWebContentsClosing,
  ownerWindowCloseIsFromGuest,
  projectInPageNavigation,
  shouldHideLocalWindowOnClose,
} from './electronTabBrowserPage'

describe('Electron tab browser page events', () => {
  it('distinguishes the implicit blank document from an explicitly loaded blank page', () => {
    expect(documentCanArmBrowserDebugger('about:blank', false)).toBe(false)
    expect(documentCanArmBrowserDebugger('about:blank', true)).toBe(true)
    expect(documentCanArmBrowserDebugger('https://fixture.test/', false)).toBe(true)
  })

  it('does not reparent through a BrowserWindow that already closed', () => {
    expect(browserWindowCanRemoveChildView({ isDestroyed: () => false })).toBe(true)
    expect(browserWindowCanRemoveChildView({ isDestroyed: () => true })).toBe(false)
  })

  it('reclaims guest webContents even while the owner window is alive', () => {
    const owner = { isDestroyed: () => false }
    const close = vi.fn()
    closeGuestWebContents(owner, { isDestroyed: () => false, close })
    expect(close).toHaveBeenCalledOnce()
    expect(ownerWindowCloseIsFromGuest(owner)).toBe(true)
    guestWebContentsCloseFinished(owner)
  })

  it('still reclaims leftover guest webContents after the owner window is gone', () => {
    const close = vi.fn()
    closeGuestWebContents(
      { isDestroyed: () => true },
      { isDestroyed: () => false, close },
    )
    expect(close).toHaveBeenCalledOnce()
  })

  it('does not close an already-destroyed guest webContents', () => {
    const close = vi.fn()
    closeGuestWebContents(
      { isDestroyed: () => true },
      { isDestroyed: () => true, close },
    )
    expect(close).not.toHaveBeenCalled()
  })

  it('does not double-count a guest close that was already noted', () => {
    const owner = { isDestroyed: () => false }
    const close = vi.fn()
    noteGuestWebContentsClosing(owner)
    closeGuestWebContents(owner, { isDestroyed: () => false, close })
    expect(ownerWindowCloseIsFromGuest(owner)).toBe(true)
    guestWebContentsCloseFinished(owner)
    expect(ownerWindowCloseIsFromGuest(owner)).toBe(false)
  })

  it('treats a guest webContents close as not a request to hide or quit the app', () => {
    const owner = {}
    expect(ownerWindowCloseIsFromGuest(owner)).toBe(false)
    noteGuestWebContentsClosing(owner)
    expect(ownerWindowCloseIsFromGuest(owner)).toBe(true)
    expect(shouldHideLocalWindowOnClose({
      hostEnabled: true, isLocal: true, allowFinalQuit: false, fromGuestWebContents: true,
    })).toBe('ignore')
    guestWebContentsCloseFinished(owner)
    expect(ownerWindowCloseIsFromGuest(owner)).toBe(false)
  })

  it('still hides a local host window on a real user close, and still quits without the host', () => {
    expect(shouldHideLocalWindowOnClose({
      hostEnabled: true, isLocal: true, allowFinalQuit: false, fromGuestWebContents: false,
    })).toBe('hide')
    expect(shouldHideLocalWindowOnClose({
      hostEnabled: false, isLocal: true, allowFinalQuit: false, fromGuestWebContents: false,
    })).toBe('allow-close')
    expect(shouldHideLocalWindowOnClose({
      hostEnabled: true, isLocal: true, allowFinalQuit: true, fromGuestWebContents: false,
    })).toBe('allow-close')
    expect(shouldHideLocalWindowOnClose({
      hostEnabled: true, isLocal: true, allowFinalQuit: true, fromGuestWebContents: true,
    })).toBe('allow-close')
  })

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
