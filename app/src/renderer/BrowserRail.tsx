import { useEffect, useRef, useState } from 'react'
import { clampBrowserViewport } from '../shared/browserViewport'
import {
  BROWSER_VIEWPORT_PRESETS,
  MIN_RAIL_WIDTH,
  MIN_TERMINAL_WIDTH,
  clampRailWidth,
  formatLastPiAction,
  keyboardRailWidth,
  railReloadCommand,
  railStopCommand,
  railWidthMetrics,
  reclampedRailWidth,
  railSecurity,
  railStatusLines,
  secondsRemaining,
  validateCustomViewport,
} from './browserRailModel'

interface BrowserStatus {
  id: string; safeRestoreUrl: string; currentUrl: string; pageIncarnation: string; generation: number
  lifecycle: 'live' | 'frozen'; loading: boolean; capacityWaiting?: boolean; mode: 'preview' | 'browse'
  title: string; restoreError?: string; restoredAfterFreeze: boolean; focused: boolean; visible: boolean
  viewport: { width: number; height: number }; diagnostics: { consoleIssues: number; networkFailures: number }
  lastAction?: { action: string; phase: string; error?: string }
}
type BrowserReply = { ok: true; result: BrowserStatus | { closed: true } } | { ok: false; error: string }

export function BrowserRail(props: {
  id: string; width: number; collapsed: boolean; designatedPi?: string; sharedWithPi?: boolean
  controllers: { name: string; label: string }[]; temporarilyHidden?: boolean; occluded?: boolean
  onWidth: (width: number) => void; onCollapsed: (collapsed: boolean) => void; onClose: () => void; onRecovery: () => void
  onPolicy: (policy: { designatedPi?: string; sharedWithPi: boolean }) => void
  ensureContext: () => Promise<void>
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null), addressInput = useRef<HTMLInputElement>(null)
  const [status, setStatus] = useState<BrowserStatus | null>(null)
  const [address, setAddress] = useState('')
  const [error, setError] = useState('')
  const [approval, setApproval] = useState<null | { approvalId: string; digest: string; controller: string; origin: string; category: string; targetLabel: string; argumentSummary: string; expiresAt: number; canGrantOrigin: boolean }>(null)
  const [dialog, setDialog] = useState<null | { dialogId: string; digest: string; dialogType: string; message: string; expiresAt: number }>(null)
  const [promptText, setPromptText] = useState('')
  const [lastAction, setLastAction] = useState<null | { action: string; phase: string; error?: string }>(null)
  const [clock, setClock] = useState(Date.now())
  const [viewportOpen, setViewportOpen] = useState(false)
  const [responsiveViewport, setResponsiveViewport] = useState(false)
  const [customWidth, setCustomWidth] = useState('1280'), [customHeight, setCustomHeight] = useState('800')
  const [autoCollapsed, setAutoCollapsed] = useState(false)
  const [capacityWaiting, setCapacityWaiting] = useState(false)
  const [availableWidth, setAvailableWidth] = useState(1200)

  const command = async (value: unknown): Promise<BrowserReply> => {
    await props.ensureContext()
    return window.amber.browserCommand(value) as Promise<BrowserReply>
  }
  const acceptStatus = (next: BrowserStatus): void => {
    setStatus(next)
    if (next.lastAction) setLastAction(next.lastAction)
    if (document.activeElement !== addressInput.current) setAddress(next.currentUrl === 'about:blank' ? '' : next.currentUrl)
  }

  useEffect(() => window.amber.onTabBrowserEvent?.((value) => {
    const event = value as { type?: unknown; id?: unknown; waiting?: unknown; browserId?: unknown; headless?: unknown; [key: string]: unknown }
    if (event.type === 'capacity-wait' && event.id === props.id && typeof event.waiting === 'boolean') {
      setCapacityWaiting(event.waiting as boolean)
      setStatus((current) => current ? { ...current, capacityWaiting: event.waiting as boolean } : current)
    } else if (event.type === 'runtime' && event.id === props.id && typeof event.status === 'object' && event.status) {
      acceptStatus(event.status as BrowserStatus)
    } else if (event.type === 'approval-request' && event.browserId === props.id && event.headless !== true) {
      setApproval(event as typeof event & NonNullable<typeof approval>)
    } else if (event.type === 'approval-resolved' && event.browserId === props.id) setApproval(null)
    else if (event.type === 'dialog-request' && event.browserId === props.id && event.headless !== true) { setPromptText(''); setDialog(event as typeof event & NonNullable<typeof dialog>) }
    else if (event.type === 'dialog-resolved' && event.browserId === props.id) { setDialog(null); setPromptText('') }
    else if (event.type === 'pi-action' && event.browserId === props.id && typeof event.action === 'string' && typeof event.phase === 'string') setLastAction({ action: event.action, phase: event.phase, ...(typeof event.error === 'string' ? { error: event.error } : {}) })
  }), [props.id])

  useEffect(() => {
    if (!approval && !dialog) return
    setClock(Date.now()); const timer = window.setInterval(() => setClock(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [approval, dialog])

  useEffect(() => {
    if (props.designatedPi && !props.controllers.some((controller) => controller.name === props.designatedPi)) props.onPolicy({ sharedWithPi: false })
  }, [props.designatedPi, props.controllers, props.onPolicy])

  useEffect(() => {
    const workarea = host.current?.closest<HTMLElement>('.tab-browser-workarea')
    if (!workarea) return
    const update = (): void => { setAvailableWidth(workarea.clientWidth); setAutoCollapsed(workarea.clientWidth < MIN_RAIL_WIDTH + MIN_TERMINAL_WIDTH) }
    update(); const observer = new ResizeObserver(update); observer.observe(workarea)
    return () => observer.disconnect()
  }, [props.id, props.collapsed])

  const widthMetrics = railWidthMetrics(props.width, availableWidth)
  useEffect(() => { const persisted = reclampedRailWidth(props.width, availableWidth); if (!autoCollapsed && persisted !== null) props.onWidth(persisted) }, [autoCollapsed, availableWidth, props.onWidth, props.width])

  const presentationHidden = props.collapsed || props.temporarilyHidden || props.occluded || viewportOpen || autoCollapsed
  useEffect(() => {
    let stopped = false, frame = 0, settled = 0
    if (presentationHidden) { void command({ type: 'hide', id: props.id }); return () => { stopped = true } }
    const element = host.current
    if (!element) return
    const update = async (): Promise<void> => {
      const rect = element.getBoundingClientRect()
      const bounds = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) }
      const reply = await command({ type: 'show', id: props.id, bounds })
      if (!stopped && reply.ok && 'id' in reply.result) {
        acceptStatus(reply.result); setError('')
        if (responsiveViewport) {
          const current = reply.result, viewport = clampBrowserViewport(bounds.width, bounds.height)
          const resized = await command({ type: 'viewport', id: props.id, pageIncarnation: current.pageIncarnation, expectedGeneration: current.generation, ...viewport })
          if (!stopped && resized.ok && 'id' in resized.result) acceptStatus(resized.result)
        }
      } else if (!stopped && !reply.ok) setError(reply.error)
    }
    const schedule = (): void => {
      cancelAnimationFrame(frame); clearTimeout(settled)
      frame = requestAnimationFrame(() => { settled = window.setTimeout(() => { void update() }, 100) })
    }
    void update()
    const observer = new ResizeObserver(schedule); observer.observe(element); window.addEventListener('resize', schedule)
    return () => { stopped = true; observer.disconnect(); window.removeEventListener('resize', schedule); cancelAnimationFrame(frame); clearTimeout(settled) }
  }, [props.id, presentationHidden, responsiveViewport])

  const withLease = async (request: (lease: BrowserStatus) => unknown): Promise<void> => {
    if (!status || status.lifecycle !== 'live') return
    const reply = await command(request(status))
    if (reply.ok && 'id' in reply.result) { acceptStatus(reply.result); setError('') } else if (!reply.ok) setError(reply.error)
  }
  const reloadOrRestore = async (): Promise<void> => {
    if (!status) return
    const rect = host.current?.getBoundingClientRect()
    const bounds = { x: Math.round(rect?.x ?? 0), y: Math.round(rect?.y ?? 0), width: Math.max(1, Math.round(rect?.width ?? widthMetrics.width)), height: Math.max(1, Math.round(rect?.height ?? 1)) }
    const reply = await command(railReloadCommand(status, bounds))
    if (reply.ok && 'id' in reply.result) { acceptStatus(reply.result); setError('') } else if (!reply.ok) setError(reply.error)
  }
  const navigate = async (): Promise<void> => {
    if (!address.trim()) return
    await withLease((lease) => ({ type: 'navigate', id: props.id, url: /^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? address : `https://${address}`, pageIncarnation: lease.pageIncarnation, expectedGeneration: lease.generation }))
  }
  const setViewport = async (width: number, height: number): Promise<void> => {
    setResponsiveViewport(false)
    await withLease((lease) => ({ type: 'viewport', id: props.id, pageIncarnation: lease.pageIncarnation, expectedGeneration: lease.generation, width, height }))
    setViewportOpen(false)
  }
  const security = railSecurity(status?.currentUrl ?? '')
  const statusLines = status ? railStatusLines({ lifecycle: status.lifecycle, loading: status.loading, capacityWaiting: capacityWaiting || !!status.capacityWaiting,
    restoredAfterFreeze: status.restoredAfterFreeze, ...(status.restoreError ? { restoreError: status.restoreError } : {}), focused: status.focused,
    diagnostics: status.diagnostics, sharedWithPi: !!props.sharedWithPi }) : []

  if (props.collapsed || props.temporarilyHidden || autoCollapsed) return <aside className="tab-browser-rail collapsed" aria-label={props.temporarilyHidden ? 'Tab browser hidden while terminal is zoomed' : autoCollapsed ? 'Tab browser collapsed for narrow window' : 'Tab browser collapsed'}>
    {!props.temporarilyHidden && <button className="icon-btn" aria-label="Expand tab browser" onClick={() => props.onCollapsed(false)}>‹</button>}
    <span className="tab-browser-collapsed-label">{props.temporarilyHidden ? 'Terminal zoom' : autoCollapsed ? 'Narrow' : 'Browser'}</span>
  </aside>

  return <aside className={`tab-browser-rail${status?.focused ? ' page-focused' : ''}`} style={{ width: widthMetrics.width, minWidth: widthMetrics.min, maxWidth: widthMetrics.max }} aria-label="Tab browser">
    <div className="tab-browser-chrome" onFocusCapture={() => { if (status?.focused) void command({ type: 'focusChrome', id: props.id }) }}>
      <div className="tab-browser-nav" role="toolbar" aria-label="Browser navigation">
        <button className="icon-btn" aria-label="Back" disabled={!status || status.lifecycle === 'frozen'} onClick={() => void withLease((lease) => ({ type: 'history', id: props.id, direction: 'back', pageIncarnation: lease.pageIncarnation, expectedGeneration: lease.generation }))}>←</button>
        <button className="icon-btn" aria-label="Forward" disabled={!status || status.lifecycle === 'frozen'} onClick={() => void withLease((lease) => ({ type: 'history', id: props.id, direction: 'forward', pageIncarnation: lease.pageIncarnation, expectedGeneration: lease.generation }))}>→</button>
        <button className="icon-btn" aria-label={status?.loading ? 'Stop loading' : status?.lifecycle === 'frozen' ? 'Restore browser' : 'Reload'} disabled={!status} onClick={() => void (status?.loading ? withLease((lease) => railStopCommand(lease)) : reloadOrRestore())}>{status?.loading ? '■' : '↻'}</button>
      </div>
      <span className={`tab-browser-security ${security.level}`} title={security.label} aria-label={security.label}>●</span>
      <input ref={addressInput} aria-label="Browser address" value={address} placeholder="https://…" onChange={(event) => setAddress(event.target.value.slice(0, 8192))} onKeyDown={(event) => { if (event.key === 'Enter') void navigate() }} />
      <button className="btn" onClick={() => void navigate()}>Go</button>
      <button className="icon-btn" aria-label="Collapse tab browser" onClick={() => { void command({ type: 'hide', id: props.id }).then((reply) => { if (reply.ok) props.onCollapsed(true); else setError(reply.error) }) }}>›</button>
      <button className="icon-btn" aria-label="Close tab browser" onClick={props.onClose}>×</button>
    </div>
    <div className="tab-browser-tools">
      <label>Mode <select aria-label="Browser mode" value={status?.mode ?? 'browse'} onChange={(event) => { void command({ type: 'mode', id: props.id, mode: event.target.value }).then((reply) => { if (reply.ok && 'id' in reply.result) acceptStatus(reply.result); else if (!reply.ok) setError(reply.error) }) }}><option value="preview">Preview</option><option value="browse">Browse</option></select></label>
      <button className="btn" aria-haspopup="menu" aria-expanded={viewportOpen} onClick={() => setViewportOpen((value) => !value)}>Viewport</button>
      <select aria-label="Pi browser controller" value={props.designatedPi ?? ''} onChange={(event) => props.onPolicy({ ...(event.target.value ? { designatedPi: event.target.value } : {}), sharedWithPi: false })}>
        <option value="">Private</option>{props.controllers.map((controller) => <option key={controller.name} value={controller.name}>{controller.label}</option>)}
      </select>
      <label className="tab-browser-share" title="Share this global Amber browser profile with the designated Pi">
        <input type="checkbox" checked={!!props.sharedWithPi} disabled={!props.designatedPi} onChange={(event) => {
          if (event.target.checked && !window.confirm('Share this tab browser with the designated Pi? It can access any origin where Amber’s global browser profile is signed in.')) return
          props.onPolicy({ ...(props.designatedPi ? { designatedPi: props.designatedPi } : {}), sharedWithPi: event.target.checked })
        }} /> Share with Pi
      </label>
      {props.sharedWithPi && <button className="btn" onClick={() => void command({ type: 'stopPi' })}>Stop Pi</button>}
      <button className="btn" aria-label="Focus browser page" disabled={!status || status.lifecycle === 'frozen'} onClick={() => void command({ type: 'focusPage', id: props.id })}>Focus page</button>
      <button className="btn" onClick={props.onRecovery}>Recovery</button>
    </div>
    {viewportOpen && <div className="tab-browser-viewport" role="menu" aria-label="Browser viewport">
      {BROWSER_VIEWPORT_PRESETS.filter((preset) => preset.viewport).map((preset) => <button role="menuitem" className="btn" key={preset.id} onClick={() => void setViewport(preset.viewport!.width, preset.viewport!.height)}>{preset.label}</button>)}
      <div className="tab-browser-custom-viewport"><input aria-label="Custom viewport width" inputMode="numeric" value={customWidth} onChange={(event) => setCustomWidth(event.target.value.slice(0, 4))} /><span>×</span><input aria-label="Custom viewport height" inputMode="numeric" value={customHeight} onChange={(event) => setCustomHeight(event.target.value.slice(0, 4))} /><button className="btn" disabled={!validateCustomViewport(customWidth, customHeight)} onClick={() => { const value = validateCustomViewport(customWidth, customHeight); if (value) void setViewport(value.width, value.height) }}>Apply</button></div>
      <button className="btn" aria-pressed={responsiveViewport} onClick={() => {
        const rect = host.current?.getBoundingClientRect(); setResponsiveViewport(true); setViewportOpen(false)
        if (rect && status?.lifecycle === 'live') void command({ type: 'viewport', id: props.id, pageIncarnation: status.pageIncarnation, expectedGeneration: status.generation, ...clampBrowserViewport(rect.width, rect.height) }).then((reply) => { if (reply.ok && 'id' in reply.result) acceptStatus(reply.result) })
      }}>Responsive to rail</button>
    </div>}
    <div className="tab-browser-state" role="status" aria-live="polite">
      <span className={`tab-browser-focus ${status?.focused ? 'active' : ''}`}>{status?.focused ? 'Page focus · Ctrl+Shift+B returns to Amber' : 'Chrome focus'}</span>
      <span>{security.label}</span>{status?.title && <span title={status.title}>{status.title}</span>}
      {capacityWaiting && !status && <span>Waiting for browser capacity</span>}
      {statusLines.map((line) => <span key={line}>{line}</span>)}
      {lastAction && <span>{formatLastPiAction(lastAction)}</span>}
    </div>
    {error && <div className="tab-browser-error" role="alert">{error}</div>}
    {approval && <div className="tab-browser-approval" role="alertdialog" aria-modal="true" aria-label="Pi browser action approval">
      <strong>Pi requests a consequential browser action</strong><div>{approval.category} · {approval.origin}</div><div>Controller: {approval.controller}</div>
      <div>Expires in {secondsRemaining(approval.expiresAt, clock)}s · dispatch not started</div><div>Target (untrusted browser content): {approval.targetLabel || 'page'}</div>
      {approval.argumentSummary && <div>Value: {approval.argumentSummary}</div>}<div className="tab-browser-approval-actions">
        <button className="btn" onClick={() => void command({ type: 'resolveApproval', approvalId: approval.approvalId, digest: approval.digest, decision: 'approve-once' })}>Approve once</button>
        {approval.canGrantOrigin && <button className="btn" onClick={() => void command({ type: 'resolveApproval', approvalId: approval.approvalId, digest: approval.digest, decision: 'allow-origin' })}>Allow this confirmation for origin</button>}
        <button className="btn" onClick={() => void command({ type: 'resolveApproval', approvalId: approval.approvalId, digest: approval.digest, decision: 'reject' })}>Reject</button>
      </div>
    </div>}
    {dialog && <div className="tab-browser-approval tab-browser-dialog" role="alertdialog" aria-modal="true" aria-label="Browser dialog">
      <strong>{dialog.dialogType === 'beforeunload' ? 'Page asks to leave' : `Page ${dialog.dialogType}`}</strong><div>Message (untrusted browser content): {dialog.message}</div>
      <div>Expires in {secondsRemaining(dialog.expiresAt, clock)}s</div>{dialog.dialogType === 'prompt' && <input aria-label="Browser prompt response" value={promptText} maxLength={4096} onChange={(event) => setPromptText(event.target.value)} />}
      <div className="tab-browser-approval-actions"><button className="btn" onClick={() => void command({ type: 'resolveDialog', dialogId: dialog.dialogId, digest: dialog.digest, accept: true, ...(dialog.dialogType === 'prompt' ? { promptText } : {}) })}>{dialog.dialogType === 'beforeunload' ? 'Leave' : 'Accept'}</button>
        <button className="btn" onClick={() => void command({ type: 'resolveDialog', dialogId: dialog.dialogId, digest: dialog.digest, accept: false })}>{dialog.dialogType === 'beforeunload' ? 'Stay' : 'Reject'}</button></div>
    </div>}
    {props.occluded && <div className="tab-browser-occluded" role="status">Browser hidden while another Amber surface is open.</div>}
    <div ref={host} className="tab-browser-page-slot" />
    <div className="tab-browser-grip" role="separator" tabIndex={0} aria-orientation="vertical" aria-label="Resize browser rail" aria-valuemin={widthMetrics.min} aria-valuemax={widthMetrics.max} aria-valuenow={widthMetrics.width} aria-valuetext={`${widthMetrics.width} pixels`}
      onKeyDown={(event) => { const width = keyboardRailWidth(widthMetrics.width, event.key, availableWidth); if (width !== null) { event.preventDefault(); props.onWidth(width) } }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId)
        const startX = event.clientX, startWidth = widthMetrics.width
        const move = (next: PointerEvent): void => props.onWidth(clampRailWidth(startWidth + startX - next.clientX, availableWidth))
        const up = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
      }} />
  </aside>
}
