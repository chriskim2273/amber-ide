import { memo, useEffect, useRef, useState } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view'
import { EditorState, Compartment, type Extension } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { searchKeymap, openSearchPanel, highlightSelectionMatches } from '@codemirror/search'
import {
  bracketMatching, codeFolding, foldGutter, foldKeymap, indentOnInput,
  syntaxHighlighting, defaultHighlightStyle,
} from '@codemirror/language'
import { linter, lintGutter } from '@codemirror/lint'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { JsonTree, JsonToolbar, jsonLint } from './JsonTree'
import { MdPreview, MdOutline, MdToolbar } from './MdPreview'
import './editor.css'

// The editor pane (spec 2026-07-19 §5). Same class as Browser: app-local, NO
// daemon session — the parent owns path/view/outline/wrap in the layout sidecar
// and feeds them back as props. The CodeMirror EditorView is created ONCE and
// lives outside React reconciliation (constitution rule #5, same discipline as
// xterm): React renders chrome, document changes flow through CM transactions.

export type EditorViewMode = 'code' | 'split' | 'preview'
export type EditorMode = 'json' | 'markdown' | 'text'

// Main-process file IO (spec §4). `window.amber`'s interface is declared in
// main.tsx (owned by the wiring agent); this local cast keeps the contract
// explicit here without editing that file.
export interface EditorFileApi {
  editorOpenDialog: () => Promise<{ path: string; text: string; mtimeMs: number } | { path: string; error: string } | null>
  editorRead: (path: string) => Promise<{ text: string; mtimeMs: number } | { error: string }>
  editorSave: (path: string, text: string, expectedMtimeMs: number | null)
    => Promise<{ mtimeMs: number } | { conflict: true; mtimeMs: number } | { error: string }>
  editorSaveDialog: (suggestedName: string, text: string)
    => Promise<{ path: string; mtimeMs: number } | { path: string; error: string } | null>
  editorDraftRead: (paneId: string) => Promise<string | null>
  editorDraftWrite: (paneId: string, text: string) => Promise<void>
  editorDraftClear: (paneId: string) => Promise<void>
}
const api = (): EditorFileApi => window.amber as unknown as EditorFileApi

// Imperative handle handed to the parent (same precedent as Pane's
// `onSearchReady`): the close guard must read dirty state and drive a save
// synchronously at close time, which props alone cannot do.
export interface EditorApi {
  isDirty: () => boolean
  // true = written to disk (or nothing to save); false = failed, cancelled, or
  // an unresolved mtime conflict (the pane shows the overwrite/reload/save-as bar).
  save: () => Promise<boolean>
  // Drop the parked draft (user chose Discard) and stop the unmount flush.
  discardDraft: () => void
}

export interface EditorProps {
  paneId: string
  path: string | null
  view: EditorViewMode
  outline: boolean
  wrap: boolean
  active: boolean
  fontSize: number
  // Path changed (Open / Save As) — persist it in the sidecar. The pane KEEPS
  // its id, so the paneId-keyed draft follows it.
  onChangePath: (paneId: string, path: string | null) => void
  // View-state patch for the sidecar (`view` / `outline` / `wrap`).
  onChangeViewState: (paneId: string, patch: { view?: EditorViewMode; outline?: boolean; wrap?: boolean }) => void
  // Header-dot / close-guard signal (spec §3).
  onDirtyChange: (paneId: string, dirty: boolean) => void
  onTitle: (paneId: string, title: string) => void
  // Imperative handle; null on unmount.
  onReady: (paneId: string, api: EditorApi | null) => void
}

const DRAFT_DEBOUNCE_MS = 800
const PANEL_DEBOUNCE_MS = 250

