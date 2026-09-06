export interface BrowserRect { x: number; y: number; width: number; height: number }

/** CDP quads alternate x/y; a minimum over the whole array corrupts both axes. */
export function quadBounds(quad: readonly number[]): BrowserRect {
  if (quad.length !== 8 || !quad.every(value => Number.isFinite(value))) throw new Error('TARGET_NOT_ACTIONABLE')
  const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!], ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!]
  const x = Math.min(...xs), y = Math.min(...ys)
  const width = Math.max(...xs) - x, height = Math.max(...ys) - y
  if (width <= 0 || height <= 0) throw new Error('TARGET_NOT_ACTIONABLE')
  return { x, y, width, height }
}
