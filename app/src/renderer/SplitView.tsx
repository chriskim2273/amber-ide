import { useEffect, useRef, useState } from 'react'
import { Pane } from './Pane'
import { paneRects, handles, type Node, type Rect } from './layout'
import { appChord } from './keys'

export interface PaneMeta { kind: string; title: string }

export function SplitView(props: {
  tree: Node
  deadCodes: Record<string, number>
  meta: Record<string, PaneMeta>
  epoch: number
  onSetRatio: (path: Array<'a' | 'b'>, ratio: number) => void
  onSplit: (paneId: string, dir: 'h' | 'v') => void
  onClose: (paneId: string) => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<Rect>({ x: 0, y: 0, w: 0, h: 0 })
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

  return (
    <div ref={ref} style={{ position: 'absolute', inset: 0 }}>
      {panes.map(({ paneId, rect }) => {
        const meta = props.meta[paneId]
        const dead = props.deadCodes[paneId]
        const kindClass = meta?.kind === 'claude' ? 'claude' : 'shell'
        return (
          <div key={paneId}
            className={'pane' + (focused === paneId ? ' focused' : '')}
            style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
            onFocusCapture={() => setFocused(paneId)}
            onMouseDownCapture={() => setFocused(paneId)}>
            <div className="pane-header">
              <span className={'kind-dot ' + kindClass} />
              <span className="pane-title">{meta?.title ?? paneId}</span>
              <div className="pane-actions">
                <button className="icon-btn" title="split right" onClick={() => props.onSplit(paneId, 'h')}>⬌</button>
                <button className="icon-btn" title="split down" onClick={() => props.onSplit(paneId, 'v')}>⬍</button>
                <button className="icon-btn danger" title="close" onClick={() => props.onClose(paneId)}>✕</button>
              </div>
            </div>
            <div className="pane-body">
              <Pane session={paneId} epoch={props.epoch} />
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
    </div>
  )
}
