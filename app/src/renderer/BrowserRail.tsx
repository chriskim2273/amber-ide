import { useEffect, useRef, useState } from 'react'

interface BrowserStatus {
  id: string; safeRestoreUrl: string; pageIncarnation: string; generation: number
  lifecycle: 'live' | 'frozen'; loading: boolean; capacityWaiting?: boolean
}
type BrowserReply = { ok: true; result: BrowserStatus | { closed: true } } | { ok: false; error: string }

export function BrowserRail(props: {
  id: string; width: number; collapsed: boolean; designatedPi?: string; sharedWithPi?: boolean
  controllers: { name: string; label: string }[]
  onWidth: (width: number) => void; onCollapsed: (collapsed: boolean) => void; onClose: () => void
  onPolicy: (policy: { designatedPi?: string; sharedWithPi: boolean }) => void
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<BrowserStatus | null>(null)
  const [address, setAddress] = useState('')
  const [error, setError] = useState('')

  const command = async (value: unknown): Promise<BrowserReply> => window.amber.browserCommand(value) as Promise<BrowserReply>

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
        setStatus(reply.result); if (!address) setAddress(reply.result.safeRestoreUrl === 'about:blank' ? '' : reply.result.safeRestoreUrl)
      }
      if (!stopped && !reply.ok) setError(reply.error)
    }
    void update()
    const observer = new ResizeObserver(() => { void update() })
    observer.observe(element)
    window.addEventListener('resize', update)
    const poll = window.setInterval(() => {
      void command({ type: 'status', id: props.id }).then((reply) => {
        if (!stopped && reply.ok && 'id' in reply.result) setStatus(reply.result)
      })
    }, 500)
    return () => { stopped = true; window.clearInterval(poll); observer.disconnect(); window.removeEventListener('resize', update); void command({ type: 'hide', id: props.id }) }
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
      <button className="icon-btn" aria-label="Collapse tab browser" onClick={() => props.onCollapsed(true)}>›</button>
      <button className="icon-btn" aria-label="Close tab browser" onClick={props.onClose}>×</button>
    </div>
    {status?.capacityWaiting && <div className="tab-browser-status" role="status">Waiting for browser capacity…</div>}
    {error && <div className="tab-browser-error" role="alert">{error}</div>}
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
