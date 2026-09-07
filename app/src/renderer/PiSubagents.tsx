import { useEffect, useRef, useState } from 'react'
import type { PiCommand } from '../shared/proto'
import { newPiRequestId } from './piAttachments'
import { subagentCanControl, subagentCanLoadTranscript, type PiSubagentStatus, type PiSubagentTranscript, type PiSubagentReceipt } from './piModel'

export interface PiSubagentsProps {
  status: PiSubagentStatus
  transcripts: Record<string, PiSubagentTranscript>
  receipts: Record<string, PiSubagentReceipt>
  pending: ReadonlySet<string>
  onCommand: (command: PiCommand & { requestId: string }) => void | Promise<void>
}

function stateLabel(value: string): string {
  return value.replace(/[-_]+/g, ' ')
}

/** Read-only fleet rows plus capability-gated controls for package-owned
 * top-level async run IDs. Fleet display keys are never sent as targets. */
export interface RequestOwner {
  runId: string
  action: 'stop' | 'steer' | 'interrupt' | 'resume' | 'transcript'
  draft?: string
  draftVersion?: number
}

export function requestBusyForRun(owners: ReadonlyMap<string, RequestOwner>, runId: string): boolean {
  // Ownership is keyed by the exact request ID and run ID. Generated request
  // IDs intentionally contain no run ID, so substring matching is invalid.
  for (const owner of owners.values()) if (owner.runId === runId) return true
  return false
}

export function shouldClearSteerDraft(
  owner: RequestOwner,
  receiptReceived: boolean,
  currentDraft: string,
  currentVersion: number,
): boolean {
  return owner.action === 'steer' && receiptReceived
    && owner.draft !== undefined && owner.draftVersion !== undefined
    && currentDraft === owner.draft && currentVersion === owner.draftVersion
}

export function shouldSubmitSteerKey(
  key: string,
  shiftKey: boolean,
  composing: boolean,
  nativeComposing: boolean,
  value: string,
): boolean {
  return key === 'Enter' && !shiftKey && !composing && !nativeComposing && value.trim().length > 0
}

