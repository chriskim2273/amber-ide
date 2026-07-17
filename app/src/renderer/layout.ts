export type Node =
  | { kind: 'leaf'; paneId: string }
  | { kind: 'split'; dir: 'h' | 'v'; ratio: number; a: Node; b: Node }
export interface Rect { x: number; y: number; w: number; h: number }

export function leaves(n: Node): string[] {
  return n.kind === 'leaf' ? [n.paneId] : [...leaves(n.a), ...leaves(n.b)]
}

export function splitLeaf(n: Node, paneId: string, dir: 'h' | 'v', newId: string): Node {
  if (n.kind === 'leaf') {
    if (n.paneId !== paneId) return n
    return { kind: 'split', dir, ratio: 0.5, a: { kind: 'leaf', paneId }, b: { kind: 'leaf', paneId: newId } }
  }
  return { ...n, a: splitLeaf(n.a, paneId, dir, newId), b: splitLeaf(n.b, paneId, dir, newId) }
}

export function removeLeaf(n: Node, paneId: string): Node | null {
  if (n.kind === 'leaf') return n.paneId === paneId ? null : n
  const a = removeLeaf(n.a, paneId)
  const b = removeLeaf(n.b, paneId)
  if (a === null) return b
  if (b === null) return a
  return { ...n, a, b }
}

export function setRatio(n: Node, path: Array<'a' | 'b'>, ratio: number): Node {
  if (n.kind !== 'split') return n
  if (path.length === 0) return { ...n, ratio: Math.min(0.95, Math.max(0.05, ratio)) }
  const [head, ...rest] = path
  return head === 'a'
    ? { ...n, a: setRatio(n.a, rest, ratio) }
    : { ...n, b: setRatio(n.b, rest, ratio) }
}

export type Zone = 'left' | 'right' | 'top' | 'bottom' | 'center'

/** Move `sourceId` next to (or onto) `targetId` per drop `zone`. The leaf set
 *  is invariant, so `reconcile` stays a no-op afterward. Edge zones re-split the
 *  target; `center` swaps the two panes; dropping on itself is a no-op. */
export function moveLeaf(n: Node, sourceId: string, targetId: string, zone: Zone): Node {
  if (sourceId === targetId) return n
  if (zone === 'center') return swapLeaves(n, sourceId, targetId)
  // Remove the source first, then graft it beside the target (found by paneId,
  // so the path shift from removal is irrelevant). If the source was the whole
  // tree there is nothing to move — leave it be.
  const without = removeLeaf(n, sourceId)
  if (without === null) return n
  return graftBeside(without, targetId, sourceId, zone)
}

function swapLeaves(n: Node, a: string, b: string): Node {
  if (n.kind === 'leaf') {
    if (n.paneId === a) return { kind: 'leaf', paneId: b }
    if (n.paneId === b) return { kind: 'leaf', paneId: a }
    return n
  }
  return { ...n, a: swapLeaves(n.a, a, b), b: swapLeaves(n.b, a, b) }
}

function graftBeside(n: Node, targetId: string, sourceId: string, zone: Zone): Node {
  if (n.kind === 'leaf') {
    if (n.paneId !== targetId) return n
    const dir: 'h' | 'v' = zone === 'left' || zone === 'right' ? 'h' : 'v'
    const src: Node = { kind: 'leaf', paneId: sourceId }
    const tgt: Node = { kind: 'leaf', paneId: targetId }
    const near = zone === 'left' || zone === 'top' // source on the near side
    return { kind: 'split', dir, ratio: 0.5, a: near ? src : tgt, b: near ? tgt : src }
  }
  return { ...n, a: graftBeside(n.a, targetId, sourceId, zone), b: graftBeside(n.b, targetId, sourceId, zone) }
}

export function paneRects(n: Node, area: Rect): Array<{ paneId: string; rect: Rect }> {
  if (n.kind === 'leaf') return [{ paneId: n.paneId, rect: area }]
  const [ra, rb] = splitRect(area, n.dir, n.ratio)
  return [...paneRects(n.a, ra), ...paneRects(n.b, rb)]
}

