import { memo, useEffect, useReducer, useRef, useState } from 'react'
import type { ControlMsg, PiCommand, PiDelivery } from '../shared/proto'
import { attachmentsError, forEachAttachmentChunk, newPiRequestId } from './piAttachments'
import { initialPiViewState, reducePiView, type PiViewState } from './piModel'
import { PiComposer, type PiAttachmentProgress } from './PiComposer'
import { PiSubagents } from './PiSubagents'
import { PiTranscript } from './PiTranscript'
import { canClearPiDraft, clearPiDraft, readPiDraft, writePiDraft } from './piDraft'
import { legacyPiDeliveryMessage, piOperationCurrent, piSubmitAllowed, releasePiOperation, resetPiSubmissionOnReconnect, uploadThenPrompt } from './piSubmission'

type PiReceipt = { success: boolean; error?: string; data?: unknown }
type ReceiptWaiter = {
  resolve: (receipt: PiReceipt) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  generation: number
  detachAbort: (() => void) | undefined
}
type RequestOptions = { signal?: AbortSignal; generation?: number }

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function receiptData(value: unknown): Record<string, unknown> | null { return record(value) }
function fileKey(file: File): string { return `${file.name}:${file.size}:${file.lastModified}` }

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }

export const PiPane = memo(function PiPane({ session, portEpoch }: { session: string; portEpoch: number }): JSX.Element {
  const [state, dispatch] = useReducer(reducePiView, initialPiViewState)
  const [draft, setDraft] = useState(() => readPiDraft(session))
  const [delivery, setDelivery] = useState<PiDelivery>('follow_up')
  const [files, setFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [uploadProgress, setUploadProgress] = useState<Record<string, PiAttachmentProgress>>({})
  const [uncertainDelivery, setUncertainDelivery] = useState<string | null>(null)
  const [pendingRequests, setPendingRequests] = useState<ReadonlySet<string>>(new Set())
  const [pendingSubmit, setPendingSubmit] = useState<string | null>(null)
  const [follow, setFollow] = useState(true)
  const portRef = useRef<MessagePort | null>(null)
  const waitersRef = useRef(new Map<string, ReceiptWaiter>())
  const generationRef = useRef(0)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const draftRef = useRef(draft)
  const draftVersionRef = useRef(0)
  const uploadAbortRef = useRef<AbortController | null>(null)
  const pendingSubmitRef = useRef<string | null>(null)

  draftRef.current = draft

  // Draft persistence is guarded and debounced. It is never used to replay a
  // prompt, and a receipt only clears the exact version that was submitted.
  useEffect(() => {
    const timer = setTimeout(() => { writePiDraft(session, draft) }, 250)
    return () => clearTimeout(timer)
  }, [session, draft])

  useEffect(() => {
    if (follow) endRef.current?.scrollIntoView({ block: 'end' })
  }, [follow, state.messages, state.liveMessage, state.tools])

  useEffect(() => {
    const generation = ++generationRef.current
    const onPort = (event: MessageEvent): void => {
      const data = event.data as { amberPanePort?: boolean; session?: string; mode?: string }
      if (!data?.amberPanePort || data.session !== session || data.mode !== 'pi' || !event.ports[0]) return
      window.removeEventListener('message', onPort)
      portRef.current?.close()
      const port = event.ports[0]
      portRef.current = port
      port.onmessage = (incoming) => {
        if (generation !== generationRef.current) return
        const msg = (incoming.data as { msg?: ControlMsg })?.msg
        if (!msg) return
        if (msg.kind === 'PiEvent' && msg.event['kind'] === 'command_result'
          && typeof msg.event['requestId'] === 'string') {
          const requestId = msg.event['requestId']
          const waiter = waitersRef.current.get(requestId)
          if (waiter && waiter.generation === generation) {
            clearTimeout(waiter.timer)
            waiter.detachAbort?.()
            waitersRef.current.delete(requestId)
            setPendingRequests((current) => {
              const next = new Set(current)
              next.delete(requestId)
              return next
            })
            const receipt: PiReceipt = { success: msg.event['success'] === true }
            if (typeof msg.event['error'] === 'string') receipt.error = msg.event['error']
            if (msg.event['data'] !== undefined) receipt.data = msg.event['data']
            if (receipt.success) waiter.resolve(receipt)
            else waiter.reject(new Error(receipt.error ?? 'Pi command failed'))
          }
        }
        dispatch(msg)
      }
      port.start()
    }
    window.addEventListener('message', onPort)
    window.amber.openPiPane(session)
    return () => {
      generationRef.current += 1
      window.removeEventListener('message', onPort)
      for (const waiter of waitersRef.current.values()) {
        clearTimeout(waiter.timer)
        waiter.detachAbort?.()
        waiter.reject(new Error('Pi pane disconnected'))
      }
      waitersRef.current.clear()
      setPendingRequests(new Set())
      uploadAbortRef.current?.abort()
      uploadAbortRef.current = null
      // Reconnect owns a fresh operation slot. Reset the old UI state here;
      // the stale upload's finally block is generation-gated and must not undo
      // a replacement operation that starts after this cleanup.
      const reset = resetPiSubmissionOnReconnect()
      pendingSubmitRef.current = reset.pendingRequestId
      setPendingSubmit(reset.pendingRequestId)
      setUploading(reset.uploading)
      portRef.current?.close()
      portRef.current = null
      if (draftRef.current.trim()) setUncertainDelivery('Delivery unknown after the Pi bridge disconnected; your draft was kept.')
      window.amber.closePiPane(session)
    }
  }, [session, portEpoch])

  const send = (command: PiCommand): boolean => {
    const port = portRef.current
    if (!port) {
      setUncertainDelivery('Delivery unknown because the Pi bridge is unavailable; your draft was kept.')
      return false
    }
    try {
      port.postMessage({ command })
      return true
    } catch {
      setUncertainDelivery('Delivery unknown because the Pi bridge is unavailable; your draft was kept.')
      return false
    }
  }
  const sendRequest = (command: PiCommand & { requestId: string }, options: RequestOptions = {}): Promise<PiReceipt> => {
    const port = portRef.current
    const generation = generationRef.current
    if (!port || (options.generation !== undefined && options.generation !== generation)) return Promise.reject(new Error('Pi bridge is not connected'))
    if (options.signal?.aborted) return Promise.reject(new Error('Pi operation canceled'))
    return new Promise<PiReceipt>((resolve, reject) => {
      let settled = false
      let detachAbort: (() => void) | undefined
      const finish = (error?: Error, receipt?: PiReceipt): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        detachAbort?.()
        waitersRef.current.delete(command.requestId)
        setPendingRequests((current) => {
          const next = new Set(current)
          next.delete(command.requestId)
          return next
        })
        if (error) reject(error); else resolve(receipt!)
      }
      const timer = setTimeout(() => finish(new Error('Pi command timed out')), 30_000)
      if (options.signal) {
        const abort = (): void => finish(new Error('Pi operation canceled'))
        options.signal.addEventListener('abort', abort, { once: true })
        detachAbort = () => options.signal?.removeEventListener('abort', abort)
      }
      waitersRef.current.set(command.requestId, { resolve, reject, timer, generation, detachAbort })
      setPendingRequests((current) => new Set(current).add(command.requestId))
      try { port.postMessage({ command }) } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  const updateProgress = (file: File, patch: Partial<PiAttachmentProgress>): void => {
    const key = fileKey(file)
    setUploadProgress((current) => ({
      ...current,
      [key]: { name: file.name, size: file.size, state: 'queued', acknowledged: 0, ...current[key], ...patch },
    }))
  }

  const uploadFile = async (file: File, signal: AbortSignal, operationGeneration: number): Promise<string> => {
    const current = (): boolean => piOperationCurrent(signal, operationGeneration, generationRef.current, portRef.current !== null)
    const ensureCurrent = (): void => { if (!current()) throw new Error(signal.aborted ? 'Pi upload canceled' : 'Pi bridge replaced') }
    updateProgress(file, { state: 'uploading', acknowledged: 0 })
    ensureCurrent()
    const begin = await sendRequest({
      kind: 'UploadBegin', requestId: newPiRequestId('upload-begin'), filename: file.name,
      mimeType: file.type || 'application/octet-stream', size: file.size,
    }, { signal, generation: operationGeneration })
    ensureCurrent()
    const attachmentId = receiptData(begin.data)?.['attachmentId']
    if (typeof attachmentId !== 'string') throw new Error('Pi did not return an attachment id')
    try {
      await forEachAttachmentChunk(file, async (offset, data, byteLength) => {
        ensureCurrent()
        const chunk = await sendRequest({
          kind: 'UploadChunk', requestId: newPiRequestId('upload-chunk'), attachmentId, offset, data,
        }, { signal, generation: operationGeneration })
        ensureCurrent()
        const acknowledgedOffset = receiptData(chunk.data)?.['acknowledgedOffset']
        if (acknowledgedOffset !== offset + byteLength) throw new Error('Pi acknowledged an unexpected attachment offset')
      }, { signal, onProgress: (acknowledged) => { if (current()) updateProgress(file, { state: 'uploading', acknowledged }) } })
      ensureCurrent()
      await sendRequest({ kind: 'UploadFinish', requestId: newPiRequestId('upload-finish'), attachmentId }, { signal, generation: operationGeneration })
      ensureCurrent()
      updateProgress(file, { state: 'done', acknowledged: file.size })
      return attachmentId
    } catch (error) {
      // Never send a cleanup mutation over a replacement port/session. A
      // cancellation on the same live operation is safe and keeps the server
      // from retaining a partial artifact.
      if (generationRef.current === operationGeneration && portRef.current !== null) {
        void sendRequest({ kind: 'UploadCancel', requestId: newPiRequestId('upload-cancel'), attachmentId }, { generation: operationGeneration }).catch(() => {})
      }
      updateProgress(file, { state: signal.aborted ? 'canceled' : 'error', error: errorText(error) })
      throw error
    }
  }

  const clearSubmittedDraft = (value: string, version: number): void => {
    if (canClearPiDraft(draftRef.current, value, draftVersionRef.current, version)) {
      setDraft('')
      clearPiDraft(session)
    }
  }
  const releasePendingSubmit = (operationId: string): void => {
    const next = releasePiOperation(pendingSubmitRef.current, operationId)
    if (next === pendingSubmitRef.current) return
    pendingSubmitRef.current = next
    setPendingSubmit((current) => current === operationId ? next : current)
  }

  const submit = (): void => {
    const message = draft.trim()
    if ((!message && files.length === 0) || !piSubmitAllowed(pendingSubmitRef.current, state.available, uploading)) return
    if (files.length > 0 && !state.capabilities.attachments) {
      setAttachmentError('This Pi bridge does not advertise attachment support.')
      return
    }
    const selected = [...files]
    const validation = attachmentsError(selected)
    if (validation) { setAttachmentError(validation); return }
    setAttachmentError(null)
    setUncertainDelivery(null)
    const submittedDraft = draft
    const submittedVersion = draftVersionRef.current
    const commandDelivery: PiDelivery = state.idle ? 'now' : delivery
    if (selected.length === 0 && state.capabilities.promptReceipts) {
      const requestId = newPiRequestId('prompt')
      pendingSubmitRef.current = requestId
      setPendingSubmit(requestId)
      void sendRequest({ kind: 'PromptWithAttachments', requestId, message, delivery: commandDelivery, attachments: [] })
        .then(() => {
          releasePendingSubmit(requestId)
          clearSubmittedDraft(submittedDraft, submittedVersion)
        })
        .catch((error) => {
          releasePendingSubmit(requestId)
          setUncertainDelivery(`Delivery unknown: ${errorText(error)} Your draft was kept.`)
        })
      return
    }
    if (selected.length === 0) {
      const sent = send({ kind: 'Prompt', message, delivery: commandDelivery })
      // Legacy bridges have no receipt. Never clear the durable draft: a
      // successful post only proves that the bridge accepted bytes, not that
      // Pi delivered the prompt to its session.
      setUncertainDelivery(legacyPiDeliveryMessage(sent))
      return
    }
    const operationId = newPiRequestId('upload')
    pendingSubmitRef.current = operationId
    setPendingSubmit(operationId)
    setUploading(true)
    const controller = new AbortController()
    const operationGeneration = generationRef.current
    uploadAbortRef.current = controller
    void (async () => {
      try {
        const isCurrent = (): boolean => piOperationCurrent(
          controller.signal, operationGeneration, generationRef.current, portRef.current !== null,
        )
        const submitted = await uploadThenPrompt(
          selected,
          (file) => uploadFile(file, controller.signal, operationGeneration),
          async (attachmentIds) => {
            if (!isCurrent()) throw new Error('Pi bridge replaced')
            await sendRequest({
              kind: 'PromptWithAttachments', requestId: newPiRequestId('prompt'), message,
              delivery: commandDelivery, attachments: attachmentIds,
            }, { signal: controller.signal, generation: operationGeneration })
          },
          isCurrent,
        )
        if (!submitted || !isCurrent()) return
        clearSubmittedDraft(submittedDraft, submittedVersion)
        setFiles([])
        setUploadProgress({})
      } catch (error) {
        if (!controller.signal.aborted && generationRef.current === operationGeneration) {
          setAttachmentError(errorText(error))
          setUncertainDelivery(`Delivery unknown: ${errorText(error)} Your draft was kept.`)
        }
      } finally {
        if (uploadAbortRef.current === controller) uploadAbortRef.current = null
        releasePendingSubmit(operationId)
        if (generationRef.current === operationGeneration) setUploading(false)
      }
    })()
  }

  const acceptFiles = (selected: File[]): void => {
    const validation = attachmentsError(selected)
    setAttachmentError(validation)
    if (!validation) setFiles(selected)
  }
  const cancelUpload = (): void => {
    uploadAbortRef.current?.abort()
    setAttachmentError('Upload canceled. Remove the attachment or send again.')
  }
  const modelName = typeof state.model?.['name'] === 'string' ? state.model['name']
    : typeof state.model?.['id'] === 'string' ? state.model['id'] : 'Pi'
  const percent = typeof state.contextUsage?.['percent'] === 'number' ? state.contextUsage['percent'] : null

  return <div className="pi-chat" tabIndex={0} aria-label="Pi graphical conversation">
    <div className="pi-chat-status" role="status">
      <span className={`pi-bridge-dot ${!state.statusKnown ? '' : state.available ? state.idle ? 'idle' : 'busy' : 'offline'}`} />
      <span>{!state.statusKnown ? 'Connecting' : state.available ? state.idle ? 'Ready' : state.pending ? 'Working · follow-up pending' : 'Working' : 'Graphical bridge unavailable'}</span>
      <span className="pi-chat-model">{modelName}</span>
      {percent !== null && <span title="context used">{Math.round(percent)}%</span>}
      <label>Thinking
        <select value={state.thinkingLevel} disabled={!state.available}
          onChange={(event) => send({ kind: 'SetThinkingLevel', level: event.currentTarget.value })}>
          {['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((level) => <option key={level}>{level}</option>)}
        </select>
      </label>
    </div>
    {state.awaitingUi && <div className="pi-dialog-notice" role="alert">Pi is waiting for {state.awaitingUi.title ?? `a ${state.awaitingUi.kind} response`} in the terminal view.</div>}
    {state.error && <div className="pi-chat-error" role="alert">{state.error}</div>}
    <PiSubagents status={state.subagents} transcripts={state.transcripts} receipts={state.receipts}
      pending={pendingRequests} onCommand={(command) => sendRequest(command).then(() => undefined).catch((error) => {
        setUncertainDelivery(`Subagent request failed: ${errorText(error)}`)
        throw error
      })} />
    <PiTranscript messages={state.messages} liveMessage={state.liveMessage} tools={state.tools}
      transcriptRef={transcriptRef} endRef={endRef} follow={follow} onFollowChange={setFollow} />
    <PiComposer draft={draft} onDraftChange={(value) => { draftVersionRef.current += 1; setDraft(value) }}
      files={files} onFiles={acceptFiles} onRemoveFile={(index) => setFiles((current) => current.filter((_, i) => i !== index))}
      onSubmit={submit} onStop={() => send({ kind: 'Abort' })} onCancelUpload={cancelUpload}
      delivery={delivery} onDeliveryChange={setDelivery} available={state.available} busy={!state.idle} uploading={uploading}
      submitting={pendingSubmit !== null} attachmentSupported={state.capabilities.attachments} attachmentError={attachmentError}
      progress={uploadProgress} uncertainDelivery={uncertainDelivery} />
  </div>
})
