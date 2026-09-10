import { describe, expect, it } from 'vitest'
import { dispatchPointer } from './browserPointer'
import { parseBrowserToolAction } from './browserToolProtocol'
import { classifyInteraction, interactionValueDigest } from './browserApproval'
import { BrowserAutomationError } from './browserErrors'
import { safeBrokerFailure } from './tabBrowserBroker'

it('forwards bounded preparation diagnostics without page text or values', () => {
  const failure = safeBrokerFailure(new BrowserAutomationError('TARGET_OCCLUDED', false, { reason: 'occluded', targetRef: 'n1', attemptedPoints: 5 }))
  expect(failure).toMatchObject({ diagnostics: { reason: 'occluded', targetRef: 'n1', attemptedPoints: 5 } })
})
const outer = { type: 'interact', pageIncarnation: 'p', expectedGeneration: 4 }
describe('grounded pointer contract', () => {
  it.each([
    { kind: 'mouseMove', screenshotId: 'image', x: 10, y: 20 },
    { kind: 'mouseClick', screenshotId: 'image', x: 10, y: 20, button: 'right', clickCount: 2 },
    { kind: 'mouseScroll', screenshotId: 'image', x: 10, y: 20, deltaX: 0, deltaY: 300 },
    { kind: 'mouseDrag', screenshotId: 'image', path: [{ x: 10, y: 20 }, { x: 30, y: 40 }] },
    { kind: 'typeFocused', screenshotId: 'image', text: 'potatoes' },
  ])('accepts the bounded $kind operation', operation => {
    expect(parseBrowserToolAction({ ...outer, operation })).toMatchObject({ operation })
  })
  it.each([
    { kind: 'mouseClick', screenshotId: 'image', x: NaN, y: 0 },
    { kind: 'mouseMove', screenshotId: 'image', x: -1, y: 0 },
    { kind: 'mouseDrag', screenshotId: 'image', path: [{ x: 0, y: 0 }] },
    { kind: 'mouseDrag', screenshotId: 'image', path: Array.from({ length: 65 }, () => ({ x: 0, y: 0 })) },
    { kind: 'mouseClick', screenshotId: 'image', x: 0, y: 0, button: 'middle' },
    { kind: 'mouseMove', x: 0, y: 0 },
    { kind: 'press', key: 'V', modifiers: ['Control'] },
    { kind: 'press', key: 'A', modifiers: ['Control', 'Control'] },
  ])('rejects unsafe or ungrounded input %j', operation => {
    expect(() => parseBrowserToolAction({ ...outer, operation })).toThrow('INVALID_REQUEST')
  })
  it('requires one-off approval for coordinate activation and binds the whole gesture', () => {
    const a = parseBrowserToolAction({ ...outer, operation: { kind: 'mouseClick', screenshotId: 'image', x: 1, y: 2 } })
    const b = parseBrowserToolAction({ ...outer, operation: { kind: 'mouseClick', screenshotId: 'image', x: 3, y: 2 } })
    if (a.type !== 'interact' || b.type !== 'interact') throw new Error('wrong action')
    expect(classifyInteraction(a.operation)).toMatchObject({ consequential: true, canGrantOrigin: false })
    expect(interactionValueDigest(a.operation)).not.toBe(interactionValueDigest(b.operation))
  })
  it('collapses any active text selection before dragging so the gesture stays a mouse drag', async () => {
    const events: string[] = []
    await dispatchPointer({ kind: 'mouseDrag', screenshotId: 'image', path: [{ x: 10, y: 20 }, { x: 30, y: 40 }] }, [{ x: 10, y: 20 }, { x: 30, y: 40 }], {
      mouse: async (type, point, extra) => { events.push(`${type}@${point.x},${point.y}${extra?.['clickCount'] !== undefined ? '#c' + String(extra?.['clickCount']) : ''}`) },
      text: async () => {},
      verify: async () => {},
      pause: async () => {},
    })
    // A prior page selection makes Chromium route press+move+release through the
    // HTML5 drag pipeline (dragstart/dragend) and swallow the mouseup; collapsing
    // the selection with an out-of-content press+release keeps it a mouse drag.
    expect(events[0]).toBe('mouseMoved@10,20')
    expect(events[1]).toBe('mousePressed@-1,-1#c0')
    expect(events[2]).toBe('mouseReleased@-1,-1#c0')
    expect(events.indexOf('mousePressed@10,20#c1')).toBeGreaterThan(2)
    expect(events.at(-1)).toBe('mouseReleased@30,40#c1')
  })
})
