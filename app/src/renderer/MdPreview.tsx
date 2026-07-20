import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import {
  mdOutline, toggleBold, toggleItalic, toggleInlineCode, wrapLink, toggleList,
  toggleTaskCheckbox, formatTable, type MdHeading,
} from '../shared/mdTools'

// Markdown preview + outline + editing helpers (spec 2026-07-19 §7).
// The preview is a SANDBOXED iframe: markdown may carry raw HTML/scripts and
// this renderer holds the `window.amber` file-write bridge, so rendering it into
// our own DOM would be an XSS with disk access. `sandbox=""` (no allow-scripts,
// no allow-same-origin) is the boundary — do NOT relax it, and do not swap it
// for dangerouslySetInnerHTML plus a sanitizer.

// Local structural cast: the `window.amber` interface lives in main.tsx (owned
// elsewhere) — this keeps the contract explicit without editing that file.
const inlineImages = (dir: string | null, html: string): Promise<string> => {
  const f = (window.amber as unknown as { editorInlineImages?: (d: string, h: string) => Promise<{ html: string }> })
    .editorInlineImages
  // Not wired yet / older preload: render without local images rather than
  // throwing inside the effect and blanking the preview.
  if (typeof f !== 'function') return Promise.resolve(html)
  return f(dir ?? '', html).then((r) => r.html)
}

// CSP keywords MUST be quoted — an unquoted `none`/`unsafe-inline` silently
// voids the whole policy (verified live 2026-07-19: the styles vanish).
// `img-src data:` only: local images arrive as data: URIs from the main process
// (file: is blocked by the app's own CSP anyway) and remote images are never
// fetched — a markdown file must not be able to phone home.
const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'"

const PREVIEW_CSS = `
  :root { color-scheme: dark }
  body { margin: 0; padding: 14px 18px; background: #0c0c0f; color: #e6e6ec;
         font: 13px/1.6 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
         overflow-wrap: anywhere }
  h1,h2,h3,h4,h5,h6 { line-height: 1.25; margin: 1.2em 0 .5em }
  h1,h2 { border-bottom: 1px solid #2a2a34; padding-bottom: .25em }
  a { color: #7c6cff }
  code { font-family: 'JetBrains Mono','SF Mono',Menlo,monospace; font-size: 12px;
         background: #1b1b22; padding: 1px 4px; border-radius: 4px }
  pre { background: #141419; border: 1px solid #2a2a34; border-radius: 6px;
        padding: 10px 12px; overflow: auto }
  pre code { background: none; padding: 0 }
  blockquote { margin: 0 0 1em; padding-left: 12px; border-left: 3px solid #3a3a48; color: #9a9aa8 }
  table { border-collapse: collapse; margin: 1em 0 }
  th, td { border: 1px solid #2a2a34; padding: 4px 8px }
  th { background: #1b1b22 }
  img { max-width: 100% }
  hr { border: none; border-top: 1px solid #2a2a34 }
  ul, ol { padding-left: 22px }
  li input[type=checkbox] { margin-right: 6px }
`

function page(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">` +
    `<style>${PREVIEW_CSS}</style></head><body>${body}</body></html>`
}

export interface MdPreviewProps {
  text: string
  // Directory of the file being edited — the base for relative image paths.
  // null for an unsaved buffer (relative images simply won't resolve).
  baseDir: string | null
}

// NOTE: with `sandbox=""` the frame is cross-origin, so the parent can neither
// read nor set its scroll position — split-mode scroll sync is therefore NOT
// implemented (the preview scrolls on its own). The alternative is
// allow-same-origin, which trades the security boundary for a cosmetic feature.
export const MdPreview = memo(function MdPreview({ text, baseDir }: MdPreviewProps): JSX.Element {
  const [html, setHtml] = useState('')
  const frameRef = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    let stale = false
    const body = marked.parse(text, { async: false })
    void inlineImages(baseDir, body)
      .catch(() => body) // main unavailable → render without local images
      .then((withImages) => { if (!stale) setHtml(page(withImages)) })
    return () => { stale = true }
  }, [text, baseDir])
  // Assigning `srcdoc` while the frame has no layout box (its pane/tab layer is
  // still `display:none`, or the pane mounts in preview mode before layout) makes
  // the frame permanently INERT: it never navigates, and later assignments do not
  // retry — verified live, where the identical HTML rendered instantly in a fresh
  // element while the original stayed blank forever.
  //
  // So: never write into a frame that isn't laid out yet. A ResizeObserver waits
  // for the first non-zero box and writes then; after that, updates are ordinary
  // assignments (re-assignment on a healthy frame works fine). Assigned as the
  // PROPERTY, imperatively — the same discipline the terminals use.
  useEffect(() => {
    const f = frameRef.current
    if (!f || !html) return
    if (f.offsetWidth > 0 && f.offsetHeight > 0) { f.srcdoc = html; return }
    const ro = new ResizeObserver(() => {
      if (f.offsetWidth > 0 && f.offsetHeight > 0) { f.srcdoc = html; ro.disconnect() }
    })
    ro.observe(f)
    return () => ro.disconnect()
  }, [html])
  return <iframe ref={frameRef} className="md-preview" sandbox="" title="markdown preview" />
})

