import { useEffect, useRef, useState } from 'react'
import type { BrowserViewportMode } from '../shared/browserViewport'
import {
  BROWSER_VIEWPORT_PRESETS,
  MIN_RAIL_WIDTH,
  MIN_TERMINAL_WIDTH,
  clampRailWidth,
  formatLastPiAction,
  keyboardRailWidth,
  railFitViewportCommand,
  railReloadCommand,
  railStopCommand,
  railWidthMetrics,
  reclampedRailWidth,
  railSecurity,
  railStatusLines,
  rotateViewport,
  viewportModeLabel,
  secondsRemaining,
  validateCustomViewport,
} from './browserRailModel'

interface BrowserStatus {
  id: string; safeRestoreUrl: string; currentUrl: string; pageIncarnation: string; generation: number
  lifecycle: 'live' | 'frozen'; loading: boolean; capacityWaiting?: boolean; mode: 'preview' | 'browse'; viewportMode?: BrowserViewportMode
  title: string; restoreError?: string; restoredAfterFreeze: boolean; focused: boolean; visible: boolean
  viewport: { width: number; height: number }; diagnostics: { consoleIssues: number; networkFailures: number }
  lastAction?: { action: string; phase: string; error?: string }
  presentation?: 'remote'
}
type BrowserReply = { ok: true; result: BrowserStatus | { closed: true } } | { ok: false; error: string }

export function browserCommandNeedsContext(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return true
  const type = (value as Record<string, unknown>)['type']
  return type !== 'resolveApproval' && type !== 'resolveDialog'
}

export function shouldRevokeDesignatedPi(designatedPi: string | undefined, controllers: readonly { name: string }[], controllersReady: boolean): boolean {
  return controllersReady && !!designatedPi && !controllers.some((controller) => controller.name === designatedPi)
}

export function hasRemoteBrowserFrame(amber: { browserFrame?: unknown } | undefined): boolean {
  return typeof amber?.browserFrame === 'function'
}

export function mapFramePoint(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, naturalWidth: number, naturalHeight: number): { x: number; y: number } | null {
  if (rect.width < 1 || rect.height < 1 || naturalWidth < 1 || naturalHeight < 1) return null
  const x = Math.round((clientX - rect.left) * (naturalWidth / rect.width))
  const y = Math.round((clientY - rect.top) * (naturalHeight / rect.height))
  if (x < 0 || y < 0 || x > naturalWidth || y > naturalHeight) return null
  return { x, y }
}

