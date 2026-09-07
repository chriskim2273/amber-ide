import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type ClipboardEvent, type FormEvent } from 'react'
import type { PiDelivery } from '../shared/proto'
import { PI_ATTACHMENT_MAX_BYTES, PI_ATTACHMENTS_PER_PROMPT } from '../shared/proto'

export interface PiAttachmentProgress {
  name: string
  size: number
  state: 'queued' | 'uploading' | 'done' | 'error' | 'canceled'
  acknowledged: number
  error?: string
}

export interface PiComposerProps {
  draft: string
  onDraftChange: (value: string) => void
  files: File[]
  onFiles: (files: File[]) => void
  onRemoveFile: (index: number) => void
  onSubmit: () => void
  onStop: () => void
  onCancelUpload?: () => void
  delivery: PiDelivery
  onDeliveryChange: (delivery: PiDelivery) => void
  available: boolean
  busy: boolean
  uploading: boolean
  submitting?: boolean
  attachmentSupported: boolean
  attachmentError: string | null
  progress?: Record<string, PiAttachmentProgress>
  uncertainDelivery?: string | null
}

function fileKey(file: File): string { return `${file.name}:${file.size}:${file.lastModified}` }

/** Pure key policy keeps IME Enter from accidentally submitting a prompt. */
export function shouldSubmitComposerKey(key: string, shiftKey: boolean, composing: boolean): boolean {
  return key === 'Enter' && !shiftKey && !composing
}

/** Shared desktop/mobile composer. File picker, drag/drop, and paste all feed
 * the same bounded `onFiles` path; no bytes are persisted in browser storage. */
export function PiComposer({
  draft, onDraftChange, files, onFiles, onRemoveFile, onSubmit, onStop, onCancelUpload,
  delivery, onDeliveryChange, available, busy, uploading, submitting = false, attachmentSupported, attachmentError,
  progress = {}, uncertainDelivery,
}: PiComposerProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const composingRef = useRef(false)
  const [dragging, setDragging] = useState(false)
  const [confirmStop, setConfirmStop] = useState(false)
  const previewUrls = useRef(new Map<string, string>())

  useEffect(() => {
    const next = new Set(files.map(fileKey))
    for (const [key, url] of previewUrls.current) {
      if (!next.has(key)) { URL.revokeObjectURL(url); previewUrls.current.delete(key) }
    }
    for (const file of files) {
      const key = fileKey(file)
      if (file.type.startsWith('image/') && !previewUrls.current.has(key)) previewUrls.current.set(key, URL.createObjectURL(file))
    }
    return () => {
      // Revoke only when a file leaves the tray or the component unmounts; the
      // effect rerun above retains URLs for files that remain selected.
    }
  }, [files])
  useEffect(() => () => {
    for (const url of previewUrls.current.values()) URL.revokeObjectURL(url)
    previewUrls.current.clear()
  }, [])

  const addFiles = (incoming: Iterable<File>): void => {
    const additions = [...incoming]
    if (additions.length === 0) return
    const existing = new Set(files.map(fileKey))
    onFiles([...files, ...additions.filter((file) => !existing.has(fileKey(file)))])
  }
  const chooseFiles = (event: ChangeEvent<HTMLInputElement>): void => {
    addFiles(Array.from(event.currentTarget.files ?? []))
    event.currentTarget.value = ''
  }
  const onDrop = (event: DragEvent<HTMLFormElement>): void => {
    event.preventDefault()
    setDragging(false)
    addFiles(Array.from(event.dataTransfer.files))
  }
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const pasted = Array.from(event.clipboardData.files ?? [])
    if (pasted.length > 0) {
      event.preventDefault()
      addFiles(pasted)
    }
  }
  const submit = (event?: FormEvent): void => {
    event?.preventDefault()
    onSubmit()
  }
  const stop = (): void => {
    if (!confirmStop) { setConfirmStop(true); return }
    setConfirmStop(false)
    onStop()
  }

  return <form className={`pi-composer${dragging ? ' dragging' : ''}`} onSubmit={submit}
    onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
    onDragOver={(event) => event.preventDefault()}
    onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false) }}
    onDrop={onDrop}>
    {attachmentSupported && <div className="pi-attachments" aria-label="Pi attachments">
      <button type="button" className="btn btn-ghost pi-attach-button" disabled={!available || uploading}
        onClick={() => inputRef.current?.click()}>Attach files</button>
      <input ref={inputRef} className="pi-file-input" type="file" multiple hidden disabled={!available || uploading}
        accept="image/*,application/pdf,text/plain,text/markdown,.json,.csv" onChange={chooseFiles} />
      {files.map((file, index) => {
        const progressState = progress[fileKey(file)]
        const preview = previewUrls.current.get(fileKey(file))
        return <span className="pi-attachment-chip" key={fileKey(file)}>
          {preview && <img src={preview} alt="" aria-hidden="true" />}
          <span title={file.name}>{file.name} · {Math.ceil(file.size / 1024)} KiB
            {progressState && ` · ${progressState.state === 'uploading' ? `${Math.round(progressState.acknowledged / Math.max(1, file.size) * 100)}%` : progressState.state}`}</span>
          <button type="button" aria-label={`Remove ${file.name}`} disabled={uploading}
            onClick={() => onRemoveFile(index)}>×</button>
        </span>
      })}
      <span className="pi-attachment-hint">up to {PI_ATTACHMENTS_PER_PROMPT} files · {Math.round(PI_ATTACHMENT_MAX_BYTES / (1024 * 1024))} MiB each</span>
    </div>}
    {attachmentError && <div className="pi-attachment-error" role="alert">{attachmentError}</div>}
    {uncertainDelivery && <div className="pi-delivery-unknown" role="alert">{uncertainDelivery}</div>}
    <textarea value={draft} disabled={!available || uploading} placeholder={available ? 'Message Pi…' : 'Switch to Terminal or wait for the bridge…'}
      aria-label="Message Pi" rows={2}
      onChange={(event) => onDraftChange(event.currentTarget.value)}
      onPaste={onPaste}
      onCompositionStart={() => { composingRef.current = true }}
      onCompositionEnd={() => { composingRef.current = false }}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (shouldSubmitComposerKey(event.key, event.shiftKey, composingRef.current || event.nativeEvent.isComposing)) {
          event.preventDefault()
          submit()
        }
      }} />
    <div className="pi-composer-actions">
      <span className="pi-composer-help">Enter to send · Shift+Enter for a new line</span>
      {!available && <span className="pi-composer-offline">Bridge offline</span>}
      {uploading && <button type="button" className="btn btn-ghost" onClick={() => onCancelUpload?.()}>Cancel upload</button>}
      {!uploading && !confirmStop && <>
        {!available ? null : <select value={delivery} onChange={(event) => onDeliveryChange(event.currentTarget.value as PiDelivery)} aria-label="Delivery mode">
          <option value="now">Send now</option><option value="follow_up">Follow up</option><option value="steer">Steer now</option>
        </select>}
        {busy && <button type="button" className="btn btn-ghost" disabled={!available} onClick={stop}>Stop</button>}
      </>}
      {confirmStop && <>
        <span className="pi-stop-confirm">Stop Pi?</span>
        <button type="button" className="btn btn-ghost" onClick={() => setConfirmStop(false)}>Cancel</button>
        <button type="button" className="btn btn-danger" onClick={stop}>Confirm stop</button>
      </>}
      <button type="submit" className="btn btn-accent" disabled={(!draft.trim() && files.length === 0) || !available || uploading || submitting}>
        {uploading ? 'Uploading…' : submitting ? 'Sending…' : 'Send'}
      </button>
    </div>
  </form>
}
