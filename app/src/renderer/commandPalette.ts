export interface PaletteEntry {
  id: string
  label: string
  detail: string
  keywords: string
  run: () => void
}

function score(entry: PaletteEntry, raw: string): number | null {
  const query = raw.trim().toLowerCase()
  if (query === '') return 0
  const label = entry.label.toLowerCase()
  const haystack = `${label} ${entry.detail} ${entry.keywords}`.toLowerCase()
  if (label === query) return 0
  if (label.startsWith(query)) return 1
  const direct = haystack.indexOf(query)
  if (direct >= 0) return 10 + direct
  let cursor = 0
  let gaps = 0
  for (const char of query) {
    const next = haystack.indexOf(char, cursor)
    if (next < 0) return null
    gaps += next - cursor
    cursor = next + 1
  }
  return 100 + gaps
}

export function filterPalette(entries: PaletteEntry[], query: string, limit = 80): PaletteEntry[] {
  return entries.map((entry, index) => ({ entry, index, score: score(entry, query) }))
    .filter((row): row is { entry: PaletteEntry; index: number; score: number } => row.score !== null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, limit).map((row) => row.entry)
}
