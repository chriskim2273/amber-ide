import { useRef, useState, useEffect } from 'react'
import { Pane, type SearchApi } from './Pane'
import { paneRects, handles, nextPaneInDirection, focusCandidates, ratioAt, leaves, type Node, type Rect, type Zone, type FocusDir } from './layout'
import { appChord, chordLabel } from './keys'
import { paneDot } from './store'

export interface PaneMeta { kind: string; title: string; cwd: string; runState?: string | undefined; rssKb?: number | undefined; growing?: boolean | undefined }

// Compact memory label from resident KiB: "0" hidden by the caller; MB up to
// ~1 GB, then GB with one decimal. Display-only.
export function fmtMem(rssKb: number): string {
  const mb = rssKb / 1024
  return mb < 1024 ? `${Math.round(mb)} MB` : `${(mb / 1024).toFixed(1)} GB`
}

// Per-pane scrollback find bar (chrome). Drives the pane's imperative SearchApi:
// debounced incremental findNext on type, Enter/Shift+Enter step, Escape closes.
// Rendered as an absolute overlay so it never enters the terminal's layout box
// (which would SIGWINCH the pty on open/close).
function FindBar({ api, focusSeq, onClose }: { api: SearchApi; focusSeq: number; onClose: () => void }): JSX.Element {
  const [query, setQuery] = useState('')
  const [res, setRes] = useState<{ index: number; count: number }>({ index: -1, count: 0 })
  const inputRef = useRef<HTMLInputElement>(null)
  // Focus on mount AND whenever the find chord re-fires on this pane (focusSeq
  // bumps) — reopening an already-open bar must put the caret back in the input.
  useEffect(() => { inputRef.current?.focus() }, [focusSeq])
  useEffect(() => {
    api.onResults((r) => setRes({ index: r.resultIndex, count: r.resultCount }))
    return () => {
      api.onResults(() => {}) // detach — a later clear() must not setState here
      // Unmount = this pane stops being the find target (close, chord moved to
      // another pane, pane killed). Always drop its decorations, not only on the
      // explicit ✕/Escape path. try: the pane-kill path disposes the Terminal
      // (and the addon) in the same commit — clearing then must not throw.
      try { api.clear() } catch { /* terminal already disposed */ }
    }
  }, [api])
  // Debounced incremental search on type; empty query clears decorations rather
  // than searching for '' (which the addon treats as a no-op/clear anyway).
  // The pending timer lives in a ref so Enter/Shift+Enter/button navigation can
  // cancel it — otherwise it fires findNext(incremental) ~150 ms AFTER the user
  // already stepped, yanking the active match back.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelDebounce = (): void => {
    if (debounceRef.current !== null) { clearTimeout(debounceRef.current); debounceRef.current = null }
  }
  useEffect(() => {
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null
      if (query) api.findNext(query, { incremental: true })
      else { api.clear(); setRes({ index: -1, count: 0 }) }
    }, 150)
    return cancelDebounce
  }, [query, api])
  // >1000 matches trips the addon threshold and reports resultIndex -1 with a
  // real count — show the count without a bogus 0/N ordinal in that case.
  const ordinal = res.count === 0 ? (query ? 'no matches' : '')
    : res.index < 0 ? `${res.count}` : `${res.index + 1}/${res.count}`
  return (
    <div className="find-bar" onMouseDown={(e) => e.stopPropagation()}>
      <input ref={inputRef} className="find-input" type="text" placeholder="Find" aria-label="find in pane"
        spellCheck={false} value={query} onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation() // keep typing/Enter out of the global app-chord handlers
          if (e.key === 'Escape') { e.preventDefault(); onClose() }
          else if (e.key === 'Enter') {
            e.preventDefault()
            if (query) {
              cancelDebounce()
              if (e.shiftKey) api.findPrevious(query); else api.findNext(query)
            }
          }
        }} />
      <span className="find-count">{ordinal}</span>
      <button className="icon-btn" aria-label="previous match" title="previous (Shift+Enter)"
        onClick={() => { if (query) { cancelDebounce(); api.findPrevious(query) } }}>↑</button>
      <button className="icon-btn" aria-label="next match" title="next (Enter)"
        onClick={() => { if (query) { cancelDebounce(); api.findNext(query) } }}>↓</button>
      <button className="icon-btn" aria-label="close find" title="close (Esc)" onClick={onClose}>✕</button>
    </div>
  )
}

