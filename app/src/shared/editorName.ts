// Pure editor-pane id grammar (mirrors browserName.ts — an editor pane is the
// same class of app-local, sidecar-owned pane with NO daemon session).
// No React — importable from renderer + shared + node test env.

const RE = /^editor-(\d+)-(\d+)-(\d+)-(.+)$/

export function formatEditorName(p: { ws: number; tab: number; ord: number; id: string }): string {
  return `editor-${p.ws}-${p.tab}-${p.ord}-${p.id}`
}

export function parseEditorName(name: string): { ws: number; tab: number; ord: number; id: string } | null {
  const m = RE.exec(name)
  if (!m) return null
  return { ws: Number(m[1]), tab: Number(m[2]), ord: Number(m[3]), id: m[4]! }
}

export function isEditorName(name: string): boolean {
  return name.startsWith('editor-') && RE.test(name)
}
