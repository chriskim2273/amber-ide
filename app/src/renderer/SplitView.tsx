import { useRef, useState, useEffect } from 'react'
import { Pane } from './Pane'
import { paneRects, handles, type Node, type Rect, type Zone } from './layout'
import { appChord } from './keys'

export interface PaneMeta { kind: string; title: string }

// Which zone of a pane the cursor is over: a center band swaps, the outer
// bands re-split. The center band is the middle third on both axes.
function zoneAt(rect: Rect, cx: number, cy: number): Zone {
  const fx = (cx - rect.x) / rect.w
  const fy = (cy - rect.y) / rect.h
  if (fx >= 1 / 3 && fx <= 2 / 3 && fy >= 1 / 3 && fy <= 2 / 3) return 'center'
  const d: Record<Zone, number> = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy, center: Infinity }
  return (Object.keys(d) as Zone[]).reduce((a, b) => (d[b] < d[a] ? b : a))
}

// The sub-rect to highlight for a given drop zone within a pane.
function zoneRect(r: Rect, zone: Zone): Rect {
  switch (zone) {
    case 'left': return { x: r.x, y: r.y, w: r.w / 2, h: r.h }
    case 'right': return { x: r.x + r.w / 2, y: r.y, w: r.w / 2, h: r.h }
    case 'top': return { x: r.x, y: r.y, w: r.w, h: r.h / 2 }
    case 'bottom': return { x: r.x, y: r.y + r.h / 2, w: r.w, h: r.h / 2 }
    case 'center': return r
  }
}

export function SplitView(props: {
  tree: Node
  deadCodes: Record<string, number>
  meta: Record<string, PaneMeta>
  epoch: number
  portEpoch: number
  onSetRatio: (path: Array<'a' | 'b'>, ratio: number) => void
  onSplit: (paneId: string, dir: 'h' | 'v') => void
  onMove: (sourceId: string, targetId: string, zone: Zone) => void
  onClose: (paneId: string) => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<Rect>({ x: 0, y: 0, w: 0, h: 0 })
  const [drag, setDrag] = useState<{ source: string; hover: { targetId: string; zone: Zone } | null } | null>(null)
  // Focused pane lives HERE (not App) so a focus change doesn't churn App's
  // reconcile/persist effects. `focusin` bubbles up from xterm's textarea.
  const [focused, setFocused] = useState<string | null>(null)
  const focusedRef = useRef<string | null>(null)
  focusedRef.current = focused

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ x: 0, y: 0, w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Keyboard: close the focused pane. New-tab / switch-tab chords are owned by
  // App; here we only act on the one that needs the focused-pane identity.
  const onClose = props.onClose
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      const c = appChord(e)
      if (c?.type === 'close' && focusedRef.current) {
        e.preventDefault()
        onClose(focusedRef.current)
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const panes = size.w > 0 ? paneRects(props.tree, size) : []
  const hs = size.w > 0 ? handles(props.tree, size) : []

  const startDrag = (path: Array<'a' | 'b'>, dir: 'h' | 'v') => (e: React.MouseEvent) => {
    e.preventDefault()
    const move = (ev: MouseEvent) => {
      const ratio = dir === 'h' ? (ev.clientX - size.x) / size.w : (ev.clientY - size.y) / size.h
      props.onSetRatio(path, ratio)
    }
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // Whole-pane drag: starts on the grip (never the terminal body — xterm needs
  // its own mouse events). Hit-tests the cursor against paneRects via a window
  // listener (mirrors the divider drag) rather than per-terminal DnD wiring.
  const startPaneDrag = (source: string) => (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const box = ref.current?.getBoundingClientRect()
    if (!box) return
    const rects = paneRects(props.tree, size)
    const hitZone = (ev: MouseEvent): { targetId: string; zone: Zone } | null => {
      const cx = ev.clientX - box.left, cy = ev.clientY - box.top
      const hit = rects.find(({ rect }) => cx >= rect.x && cx < rect.x + rect.w && cy >= rect.y && cy < rect.y + rect.h)
      return hit ? { targetId: hit.paneId, zone: zoneAt(hit.rect, cx, cy) } : null
    }
    setDrag({ source, hover: null })
    const move = (ev: MouseEvent) => setDrag((d) => (d ? { ...d, hover: hitZone(ev) } : d))
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
      const h = hitZone(ev)
      if (h) props.onMove(source, h.targetId, h.zone)
      setDrag(null)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const hoverRect = drag?.hover
    ? (() => {
        const r = panes.find((p) => p.paneId === drag.hover!.targetId)?.rect
        return r ? zoneRect(r, drag.hover!.zone) : null
      })()
    : null

  return (
    <div ref={ref} style={{ position: 'absolute', inset: 0 }}>
      {panes.map(({ paneId, rect }) => {
        const meta = props.meta[paneId]
        const dead = props.deadCodes[paneId]
        const kindClass = meta?.kind === 'claude' ? 'claude' : 'shell'
        return (
          <div key={paneId}
            className={'pane' + (focused === paneId ? ' focused' : '')}
            style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, opacity: drag?.source === paneId ? 0.4 : 1 }}
            onFocusCapture={() => setFocused(paneId)}
            onMouseDownCapture={() => setFocused(paneId)}>
            <div className="pane-header">
              <span className={'kind-dot ' + kindClass} />
              <span className="pane-title">{meta?.title ?? paneId}</span>
              <div className="pane-actions">
                <button className="icon-btn" title="drag to move" onMouseDown={startPaneDrag(paneId)} style={{ cursor: 'grab' }}>⠿</button>
                <button className="icon-btn" title="split right" onClick={() => props.onSplit(paneId, 'h')}>⬌</button>
                <button className="icon-btn" title="split down" onClick={() => props.onSplit(paneId, 'v')}>⬍</button>
                <button className="icon-btn danger" title="close" onClick={() => props.onClose(paneId)}>✕</button>
              </div>
            </div>
            <div className="pane-body">
              <Pane session={paneId} epoch={props.epoch} portEpoch={props.portEpoch} />
              {dead !== undefined &&
                <div className="dead-overlay">
                  <div className={'dead-badge ' + (dead === 0 ? 'ok' : 'err')}>
                    exited · code {dead}
                  </div>
                  <div className="dead-hint">session ended — close to remove</div>
                </div>}
            </div>
          </div>
        )
      })}
      {hs.map((h, i) => (
        <div key={i} onMouseDown={startDrag(h.path, h.dir)}
          className={'split-handle ' + h.dir}
          style={{ left: h.rect.x, top: h.rect.y, width: h.rect.w, height: h.rect.h }} />
      ))}
      {hoverRect &&
        <div style={{ position: 'absolute', left: hoverRect.x, top: hoverRect.y, width: hoverRect.w, height: hoverRect.h,
                      background: 'rgba(80,140,255,.35)', border: '1px solid rgba(120,170,255,.9)', boxSizing: 'border-box',
                      pointerEvents: 'none', zIndex: 6 }} />}
    </div>
  )
}