// Inline note prompt shown over a pane when freezing (context-menu path).
// Enter commits (empty note allowed), Escape cancels. Blur = CANCEL (not commit)
// so an accidental click-away never silently parks the pane — an accidental
// freeze is a worse surprise than a dropped note. stopPropagation keeps typing
// away from the global chords.
function FreezeNoteInput({ onCommit, onCancel }:
  { onCommit: (note: string) => void; onCancel: () => void }): JSX.Element {
  const committed = useRef(false)
  return (
    <div className="freeze-note" onMouseDown={(e) => e.stopPropagation()}>
      <span className="freeze-note-label">❄ freeze — add a note</span>
      <input className="freeze-note-input" autoFocus aria-label="freeze note"
        placeholder="note (optional), Enter to freeze" spellCheck={false}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') { committed.current = true; e.currentTarget.blur() }
          else if (e.key === 'Escape') { e.preventDefault(); e.currentTarget.blur() }
        }}
        onBlur={(e) => { if (committed.current) onCommit(e.currentTarget.value); else onCancel() }} />
    </div>
  )
}

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
  // Whether this view's tab is the visible one. Background tabs stay MOUNTED
  // (keep-alive — no terminal teardown/backlog-replay on switch) but hidden via
  // display:none by the parent. When false, this view ignores window keyboard
  // chords (its focusedRef is stale) so a chord only ever acts on the visible tab.
  active: boolean
  epoch: number
  portEpoch: number
  fontSize: number
  onPaneTitle: (session: string, title: string) => void
  onSetRatio: (path: Array<'a' | 'b'>, ratio: number) => void
  onSplit: (paneId: string, dir: 'h' | 'v', kind?: 'shell' | 'claude') => void
  onMove: (sourceId: string, targetId: string, zone: Zone) => void
  onClose: (paneId: string) => void
  // Zoom is transient per-tab renderer state owned by App (never persisted); this
  // view is presentational — it renders the zoomed pane full-stage and toggles.
  zoomedPane: string | null
  onToggleZoom: (paneId: string) => void
  // Parked panes (display-only), keyed by session name → optional note. App-owned
  // sidecar state; freezing never touches the daemon.
  frozen: Record<string, { note?: string }>
  onFreeze: (paneId: string, note: string) => void
  onUnfreeze: (paneId: string) => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<Rect>({ x: 0, y: 0, w: 0, h: 0 })
  const [drag, setDrag] = useState<{ source: string; hover: { targetId: string; zone: Zone } | null } | null>(null)
  // Focused pane lives HERE (not App) so a focus change doesn't churn App's
  // reconcile/persist effects. `focusin` bubbles up from xterm's textarea.
  const [focused, setFocused] = useState<string | null>(null)
  const focusedRef = useRef<string | null>(null)
  focusedRef.current = focused
  // Live `active` for the once-registered window keydown handler (read via ref so
  // toggling active never rebinds the listener). Bumped `activateSeq` is handed to
  // every Pane so it can repaint when the tab becomes visible again (keep-alive).
  const activeRef = useRef(props.active)
  activeRef.current = props.active
  const [activateSeq, setActivateSeq] = useState(0)
  // Which pane (if any) has its find bar open. The find chord opens it on the
  // FOCUSED pane; only that pane renders the bar. `findSeq` bumps on every chord
  // fire so re-invoking find on an already-open bar refocuses its input.
  const [findPane, setFindPane] = useState<string | null>(null)
  const [findSeq, setFindSeq] = useState(0)
  // Custom header context menu, if open: which pane and where (stage-relative,
  // clamped on render). Bound to the pane HEADER only — xterm owns body events.
  const [menu, setMenu] = useState<{ paneId: string; x: number; y: number } | null>(null)
  // Which pane (if any) has the inline freeze-note prompt open (context-menu
  // "Freeze pane…" path). Only that pane renders the input.
  const [notePane, setNotePane] = useState<string | null>(null)
  // Live frozen set for the keydown handler + focus guards (registered once —
  // read via ref so freeze/unfreeze doesn't rebind the window listener).
  const frozenSet = new Set(Object.keys(props.frozen))
  const frozenRef = useRef(frozenSet)
  frozenRef.current = frozenSet
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

  // Never programmatically focus a frozen pane's terminal — it's input-locked
  // (belt-and-suspenders alongside the overlay swallowing pointer events).
  const focusPane = (id: string): void => {
    if (frozenRef.current.has(id)) return
    const el = bodyEls.current.get(id)
    el?.querySelector('textarea')?.focus()
  }

  // Keep-alive activation: when this tab goes hidden -> visible (parent flips
  // `active`), nothing remounts, so no Pane calls term.focus() and the outgoing
  // tab's blur left focus on <body>. Re-focus the previously-focused (or first)
  // pane so typing lands immediately, and bump activateSeq so every Pane repaints
  // its possibly-stale backgrounded frame. Rising edge only (a prevActive ref).
  const prevActiveRef = useRef(props.active)
  useEffect(() => {
    const rising = props.active && !prevActiveRef.current
    prevActiveRef.current = props.active
    if (!rising) return
    setActivateSeq((s) => s + 1)
    const target = focusedRef.current ?? leaves(props.tree)[0] ?? null
    if (target) focusPane(target)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.active])

  // Freeze a pane. The overlay + focusPane guard only block FUTURE focus; if this
  // pane's xterm textarea already holds DOM focus, keystrokes keep flowing into
  // its pty. So blur the live focus now (both freeze entry points route here).
  const freeze = (id: string, note: string): void => {
    const el = bodyEls.current.get(id)
    const active = document.activeElement
    if (el && active instanceof HTMLElement && el.contains(active)) active.blur()
    onFreeze(id, note)
  }

  // Per-pane title callbacks, cached by paneId so each `Pane` gets a REFERENTIALLY
  // STABLE `onTitle` — otherwise a fresh closure every render would defeat Pane's
  // memo (every drag mousemove would reconcile all terminals).
  //
  // CONTRACT: `props.onPaneTitle` must itself be PERMANENTLY referentially stable
  // (App creates it with useCallback([], …)). Each wrapper captures the value at
  // cache time and is never refreshed, so a changing onPaneTitle would silently
  // keep dispatching to the stale closure.
  const titleCbs = useRef<Map<string, (t: string) => void>>(new Map())
  const onPaneTitle = props.onPaneTitle
  const titleCbFor = (paneId: string): ((t: string) => void) => {
    let cb = titleCbs.current.get(paneId)
    if (!cb) { cb = (t) => onPaneTitle(paneId, t); titleCbs.current.set(paneId, cb) }
    return cb
  }
  // Same stability contract for the pane's search handle: each `Pane` gets a
  // REFERENTIALLY STABLE `onSearchReady` (per-paneId cached wrapper) that stashes
  // the delivered SearchApi in `searchApis` for the find bar to drive. A fresh
  // closure every render would defeat Pane's memo.
  const searchApis = useRef<Map<string, SearchApi>>(new Map())
  const searchReadyCbs = useRef<Map<string, (api: SearchApi) => void>>(new Map())
  const searchReadyFor = (paneId: string): ((api: SearchApi) => void) => {
    let cb = searchReadyCbs.current.get(paneId)
    if (!cb) { cb = (api) => { searchApis.current.set(paneId, api) }; searchReadyCbs.current.set(paneId, cb) }
    return cb
  }
  // Sweep cached callbacks/apis for panes no longer in the tree — the caches are
  // keyed by session name, which never repeats, so without this they grow
  // unboundedly in a long-lived renderer. Also close the find bar if its pane
  // vanished (daemon kill/reap).
  useEffect(() => {
    const live = new Set(leaves(props.tree))
    for (const id of [...titleCbs.current.keys()]) {
      if (!live.has(id)) titleCbs.current.delete(id)
    }
    // Union of both maps' keys: a cb can be cached before its api is delivered
    // (Pane not yet mounted), so sweeping only searchApis would strand cb entries.
    for (const id of new Set([...searchApis.current.keys(), ...searchReadyCbs.current.keys()])) {
      if (!live.has(id)) { searchApis.current.delete(id); searchReadyCbs.current.delete(id) }
    }
    setFindPane((p) => (p && !live.has(p) ? null : p))
    setMenu((m) => (m && !live.has(m.paneId) ? null : m))
    setNotePane((p) => (p && !live.has(p) ? null : p))
  }, [props.tree])

  // Dismiss the context menu on Escape or any outside click. The menu itself
  // stops mousedown propagation, so clicks inside it don't reach this listener.
  useEffect(() => {
    if (!menu) return
    const onDown = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setMenu(null) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [menu])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Keep-alive: a backgrounded tab is display:none, so its stage measures 0×0.
    // If we accepted that, `panes` (below, gated on size.w>0) would collapse to []
    // and every Pane would UNMOUNT — defeating keep-alive and disposing the
    // terminals. So only accept non-zero sizes; a hidden view retains its last
    // real geometry (its Panes stay mounted, positioned, hidden by the parent),
    // and re-measures on show. Also dodges transient 0-size flicker mid-layout.
    const ro = new ResizeObserver(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) setSize({ x: 0, y: 0, w: el.clientWidth, h: el.clientHeight })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Keyboard: close the focused pane, and move focus between panes. New-tab /
  // switch-tab / help chords are owned by App; here we act on the ones that
  // need the focused-pane identity and pane geometry.
  const onClose = props.onClose
  const onToggleZoom = props.onToggleZoom
  const onFreeze = props.onFreeze
  const onUnfreeze = props.onUnfreeze
  useEffect(() => {
    const dirOf: Record<string, FocusDir> = {
      'focus-left': 'left', 'focus-right': 'right', 'focus-up': 'up', 'focus-down': 'down',
    }
    const h = (e: KeyboardEvent): void => {
      // Keep-alive: background (hidden) tabs stay mounted and each registers this
      // window listener. Only the visible tab may act on a chord — otherwise a
      // close/zoom would fire against a hidden tab's stale focusedRef too.
      if (!activeRef.current) return
      const c = appChord(e)
      if (!c) return
      // Type the skip-permissions flag into the focused pane's pty (no Enter).
      if (c.type === 'insert-skip-perms' && focusedRef.current && !frozenRef.current.has(focusedRef.current)) {
        const api = searchApis.current.get(focusedRef.current)
        if (api) { e.preventDefault(); api.insert(' --dangerously-skip-permissions') }
        return
      }
      // Copy the focused pane's terminal selection to the clipboard. Only acts
      // when there IS a selection, so with none the chord is inert (on Linux it
      // never reaches here as ^C — Ctrl is required WITH Shift, which xterm
      // doesn't treat as SIGINT).
      if (c.type === 'copy' && focusedRef.current) {
        const sel = searchApis.current.get(focusedRef.current)?.copySelection()
        if (sel) { e.preventDefault(); window.amber.clipboardWrite(sel) }
        return
      }
      // Paste clipboard text into the focused pane (bracketed-paste-aware). Read
      // via the main-process clipboard bridge (reliable; no permission prompt).
      if (c.type === 'paste' && focusedRef.current && !frozenRef.current.has(focusedRef.current)) {
        const api = searchApis.current.get(focusedRef.current)
        if (api) {
          e.preventDefault()
          void window.amber.clipboardRead().then((t) => { if (t) api.paste(t) }).catch(() => {})
        }
        return
      }
      if (c.type === 'close' && focusedRef.current) {
        e.preventDefault()
        onClose(focusedRef.current)
        return
      }
      // Zoom toggles the FOCUSED pane (identity lives here, not App). App owns the
      // per-tab zoom state; this only requests the toggle.
      if (c.type === 'zoom' && focusedRef.current) {
        e.preventDefault()
        onToggleZoom(focusedRef.current)
        return
      }
      // Freeze toggles the FOCUSED pane. Toggle-on uses an empty note (the
      // context-menu path is the way to attach one). Display-only — no daemon call.
      if (c.type === 'freeze' && focusedRef.current) {
        e.preventDefault()
        const id = focusedRef.current
        if (frozenRef.current.has(id)) onUnfreeze(id); else freeze(id, '')
        return
      }
      // Find targets the focused pane (its SearchApi must be ready — it is, once
      // the pane has mounted). Switching the target unmounts the previous pane's
      // FindBar, whose teardown clears that pane's decorations; re-firing on the
      // already-open pane bumps findSeq, which refocuses the bar's input.
      if (c.type === 'find' && focusedRef.current && !frozenRef.current.has(focusedRef.current) && searchApis.current.has(focusedRef.current)) {
        e.preventDefault()
        setFindPane(focusedRef.current)
        setFindSeq((s) => s + 1)
        return
      }
      const dir = dirOf[c.type]
      if (dir && focusedRef.current && sizeRef.current.w > 0) {
        // Frozen panes are parked — skip them as focus targets (keeps the source).
        const rects = focusCandidates(paneRects(treeRef.current, sizeRef.current), frozenRef.current, focusedRef.current)
        const target = nextPaneInDirection(rects, focusedRef.current, dir)
        if (target) {
          e.preventDefault()
          focusPane(target)
        }
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose, onToggleZoom, onFreeze, onUnfreeze])

  const panes = size.w > 0 ? paneRects(props.tree, size) : []
  const hs = size.w > 0 ? handles(props.tree, size) : []
  // Zoom is a DISPLAY override only — the layout tree is untouched. Guard against
  // a stale zoomed id (pane already gone): only zoom if it's a real pane here.
  const zoomActive = props.zoomedPane != null && panes.some((p) => p.paneId === props.zoomedPane)

  const startDrag = (path: Array<'a' | 'b'>, dir: 'h' | 'v') => (e: React.MouseEvent) => {
    e.preventDefault()
    // Capture the pre-drag ratio so Escape can restore it (divider drag applies
    // live via onSetRatio, so aborting means putting the stored ratio back).
    const startRatio = ratioAt(props.tree, path)
    const move = (ev: MouseEvent) => {
      const ratio = dir === 'h' ? (ev.clientX - size.x) / size.w : (ev.clientY - size.y) / size.h
      props.onSetRatio(path, ratio)
    }
    const cleanup = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      window.removeEventListener('keydown', onKey)
    }
    const up = () => cleanup()
    // Escape aborts: removing `up` before the (still-held) mouse releases stops a
    // later mouseup from committing; then restore the ratio captured at start.
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      cleanup()
      if (startRatio !== null) props.onSetRatio(path, startRatio)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    window.addEventListener('keydown', onKey)
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
    // Move threshold: don't enter drag state (setDrag + dimming) until the cursor
    // travels ≥4 px from mousedown, so a plain click on the grip does nothing.
    const sx = e.clientX, sy = e.clientY
    let started = false
    const cleanup = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      window.removeEventListener('keydown', onKey)
    }
    const move = (ev: MouseEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return
        started = true
      }
      setDrag({ source, hover: hitZone(ev) })
    }
    const up = (ev: MouseEvent) => {
      cleanup()
      if (started) {
        const h = hitZone(ev)
        if (h) props.onMove(source, h.targetId, h.zone)
      }
      setDrag(null)
    }
    // Escape aborts an in-flight drag: drop the listeners (so the still-held
    // mouse's release can't commit a move) and clear the drag state.
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      cleanup()
      setDrag(null)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    window.addEventListener('keydown', onKey)
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
        const dot = paneDot(meta?.kind ?? 'shell', meta?.runState)
        const frozenEntry = props.frozen[paneId]
        const isFrozen = frozenEntry !== undefined
        const isZoomedPane = zoomActive && props.zoomedPane === paneId
        // Zoomed pane fills the stage; the others stay MOUNTED but hidden via
        // display:none (Pane's ResizeObserver early-returns at 0×0, so this fires
        // NO spurious pty resize — verified in Pane.sendResize).
        const box = isZoomedPane ? size : rect
        const hidden = zoomActive && !isZoomedPane
        return (
          <div key={paneId}
            className={'pane' + (focused === paneId ? ' focused' : '')}
            style={{ left: box.x, top: box.y, width: box.w, height: box.h,
              opacity: drag?.source === paneId ? 0.4 : 1,
              display: hidden ? 'none' : undefined, zIndex: isZoomedPane ? 2 : undefined }}
            onFocusCapture={() => setFocused(paneId)}
            onMouseDownCapture={() => setFocused(paneId)}>
            <div className="pane-header"
              onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest('button')) props.onToggleZoom(paneId) }}
              onContextMenu={(e) => {
                e.preventDefault()
                const b = ref.current?.getBoundingClientRect()
                if (!b) return
                setFocused(paneId)
                setMenu({ paneId, x: e.clientX - b.left, y: e.clientY - b.top })
              }}>
              <span className={'kind-dot ' + dot.cls} role="img" aria-label={dot.label} title={dot.label} />
              <span className="pane-title">{meta?.title ?? paneId}</span>
              {meta?.rssKb !== undefined && meta.rssKb > 0 &&
                <span className={'mem-tag' + (meta.growing ? ' growing' : '')}
                  title={meta.growing ? 'memory climbing (possible leak)' : 'child process memory'}>
                  {meta.growing ? '▲ ' : ''}{fmtMem(meta.rssKb)}
                </span>}
              {isFrozen && <span className="frozen-badge" title="pane frozen">❄ frozen</span>}
              {isZoomedPane &&
                <span className="zoom-badge">zoomed — {chordLabel('zoom')} to restore</span>}
              <div className="pane-actions">
                <button className="icon-btn" aria-label="move pane" title="drag to move" onMouseDown={startPaneDrag(paneId)} style={{ cursor: 'grab' }}>⠿</button>
                <button className="icon-btn" aria-label="refresh pane" title="force refresh (re-fit + repaint)"
                  onClick={() => searchApis.current.get(paneId)?.refresh()}>⟳</button>
                <button className="icon-btn" aria-label="split right" title="split right" onClick={() => props.onSplit(paneId, 'h')}>⬌</button>
                <button className="icon-btn" aria-label="split down" title="split down" onClick={() => props.onSplit(paneId, 'v')}>⬍</button>
                <button className="icon-btn danger" aria-label="close pane" title="close" onClick={() => props.onClose(paneId)}>✕</button>
              </div>
            </div>
            <div className="pane-body" ref={(el) => { if (el) bodyEls.current.set(paneId, el); else bodyEls.current.delete(paneId) }}>
              <Pane session={paneId} epoch={props.epoch} portEpoch={props.portEpoch} activateSeq={activateSeq}
                fontSize={props.fontSize} cwd={meta?.cwd ?? ''} onTitle={titleCbFor(paneId)} onSearchReady={searchReadyFor(paneId)} />
              {findPane === paneId && !isFrozen && searchApis.current.get(paneId) &&
                <FindBar api={searchApis.current.get(paneId)!} focusSeq={findSeq}
                  onClose={() => { setFindPane(null); focusPane(paneId) }} />}
              {dead !== undefined &&
                <div className="dead-overlay">
                  <div className={'dead-badge ' + (dead === 0 ? 'ok' : 'err')}>
                    exited · code {dead}
                  </div>
                  <button className="dead-close" onClick={() => props.onClose(paneId)}>close pane</button>
                </div>}
              {/* Inline freeze-note prompt (context-menu path). Above the terminal;
                  commits/cancels back into App's sidecar state. */}
              {notePane === paneId && !isFrozen &&
                <FreezeNoteInput
                  onCommit={(note) => { freeze(paneId, note); setNotePane(null) }}
                  onCancel={() => setNotePane(null)} />}
              {/* Frozen (parked) overlay — reuses the dead-overlay visual language.
                  Intercepts ALL pointer events, so the terminal underneath is
                  unclickable (it stays MOUNTED and streaming). Suppressed when the
                  session has EXITED: death takes precedence (same z-index would
                  otherwise hide the exit code + close button under the note). The
                  header frozen badge still marks the pane as parked. */}
              {isFrozen && dead === undefined &&
                <div className="frozen-overlay">
                  <div className="frozen-badge-lg" role="img" aria-label="frozen pane">❄</div>
                  <div className="frozen-note-text">{frozenEntry.note?.trim() || 'frozen'}</div>
                  <button className="frozen-unfreeze" aria-label="unfreeze pane"
                    onClick={() => props.onUnfreeze(paneId)}>⏵ unfreeze</button>
                </div>}
            </div>
          </div>
        )
      })}
      {/* No dividers or drop targets while a pane is zoomed — the others are hidden. */}
      {!zoomActive && hs.map((h, i) => (
        <div key={i} onMouseDown={startDrag(h.path, h.dir)}
          className={'split-handle ' + h.dir}
          style={{ left: h.rect.x, top: h.rect.y, width: h.rect.w, height: h.rect.h }} />
      ))}
      {!zoomActive && hoverRect &&
        <div className="drop-zone"
          style={{ left: hoverRect.x, top: hoverRect.y, width: hoverRect.w, height: hoverRect.h }} />}
      {menu && (() => {
        // Clamp the menu box (approx dims) inside the stage so it never spills off.
        const MW = 200, MH = 268
        const x = Math.max(0, Math.min(menu.x, size.w - MW))
        const y = Math.max(0, Math.min(menu.y, size.h - MH))
        const paneId = menu.paneId
        const close = (): void => setMenu(null)
        const run = (fn: () => void) => (): void => { fn(); close() }
        const isZoomed = props.zoomedPane === paneId
        const isFrozen = props.frozen[paneId] !== undefined
        return (
          <div className="ctx-menu" role="menu" style={{ left: x, top: y }}
            onMouseDown={(e) => e.stopPropagation()}>
            <button className="ctx-item" role="menuitem" onClick={run(() => props.onSplit(paneId, 'h'))}>Split right</button>
            <button className="ctx-item" role="menuitem" onClick={run(() => props.onSplit(paneId, 'v'))}>Split down</button>
            <button className="ctx-item" role="menuitem" onClick={run(() => props.onSplit(paneId, 'h', 'claude'))}>New claude pane right</button>
            <div className="ctx-sep" />
            <button className="ctx-item" role="menuitem" onClick={run(() => props.onToggleZoom(paneId))}>{isZoomed ? 'Restore' : 'Zoom'}</button>
            {isFrozen
              ? <button className="ctx-item" role="menuitem" onClick={run(() => props.onUnfreeze(paneId))}>Unfreeze</button>
              : <button className="ctx-item" role="menuitem" onClick={run(() => setNotePane(paneId))}>Freeze pane…</button>}
            <button className="ctx-item" role="menuitem"
              onClick={run(() => {
                // Swallow a rejection (clipboard perms) — no unhandled promise rejection.
                navigator.clipboard?.writeText(props.meta[paneId]?.cwd ?? '').catch(() => {})
              })}>Copy cwd</button>
            <div className="ctx-sep" />
            <button className="ctx-item danger" role="menuitem" onClick={run(() => props.onClose(paneId))}>Close</button>
          </div>
        )
      })()}
    </div>
  )
}
