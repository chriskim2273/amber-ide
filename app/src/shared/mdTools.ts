// Pure Markdown helpers for the editor pane (spec 2026-07-19 §7). No DOM, no
// deps — importable from the renderer and the node test env. Every editing
// helper takes (text, from, to) and returns the new text plus the selection to
// restore, so the caller can dispatch one CodeMirror transaction.

export interface MdHeading {
  level: number // 1..6
  text: string
  line: number // 1-BASED, matching CodeMirror's doc.line(n)
}

export interface MdEdit {
  text: string
  from: number
  to: number
}

// ---- outline ----------------------------------------------------------------
const ATX = /^ {0,3}(#{1,6})\s+(.*?)\s*$/
const SETEXT = /^ {0,3}(=+|-+)\s*$/
const FENCE = /^\s*(```|~~~)/

// ATX + setext headings, skipping anything inside a fenced code block (a `#`
// comment in a shell snippet is not a heading).
export function mdOutline(text: string): MdHeading[] {
  const lines = text.split('\n')
  const out: MdHeading[] = []
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const f = FENCE.exec(line)
    if (f) {
      if (fence === null) fence = f[1]!
      else if (f[1] === fence) fence = null
      continue
    }
    if (fence !== null) continue
    const atx = ATX.exec(line)
    if (atx) {
      // A closing run of hashes is decoration, not text.
      out.push({ level: atx[1]!.length, text: atx[2]!.replace(/\s*#+\s*$/, ''), line: i + 1 })
      continue
    }
    // Setext: the PREVIOUS line is the heading text. A blank/heading/fenced
    // predecessor means this is a horizontal rule, not an underline.
    const se = SETEXT.exec(line)
    const prev = i > 0 ? lines[i - 1]! : ''
    if (se && prev.trim() !== '' && !ATX.test(prev) && !SETEXT.test(prev) && !FENCE.test(prev)) {
      out.push({ level: se[1]!.startsWith('=') ? 1 : 2, text: prev.trim(), line: i })
    }
  }
  return out
}

// ---- inline wrap toggles ----------------------------------------------------
// Three cases, in order: markers inside the selection → strip them; markers
// immediately around the selection → strip them; otherwise wrap. Applying the
// same toggle to the result restores the original text AND selection.
function toggleWrap(text: string, from: number, to: number, mark: string): MdEdit {
  const n = mark.length
  const sel = text.slice(from, to)
  // A single '*' must not mistake a '**' bold marker for its own.
  const solo = (i: number, dir: -1 | 1): boolean =>
    mark !== '*' || text.slice(i + dir * n, i + dir * n + n) !== mark
  if (sel.length >= 2 * n && sel.startsWith(mark) && sel.endsWith(mark)
      && (mark !== '*' || !sel.startsWith(mark + mark))) {
    return { text: text.slice(0, from) + sel.slice(n, -n) + text.slice(to), from, to: to - 2 * n }
  }
  if (from >= n && text.slice(from - n, from) === mark && text.slice(to, to + n) === mark
      && solo(from - n, -1) && solo(to + n, 1)) {
    return { text: text.slice(0, from - n) + sel + text.slice(to + n), from: from - n, to: to - n }
  }
  return { text: text.slice(0, from) + mark + sel + mark + text.slice(to), from: from + n, to: to + n }
}

export function toggleBold(text: string, from: number, to: number): MdEdit {
  return toggleWrap(text, from, to, '**')
}
export function toggleItalic(text: string, from: number, to: number): MdEdit {
  return toggleWrap(text, from, to, '*')
}
export function toggleInlineCode(text: string, from: number, to: number): MdEdit {
  return toggleWrap(text, from, to, '`')
}

// `[selection](url)`. With a non-empty selection the URL slot is selected (type
// or paste over it); with an empty selection the cursor lands in the text slot.
export function wrapLink(text: string, from: number, to: number, url = ''): MdEdit {
  const sel = text.slice(from, to)
  const next = `${text.slice(0, from)}[${sel}](${url})${text.slice(to)}`
  if (sel === '') return { text: next, from: from + 1, to: from + 1 }
  const urlStart = from + sel.length + 3
  return { text: next, from: urlStart, to: urlStart + url.length }
}

// ---- line-based toggles -----------------------------------------------------
// Expand [from,to] to whole lines; returns the block bounds and its lines.
function lineBlock(text: string, from: number, to: number): { start: number; end: number; lines: string[] } {
  const start = text.lastIndexOf('\n', from - 1) + 1
  const nl = text.indexOf('\n', to)
  const end = nl === -1 ? text.length : nl
  return { start, end, lines: text.slice(start, end).split('\n') }
}

function replaceBlock(text: string, start: number, end: number, lines: string[]): MdEdit {
  const body = lines.join('\n')
  return { text: text.slice(0, start) + body + text.slice(end), from: start, to: start + body.length }
}

const BULLET = /^(\s*)[-*+] /
const NUMBER = /^(\s*)\d+\. /

// Bullet or ordered list. If EVERY non-blank line already carries the marker the
// markers are removed; otherwise they are added (ordered lists renumber from 1).
export function toggleList(text: string, from: number, to: number, marker: '-' | '1.'): MdEdit {
  const { start, end, lines } = lineBlock(text, from, to)
  const re = marker === '-' ? BULLET : NUMBER
  const body = lines.filter((l) => l.trim() !== '')
  const allMarked = body.length > 0 && body.every((l) => re.test(l))
  let n = 0
  const next = lines.map((l) => {
    if (l.trim() === '') return l
    if (allMarked) return l.replace(re, '$1')
    n++
    return l.replace(/^(\s*)/, marker === '-' ? '$1- ' : `$1${n}. `)
  })
  return replaceBlock(text, start, end, next)
}

const TASK = /^(\s*[-*+] )\[([ xX])\] /

// Toggles the CHECKED state of every task line in the selection (all-checked →
// uncheck all, otherwise check all). A line with no checkbox gets one added —
// that step is an upgrade, not a toggle; the checked state itself round-trips.
export function toggleTaskCheckbox(text: string, from: number, to: number): MdEdit {
  const { start, end, lines } = lineBlock(text, from, to)
  const tasks = lines.filter((l) => TASK.test(l))
  const check = !(tasks.length > 0 && tasks.every((l) => TASK.exec(l)![2] !== ' '))
  const box = check ? '[x] ' : '[ ] '
  const next = lines.map((l) => {
    if (TASK.test(l)) return l.replace(TASK, `$1${box}`)
    if (l.trim() === '') return l
    if (BULLET.test(l)) return l.replace(BULLET, `$&${'[ ] '}`)
    return l.replace(/^(\s*)/, '$1- [ ] ')
  })
  return replaceBlock(text, start, end, next)
}

// ---- GFM table alignment ----------------------------------------------------
const CELL_SPLIT = /(?<!\\)\|/
const MIN_COL = 3 // a separator cell needs 3 chars to hold ':-:'
const SEP_ROW = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

function isTableLine(l: string): boolean {
  return l.includes('|')
}
function cells(line: string): string[] {
  const parts = line.split(CELL_SPLIT)
  if (parts[0]!.trim() === '') parts.shift()
  if (parts.length && parts[parts.length - 1]!.trim() === '') parts.pop()
  return parts.map((c) => c.trim())
}
type Align = 'l' | 'r' | 'c' | null
function alignOf(cell: string): Align {
  const l = cell.startsWith(':')
  const r = cell.endsWith(':')
  return l && r ? 'c' : l ? 'l' : r ? 'r' : null
}
function sepCell(w: number, a: Align): string {
  if (a === 'c') return ':' + '-'.repeat(w - 2) + ':'
  if (a === 'l') return ':' + '-'.repeat(w - 1)
  if (a === 'r') return '-'.repeat(w - 1) + ':'
  return '-'.repeat(w)
}

// Re-aligns the pipe-table block containing the selection. Not in a table → the
// input is returned untouched.
export function formatTable(text: string, from: number, to: number): MdEdit {
  const { start } = lineBlock(text, from, from)
  const all = text.split('\n')
  // Which line does `start` fall on?
  let idx = 0
  let off = 0
  for (; idx < all.length; idx++) {
    const next = off + all[idx]!.length + 1
    if (start < next) break
    off = next
  }
  if (idx >= all.length || !isTableLine(all[idx]!)) return { text, from, to }
  let first = idx
  while (first > 0 && isTableLine(all[first - 1]!)) first--
  let last = idx
  while (last + 1 < all.length && isTableLine(all[last + 1]!)) last++

  const rows = all.slice(first, last + 1).map(cells)
  const sepAt = rows.findIndex((_, i) => SEP_ROW.test(all[first + i]!))
  const aligns: Align[] = sepAt === -1 ? [] : rows[sepAt]!.map(alignOf)
  const width: number[] = []
  rows.forEach((r, i) => {
    if (i === sepAt) return
    r.forEach((c, j) => { width[j] = Math.max(width[j] ?? MIN_COL, c.length) })
  })
  const cols = Math.max(width.length, ...rows.map((r) => r.length))
  for (let j = 0; j < cols; j++) width[j] = Math.max(width[j] ?? MIN_COL, MIN_COL)

  const out = rows.map((r, i) => {
    const parts: string[] = []
    for (let j = 0; j < cols; j++) {
      const w = width[j]!
      parts.push(i === sepAt ? sepCell(w, aligns[j] ?? null) : (r[j] ?? '').padEnd(w))
    }
    return `| ${parts.join(' | ')} |`
  })

  const blockStart = all.slice(0, first).reduce((a, l) => a + l.length + 1, 0)
  const body = out.join('\n')
  const blockEnd = blockStart + all.slice(first, last + 1).join('\n').length
  return { text: text.slice(0, blockStart) + body + text.slice(blockEnd), from: blockStart, to: blockStart + body.length }
}
