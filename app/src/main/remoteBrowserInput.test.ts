import { describe, expect, it } from 'vitest'
import { BrowserObservations } from './browserObservations'
import { remoteInputEvents } from './remoteBrowserInput'

const observation = new BrowserObservations(() => 1).issue({
  browserId: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  pageIncarnation: 'page',
  generation: 0,
  imageWidth: 200,
  imageHeight: 100,
  viewport: { width: 100, height: 50, pageX: 0, pageY: 0 },
})

describe('remote browser input', () => {
  it('maps screenshot clicks into view-local mouse events', () => {
    expect(remoteInputEvents(observation, { kind: 'mouseClick', screenshotId: observation.screenshotId, x: 40, y: 20, button: 'left', clickCount: 1 })).toEqual([
      { type: 'mouseMove', x: 20, y: 10, button: 'left', clickCount: 0 },
      { type: 'mouseDown', x: 20, y: 10, button: 'left', clickCount: 1 },
      { type: 'mouseUp', x: 20, y: 10, button: 'left', clickCount: 1 },
    ])
  })

  it('types into the focused guest without a screenshot hit-test', () => {
    expect(remoteInputEvents(observation, { kind: 'typeFocused', screenshotId: observation.screenshotId, text: 'hi' }))
      .toEqual([{ type: 'insertText', text: 'hi' }])
  })

  it('rejects non-pointer remote operations', () => {
    expect(() => remoteInputEvents(observation, { kind: 'fill', target: { snapshotId: 's', ref: 'n1' }, text: 'x' })).toThrow('INVALID_REQUEST')
  })
})
