import type { BrowserPoint, BrowserPointerInteraction } from './browserToolProtocol'
import { modifierMask } from './browserKeyboard'
export interface PointerDispatch {
  mouse(type: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel', point: BrowserPoint, extra?: Record<string, unknown>): Promise<void>
  text(text: string): Promise<void>
  verify(release?: boolean): Promise<void>
  pause(ms: number): Promise<void>
}
/** One bounded gesture; held input cleanup is owned by the adapter's finally. */
export async function dispatchPointer(operation: BrowserPointerInteraction, points: BrowserPoint[], io: PointerDispatch): Promise<void> {
  const modifiers = modifierMask(operation.modifiers)
  const movePath = async (held = false): Promise<void> => {
    for (let index = 0; index < points.length; index++) {
      await io.mouse('mouseMoved', points[index]!, { modifiers, ...(held ? { button: 'left', buttons: 1 } : {}) })
      if (index + 1 < points.length) await io.pause(16)
    }
  }
  if (operation.kind === 'typeFocused') { await io.verify(); await io.text(operation.text); return }
  if (operation.kind === 'mouseMove') { await movePath(); return }
  if (operation.kind === 'mouseScroll') { await io.mouse('mouseMoved', points[0]!, { modifiers }); await io.mouse('mouseWheel', points[0]!, { modifiers, deltaX: operation.deltaX, deltaY: operation.deltaY }); return }
  await io.verify()
  if (operation.kind === 'mouseClick') {
    await movePath(); await io.verify()
    const point = points.at(-1)!, button = operation.button ?? 'left'
    for (let count = 1; count <= (operation.clickCount ?? 1); count++) {
      if (count > 1) await io.verify()
      await io.mouse('mousePressed', point, { button, buttons: button === 'left' ? 1 : 2, clickCount: count, modifiers })
      await io.verify(true)
      await io.mouse('mouseReleased', point, { button, buttons: 0, clickCount: count, modifiers })
    }
  } else {
    await io.mouse('mouseMoved', points[0]!, { modifiers })
    await io.verify()
    await io.mouse('mousePressed', points[0]!, { button: 'left', buttons: 1, clickCount: 1, modifiers })
    await movePath(true)
    await io.verify(true)
    await io.mouse('mouseReleased', points.at(-1)!, { button: 'left', buttons: 0, clickCount: 1, modifiers })
  }
}