export function BrowserRail(props: {
  id: string; width: number; collapsed: boolean; designatedPi?: string; sharedWithPi?: boolean; fullAccess?: boolean
  controllers: { name: string; label: string }[]; controllersReady?: boolean; temporarilyHidden?: boolean; occluded?: boolean
  onWidth: (width: number) => void; onCollapsed: (collapsed: boolean) => void; onClose: () => void; onRecovery: () => void
  onPolicy: (policy: { designatedPi?: string; sharedWithPi: boolean; fullAccess?: boolean }) => void
  ensureContext: () => Promise<void>
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null), addressInput = useRef<HTMLInputElement>(null)
  const [status, setStatus] = useState<BrowserStatus | null>(null)
  const statusRef = useRef<BrowserStatus | null>(null)
  const [address, setAddress] = useState('')
  const [error, setError] = useState('')
  const [approval, setApproval] = useState<null | { approvalId: string; digest: string; controller: string; origin: string; category: string; targetLabel: string; argumentSummary: string; visualPreview?: string; expiresAt: number; canGrantOrigin: boolean }>(null)
  const [dialog, setDialog] = useState<null | { dialogId: string; digest: string; dialogType: string; message: string; expiresAt: number }>(null)
  const [promptText, setPromptText] = useState('')
  const [lastAction, setLastAction] = useState<null | { action: string; phase: string; error?: string }>(null)
  const [clock, setClock] = useState(Date.now())
  const [viewportOpen, setViewportOpen] = useState(false)
  const [customWidth, setCustomWidth] = useState('1280'), [customHeight, setCustomHeight] = useState('800')
  const viewportIntentRef = useRef(0)
  const [autoCollapsed, setAutoCollapsed] = useState(false)
  const [capacityWaiting, setCapacityWaiting] = useState(false)
  const [availableWidth, setAvailableWidth] = useState(1200)
  const [frameUrl, setFrameUrl] = useState('')
  const [frameLease, setFrameLease] = useState<{ screenshotId: string } | null>(null)
  const remote = typeof window !== 'undefined' && hasRemoteBrowserFrame(window.amber as { browserFrame?: unknown } | undefined)

  const command = async (value: unknown): Promise<BrowserReply> => {
    if (browserCommandNeedsContext(value)) await props.ensureContext()
    return window.amber.browserCommand(value) as Promise<BrowserReply>
  }
  const acceptStatus = (next: BrowserStatus): void => {
    const current = statusRef.current
    if (current && current.pageIncarnation === next.pageIncarnation && next.generation < current.generation) return
    statusRef.current = next
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
    if (shouldRevokeDesignatedPi(props.designatedPi, props.controllers, props.controllersReady !== false)) props.onPolicy({ sharedWithPi: false })
  }, [props.designatedPi, props.controllers, props.controllersReady, props.onPolicy])

  useEffect(() => {
    const workarea = host.current?.closest<HTMLElement>('.tab-browser-workarea')
    if (!workarea) return
    const update = (): void => { setAvailableWidth(workarea.clientWidth); setAutoCollapsed(workarea.clientWidth < MIN_RAIL_WIDTH + MIN_TERMINAL_WIDTH) }
    update(); const observer = new ResizeObserver(update); observer.observe(workarea)
    return () => observer.disconnect()
  }, [props.id, props.collapsed])

  const widthMetrics = railWidthMetrics(props.width, availableWidth)
  const activeViewportMode = status?.viewportMode ?? 'fit'
  const canonicalViewport = status?.viewport ?? { width: 1280, height: 800 }
  useEffect(() => { const persisted = reclampedRailWidth(props.width, availableWidth); if (!autoCollapsed && persisted !== null) props.onWidth(persisted) }, [autoCollapsed, availableWidth, props.onWidth, props.width])

  const presentationHidden = props.collapsed || props.temporarilyHidden || props.occluded || viewportOpen || autoCollapsed
  useEffect(() => {
    let stopped = false, frame = 0, settled = 0
    if (presentationHidden) { viewportIntentRef.current += 1; void command({ type: 'hide', id: props.id }); return () => { stopped = true } }
    const element = host.current
    if (!element) return
    const update = async (): Promise<void> => {
      const rect = element.getBoundingClientRect()
      const bounds = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) }
      const intent = viewportIntentRef.current
      const reply = await command({ type: 'show', id: props.id, bounds })
      if (intent !== viewportIntentRef.current || stopped) return
      if (reply.ok && 'id' in reply.result) {
        const current = reply.result
        acceptStatus(current); setError('')
        if ((current.viewportMode ?? 'fit') === 'fit') {
          const fitIntent = ++viewportIntentRef.current
          const fitted = await command(railFitViewportCommand(current))
          if (!stopped && fitIntent === viewportIntentRef.current && fitted.ok && 'id' in fitted.result) acceptStatus(fitted.result)
          else if (!stopped && fitIntent === viewportIntentRef.current && !fitted.ok) setError(fitted.error)
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
  }, [props.id, presentationHidden])

  useEffect(() => {
    if (!remote || presentationHidden) return
    const amber = window.amber as { browserFrame?: (id: string) => Promise<Record<string, unknown>> }
    if (!amber.browserFrame) return
    let stopped = false, timer = 0, currentUrl = ''
    const poll = async (): Promise<void> => {
      const reply = await amber.browserFrame!(props.id)
      if (stopped) return
      const result = reply['result'] as { blob?: Blob; screenshotId?: string; generation?: number; pageIncarnation?: string } | undefined
      if (reply['ok'] === true && result?.blob instanceof Blob) {
        const next = URL.createObjectURL(result.blob)
        if (currentUrl) URL.revokeObjectURL(currentUrl)
        currentUrl = next
        setFrameUrl(next)
        setFrameLease(typeof result.screenshotId === 'string' && result.screenshotId ? { screenshotId: result.screenshotId } : null)
        if (typeof result.generation === 'number' || typeof result.pageIncarnation === 'string') {
          setStatus((current) => current ? {
            ...current,
            ...(typeof result.generation === 'number' ? { generation: result.generation } : {}),
            ...(typeof result.pageIncarnation === 'string' && result.pageIncarnation ? { pageIncarnation: result.pageIncarnation } : {}),
          } : current)
        }
      }
      if (!stopped) timer = window.setTimeout(() => { void poll() }, 50)
    }
    void poll()
    return () => { stopped = true; window.clearTimeout(timer); if (currentUrl) URL.revokeObjectURL(currentUrl) }
  }, [props.id, presentationHidden, remote])

  const withLease = async (request: (lease: BrowserStatus) => unknown): Promise<void> => {
    const currentStatus = statusRef.current ?? status
    if (!currentStatus || currentStatus.lifecycle !== 'live') return
    const intent = viewportIntentRef.current
    const reply = await command(request(currentStatus))
    if (intent !== viewportIntentRef.current) return
    if (reply.ok && 'id' in reply.result) { acceptStatus(reply.result); setError('') } else if (!reply.ok) setError(reply.error)
  }
  const reloadOrRestore = async (): Promise<void> => {
    const currentStatus = statusRef.current ?? status
    if (!currentStatus) return
    const rect = host.current?.getBoundingClientRect()
    const bounds = { x: Math.round(rect?.x ?? 0), y: Math.round(rect?.y ?? 0), width: Math.max(1, Math.round(rect?.width ?? widthMetrics.width)), height: Math.max(1, Math.round(rect?.height ?? 1)) }
    const reply = await command(railReloadCommand(currentStatus, bounds))
    if (reply.ok && 'id' in reply.result) { acceptStatus(reply.result); setError('') } else if (!reply.ok) setError(reply.error)
  }
  const navigate = async (): Promise<void> => {
    if (!address.trim()) return
    await withLease((lease) => ({ type: 'navigate', id: props.id, url: /^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? address : `https://${address}`, pageIncarnation: lease.pageIncarnation, expectedGeneration: lease.generation }))
  }
  const setViewport = async (width: number, height: number): Promise<void> => {
    const intent = ++viewportIntentRef.current
    const currentStatus = statusRef.current ?? status
    if (!currentStatus || currentStatus.lifecycle !== 'live') return
    const reply = await command({ type: 'viewport', id: props.id, pageIncarnation: currentStatus.pageIncarnation, expectedGeneration: currentStatus.generation, width, height })
    if (intent !== viewportIntentRef.current) return
    if (reply.ok && 'id' in reply.result) {
      acceptStatus(reply.result); setError(''); setViewportOpen(false)
    } else if (!reply.ok) setError(reply.error)
  }
  const fitViewport = async (): Promise<void> => {
    const currentStatus = statusRef.current ?? status
    if (!currentStatus || currentStatus.lifecycle !== 'live') return
    const intent = ++viewportIntentRef.current
    const reply = await command(railFitViewportCommand(currentStatus))
    if (intent !== viewportIntentRef.current) return
    if (reply.ok && 'id' in reply.result) {
      acceptStatus(reply.result); setError(''); setViewportOpen(false)
    } else if (!reply.ok) setError(reply.error)
  }
  const security = railSecurity(status?.currentUrl ?? '')
  const statusLines = status ? railStatusLines({ lifecycle: status.lifecycle, loading: status.loading, capacityWaiting: capacityWaiting || !!status.capacityWaiting,
    restoredAfterFreeze: status.restoredAfterFreeze, ...(status.restoreError ? { restoreError: status.restoreError } : {}), focused: status.focused,
    diagnostics: status.diagnostics, sharedWithPi: !!props.sharedWithPi, fullAccess: !!props.fullAccess }) : []

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
    <div className="tab-browser-tools tab-browser-dock-strip">
      <label>Mode <select aria-label="Browser mode" value={status?.mode ?? 'browse'} onChange={(event) => { void command({ type: 'mode', id: props.id, mode: event.target.value }).then((reply) => { if (reply.ok && 'id' in reply.result) acceptStatus(reply.result); else if (!reply.ok) setError(reply.error) }) }}><option value="preview">Preview</option><option value="browse">Browse</option></select></label>
      <label className="tab-browser-viewport-mode">Viewport <select aria-label="Viewport mode" value={activeViewportMode} disabled={!status || status.lifecycle !== 'live'} onChange={(event) => {
        if (event.target.value === 'fit') void fitViewport()
        else void setViewport(canonicalViewport.width, canonicalViewport.height)
      }}><option value="fit">Fit to rail</option><option value="fixed">Fixed viewport</option></select></label>
      <span className="tab-browser-viewport-label" title="Viewport size simulation; not real-device, browser, OS, or IME testing">{viewportModeLabel(activeViewportMode, canonicalViewport)}</span>
      <button className="btn" aria-haspopup="menu" aria-expanded={viewportOpen} onClick={() => setViewportOpen((value) => !value)}>Viewport size</button>
      <select aria-label="Pi browser controller" value={props.designatedPi ?? ''} onChange={(event) => props.onPolicy({ ...(event.target.value ? { designatedPi: event.target.value } : {}), sharedWithPi: false })}>
        <option value="">Private</option>{props.controllers.map((controller) => <option key={`${controller.name}:${controller.label}`} value={controller.name}>{controller.label}</option>)}
      </select>
      <label className="tab-browser-share" title="Share this global Amber browser profile with the designated Pi">
        <input type="checkbox" checked={!!props.sharedWithPi} disabled={!props.designatedPi} onChange={(event) => {
          if (event.target.checked && !window.confirm('Share this tab browser with the designated Pi? It can access any origin where Amber’s global browser profile is signed in.')) return
          props.onPolicy({ ...(props.designatedPi ? { designatedPi: props.designatedPi } : {}), sharedWithPi: event.target.checked })
        }} /> Share with Pi
      </label>
      <label className="tab-browser-share" title="Let the designated Pi act in this browser without approval prompts. Page hardening stays in place.">
        <input type="checkbox" aria-label="Full access" checked={!!props.fullAccess} disabled={!props.sharedWithPi} onChange={(event) => {
          if (event.target.checked && !window.confirm('Allow the designated Pi to act in this browser without approval prompts?')) return
          props.onPolicy({ ...(props.designatedPi ? { designatedPi: props.designatedPi } : {}), sharedWithPi: true, fullAccess: event.target.checked })
        }} /> Full access
      </label>
      {props.sharedWithPi && <button className="btn" onClick={() => void command({ type: 'stopPi' })}>Stop Pi</button>}
      <button className="btn" aria-label="Focus browser page" disabled={!status || status.lifecycle === 'frozen'} onClick={() => void command({ type: 'focusPage', id: props.id })}>Focus page</button>
      <button className="btn" onClick={props.onRecovery}>Recovery</button>
    </div>
    {viewportOpen && <div className="tab-browser-viewport" role="menu" aria-label="Browser viewport">
      <div className="tab-browser-viewport-summary"><strong>{viewportModeLabel(activeViewportMode, canonicalViewport)}</strong><span>Viewport size simulation only — not real-device, browser, OS, or IME testing.</span></div>
      {BROWSER_VIEWPORT_PRESETS.filter((preset) => preset.viewport).map((preset) => <button role="menuitem" className="btn" key={preset.id} onClick={() => void setViewport(preset.viewport!.width, preset.viewport!.height)}>{preset.label}</button>)}
      <div className="tab-browser-custom-viewport"><input aria-label="Custom viewport width" inputMode="numeric" value={customWidth} onChange={(event) => setCustomWidth(event.target.value.slice(0, 4))} /><span>×</span><input aria-label="Custom viewport height" inputMode="numeric" value={customHeight} onChange={(event) => setCustomHeight(event.target.value.slice(0, 4))} /><button className="btn" disabled={!validateCustomViewport(customWidth, customHeight)} onClick={() => { const value = validateCustomViewport(customWidth, customHeight); if (value) void setViewport(value.width, value.height) }}>Apply fixed</button><button className="btn" disabled={!status || activeViewportMode !== 'fixed'} onClick={() => { const rotated = rotateViewport(canonicalViewport); void setViewport(rotated.width, rotated.height) }}>Rotate</button></div>
      <button className="btn" aria-pressed={activeViewportMode === 'fit'} onClick={() => void fitViewport()}>Fit to rail</button>
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
      {approval.visualPreview?.startsWith('data:image/png;base64,') && approval.visualPreview.length <= 512 * 1024 + 32 && <img src={approval.visualPreview} alt="Untrusted browser target preview" style={{ maxWidth: 256, maxHeight: 256, objectFit: 'contain' }} />}
      {approval.argumentSummary && <div>Action details: {approval.argumentSummary}</div>}<div className="tab-browser-approval-actions">
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
    <div ref={host} className="tab-browser-page-slot">
      {remote && <img className="tab-browser-remote-frame" alt="Remote browser page" src={frameUrl || undefined} draggable={false} tabIndex={0}
        onClick={(event) => {
          if (!status || !frameLease) return
          const image = event.currentTarget
          const point = mapFramePoint(event.clientX, event.clientY, image.getBoundingClientRect(), image.naturalWidth, image.naturalHeight)
          if (!point) return
          void command({ type: 'remoteInput', pageIncarnation: status.pageIncarnation, expectedGeneration: status.generation, operation: { kind: 'mouseClick', screenshotId: frameLease.screenshotId, x: point.x, y: point.y, button: 'left', clickCount: 1 } }).then((reply) => { if (!reply.ok) setError(reply.error) })
        }}
        onKeyDown={(event) => {
          if (!status || !frameLease || event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return
          event.preventDefault()
          void command({ type: 'remoteInput', pageIncarnation: status.pageIncarnation, expectedGeneration: status.generation, operation: { kind: 'typeFocused', screenshotId: frameLease.screenshotId, text: event.key } }).then((reply) => { if (!reply.ok) setError(reply.error) })
        }} />}
    </div>
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
