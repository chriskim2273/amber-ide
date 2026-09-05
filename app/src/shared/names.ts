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

// Retarget a daemon session name at another ws/tab (grouping is name-encoded —
// core rule #2 — so a cross-tab/ws move IS a rename). The pane's stable `id` is
// kept; only ws/tab/ord change. Omitted ws/tab keep their current value. Returns
// null for app-local pane ids, which never reach daemon Rename.
export function retargetPane(name: string, to: { ws?: number; tab?: number; ord: number }): string | null {
  const p = parseName(name)
  if (!p) return null
  return formatName({ ...p, ws: to.ws ?? p.ws, tab: to.tab ?? p.tab, ord: to.ord })
}

let counter = 0
export function makeId(): string {
  counter = (counter + 1) % 0xffff
  // Time + counter keeps ids unique within a session without crypto.
  return (Date.now().toString(36) + counter.toString(36)).replace(/[^a-z0-9]/g, '')
}
