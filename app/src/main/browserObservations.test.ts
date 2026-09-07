import { describe, expect, it } from 'vitest'
import { BrowserObservations, mapScreenshotPoint } from './browserObservations'

const capture = { browserId: 'b', pageIncarnation: 'p', generation: 4, controller: 'pi', imageWidth: 1600, imageHeight: 1200,
  viewport: { width: 800, height: 600, pageX: 0, pageY: 350 } }
const lease = { browserId: 'b', pageIncarnation: 'p', generation: 4, controller: 'pi' }
describe('screenshot observations', () => {
  it('maps delivered image pixels onto viewport CSS pixels, not document coordinates', () => {
    const store = new BrowserObservations()
    const observation = store.issue(capture)
    expect(mapScreenshotPoint(observation, { x: 800, y: 600 })).toEqual({ x: 400, y: 300 })
    expect(store.resolve(lease, observation.screenshotId)).toEqual(observation)
    expect(() => mapScreenshotPoint(observation, { x: 1600, y: 0 })).toThrow('INVALID_REQUEST')
    expect(() => mapScreenshotPoint(observation, { x: NaN, y: 0 })).toThrow('INVALID_REQUEST')
  })
  it('rejects stale generation, controller or page identity', () => {
    const store = new BrowserObservations(), observation = store.issue(capture)
    for (const changed of [{ generation: 5 }, { controller: 'another' }, { pageIncarnation: 'new' }]) {
      expect(() => store.resolve({ ...lease, ...changed }, observation.screenshotId)).toThrow('STALE_GENERATION')
    }
    store.clear()
    expect(() => store.resolve(lease, observation.screenshotId)).toThrow('STALE_GENERATION')
  })
  it('bounds retained metadata and expires old observations', () => {
    let now = 0
    const store = new BrowserObservations(() => now)
    const oldest = store.issue(capture)
    for (let i = 0; i < 4; i++) store.issue(capture)
    expect(() => store.resolve(lease, oldest.screenshotId)).toThrow('STALE_GENERATION')
    const current = store.issue(capture)
    now = 60001
    expect(() => store.resolve(lease, current.screenshotId)).toThrow('STALE_GENERATION')
  })
})
