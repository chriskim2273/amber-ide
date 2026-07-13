import { useEffect, useRef, useState } from 'react'
import { Pane } from './Pane'
import { paneRects, handles, type Node, type Rect } from './layout'

export function SplitView(props: {
  tree: Node
  deadCodes: Record<string, number>
  onSetRatio: (path: Array<'a' | 'b'>, ratio: number) => void
  onSplit: (paneId: string, dir: 'h' | 'v') => void
  onClose: (paneId: string) => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<Rect>({ x: 0, y: 0, w: 0, h: 0 })
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

  return (
    <div ref={ref} style={{ position: 'absolute', inset: 0 }}>
      {panes.map(({ paneId, rect }) => (
        <div key={paneId} style={{ position: 'absolute', left: rect.x, top: rect.y, width: rect.w, height: rect.h, overflow: 'hidden' }}>
          <div style={{ position: 'absolute', top: 2, right: 2, zIndex: 3, display: 'flex', gap: 2 }}>
            <button title="split right" onClick={() => props.onSplit(paneId, 'h')}>⬌</button>
            <button title="split down" onClick={() => props.onSplit(paneId, 'v')}>⬍</button>
            <button title="close" onClick={() => props.onClose(paneId)}>×</button>
          </div>
          {props.deadCodes[paneId] !== undefined &&
            <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.6)', color: '#fff', zIndex: 2, padding: 8 }}>exited {props.deadCodes[paneId]}</div>}
          <Pane session={paneId} />
        </div>
      ))}
      {hs.map((h, i) => (
        <div key={i} onMouseDown={startDrag(h.path, h.dir)}
          style={{ position: 'absolute', left: h.rect.x, top: h.rect.y, width: h.rect.w, height: h.rect.h,
                   cursor: h.dir === 'h' ? 'col-resize' : 'row-resize', zIndex: 4, background: '#444' }} />
      ))}
    </div>
  )
}
