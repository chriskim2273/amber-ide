import { mapScreenshotPoint, type ScreenshotObservation } from './browserObservations'
import type { BrowserInteraction } from './browserToolProtocol'

export type RemoteInputEvent =
  | { type: 'mouseMove' | 'mouseDown' | 'mouseUp'; x: number; y: number; button: 'left' | 'right'; clickCount: number }
  | { type: 'insertText'; text: string }

export function remoteInputEvents(observation: ScreenshotObservation, operation: BrowserInteraction): RemoteInputEvent[] {
  if (operation.kind === 'mouseClick') {
    const point = mapScreenshotPoint(observation, { x: operation.x, y: operation.y })
    const button = operation.button ?? 'left'
    const clickCount = operation.clickCount ?? 1
    return [
      { type: 'mouseMove', x: point.x, y: point.y, button, clickCount: 0 },
      { type: 'mouseDown', x: point.x, y: point.y, button, clickCount },
      { type: 'mouseUp', x: point.x, y: point.y, button, clickCount },
    ]
  }
  if (operation.kind === 'typeFocused') return [{ type: 'insertText', text: operation.text }]
  throw new Error('INVALID_REQUEST')
}
