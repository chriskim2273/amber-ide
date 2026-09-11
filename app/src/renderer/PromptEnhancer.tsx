// Prompt enhancement dialog: type a rough prompt, rewrite it through the
// local model router (`auto` alias), edit the result, and iterate. Copy
// works anywhere; insert targets a live Pi composer draft.

import { useEffect, useState } from 'react'
import { ENHANCE_MAX_CHARS } from '../shared/promptEnhance'
import { notifyPiDraftSet } from './piDraft'
import { Icon } from './Icon'

export interface EnhanceTarget {
  name: string
  label: string
}

interface Props {
  initial?: string
  /** Live Pi sessions, for the insert-into-draft row. */
  targets: EnhanceTarget[]
  onClose: () => void
}

export function PromptEnhancer({ initial = '', targets, onClose }: Props): JSX.Element {
  const [input, setInput] = useState(initial)
  const [output, setOutput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [target, setTarget] = useState(targets[0]?.name ?? '')
  const [turns, setTurns] = useState(0)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // A target that died while the dialog is open falls back to the first
  // live one rather than inserting into a stale session.
  const effectiveTarget = targets.some((t) => t.name === target) ? target : (targets[0]?.name ?? '')

  const enhance = async (source: string): Promise<void> => {
    const prompt = source.trim()
    if (prompt.length === 0 || busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const res = await window.amber.routerEnhance(prompt)
      if (res.ok && res.text) {
        setOutput(res.text)
        setTurns((n) => n + 1)
      } else {
        setError(res.error ?? 'enhancement failed')
      }
    } catch {
      setError('enhancement failed. Is the router running?')
    } finally {
      setBusy(false)
    }
  }

  const copy = (): void => {
    if (output.trim().length === 0) return
    window.amber.clipboardWrite(output)
    setNotice('copied to clipboard')
  }

  const insert = (): void => {
    if (output.trim().length === 0 || effectiveTarget.length === 0) return
    notifyPiDraftSet(effectiveTarget, output)
    setNotice(`inserted into ${effectiveTarget}`)
  }

  const onTextareaKey = (source: string) => (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    e.stopPropagation()
    if (e.key === 'Escape') onClose()
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void enhance(source)
  }

  return (
    <div className="help-overlay" onMouseDown={onClose}>
      <div
        className="help-card dialog-card productivity-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Enhance prompt"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="help-head">
          <span className="help-title">Enhance prompt</span>
          <button className="icon-btn" aria-label="close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <p className="dialog-text">
          Rewrites through your model router&apos;s auto alias. Edit the result freely: enhance again to iterate.
          {turns > 0 && <> Iteration {turns}.</>}
        </p>
        <label className="productivity-label" htmlFor="enhance-input">Rough prompt</label>
        <textarea
          id="enhance-input"
          autoFocus
          className="productivity-textarea"
          aria-label="Prompt to enhance"
          placeholder="Type the rough version. A sentence or two is enough."
          value={input}
          maxLength={ENHANCE_MAX_CHARS}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onTextareaKey(input)}
        />
        <div className="productivity-controls">
          <button
            className="btn btn-accent"
            aria-label="Enhance"
            disabled={busy || input.trim().length === 0}
            onClick={() => void enhance(input)}
          >
            {busy ? 'Enhancing…' : 'Enhance'}
          </button>
          <span className="productivity-hint">
            {input.length} / {ENHANCE_MAX_CHARS} · ⌘/Ctrl+Enter enhances
          </span>
        </div>
        {error && (
          <div className="productivity-error" role="alert">
            {error}
          </div>
        )}
        <label className="productivity-label" htmlFor="enhance-output">Rewritten prompt</label>
        <textarea
          id="enhance-output"
          className="productivity-textarea"
          aria-label="Enhanced prompt"
          placeholder="The rewrite lands here — edit it, then enhance again to iterate"
          value={output}
          onChange={(e) => setOutput(e.target.value)}
          onKeyDown={onTextareaKey(output)}
        />
        <div className="productivity-controls">
          <button
            className="btn"
            aria-label="Enhance again"
            disabled={busy || output.trim().length === 0}
            onClick={() => void enhance(output)}
          >
            Enhance again
          </button>
          <button className="btn btn-ghost" aria-label="Copy enhanced prompt" disabled={output.trim().length === 0} onClick={copy}>
            Copy
          </button>
        </div>
        {targets.length > 0 ? (
          <div className="productivity-controls">
            <select aria-label="Insert into Pi session" value={effectiveTarget} onChange={(e) => setTarget(e.target.value)}>
              {targets.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.label}
                </option>
              ))}
            </select>
            <button
              className="btn btn-ghost"
              aria-label="Insert into Pi draft"
              disabled={output.trim().length === 0 || effectiveTarget.length === 0}
              onClick={insert}
            >
              Insert into Pi draft
            </button>
          </div>
        ) : (
          <p className="productivity-hint">No Pi sessions are live. Copy works anywhere.</p>
        )}
        {notice && <p className="productivity-hint" role="status">{notice}</p>}
      </div>
    </div>
  )
}
