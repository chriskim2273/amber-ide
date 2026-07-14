export interface PaneName { ws: number; tab: number; ord: number; id: string }

const RE = /^amber-(\d+)-(\d+)-(\d+)-([A-Za-z0-9]+)$/

export function parseName(name: string): PaneName | null {
  const m = RE.exec(name)
  if (!m) return null
  return { ws: Number(m[1]), tab: Number(m[2]), ord: Number(m[3]), id: m[4] as string }
}

export function formatName(p: PaneName): string {
  return `amber-${p.ws}-${p.tab}-${p.ord}-${p.id}`
}

let counter = 0
export function makeId(): string {
  counter = (counter + 1) % 0xffff
  // Time + counter keeps ids unique within a session without crypto.
  return (Date.now().toString(36) + counter.toString(36)).replace(/[^a-z0-9]/g, '')
}