export function PiSubagents({ status, transcripts, receipts, pending, onCommand }: PiSubagentsProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [confirmStop, setConfirmStop] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [, setRequestEpoch] = useState(0)
  const draftVersionsRef = useRef<Record<string, number>>({})
  const requestOwnersRef = useRef(new Map<string, RequestOwner>())
  const composingRef = useRef(false)

  const releaseRequest = (requestId: string): void => {
    if (!requestOwnersRef.current.delete(requestId)) return
    setRequestEpoch((current) => current + 1)
  }
  useEffect(() => {
    let released = false
    for (const [requestId, owner] of requestOwnersRef.current) {
      if (pending.has(requestId)) continue
      requestOwnersRef.current.delete(requestId)
      released = true
      if (!shouldClearSteerDraft(owner, receipts[requestId] !== undefined, drafts[owner.runId] ?? '', draftVersionsRef.current[owner.runId] ?? 0)) continue
      setDrafts((current) => {
        if (!shouldClearSteerDraft(owner, true, current[owner.runId] ?? '', draftVersionsRef.current[owner.runId] ?? 0)) return current
        const next = { ...current }
        delete next[owner.runId]
        return next
      })
    }
    if (released) setRequestEpoch((current) => current + 1)
  }, [drafts, pending, receipts])

  const requestBusy = (runId: string): boolean => requestBusyForRun(requestOwnersRef.current, runId)
  const dispatch = (requestId: string, owner: RequestOwner, command: PiCommand & { requestId: string }): void => {
    requestOwnersRef.current.set(requestId, owner)
    try {
      const result = onCommand(command)
      if (result) void result.catch(() => releaseRequest(requestId))
    } catch {
      releaseRequest(requestId)
    }
  }
  const send = (runId: string, action: 'stop' | 'steer' | 'interrupt' | 'resume', message?: string): void => {
    // Revalidate at dispatch time: the row may have gone stale after it was
    // rendered, including while the confirm-stop button was open.
    if (!subagentCanControl(status, runId, action) || requestBusy(runId)) return
    const requestId = newPiRequestId(`subagent-${action}`)
    const owner: RequestOwner = { runId, action }
    if (action === 'steer') {
      // Keep the raw editor value for receipt-safe draft clearing. The wire
      // command may be trimmed, but whitespace-bearing edits are still user
      // edits and must survive an uncertain delivery.
      owner.draft = drafts[runId] ?? message ?? ''
      owner.draftVersion = draftVersionsRef.current[runId] ?? 0
    }
    dispatch(requestId, owner, { kind: 'SubagentControl', requestId, action, runId, ...(message ? { message } : {}) })
  }
  const loadTranscript = (runId: string): void => {
    if (!subagentCanLoadTranscript(status, runId) || requestBusy(runId)) return
    const requestId = newPiRequestId('subagent-transcript')
    dispatch(requestId, { runId, action: 'transcript' }, { kind: 'SubagentTranscript', requestId, runId })
  }
  const hasRows = status.asyncRuns.length > 0 || status.fleet.entries.length > 0
  return <section className="pi-subagents" aria-label="Pi subagents">
    <button type="button" className="pi-subagents-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <span className="pi-subagents-dot" />
      Subagents {status.stale ? '(status unavailable)' : status.fleet.totalActive > 0 ? `· ${status.fleet.totalActive} active` : ''}
      <span aria-hidden="true">{open ? '⌃' : '⌄'}</span>
    </button>
    {open && <div className="pi-subagents-panel">
      {!status.available && <p className="pi-subagents-muted">{status.reason ?? 'The pi-subagents extension is unavailable.'}</p>}
      {status.available && !hasRows && <p className="pi-subagents-muted">No active subagents.</p>}
      {status.asyncRuns.map((run) => {
        const canStop = subagentCanControl(status, run.id, 'stop')
        const canSteer = subagentCanControl(status, run.id, 'steer')
        const canInterrupt = subagentCanControl(status, run.id, 'interrupt')
        const canResume = subagentCanControl(status, run.id, 'resume')
        const canTranscript = subagentCanLoadTranscript(status, run.id)
        const busy = requestBusy(run.id)
        const receipt = Object.values(receipts).reverse().find((item) => item.runId === run.id)
        const transcript = Object.values(transcripts).reverse().find((item) => item.runId === run.id)
        return <article className="pi-subagent-run" key={run.id}>
          <div className="pi-subagent-heading">
            <span className="pi-subagent-state" data-state={run.state} />
            <strong>{run.label}</strong>
            <span className="pi-subagent-state-label">{stateLabel(run.state)}</span>
          </div>
          {run.activity?.currentTool && <div className="pi-subagent-activity">{run.activity.currentTool}</div>}
          <div className="pi-subagent-actions">
            {canStop && <button type="button" className="btn btn-ghost" disabled={busy}
              onClick={() => setConfirmStop((current) => current === run.id ? null : run.id)}>Stop</button>}
            {confirmStop === run.id && <button type="button" className="btn btn-danger" disabled={busy}
              onClick={() => { setConfirmStop(null); send(run.id, 'stop') }}>Confirm stop</button>}
            {canResume && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => send(run.id, 'resume')}>Resume</button>}
            {canInterrupt && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => send(run.id, 'interrupt')}>Interrupt</button>}
            {canTranscript && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => loadTranscript(run.id)}>Details</button>}
          </div>
          {canSteer && <div className="pi-subagent-steer">
            <input value={drafts[run.id] ?? ''} aria-label={`Steer ${run.label}`} placeholder="Send a follow-up…"
              onChange={(event) => {
                draftVersionsRef.current[run.id] = (draftVersionsRef.current[run.id] ?? 0) + 1
                setDrafts((current) => ({ ...current, [run.id]: event.currentTarget.value }))
              }}
              onCompositionStart={() => { composingRef.current = true }}
              onCompositionEnd={() => { composingRef.current = false }}
              onKeyDown={(event) => {
                if (shouldSubmitSteerKey(event.key, event.shiftKey, composingRef.current, event.nativeEvent.isComposing, event.currentTarget.value)) {
                  event.preventDefault(); send(run.id, 'steer', event.currentTarget.value.trim())
                }
              }} />
            <button type="button" className="btn btn-accent" disabled={busy || !(drafts[run.id] ?? '').trim()}
              onClick={() => send(run.id, 'steer', (drafts[run.id] ?? '').trim())}>Send</button>
          </div>}
          {receipt && <div className="pi-subagent-receipt" role="status">{receipt.action}: {receipt.message ?? receipt.deliveryStatus ?? receipt.state ?? 'accepted'}</div>}
          {transcript && <details className="pi-subagent-transcript" open><summary>Transcript</summary>
            {transcript.text && <p>{transcript.text}</p>}
            {transcript.results.map((result, index) => <div key={index} className="pi-subagent-result">
              <strong>{result.agent ?? 'subagent'}{result.status ? ` · ${result.status}` : ''}</strong>
              {result.finalOutput && <p>{result.finalOutput}</p>}
              {result.messages?.map((message, messageIndex) => <p key={messageIndex}>{message.text}</p>)}
            </div>)}
          </details>}
        </article>
      })}
      {status.fleet.entries.map((entry) => <div className="pi-subagent-fleet-row" key={`${entry.agent}:${entry.startedAt}`}>
        <span className="pi-subagent-state" />
        <span>{entry.agent}</span><span>{entry.role ?? entry.model ?? 'worker'}</span><span className="pi-subagents-muted">read-only</span>
      </div>)}
      {(status.omitted.runs > 0 || status.omitted.children > 0 || status.omitted.byteLimitExceeded) &&
        <p className="pi-subagents-muted">Some subagent details are omitted for safety and size limits.</p>}
    </div>}
  </section>
}