export function baseName(path: string | null): string { return path ? path.slice(path.lastIndexOf('/') + 1) : 'untitled' }
function dirName(path: string | null): string | null {
  if (!path) return null
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

export function modeFor(path: string | null): EditorMode {
  const ext = (path ?? '').slice((path ?? '').lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'json' || ext === 'jsonc') return 'json'
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  return 'text'
}

function langFor(mode: EditorMode): Extension {
  return mode === 'json' ? json() : mode === 'markdown' ? markdown() : []
}

// Dark theme mirroring theme.css tokens. CM writes its own stylesheet, so the
// var() references resolve against :root at paint time — no duplication of hex.
const CM_THEME = EditorView.theme({
  '&': { color: 'var(--text)', backgroundColor: 'var(--bg)', height: '100%' },
  '.cm-content': { fontFamily: 'var(--font-mono)', caretColor: 'var(--accent)' },
  '.cm-gutters': { backgroundColor: 'var(--surface)', color: 'var(--text-faint)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'rgba(124,108,255,0.06)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-dim)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'rgba(124,108,255,0.30)' },
  '.cm-selectionMatch': { backgroundColor: 'rgba(124,108,255,0.18)' },
  '.cm-panels': { backgroundColor: 'var(--surface-2)', color: 'var(--text)', border: 'none' },
  '.cm-panel input, .cm-panel button': {
    backgroundColor: 'var(--surface-3)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 'var(--radius)',
  },
  '.cm-tooltip': { backgroundColor: 'var(--surface-3)', border: '1px solid var(--border)', color: 'var(--text)' },
  '.cm-searchMatch': { backgroundColor: '#3d3563', outline: '1px solid var(--accent)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--accent)' },
}, { dark: true })

type Notice =
  | { kind: 'draft' }
  | { kind: 'confirm-open' }
  | { kind: 'conflict' }
  | { kind: 'error'; msg: string }

