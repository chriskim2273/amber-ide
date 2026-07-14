import { useRef, useState, useEffect } from 'react'
import { Pane } from './Pane'
import { paneRects, handles, type Node, type Rect, type Zone } from './layout'

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
  epoch: number
  onSetRatio: (path: Array<'a' | 'b'>, ratio: number) => void
  onSplit: (paneId: string, dir: 'h' | 'v') => void
  onMove: (sourceId: string, targetId: string, zone: Zone) => void
  onClose: (paneId: string) => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<Rect>({ x: 0, y: 0, w: 0, h: 0 })
  const [drag, setDrag] = useState<{ source: string; hover: { targetId: string; zone: Zone } | null } | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ x: 0, y: 0, w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

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
    <div ref={ref} style={{ position: 'absolute', inset: 0, background: '#000' }}>
      {panes.map(({ paneId, rect }) => (
        <div key={paneId} style={{ position: 'absolute', left: rect.x, top: rect.y, width: rect.w, height: rect.h, overflow: 'hidden', background: '#000', opacity: drag?.source === paneId ? 0.4 : 1 }}>
          <div style={{ position: 'absolute', top: 2, right: 2, zIndex: 3, display: 'flex', gap: 2 }}>
            <button title="drag to move" onMouseDown={startPaneDrag(paneId)} style={{ cursor: 'grab' }}>⠿</button>
            <button title="split right" onClick={() => props.onSplit(paneId, 'h')}>⬌</button>
            <button title="split down" onClick={() => props.onSplit(paneId, 'v')}>⬍</button>
            <button title="close" onClick={() => props.onClose(paneId)}>×</button>
          </div>
          {props.deadCodes[paneId] !== undefined &&
            <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.6)', color: '#fff', zIndex: 2, padding: 8 }}>exited {props.deadCodes[paneId]}</div>}
          <Pane session={paneId} epoch={props.epoch} />
        </div>
      ))}
      {hs.map((h, i) => (
        <div key={i} onMouseDown={startDrag(h.path, h.dir)}
          style={{ position: 'absolute', left: h.rect.x, top: h.rect.y, width: h.rect.w, height: h.rect.h,
                   cursor: h.dir === 'h' ? 'col-resize' : 'row-resize', zIndex: 4, background: '#444' }} />
      ))}
      {hoverRect &&
        <div style={{ position: 'absolute', left: hoverRect.x, top: hoverRect.y, width: hoverRect.w, height: hoverRect.h,
                      background: 'rgba(80,140,255,.35)', border: '1px solid rgba(120,170,255,.9)', boxSizing: 'border-box',
                      pointerEvents: 'none', zIndex: 6 }} />}
    </div>
  )
}