export interface MdOutlineProps {
  text: string
  // Jump to a 1-based document line (move the cursor + scroll it into view).
  onJump: (line: number) => void
}

export const MdOutline = memo(function MdOutline({ text, onJump }: MdOutlineProps): JSX.Element {
  const heads: MdHeading[] = mdOutline(text)
  if (heads.length === 0) return <div className="json-empty">no headings</div>
  return (
    <div role="list">
      {heads.map((h, i) => (
        <button key={`${h.line}-${i}`} className="md-outline-row" title={h.text}
          style={{ paddingLeft: 8 + (h.level - 1) * 10, opacity: h.level > 2 ? 0.8 : 1 }}
          onClick={() => onJump(h.line)}>
          {h.text}
        </button>
      ))}
    </div>
  )
})

export interface MdToolbarProps {
  // Applies a pure mdTools edit: hands over the current text + selection and
  // takes back the rewritten text + the selection to restore. `range` overrides
  // the live selection — the link flow caches it before focus moves to its input.
  apply: (
    f: (text: string, from: number, to: number) => { text: string; from: number; to: number },
    range?: { from: number; to: number },
  ) => void
  // The editor's current selection, read at click time.
  getSelection: () => { from: number; to: number }
  view: 'code' | 'split' | 'preview'
  onView: (v: 'code' | 'split' | 'preview') => void
  outline: boolean
  onToggleOutline: () => void
}

export function MdToolbar(p: MdToolbarProps): JSX.Element {
  // Inline URL input — `window.prompt` is NOT supported in this renderer
  // (Electron throws "prompt() is not supported"), and a native modal would
  // block the app anyway.
  //
  // The document is touched ONLY on an Enter commit with a non-empty URL:
  // Escape, blur and an empty value leave the buffer untouched. (`wrapLink`
  // defaults `url` to '', so any accidental early apply silently inserts
  // `[sel]()` — that was the live bug.) The selection is captured when the
  // button is clicked, because focus — and later possibly the selection —
  // moves to this input.
  const [linking, setLinking] = useState<{ from: number; to: number } | null>(null)
  // Stable ref callback: focus imperatively (the `autoFocus` attribute lost the
  // race with CodeMirror, which refocuses aggressively) and only once, so a
  // re-render can't reselect the text mid-typing.
  const focusInput = useCallback((el: HTMLInputElement | null) => { el?.focus(); el?.select() }, [])
  const commit = (raw: string): void => {
    const url = raw.trim()
    const range = linking
    setLinking(null)
    if (url !== '' && range) p.apply((t, from, to) => wrapLink(t, from, to, url), range)
  }
  return (
    <>
      {(['code', 'split', 'preview'] as const).map((v) => (
        <button key={v} className="editor-btn" aria-pressed={p.view === v} onClick={() => p.onView(v)}>{v}</button>
      ))}
      <span className="editor-sep" />
      <button className="editor-btn" title="bold" onClick={() => p.apply(toggleBold)}><b>B</b></button>
      <button className="editor-btn" title="italic" onClick={() => p.apply(toggleItalic)}><i>I</i></button>
      <button className="editor-btn" title="inline code" onClick={() => p.apply(toggleInlineCode)}>{'</>'}</button>
      {linking
        ? <input className="editor-link-input" ref={focusInput} defaultValue="https://"
            aria-label="link URL" spellCheck={false}
            // stopPropagation on every key: nothing typed here may reach the
            // editor's chord handler (and Enter must never become a newline).
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') { e.preventDefault(); commit(e.currentTarget.value) }
              else if (e.key === 'Escape') { e.preventDefault(); setLinking(null) }
            }}
            onBlur={() => setLinking(null)} />
        : <button className="editor-btn" title="link"
            // Don't let the button's mousedown pull focus back to CodeMirror
            // before the input mounts (the repo's key-bar idiom).
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setLinking(p.getSelection())}>🔗</button>}
      <button className="editor-btn" title="bullet list" onClick={() => p.apply((t, f, to) => toggleList(t, f, to, '-'))}>• list</button>
      <button className="editor-btn" title="task checkbox" onClick={() => p.apply(toggleTaskCheckbox)}>☑</button>
      <button className="editor-btn" title="align the table under the cursor" onClick={() => p.apply(formatTable)}>table</button>
      <span className="editor-sep" />
      <button className="editor-btn" aria-pressed={p.outline} title="toggle the outline panel" onClick={p.onToggleOutline}>outline</button>
    </>
  )
}