// Memoized like Pane: SplitView re-renders on every drag-hover mousemove, and a
// reconciled editor would be a re-rendered (not re-created) CodeMirror host.
export const Editor = memo(function Editor(p: EditorProps): JSX.Element {
  const { path, view: viewMode, outline, wrap } = p
  const mode = modeFor(path)
  // Latest derived values readable from the once-registered mount effect and
  // from callbacks, without making them effect deps (that would re-create the
  // EditorView — constitution rule #5).
  const cur = useRef({ paneId: p.paneId, path, wrap, fontSize: p.fontSize })
  cur.current = { paneId: p.paneId, path, wrap, fontSize: p.fontSize }

  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // Text as last READ from / WRITTEN to disk. Dirty is `doc !== baseline` —
  // derived from this ref, never from a re-rendered value (spec §3.1).
  const baselineRef = useRef('')
  const mtimeRef = useRef<number | null>(null)
  // The path whose content is in the buffer. Guards the [path] effect from
  // re-reading a file we just wrote via Save As / Open.
  const loadedPathRef = useRef<string | null>(path)
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const panelTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtyRef = useRef(false)
  // Set when the user chose Discard at close time — suppresses the unmount
  // draft flush so a discarded buffer cannot come back on the next start.
  const closingRef = useRef(false)
  const [dirty, setDirty] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  // Debounced document snapshot feeding the JSON tree / markdown preview +
  // outline. Those are React chrome, so they must NOT re-render per keystroke.
  const [docText, setDocText] = useState('')

  // ---- mount: create the EditorView once ------------------------------------
  const lang = useRef(new Compartment()).current
  const lintComp = useRef(new Compartment()).current
  const wrapComp = useRef(new Compartment()).current
  const fontComp = useRef(new Compartment()).current

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: '',
        extensions: [
          lineNumbers(), highlightActiveLine(), highlightActiveLineGutter(), drawSelection(),
          history(), indentOnInput(), bracketMatching(), codeFolding(), foldGutter(),
          highlightSelectionMatches(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap, indentWithTab]),
          lang.of(langFor(modeFor(cur.current.path))),
          lintComp.of(modeFor(cur.current.path) === 'json' ? [linter(jsonLint), lintGutter()] : []),
          wrapComp.of(cur.current.wrap ? EditorView.lineWrapping : []),
          fontComp.of(EditorView.theme({ '&': { fontSize: `${cur.current.fontSize}px` } })),
          CM_THEME,
          EditorView.updateListener.of((u) => { if (u.docChanged) onDoc(u.state.doc.toString()) }),
        ],
      }),
    })
    viewRef.current = view
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current)
      if (panelTimer.current) clearTimeout(panelTimer.current)
      // Unmount with unsaved work: persist the draft NOW rather than losing the
      // pending debounce (spec §3.2 — the buffer exists nowhere else).
      if (dirtyRef.current && !closingRef.current) void api().editorDraftWrite(cur.current.paneId, view.state.doc.toString())
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.paneId])

  // Every document change: dirty tracking + debounced draft + debounced panels.
  function onDoc(text: string): void {
    const isDirty = text !== baselineRef.current
    dirtyRef.current = isDirty
    setDirty(isDirty)
    if (draftTimer.current) clearTimeout(draftTimer.current)
    if (isDirty) {
      draftTimer.current = setTimeout(() => void api().editorDraftWrite(cur.current.paneId, text), DRAFT_DEBOUNCE_MS)
    } else {
      void api().editorDraftClear(cur.current.paneId)
    }
    if (panelTimer.current) clearTimeout(panelTimer.current)
    panelTimer.current = setTimeout(() => setDocText(text), PANEL_DEBOUNCE_MS)
  }

  // Replace the whole document (load / format / md helper). One transaction, so
  // undo steps back over it in one go.
  function replaceDoc(text: string, sel?: { from: number; to: number }): void {
    const v = viewRef.current
    if (!v) return
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: text },
      selection: sel ? { anchor: Math.min(sel.from, text.length), head: Math.min(sel.to, text.length) } : undefined,
      scrollIntoView: sel !== undefined,
    })
    setDocText(text)
  }

  function markClean(text: string, mtimeMs: number | null): void {
    if (draftTimer.current) clearTimeout(draftTimer.current) // no stray write after a save
    baselineRef.current = text
    mtimeRef.current = mtimeMs
    dirtyRef.current = false
    setDirty(false)
    void api().editorDraftClear(cur.current.paneId)
  }

  // ---- mount load: file + draft reconciliation (spec §3.2) -------------------
  useEffect(() => {
    let stale = false
    void (async () => {
      const a = api()
      const draft = await a.editorDraftRead(p.paneId).catch(() => null)
      let fileText = ''
      let mtime: number | null = null
      if (path) {
        const r = await a.editorRead(path)
        if ('error' in r) { if (!stale) setNotice({ kind: 'error', msg: `${baseName(path)}: ${r.error}` }) }
        else { fileText = r.text; mtime = r.mtimeMs }
      }
      if (stale) return
      loadedPathRef.current = path
      baselineRef.current = fileText
      mtimeRef.current = mtime
      if (draft !== null && draft !== fileText) {
        // The draft wins; the banner offers keep/discard. onDoc (fired by the
        // dispatch) flips dirty on, because baseline is the FILE's text.
        replaceDoc(draft)
        setNotice({ kind: 'draft' })
      } else {
        replaceDoc(fileText)
        markClean(fileText, mtime)
      }
    })()
    return () => { stale = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.paneId])

  // Path changed from OUTSIDE (a sidecar restore) — re-read. Our own Open/Save
  // As set loadedPathRef before calling onChangePath, so they no-op here (and
  // Save As must never remount: the language switches via the compartment).
  useEffect(() => {
    if (path === loadedPathRef.current) return
    loadedPathRef.current = path
    if (!path) return
    let stale = false
    void api().editorRead(path).then((r) => {
      if (stale) return
      if ('error' in r) { setNotice({ kind: 'error', msg: `${baseName(path)}: ${r.error}` }); return }
      baselineRef.current = r.text
      replaceDoc(r.text)
      markClean(r.text, r.mtimeMs)
    })
    return () => { stale = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  // ---- prop → compartment reconfigurations (never a remount) ----------------
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: [
        lang.reconfigure(langFor(mode)),
        lintComp.reconfigure(mode === 'json' ? [linter(jsonLint), lintGutter()] : []),
      ],
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: wrapComp.reconfigure(wrap ? EditorView.lineWrapping : []) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wrap])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: fontComp.reconfigure(EditorView.theme({ '&': { fontSize: `${p.fontSize}px` } })),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.fontSize])

  useEffect(() => { p.onDirtyChange(p.paneId, dirty) }, [dirty, p.paneId, p.onDirtyChange])
  useEffect(() => { p.onTitle(p.paneId, baseName(path)) }, [path, p.paneId, p.onTitle])
  useEffect(() => { if (p.active) viewRef.current?.focus() }, [p.active])
  // A pane restored in `view:'preview'` mounts CM under display:none, so it
  // measured 0×0. React has already committed the style when this runs.
  useEffect(() => { viewRef.current?.requestMeasure() }, [viewMode, mode])

  // Imperative handle for the parent's close guard (spec §3.3) — the same
  // pattern as Pane's `onSearchReady`. Identity is stable for the pane's
  // lifetime: it reads refs, so it can never serve stale dirty state.
  const saveRef = useRef<() => Promise<boolean>>(async () => false)
  saveRef.current = () => doSave()
  const handleRef = useRef<EditorApi | null>(null)
  if (!handleRef.current) {
    handleRef.current = {
      isDirty: () => dirtyRef.current,
      save: () => saveRef.current(),
      discardDraft: () => { closingRef.current = true; void api().editorDraftClear(cur.current.paneId) },
    }
  }
  useEffect(() => {
    p.onReady(p.paneId, handleRef.current)
    return () => p.onReady(p.paneId, null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.paneId])

  // ---- commands -------------------------------------------------------------
  const text = (): string => viewRef.current?.state.doc.toString() ?? ''

  // Resolves true only when the bytes reached disk — the parent's close guard
  // uses that to decide whether closing is safe.
  async function doSave(force = false): Promise<boolean> {
    const body = text()
    if (!path) return doSaveAs()
    const r = await api().editorSave(path, body, force ? null : mtimeRef.current)
    if ('error' in r) { setNotice({ kind: 'error', msg: r.error }); return false }
    // Changed underneath us — show overwrite/reload/save-as and DON'T clobber.
    if ('conflict' in r) { setNotice({ kind: 'conflict' }); return false }
    markClean(body, r.mtimeMs)
    setNotice(null)
    return true
  }

  async function doSaveAs(): Promise<boolean> {
    const body = text()
    const r = await api().editorSaveDialog(baseName(path), body)
    if (!r) return false // dialog cancelled
    // A picked path that failed to write (permissions, bad target): report it
    // and stay dirty — the buffer is still the only copy.
    if ('error' in r) { setNotice({ kind: 'error', msg: `${baseName(r.path)}: ${r.error}` }); return false }
    loadedPathRef.current = r.path
    markClean(body, r.mtimeMs)
    setNotice(null)
    p.onChangePath(p.paneId, r.path)
    return true
  }

  // `force` skips the dirty prompt — the banner's buttons call back with it.
  async function doOpen(force = false): Promise<void> {
    if (!force && dirtyRef.current) { setNotice({ kind: 'confirm-open' }); return }
    const r = await api().editorOpenDialog()
    if (!r) return
    // Rejected by main's guards (too large / binary / not a regular file).
    if ('error' in r) { setNotice({ kind: 'error', msg: `${baseName(r.path)}: ${r.error}` }); return }
    loadedPathRef.current = r.path
    baselineRef.current = r.text
    replaceDoc(r.text)
    markClean(r.text, r.mtimeMs)
    setNotice(null)
    p.onChangePath(p.paneId, r.path)
  }

  // Banner "discard": drop the restored draft. Distinct from the handle's
  // discardDraft() (that one is discard-at-close, pane going away). A scratch
  // buffer has no file to reload — it reverts to empty.
  async function discardRestoredDraft(): Promise<void> {
    if (path) { await doReload(); return }
    baselineRef.current = ''
    replaceDoc('')
    markClean('', null) // also clears the draft file
    setNotice(null)
  }

  // Conflict → reload from disk, discarding the buffer (the user picked it).
  async function doReload(): Promise<void> {
    if (!path) return
    const r = await api().editorRead(path)
    if ('error' in r) { setNotice({ kind: 'error', msg: r.error }); return }
    baselineRef.current = r.text
    replaceDoc(r.text)
    markClean(r.text, r.mtimeMs)
    setNotice(null)
  }

  function jumpTo(offset: number): void {
    const v = viewRef.current
    if (!v || offset < 0) return
    const pos = Math.min(offset, v.state.doc.length)
    v.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
    v.focus()
  }

  function jumpToLine(line: number): void {
    const v = viewRef.current
    if (!v) return
    jumpTo(v.state.doc.line(Math.min(Math.max(1, line), v.state.doc.lines)).from)
  }

  function selRange(): { from: number; to: number } {
    const sel = viewRef.current?.state.selection.main
    return { from: sel?.from ?? 0, to: sel?.to ?? 0 }
  }

  // Apply a pure mdTools edit. `range` (the link flow's cached selection) wins
  // over the live one — by commit time focus has been in an input, so the live
  // selection is not trustworthy. Clamped: the doc may have changed since.
  function applyMd(
    f: (t: string, from: number, to: number) => { text: string; from: number; to: number },
    range?: { from: number; to: number },
  ): void {
    const v = viewRef.current
    if (!v) return
    const doc = v.state.doc.toString()
    const r0 = range ?? selRange()
    const r = f(doc, Math.min(r0.from, doc.length), Math.min(r0.to, doc.length))
    replaceDoc(r.text, { from: r.from, to: r.to })
    v.focus()
  }

  // Editor-scoped chords. Registered on this subtree (NOT window) so they never
  // collide with the app's global CHORD_TABLE — the app's handlers are all
  // bubble-phase window listeners, so stopPropagation here is enough.
  function onKeyDown(e: React.KeyboardEvent): void {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return
    const k = e.key.toLowerCase()
    if (k === 's') {
      e.preventDefault(); e.stopPropagation()
      void (e.shiftKey ? doSaveAs() : doSave())
    } else if (k === 'o' && !e.shiftKey) {
      e.preventDefault(); e.stopPropagation()
      void doOpen()
    } else if (k === 'f') {
      e.stopPropagation() // keep the app's find-in-scrollback chord out of it
      // CM's own searchKeymap already handled it when focus is in the editor
      // (it preventDefaults); otherwise open the panel ourselves.
      if (!e.defaultPrevented) {
        e.preventDefault()
        const v = viewRef.current
        if (v) { v.focus(); openSearchPanel(v) }
      }
    }
  }

  const showPreview = mode === 'markdown' && viewMode !== 'code'
  const showCode = !(mode === 'markdown' && viewMode === 'preview')
  const showSide = outline && mode !== 'text'

  return (
    <div className="editor-pane" onKeyDown={onKeyDown}>
      <div className="editor-bar">
        <span className="editor-name" title={path ?? 'unsaved buffer'}>
          {dirty && <span className="editor-dirty" role="img" aria-label="unsaved changes" />}
          {baseName(path)}
        </span>
        <button className="editor-btn" title="open a file (Cmd/Ctrl+O)" onClick={() => void doOpen()}>open</button>
        <button className="editor-btn" title="save (Cmd/Ctrl+S)" onClick={() => void doSave()}>save</button>
        <button className="editor-btn" title="save as (Cmd/Ctrl+Shift+S)" onClick={() => void doSaveAs()}>save as</button>
        <span className="editor-sep" />
        {mode === 'json' &&
          <JsonToolbar getText={text} onReplace={(t) => replaceDoc(t)}
            onError={(msg) => setNotice({ kind: 'error', msg })}
            outline={outline} onToggleOutline={() => p.onChangeViewState(p.paneId, { outline: !outline })} />}
        {mode === 'markdown' &&
          <MdToolbar apply={applyMd} getSelection={selRange} view={viewMode} onView={(v) => p.onChangeViewState(p.paneId, { view: v })}
            outline={outline} onToggleOutline={() => p.onChangeViewState(p.paneId, { outline: !outline })} />}
        <span className="editor-spacer" />
        <button className="editor-btn" aria-pressed={wrap} title="soft wrap"
          onClick={() => p.onChangeViewState(p.paneId, { wrap: !wrap })}>wrap</button>
      </div>

      {notice?.kind === 'draft' &&
        <div className="editor-banner" role="status">
          <span className="editor-banner-msg">restored unsaved changes from the last session</span>
          <button className="editor-btn" onClick={() => setNotice(null)}>keep</button>
          <button className="editor-btn" onClick={() => void discardRestoredDraft()}>discard</button>
        </div>}
      {notice?.kind === 'confirm-open' &&
        <div className="editor-banner danger" role="alert">
          <span className="editor-banner-msg">unsaved changes in this buffer — open another file anyway?</span>
          <button className="editor-btn"
            onClick={() => { setNotice(null); void doSave().then((ok) => { if (ok) void doOpen(true) }) }}>save &amp; open</button>
          <button className="editor-btn"
            onClick={() => { setNotice(null); void doOpen(true) }}>discard &amp; open</button>
          <button className="editor-btn" onClick={() => setNotice(null)}>cancel</button>
        </div>}
      {notice?.kind === 'conflict' &&
        <div className="editor-banner danger" role="alert">
          <span className="editor-banner-msg">{baseName(path)} changed on disk since it was read</span>
          <button className="editor-btn" onClick={() => void doSave(true)}>overwrite</button>
          <button className="editor-btn" onClick={() => void doReload()}>reload</button>
          <button className="editor-btn" onClick={() => void doSaveAs()}>save as…</button>
        </div>}
      {notice?.kind === 'error' &&
        <div className="editor-banner danger" role="alert">
          <span className="editor-banner-msg">{notice.msg}</span>
          <button className="editor-btn" onClick={() => setNotice(null)}>dismiss</button>
        </div>}

      <div className="editor-body">
        {showSide &&
          <div className="editor-side">
            {mode === 'json'
              ? <JsonTree text={docText} onJump={jumpTo} />
              : <MdOutline text={docText} onJump={jumpToLine} />}
          </div>}
        {/* Hidden, never unmounted: unmounting would destroy the EditorView. */}
        <div className="editor-cm" ref={hostRef} style={showCode ? undefined : { display: 'none' }} />
        {showPreview && <MdPreview text={docText} baseDir={dirName(path)} />}
      </div>
    </div>
  )
})
