import { useRef, useState, useEffect } from 'react'
import { Pane } from './Pane'
import { paneRects, handles, nextPaneInDirection, type Node, type Rect, type Zone, type FocusDir } from './layout'
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
  // Live tree/size for the keydown handler (registered once). Directional focus
  // needs the current geometry without re-binding the listener each render.
  const treeRef = useRef(props.tree)
  treeRef.current = props.tree
  const sizeRef = useRef(size)
  sizeRef.current = size
  // Pane-body elements, keyed by paneId (ref callback below). Directional focus
  // calls .focus() on the target's xterm textarea; the resulting focusin bubbles
  // to onFocusCapture and updates `focused`.
  const bodyEls = useRef<Map<string, HTMLElement>>(new Map())

  const focusPane = (id: string): void => {
    const el = bodyEls.current.get(id)
    el?.querySelector('textarea')?.focus()
  }

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ x: 0, y: 0, w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Keyboard: close the focused pane, and move focus between panes. New-tab /
  // switch-tab / help chords are owned by App; here we act on the ones that
  // need the focused-pane identity and pane geometry.
  const onClose = props.onClose
  useEffect(() => {
    const dirOf: Record<string, FocusDir> = {
      'focus-left': 'left', 'focus-right': 'right', 'focus-up': 'up', 'focus-down': 'down',
    }
    const h = (e: KeyboardEvent): void => {
      const c = appChord(e)
      if (!c) return
      if (c.type === 'close' && focusedRef.current) {
        e.preventDefault()
        onClose(focusedRef.current)
        return
      }
      const dir = dirOf[c.type]
      if (dir && focusedRef.current && sizeRef.current.w > 0) {
        const rects = paneRects(treeRef.current, sizeRef.current)
        const target = nextPaneInDirection(rects, focusedRef.current, dir)
        if (target) {
          e.preventDefault()
          focusPane(target)
        }
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
                <button className="icon-btn" aria-label="move pane" title="drag to move" onMouseDown={startPaneDrag(paneId)} style={{ cursor: 'grab' }}>⠿</button>
                <button className="icon-btn" aria-label="split right" title="split right" onClick={() => props.onSplit(paneId, 'h')}>⬌</button>
                <button className="icon-btn" aria-label="split down" title="split down" onClick={() => props.onSplit(paneId, 'v')}>⬍</button>
                <button className="icon-btn danger" aria-label="close pane" title="close" onClick={() => props.onClose(paneId)}>✕</button>
              </div>
            </div>
            <div className="pane-body" ref={(el) => { if (el) bodyEls.current.set(paneId, el); else bodyEls.current.delete(paneId) }}>
              <Pane session={paneId} epoch={props.epoch} portEpoch={props.portEpoch} />
              {dead !== undefined &&
                <div className="dead-overlay">
                  <div className={'dead-badge ' + (dead === 0 ? 'ok' : 'err')}>
                    exited · code {dead}
                  </div>
                  <button className="dead-close" onClick={() => props.onClose(paneId)}>close pane</button>
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
