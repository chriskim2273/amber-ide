// Only numeric protocol identities/edges are retained. Page attributes/text are not stored.
// describeNode omits parentId on real Chromium; setChildNodes supplies the edges.
interface Relation { backend: number; parent: number }
function id(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }
function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined }

export class BrowserDomRelations {
  private readonly nodes = new Map<number, Relation>()
  private readonly children = new Map<number, Set<number>>()
  private exhausted = false
  constructor(private readonly limit = 4096) {}
  clear(): void { this.nodes.clear(); this.children.clear(); this.exhausted = false }
  private exhaust(): void { this.clear(); this.exhausted = true }
  parentOf(nodeId: number): number | undefined { return this.nodes.get(nodeId)?.parent }
  isWithin(nodeId: number, backendTarget: number): boolean {
    if (this.exhausted || !id(nodeId) || !id(backendTarget)) return false
    const seen = new Set<number>()
    for (let depth = 0; depth < 32 && !seen.has(nodeId); depth++) {
      seen.add(nodeId)
      const relation = this.nodes.get(nodeId)
      if (!relation) return false
      if (relation.backend === backendTarget) return true
      nodeId = relation.parent
    }
    return false
  }
  private remove(nodeId: number): void {
    const pending = [nodeId], seen = new Set<number>()
    while (pending.length && seen.size <= this.limit) {
      const current = pending.pop()!
      if (seen.has(current)) continue
      seen.add(current)
      const relation = this.nodes.get(current)
      if (relation) {
        const siblings = this.children.get(relation.parent)
        siblings?.delete(current)
        if (siblings?.size === 0) this.children.delete(relation.parent)
      }
      for (const child of this.children.get(current) ?? []) pending.push(child)
      this.children.delete(current); this.nodes.delete(current)
    }
  }
  private remember(rawNodes: unknown, parent: unknown): void {
    if (this.exhausted || !id(parent) || !Array.isArray(rawNodes)) return
    if (rawNodes.length > this.limit) { this.exhaust(); return }
    const pending = rawNodes.map(node => ({ node, parent }))
    let scanned = 0
    while (pending.length) {
      if (++scanned > this.limit) { this.exhaust(); return }
      const item = pending.pop()!, node = record(item.node)
      if (!node || !id(node['nodeId']) || !id(node['backendNodeId'])) continue
      const nodeId = node['nodeId'], old = this.nodes.get(nodeId)
      if (!old && this.nodes.size >= this.limit) { this.exhaust(); return }
      if (old && old.parent !== item.parent) {
        const siblings = this.children.get(old.parent)
        siblings?.delete(nodeId)
        if (siblings?.size === 0) this.children.delete(old.parent)
      }
      this.nodes.set(nodeId, { backend: node['backendNodeId'], parent: item.parent })
      if (!this.children.has(item.parent)) this.children.set(item.parent, new Set())
      this.children.get(item.parent)!.add(nodeId)
      // Author shadow roots participate in composed ancestry. Frame documents do not.
      for (const key of ['children', 'shadowRoots']) {
        const nested = node[key]
        if (!Array.isArray(nested)) continue
        if (scanned + pending.length + nested.length > this.limit) { this.exhaust(); return }
        for (const child of nested) pending.push({ node: child, parent: nodeId })
      }
    }
  }
  onMessage(method: string, params: Record<string, unknown>): void {
    if (method === 'DOM.documentUpdated') { this.clear(); return }
    if (this.exhausted) return
    if (method === 'DOM.setChildNodes') this.remember(params['nodes'], params['parentId'])
    else if (method === 'DOM.childNodeInserted') this.remember([params['node']], params['parentNodeId'])
    else if (method === 'DOM.shadowRootPushed') this.remember([params['root']], params['hostId'])
    else if (method === 'DOM.childNodeRemoved' && id(params['nodeId'])) this.remove(params['nodeId'])
    else if (method === 'DOM.shadowRootPopped' && id(params['rootId'])) this.remove(params['rootId'])
  }
}
