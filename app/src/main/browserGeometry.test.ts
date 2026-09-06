import { describe, expect, it } from 'vitest'
import { quadBounds } from './browserGeometry'

describe('quad bounds', () => {
  it.each([
    { quad: [400, 20, 500, 20, 500, 60, 400, 60], want: { x: 400, y: 20, width: 100, height: 40 } },
    { quad: [20, 400, 60, 400, 60, 500, 20, 500], want: { x: 20, y: 400, width: 40, height: 100 } },
    { quad: [-10, 0, 0, -10, 10, 0, 0, 10], want: { x: -10, y: -10, width: 20, height: 20 } },
  ])('extracts axes independently: $quad', ({ quad, want }) => {
    expect(quadBounds(quad)).toEqual(want)
  })
  it.each([[], [0, 0, 1, 0], [0, 0, Infinity, 0, 1, 1, 0, 1], [0, 0, 0, 0, 0, 1, 0, 1], [0, 0, NaN, 0, 1, 1, 0, 1]].map(quad => ({ quad })))('rejects invalid/degenerate quads $quad', ({ quad }) => {
    expect(() => quadBounds(quad)).toThrow('TARGET_NOT_ACTIONABLE')
  })
})
