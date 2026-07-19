import { memo, useMemo, useState } from 'react'
import type { EditorView } from '@codemirror/view'
import type { Diagnostic } from '@codemirror/lint'
import {
  buildJsonTree, jsonErrorAt, jsonNodeOffset, formatJson, minifyJson, sortJsonKeys,
  type JsonNode,
} from '../shared/jsonTools'

// JSON side panel + toolbar + lint source (spec 2026-07-19 §6). Everything that
// parses lives in `shared/jsonTools` (pure, TDD'd); this file is chrome only.

// CodeMirror lint source. Registered behind a compartment by Editor so it is
// only active in JSON mode. Returns at most one diagnostic — JSON.parse stops
// at the first syntax error, there is no recovery to report a second.
export function jsonLint(view: EditorView): Diagnostic[] {
  const text = view.state.doc.toString()
  if (text.trim() === '') return [] // an empty buffer is "not yet JSON", not broken
  try {
    JSON.parse(text)
    return []
  } catch (e) {
    const at = jsonErrorAt(text, e)
    return [{ from: at.from, to: at.to, severity: 'error', message: e instanceof Error ? e.message : String(e) }]
  }
}

export interface JsonToolbarProps {
  // Applies a whole-document rewrite (Editor dispatches it as one transaction so
  // undo restores the pre-format text in a single step).
  onReplace: (text: string) => void
  // Current document text — read on click, not on render.
  getText: () => string
  onError: (msg: string) => void
  outline: boolean
  onToggleOutline: () => void
}

export function JsonToolbar(p: JsonToolbarProps): JSX.Element {
  const run = (f: (t: string) => { text: string } | { error: string }) => (): void => {
    const r = f(p.getText())
    if ('error' in r) p.onError(r.error)
    else p.onReplace(r.text)
  }
  return (
    <>
      <button className="editor-btn" title="pretty-print (2-space)" onClick={run((t) => formatJson(t))}>format</button>
      <button className="editor-btn" title="strip all whitespace" onClick={run(minifyJson)}>minify</button>
      <button className="editor-btn" title="sort object keys recursively (arrays untouched)" onClick={run((t) => sortJsonKeys(t))}>sort keys</button>
      <button className="editor-btn" aria-pressed={p.outline} title="toggle the JSON tree panel" onClick={p.onToggleOutline}>tree</button>
    </>
  )
}

export interface JsonTreeProps {
  text: string
  // Move the editor cursor to a document offset (-1 = not found, ignored).
  onJump: (offset: number) => void
}

// Collapsible tree. Clicking a node copies its JSONPath AND moves the cursor —
// both are the spec'd gesture (§6), so there is no separate "copy" affordance.
export const JsonTree = memo(function JsonTree({ text, onJump }: JsonTreeProps): JSX.Element {
  // Parsed per text change only. A broken document keeps the last good tree
  // out of the way and says so — the lint gutter already points at the error.
  const nodes = useMemo<JsonNode[] | null>(() => {
    try {
      return buildJsonTree(JSON.parse(text) as unknown)
    } catch {
      return null
    }
  }, [text])
  const [open, setOpen] = useState<Record<string, boolean>>({})

  if (!nodes) return <div className="json-empty">invalid JSON — fix the error to see the tree</div>
  if (nodes.length === 0) return <div className="json-empty">empty</div>

  const click = (n: JsonNode): void => {
    window.amber.clipboardWrite(n.path)
    onJump(jsonNodeOffset(text, n.path))
    if (n.children.length > 0) setOpen((o) => ({ ...o, [n.path]: !o[n.path] }))
  }

  const rows = (list: JsonNode[], depth: number): JSX.Element[] =>
    list.flatMap((n) => {
      const expanded = open[n.path] === true
      const row = (
        <button key={n.path} className="json-row" style={{ paddingLeft: 8 + depth * 12 }}
          title={`${n.path} — click to copy the path and jump`} onClick={() => click(n)}>
          <span className="json-caret">{n.children.length > 0 ? (expanded ? '▾' : '▸') : ''}</span>
          <span className="json-key">{n.key}</span>
          <span className="json-preview">{n.preview}</span>
        </button>
      )
      return expanded ? [row, ...rows(n.children, depth + 1)] : [row]
    })

  return <div role="tree">{rows(nodes, 0)}</div>
})
