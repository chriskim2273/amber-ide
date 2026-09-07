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

/** Clip a convex CDP quad to the viewport and retain at most five interior hits. */
export function visibleQuadPoints(quad: readonly number[], width: number, height: number): Array<{ x: number; y: number }> {
  quadBounds(quad)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) throw new Error('TARGET_NOT_ACTIONABLE')
  type Point = { x: number; y: number }
  let polygon: Point[] = [0, 2, 4, 6].map(index => ({ x: quad[index]!, y: quad[index + 1]! }))
  for (const [axis, boundary, greater] of [['x', 0, true], ['x', width, false], ['y', 0, true], ['y', height, false]] as const) {
    const result: Point[] = []
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!
      const insideA = greater ? a[axis] >= boundary : a[axis] <= boundary
      const insideB = greater ? b[axis] >= boundary : b[axis] <= boundary
      if (insideA) result.push(a)
      if (insideA !== insideB) {
        const ratio = (boundary - a[axis]) / (b[axis] - a[axis])
        result.push({ x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio })
      }
    }
    polygon = result
  }
  if (polygon.length < 3) throw new Error('TARGET_NOT_ACTIONABLE')
  let area = 0
  for (let i = 0; i < polygon.length; i++) { const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!; area += a.x * b.y - b.x * a.y }
  if (Math.abs(area) < 0.01) throw new Error('TARGET_NOT_ACTIONABLE')
  const center = { x: polygon.reduce((sum, p) => sum + p.x, 0) / polygon.length, y: polygon.reduce((sum, p) => sum + p.y, 0) / polygon.length }
  return [center, ...polygon.slice(0, 4).map(p => ({ x: (p.x + center.x) / 2, y: (p.y + center.y) / 2 }))]
}
