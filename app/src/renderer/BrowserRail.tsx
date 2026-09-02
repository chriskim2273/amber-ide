import { useEffect, useRef, useState } from 'react'
import { formatLastPiAction, secondsRemaining } from './browserRailModel'

interface BrowserStatus {
  id: string; safeRestoreUrl: string; pageIncarnation: string; generation: number
  lifecycle: 'live' | 'frozen'; loading: boolean; capacityWaiting?: boolean
  lastAction?: { action: string; phase: string; error?: string }
}
type BrowserReply = { ok: true; result: BrowserStatus | { closed: true } } | { ok: false; error: string }

export function BrowserRail(props: {
  id: string; width: number; collapsed: boolean; designatedPi?: string; sharedWithPi?: boolean
  controllers: { name: string; label: string }[]
  onWidth: (width: number) => void; onCollapsed: (collapsed: boolean) => void; onClose: () => void
  onPolicy: (policy: { designatedPi?: string; sharedWithPi: boolean }) => void
  ensureContext: () => Promise<void>
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<BrowserStatus | null>(null)
  const [address, setAddress] = useState('')
  const [error, setError] = useState('')
  const [approval, setApproval] = useState<null | { approvalId: string; digest: string; controller: string; origin: string; category: string; targetLabel: string; argumentSummary: string; expiresAt: number; canGrantOrigin: boolean }>(null)
  const [dialog, setDialog] = useState<null | { dialogId: string; digest: string; dialogType: string; message: string; expiresAt: number }>(null)
  const [promptText, setPromptText] = useState('')
  const [lastAction, setLastAction] = useState<null | { action: string; phase: string; error?: string }>(null)
  const [clock, setClock] = useState(Date.now())

  const command = async (value: unknown): Promise<BrowserReply> => {
    await props.ensureContext()
    return window.amber.browserCommand(value) as Promise<BrowserReply>
  }

  useEffect(() => {
    return window.amber.onTabBrowserEvent?.((value) => {
      const event = value as { type?: unknown; id?: unknown; waiting?: unknown; browserId?: unknown; headless?: unknown; [key: string]: unknown }
      if (event.type === 'capacity-wait' && event.id === props.id && typeof event.waiting === 'boolean') {
        setStatus((current) => current ? { ...current, ...(event.waiting ? { capacityWaiting: true } : { capacityWaiting: false }) } : current)
      } else if (event.type === 'runtime' && event.id === props.id && typeof (event as { status?: unknown }).status === 'object') {
        setStatus((event as { status: BrowserStatus }).status)
      } else if (event.type === 'approval-request' && event.browserId === props.id && event.headless !== true) {
        const candidate = event as typeof event & { approvalId: string; digest: string; controller: string; origin: string; category: string; targetLabel: string; argumentSummary: string; expiresAt: number; canGrantOrigin: boolean }
        setApproval(candidate)
      } else if (event.type === 'approval-resolved' && event.browserId === props.id) setApproval(null)
      else if (event.type === 'dialog-request' && event.browserId === props.id && event.headless !== true) { const candidate = event as typeof event & { dialogId: string; digest: string; dialogType: string; message: string; expiresAt: number }; setPromptText(''); setDialog(candidate) }
      else if (event.type === 'dialog-resolved' && event.browserId === props.id) { setDialog(null); setPromptText('') }
      else if (event.type === 'pi-action' && event.browserId === props.id && typeof event.action === 'string' && typeof event.phase === 'string') setLastAction({ action: event.action, phase: event.phase, ...(typeof event.error === 'string' ? { error: event.error } : {}) })
    })
  }, [props.id])

  useEffect(() => {
    if (!approval && !dialog) return
    setClock(Date.now()); const timer = window.setInterval(() => setClock(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [approval, dialog])

  useEffect(() => {
    if (props.designatedPi && !props.controllers.some((controller) => controller.name === props.designatedPi)) {
      props.onPolicy({ sharedWithPi: false })
    }
  }, [props.designatedPi, props.controllers, props.onPolicy])

  useEffect(() => {
    let stopped = false
    if (props.collapsed) {
      void command({ type: 'hide', id: props.id })
      return () => { stopped = true }
    }
    const element = host.current
    if (!element) return
    const update = async (): Promise<void> => {
      const rect = element.getBoundingClientRect()
      const bounds = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) }
      const reply = await command({ type: 'show', id: props.id, bounds })
      if (!stopped && reply.ok && 'id' in reply.result) {
        const currentReply = await command({ type: 'status', id: props.id })
        const current = currentReply.ok && 'id' in currentReply.result ? currentReply.result : reply.result
        if (current.lastAction) setLastAction(current.lastAction)
        setStatus(current); if (!address) setAddress(current.safeRestoreUrl === 'about:blank' ? '' : current.safeRestoreUrl)
      }
      if (!stopped && !reply.ok) setError(reply.error)
    }
    void update()
    const observer = new ResizeObserver(() => { void update() })
    observer.observe(element)
    window.addEventListener('resize', update)
    return () => { stopped = true; observer.disconnect(); window.removeEventListener('resize', update) }
  }, [props.id, props.collapsed])

  const navigate = async (): Promise<void> => {
    if (!status || !address.trim()) return
    const currentReply = await command({ type: 'status', id: props.id })
    const current = currentReply.ok && 'id' in currentReply.result ? currentReply.result : status
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? address : `https://${address}`
    const reply = await command({ type: 'navigate', id: props.id, url, pageIncarnation: current.pageIncarnation, expectedGeneration: current.generation })
    if (reply.ok && 'id' in reply.result) { setStatus(reply.result); setError('') }
    else if (!reply.ok) setError(reply.error)
  }

  if (props.collapsed) return <aside className="tab-browser-rail collapsed" aria-label="Tab browser collapsed">
    <button className="icon-btn" aria-label="Expand tab browser" onClick={() => props.onCollapsed(false)}>‹</button>
  </aside>

  return <aside className="tab-browser-rail" style={{ width: props.width }} aria-label="Tab browser">
    <div className="tab-browser-chrome">
      <input aria-label="Browser address" value={address} placeholder="https://…" onChange={(event) => setAddress(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void navigate() }} />
      <button className="btn" onClick={() => void navigate()}>Go</button>
      <select aria-label="Pi browser controller" value={props.designatedPi ?? ''}
        onChange={(event) => props.onPolicy({ ...(event.target.value ? { designatedPi: event.target.value } : {}), sharedWithPi: false })}>
        <option value="">Private</option>
        {props.controllers.map((controller) => <option key={controller.name} value={controller.name}>{controller.label}</option>)}
      </select>
      <label className="tab-browser-share" title="Share this global Amber browser profile with the designated Pi">
        <input type="checkbox" checked={!!props.sharedWithPi} disabled={!props.designatedPi}
          onChange={(event) => {
            if (event.target.checked && !window.confirm('Share this tab browser with the designated Pi? It can access any origin where Amber’s global browser profile is signed in.')) return
            props.onPolicy({ ...(props.designatedPi ? { designatedPi: props.designatedPi } : {}), sharedWithPi: event.target.checked })
          }} /> Pi
      </label>
      {props.sharedWithPi && <button className="btn" onClick={() => void command({ type: 'stopPi' })}>Stop Pi</button>}
      <button className="icon-btn" aria-label="Collapse tab browser" onClick={() => { void command({ type: 'hide', id: props.id }).then((reply) => { if (reply.ok) props.onCollapsed(true); else setError(reply.error) }) }}>›</button>
      <button className="icon-btn" aria-label="Close tab browser" onClick={props.onClose}>×</button>
    </div>
    {status?.capacityWaiting && <div className="tab-browser-status" role="status">Waiting for browser capacity…</div>}
    {lastAction && <div className="tab-browser-status" role="status">{formatLastPiAction(lastAction)}</div>}
    {error && <div className="tab-browser-error" role="alert">{error}</div>}
    {approval && <div className="tab-browser-approval" role="alertdialog" aria-modal="true" aria-label="Pi browser action approval">
      <strong>Pi requests a consequential browser action</strong>
      <div>{approval.category} · {approval.origin}</div>
      <div>Controller: {approval.controller}</div>
      <div>Expires in {secondsRemaining(approval.expiresAt, clock)}s · dispatch not started</div>
      <div>Target (untrusted browser content): {approval.targetLabel || 'page'}</div>
      {approval.argumentSummary && <div>Value: {approval.argumentSummary}</div>}
      <div className="tab-browser-approval-actions">
        <button className="btn" onClick={() => void command({ type: 'resolveApproval', approvalId: approval.approvalId, digest: approval.digest, decision: 'approve-once' })}>Approve once</button>
        {approval.canGrantOrigin && <button className="btn" onClick={() => void command({ type: 'resolveApproval', approvalId: approval.approvalId, digest: approval.digest, decision: 'allow-origin' })}>Allow this confirmation for origin</button>}
        <button className="btn" onClick={() => void command({ type: 'resolveApproval', approvalId: approval.approvalId, digest: approval.digest, decision: 'reject' })}>Reject</button>
      </div>
    </div>}
    {dialog && <div className="tab-browser-approval tab-browser-dialog" role="alertdialog" aria-modal="true" aria-label="Browser dialog">
      <strong>{dialog.dialogType === 'beforeunload' ? 'Page asks to leave' : `Page ${dialog.dialogType}`}</strong>
      <div>Message (untrusted browser content): {dialog.message}</div>
      <div>Expires in {secondsRemaining(dialog.expiresAt, clock)}s</div>
      {dialog.dialogType === 'prompt' && <input aria-label="Browser prompt response" value={promptText} maxLength={4096} onChange={(event) => setPromptText(event.target.value)} />}
      <div className="tab-browser-approval-actions">
        <button className="btn" onClick={() => void command({ type: 'resolveDialog', dialogId: dialog.dialogId, digest: dialog.digest, accept: true, ...(dialog.dialogType === 'prompt' ? { promptText } : {}) })}>{dialog.dialogType === 'beforeunload' ? 'Leave' : 'Accept'}</button>
        <button className="btn" onClick={() => void command({ type: 'resolveDialog', dialogId: dialog.dialogId, digest: dialog.digest, accept: false })}>{dialog.dialogType === 'beforeunload' ? 'Stay' : 'Reject'}</button>
      </div>
    </div>}
    <div ref={host} className="tab-browser-page-slot" />
    <div className="tab-browser-grip" role="separator" aria-orientation="vertical" aria-label="Resize browser rail"
      onPointerDown={(event) => {
        const startX = event.clientX; const startWidth = props.width
        const move = (next: PointerEvent): void => props.onWidth(Math.min(900, Math.max(280, startWidth + startX - next.clientX)))
        const up = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
      }} />
  </aside>
}
