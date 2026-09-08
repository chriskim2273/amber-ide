import { describe, expect, it } from 'vitest'
import { attachRemotePresentation, parseRemoteInput, rewriteRemotePresentation } from './browserUiDispatch'
import type { TabBrowserCommand } from './tabBrowserService'

describe('remote presentation', () => {
  it('rewrites overlay coordinates to the host origin while keeping the rail size', () => {
    const show: TabBrowserCommand = { type: 'show', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', bounds: { x: 412, y: 88, width: 420, height: 800 } }
    expect(rewriteRemotePresentation(show)).toEqual({
      type: 'show', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', bounds: { x: 0, y: 0, width: 420, height: 800 },
    })
    const bounds: TabBrowserCommand = { type: 'bounds', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', bounds: { x: 10, y: 20, width: 300, height: 400 } }
    const rewritten = rewriteRemotePresentation(bounds)
    expect(rewritten).toEqual({ type: 'bounds', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', bounds: { x: 0, y: 0, width: 300, height: 400 } })
    expect(rewriteRemotePresentation({ type: 'hide', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })).toEqual({ type: 'hide', id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
  })

  it('tags successful remote results without inventing a presentation for errors or closed replies', () => {
    expect(attachRemotePresentation({ id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', generation: 2 }, true))
      .toEqual({ id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', generation: 2, presentation: 'remote' })
    expect(attachRemotePresentation({ closed: true }, true)).toEqual({ closed: true, presentation: 'remote' })
    expect(attachRemotePresentation({ id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, false)).toEqual({ id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
    expect(attachRemotePresentation('nope', true)).toBe('nope')
  })

  it('maps remote input onto a grounded interact command for the active browser', () => {
    const command = parseRemoteInput({
      type: 'remoteInput',
      pageIncarnation: 'page',
      expectedGeneration: 3,
      operation: { kind: 'mouseClick', screenshotId: 'shot', x: 10, y: 20, button: 'left', clickCount: 1 },
    }, 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(command).toMatchObject({
      type: 'automation',
      id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      action: { type: 'interact', pageIncarnation: 'page', expectedGeneration: 3, operation: { kind: 'mouseClick', screenshotId: 'shot', x: 10, y: 20 } },
    })
    expect(() => parseRemoteInput({ type: 'remoteInput', pageIncarnation: 'page', expectedGeneration: 3, operation: { kind: 'cdp' } }, 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toThrow('INVALID_REQUEST')
  })
})