export function handles(n: Node, area: Rect): Array<{ path: Array<'a' | 'b'>; dir: 'h' | 'v'; rect: Rect }> {
  if (n.kind === 'leaf') return []
  const [ra, rb] = splitRect(area, n.dir, n.ratio)
  const T = 6
  const self = n.dir === 'h'
    ? { path: [] as Array<'a' | 'b'>, dir: n.dir, rect: { x: ra.x + ra.w - T / 2, y: area.y, w: T, h: area.h } }
    : { path: [] as Array<'a' | 'b'>, dir: n.dir, rect: { x: area.x, y: ra.y + ra.h - T / 2, w: area.w, h: T } }
  const nest = (side: 'a' | 'b', hs: ReturnType<typeof handles>) =>
    hs.map((h) => ({ ...h, path: [side, ...h.path] as Array<'a' | 'b'> }))
  return [self, ...nest('a', handles(n.a, ra)), ...nest('b', handles(n.b, rb))]
}

function splitRect(area: Rect, dir: 'h' | 'v', ratio: number): [Rect, Rect] {
  if (dir === 'h') {
    const wa = Math.round(area.w * ratio)
    return [{ ...area, w: wa }, { x: area.x + wa, y: area.y, w: area.w - wa, h: area.h }]
  }
  const ha = Math.round(area.h * ratio)
  return [{ ...area, h: ha }, { x: area.x, y: area.y + ha, w: area.w, h: area.h - ha }]
}

export function equalColumns(paneIds: string[]): Node | null {
  if (paneIds.length === 0) return null
  let tree: Node = { kind: 'leaf', paneId: paneIds[0] as string }
  for (let i = 1; i < paneIds.length; i++) {
    // append the new pane as a right column with even weighting
    tree = { kind: 'split', dir: 'h', ratio: i / (i + 1), a: tree, b: { kind: 'leaf', paneId: paneIds[i] as string } }
  }
  return tree
}

export type FocusDir = 'left' | 'right' | 'up' | 'down'

/** Pick the pane to focus when moving `dir` from `fromId`, given the laid-out
 *  rect list. Considers only panes whose center lies strictly in that direction
 *  from the source center; among those, nearest on the primary axis wins, ties
 *  broken by the smaller secondary-axis distance. Returns null at an edge (no
 *  pane in that direction) or when `fromId` is not in the list. Pure. */
export function nextPaneInDirection(
  rects: Array<{ paneId: string; rect: Rect }>,
  fromId: string,
  dir: FocusDir,
): string | null {
  const from = rects.find((r) => r.paneId === fromId)
  if (!from) return null
  const fx = from.rect.x + from.rect.w / 2
  const fy = from.rect.y + from.rect.h / 2
  let best: string | null = null
  let bestPrimary = Infinity
  let bestSecondary = Infinity
  for (const r of rects) {
    if (r.paneId === fromId) continue
    const cx = r.rect.x + r.rect.w / 2
    const cy = r.rect.y + r.rect.h / 2
    let primary: number
    let secondary: number
    if (dir === 'left') { if (cx >= fx) continue; primary = fx - cx; secondary = Math.abs(cy - fy) }
    else if (dir === 'right') { if (cx <= fx) continue; primary = cx - fx; secondary = Math.abs(cy - fy) }
    else if (dir === 'up') { if (cy >= fy) continue; primary = fy - cy; secondary = Math.abs(cx - fx) }
    else { if (cy <= fy) continue; primary = cy - fy; secondary = Math.abs(cx - fx) }
    if (primary < bestPrimary || (primary === bestPrimary && secondary < bestSecondary)) {
      best = r.paneId
      bestPrimary = primary
      bestSecondary = secondary
    }
  }
  return best
}

export function reconcile(tree: Node | null, liveIds: string[]): Node | null {
  const live = new Set(liveIds)
  let pruned = tree
  if (pruned) for (const id of leaves(pruned)) if (!live.has(id)) pruned = pruned ? removeLeaf(pruned, id) : null
  const present = new Set(pruned ? leaves(pruned) : [])
  const missing = liveIds.filter((id) => !present.has(id))
  for (const id of missing) {
    pruned = pruned === null
      ? { kind: 'leaf', paneId: id }
      : { kind: 'split', dir: 'h', ratio: 0.66, a: pruned, b: { kind: 'leaf', paneId: id } }
  }
  return pruned
}
