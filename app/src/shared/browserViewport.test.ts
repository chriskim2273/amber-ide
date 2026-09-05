import { describe, expect, it } from 'vitest'
import { BROWSER_VIEWPORT_MAX_HEIGHT, BROWSER_VIEWPORT_MAX_WIDTH, BROWSER_VIEWPORT_MIN_HEIGHT, BROWSER_VIEWPORT_MIN_WIDTH, clampBrowserViewport, parseBrowserViewport } from './browserViewport'

describe('shared browser viewport contract', () => {
  it('uses one inclusive integer bound across every caller', () => {
    expect([BROWSER_VIEWPORT_MIN_WIDTH, BROWSER_VIEWPORT_MIN_HEIGHT, BROWSER_VIEWPORT_MAX_WIDTH, BROWSER_VIEWPORT_MAX_HEIGHT]).toEqual([200, 200, 4096, 4096])
    expect(parseBrowserViewport({ width: 200, height: 200 })).toEqual({ width: 200, height: 200 })
    expect(parseBrowserViewport({ width: 4096, height: 4096 })).toEqual({ width: 4096, height: 4096 })
    expect(parseBrowserViewport({ width: 199, height: 200 })).toBeNull()
    expect(parseBrowserViewport({ width: 200, height: 4097 })).toBeNull()
    expect(parseBrowserViewport({ width: 200.5, height: 200 })).toBeNull()
    expect(clampBrowserViewport(1, 9000)).toEqual({ width: 200, height: 4096 })
  })
})
