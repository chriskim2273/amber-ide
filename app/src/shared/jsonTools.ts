// Pure JSON helpers for the editor pane (spec 2026-07-19 §6). No dependencies,
// no DOM — importable from the renderer and the node test env. NOTHING here
// throws: every entry point either returns a value or an `{ error }` result.

export interface JsonErrorPos {
  line: number // 1-based (CodeMirror doc.line() is 1-based)
  col: number // 1-based
  from: number // character offset into `text`
  to: number // character offset; may equal `from` at EOF (a valid zero-width lint range)
}

export type JsonResult = { text: string } | { error: string }

export type JsonKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'

export interface JsonNode {
  key: string // object key, array index as a string, or '$' for a scalar root
  path: string // JSONPath-ish: $.a.b[0], bracketed for non-identifier keys
  kind: JsonKind
  preview: string // one-line summary: {2} / [3] / "text" / 42 / true / null
  children: JsonNode[] // always present; empty for scalars
}

// ---- error position ---------------------------------------------------------
// V8 (node 20+) puts `at position N (line L column C)` in most JSON syntax
// errors, but NOT in "Unexpected end of JSON input" (→ EOF) or the snippet form
// `Unexpected token 'a', "abc" is not valid JSON` (→ no position at all, so we
// point at the start). Offsets are always clamped into the document.
export function jsonErrorAt(text: string, err: unknown): JsonErrorPos {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  const m = /at position (\d+)/.exec(msg)
  const raw = m ? Number(m[1]) : /end of (?:JSON )?input/i.test(msg) ? text.length : 0
  const from = Math.max(0, Math.min(Number.isFinite(raw) ? raw : 0, text.length))
  const before = text.slice(0, from)
  const nl = before.lastIndexOf('\n')
  let line = 1
  for (let i = 0; i < before.length; i++) if (before.charCodeAt(i) === 10) line++
  return { line, col: from - nl, from, to: Math.min(from + 1, text.length) }
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ---- format / minify / sort -------------------------------------------------
export function formatJson(text: string, indent = 2): JsonResult {
  try {
    return { text: JSON.stringify(JSON.parse(text), null, indent) }
  } catch (e) {
    return { error: errMessage(e) }
  }
}

export function minifyJson(text: string): JsonResult {
  try {
    return { text: JSON.stringify(JSON.parse(text)) }
  } catch (e) {
    return { error: errMessage(e) }
  }
}

// Recursive key sort. Arrays keep their order (order is data in an array).
function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue)
  if (typeof v === 'object' && v !== null) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) out[k] = sortValue((v as Record<string, unknown>)[k])
    return out
  }
  return v
}

export function sortJsonKeys(text: string, indent = 2): JsonResult {
  try {
    return { text: JSON.stringify(sortValue(JSON.parse(text)), null, indent) }
  } catch (e) {
    return { error: errMessage(e) }
  }
}

// ---- tree -------------------------------------------------------------------
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/
function childPath(base: string, key: string): string {
  return IDENT.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`
}

const PREVIEW_MAX = 40
function kindOf(v: unknown): JsonKind {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  const t = typeof v
  return t === 'object' ? 'object' : t === 'string' ? 'string' : t === 'number' ? 'number' : 'boolean'
}
function previewOf(v: unknown, kind: JsonKind): string {
  if (kind === 'array') return `[${(v as unknown[]).length}]`
  if (kind === 'object') return `{${Object.keys(v as object).length}}`
  const s = JSON.stringify(v) ?? String(v)
  return s.length > PREVIEW_MAX ? s.slice(0, PREVIEW_MAX - 1) + '…' : s
}

function node(key: string, path: string, v: unknown): JsonNode {
  const kind = kindOf(v)
  return { key, path, kind, preview: previewOf(v, kind), children: childrenOf(v, path) }
}

function childrenOf(v: unknown, path: string): JsonNode[] {
  if (Array.isArray(v)) return v.map((c, i) => node(String(i), `${path}[${i}]`, c))
  if (typeof v === 'object' && v !== null) {
    return Object.entries(v).map(([k, c]) => node(k, childPath(path, k), c))
  }
  return []
}

// Returns the ROOT'S CHILDREN (an object/array root is the implicit `$` and is
// not itself a node). A scalar root has no children, so it is returned as a
// single `$` node instead — the panel always has something to render.
export function buildJsonTree(value: unknown): JsonNode[] {
  const kind = kindOf(value)
  if (kind === 'object' || kind === 'array') return childrenOf(value, '$')
  return [node('$', '$', value)]
}

// ---- source offsets ---------------------------------------------------------
// A minimal recursive-descent scan that records the source offset of every
// value's first character, keyed by the same path grammar as buildJsonTree.
// Needed because JSON.parse exposes no positions; a textual search would break
// on duplicate keys and on key-like text inside string values.
// ponytail: recursive — a pathologically deep document could blow the stack.
// Bounded by the editor's 8 MiB read cap; make it iterative only if that bites.
function scanOffsets(text: string): Record<string, number> | null {
  const out: Record<string, number> = {}
  let i = 0
  const skipWs = (): void => {
    while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++
  }
  // Consumes a string literal at `i`; returns its decoded value (null = malformed).
  const parseString = (): string | null => {
    if (text[i] !== '"') return null
    const start = i
    i++
    while (i < text.length) {
      const c = text[i]
      if (c === '\\') { i += 2; continue }
      i++
      if (c === '"') {
        try {
          return JSON.parse(text.slice(start, i)) as string
        } catch {
          return null
        }
      }
    }
    return null
  }
  const parseValue = (path: string): boolean => {
    skipWs()
    if (i >= text.length) return false
    // Duplicate keys: a later assignment wins, matching JSON.parse semantics.
    out[path] = i
    const c = text[i]
    if (c === '{') {
      i++
      skipWs()
      if (text[i] === '}') { i++; return true }
      for (;;) {
        skipWs()
        const k = parseString()
        if (k === null) return false
        skipWs()
        if (text[i] !== ':') return false
        i++
        if (!parseValue(childPath(path, k))) return false
        skipWs()
        if (text[i] === ',') { i++; continue }
        if (text[i] === '}') { i++; return true }
        return false
      }
    }
    if (c === '[') {
      i++
      skipWs()
      if (text[i] === ']') { i++; return true }
      let n = 0
      for (;;) {
        if (!parseValue(`${path}[${n++}]`)) return false
        skipWs()
        if (text[i] === ',') { i++; continue }
        if (text[i] === ']') { i++; return true }
        return false
      }
    }
    if (c === '"') return parseString() !== null
    const lit = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i))
    if (!lit) return false
    i += lit[0].length
    return true
  }
  if (!parseValue('$')) return null
  skipWs()
  return i === text.length ? out : null
}

// Character offset of the value at `path` in the SOURCE text, or -1 when the
// path is absent / the text is not valid JSON. Never throws.
export function jsonNodeOffset(text: string, path: string): number {
  const map = scanOffsets(text)
  if (map === null) return -1
  return map[path] ?? -1
}
