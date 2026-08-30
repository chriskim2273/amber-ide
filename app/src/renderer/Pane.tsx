import { memo, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { altScrollKeys, takeWholeLines, AXIS_LOCK_PX, FLICK_DECAY, FLICK_MIN_LINES } from './touchInput'
import { keyboardInset, keyboardOpen, terminalLift } from './keyboardViewport'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { appChord } from './keys'
import { takeReplay } from './replay'
import { decodeOsc52Payload } from './osc'
import { KeyboardInputModeTracker, shiftEnterSequence } from './terminalKeys'

// Imperative scrollback-search handle handed to the chrome (the find bar in
// SplitView) via `onSearchReady`. Search execution stays outside React — the
// bar only calls these; the addon owns match state + decorations.
export interface SearchApi {
  // `incremental` (findNext only) expands the current match while typing so the
  // view doesn't jump to the NEXT match on every keystroke; Enter/buttons omit it.
  findNext(q: string, opts?: { incremental?: boolean }): boolean
  findPrevious(q: string): boolean
  clear(): void
  onResults(cb: (r: { resultIndex: number; resultCount: number }) => void): void
  // Type raw text into the pane's pty (as if the user typed it). Used by the
  // skip-permissions chord in SplitView. No-op until the port is wired.
  insert(text: string): void
  // The current terminal selection (empty string if nothing selected) — for the
  // copy chord.
  copySelection(): string
  // Selected text, or a small semantic anchor around the live cursor.
  captureBookmark(): string
  // Paste text into the pty via xterm, which wraps it in bracketed-paste markers
  // when the running program requested that mode (so multiline paste doesn't
  // submit line-by-line in claude/vim). Routes through onData → the port.
  paste(text: string): void
}

/**
 * Imperative input handle for the on-screen key bar (spec §5). The bar lives in
 * `SplitView` chrome, outside this component, and must reach the SAME port
 * `term.onData` writes to — never a second transport.
 */
/**
 * How a pane reacts to its container's size.
 *
 * `'fit'` — reflow the pty to the container (every desktop pane, and a phone
 * pane the user has zoomed to full screen).
 *
 * `'scale'` — keep the pty's current grid and CSS-scale the rendered terminal
 * into the container. This exists because a pty's winsize is SHARED with the
 * desktop and every other client: an unzoomed mosaic tile on a 390px phone is
 * ~180px wide, and fitting it reflowed a real session to **13 columns** —
 * measured, not hypothetical — which wrecks an agent TUI for whoever is
 * sitting at the desk. A tile is for looking at; only a zoomed pane earns the
 * right to reflow (spec §2.4).
 */
export type FitMode = 'fit' | 'scale'

export interface InputApi {
  send(data: string): void
  /** Application cursor-key mode: decides SS3 vs CSI arrows. */
  appMode(): boolean
  focus(): void
}

// Search decoration colors. Like XTERM_THEME, the addon can't read CSS vars, so
// these MIRROR theme.css tokens (--accent #7c6cff and a lighter active variant).
// Colors must be 6-digit #RRGGBB (the addon rejects alpha) — the match fill is a
// muted violet that keeps the glyph legible; the active match is the full accent.
const SEARCH_DECORATIONS = {
  matchBackground: '#3d3563',
  matchBorder: '#7c6cff',
  matchOverviewRuler: '#7c6cff',
  activeMatchBackground: '#7c6cff',
  activeMatchBorder: '#b3a8ff',
  activeMatchColorOverviewRuler: '#b3a8ff',
}

// xterm palette — kept in sync with theme.css tokens (Terminal can't read CSS
// vars at construction). background matches --bg so the pane body blends with
// the header/chrome; cursor + selection use the violet accent.
const FONT_STACK =
  "'JetBrains Mono','SF Mono','Menlo','Monaco','DejaVu Sans Mono','Consolas',monospace"
const XTERM_THEME = {
  background: '#0c0c0f',
  foreground: '#e6e6ec',
  cursor: '#7c6cff',
  cursorAccent: '#0c0c0f',
  selectionBackground: 'rgba(124,108,255,0.30)',
  black: '#1b1b22',
  red: '#ff5c5c',
  green: '#52d273',
  yellow: '#ffb454',
  blue: '#4d9fff',
  magenta: '#7c6cff',
  cyan: '#4dd6c8',
  white: '#c8c8d2',
  brightBlack: '#64646f',
  brightRed: '#ff7b7b',
  brightGreen: '#78e094',
  brightYellow: '#ffc879',
  brightBlue: '#78b6ff',
  brightMagenta: '#9d90ff',
  brightCyan: '#79e2d6',
  brightWhite: '#f4f4f8',
}

// Replaying raw scrollback re-executes its escape codes, including any mouse-
// tracking enable from a prior program (e.g. an exited claude). Left set, a
// shell echoes mouse reports on every click/move. Disable all mouse modes
// after each backlog; a live program re-asserts what it needs on redraw.
const MOUSE_RESET = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l'

// Memoized: SplitView re-renders on every drag-hover mousemove. `session`/
// `epoch` are primitives, so memo keeps a drag from reconciling every terminal
// (honors "xterm instances live outside React reconciliation").
// Focus is tracked by SplitView via `focusin` on the wrapper; nothing here.
export const Pane = memo(function Pane(
  { session, kind, epoch, portEpoch, activateSeq, fontSize, cwd, onTitle, onSearchReady, onInputReady, fitMode = 'fit' }:
    { session: string; kind: string; epoch: number; portEpoch: number; activateSeq: number; fontSize: number; cwd: string; onTitle?: (title: string) => void; onSearchReady?: (api: SearchApi) => void; onInputReady?: (api: InputApi) => void; fitMode?: FitMode },
): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  // Floating "Open" button state: shown when the current selection resolves to a
  // real path (main-process stat). `path` is the abs path revealed on click.
  const [openBtn, setOpenBtn] = useState<{ x: number; y: number; path: string } | null>(null)
  // Latest pointer position (container-relative) from the selection's mouseup —
  // where the button anchors. cwd (for relative-path resolution) lives in a ref
  // so it stays fresh without re-running the once-only [session] mount effect.
  const ptrRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const portRef = useRef<MessagePort | null>(null)
  // Latest values read inside the once-registered mount effect without making
  // them effect deps (which would recreate the terminal). `fontSize` seeds the
  // constructor; `onTitle` receives OSC-2 title changes; `onSearchReady` receives
  // the imperative search handle once the addon is loaded.
  const fontSizeRef = useRef(fontSize)
  fontSizeRef.current = fontSize
  const onTitleRef = useRef(onTitle)
  onTitleRef.current = onTitle
  const onSearchReadyRef = useRef(onSearchReady)
  onSearchReadyRef.current = onSearchReady
  const onInputReadyRef = useRef(onInputReady)
  onInputReadyRef.current = onInputReady
  const fitModeRef = useRef(fitMode)
  fitModeRef.current = fitMode
  // True once this Pane has consumed one Attach backlog. A LATER backlog is a
  // RE-attach replay of history the terminal already shows, so it must clear
  // first — see the `term.reset()` in the port handler. Deliberately not armed
  // for the first attach of the pane's life: a `.amberws` load stages replay
  // bytes into the terminal BEFORE the port is wired, and clearing would wipe
  // exactly the history that load exists to restore.
  const attachedOnceRef = useRef(false)
  // Re-acquire the pane's MessagePort. Points at the live mount-effect closure;
  // called when the client utilityProcess restarts (portEpoch) and the old port
  // is dead.
  const acquireRef = useRef<() => void>(() => {})

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      convertEol: false,
      fontFamily: FONT_STACK,
      fontSize: fontSizeRef.current,
      lineHeight: 1.15,
      theme: XTERM_THEME,
      cursorBlink: true,
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.open(host)
    term.loadAddon(fit)
    // WebGL is the fast path on hardware GL, but pathologically slow on
    // SwiftShader — under software GL, use xterm's default DOM renderer.
    if (!window.amber.softwareGl) {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    }
    // Scrollback search. Decorations are passed on EVERY call (not just for the
    // highlight): the addon fires onDidChangeResults only when decorations are
    // enabled, so the ordinal would go stale otherwise. The handle is imperative
    // — the find bar (React chrome) drives it without touching the Terminal.
    const search = new SearchAddon()
    term.loadAddon(search)
    let resultsCb: ((r: { resultIndex: number; resultCount: number }) => void) | null = null
    const resultsSub = search.onDidChangeResults((r) => resultsCb?.(r))
    onSearchReadyRef.current?.({
      findNext: (q, opts) => search.findNext(q, { decorations: SEARCH_DECORATIONS, incremental: opts?.incremental ?? false }),
      findPrevious: (q) => search.findPrevious(q, { decorations: SEARCH_DECORATIONS }),
      clear: () => search.clearDecorations(),
      onResults: (cb) => { resultsCb = cb },
      // Reads the live `port` binding (reassigned on wire/re-acquire), same as
      // term.onData below — so it targets the current pty even after a reconnect.
      insert: (text) => port?.postMessage({ data: new TextEncoder().encode(text) }),
      copySelection: () => term.getSelection(),
      captureBookmark: () => {
        const selection = term.getSelection().trim()
        if (selection) return selection.slice(0, 500)
        const buffer = term.buffer.active
        const cursor = buffer.baseY + buffer.cursorY
        const lines: string[] = []
        for (let row = Math.max(0, cursor - 2); row <= cursor; row += 1) {
          const text = buffer.getLine(row)?.translateToString(true).trimEnd()
          if (text) lines.push(text)
        }
        return lines.join('\n').slice(0, 500)
      },
      // term.paste() emits through onData (registered below) → the live port,
      // and applies bracketed-paste framing when the program enabled it.
      paste: (text) => term.paste(text),
    })

    // OSC 52 clipboard writes: a TUI sets the system clipboard by emitting
    // ESC ] 52 ; <sel> ; <base64> BEL. Claude Code's select-to-copy uses this.
    // xterm.js ignores OSC 52 by default, so route it to the same clipboard
    // bridge as the copy chord. decodeOsc52Payload returns null for a "?" READ
    // request (denied — no clipboard exfiltration) or malformed data. We own
    // OSC 52, so always return true (consume it). Disposed with the Terminal.
    term.parser.registerOscHandler(52, (data) => {
      const text = decodeOsc52Payload(data)
      if (text) window.amber.clipboardWrite(text)
      return true
    })

    fit.fit()
    termRef.current = term
    fitRef.current = fit

    // Workspace-load scrollback replay (single-shot). A freshly created session
    // has empty daemon backlog, so writing the saved history here — before the
    // live port is wired — yields display-correct ordering (history, then live
    // output). MOUSE_RESET clears any mouse-tracking mode the replayed bytes
    // re-enabled (same hazard as an Attach backlog).
    const replay = takeReplay(session)
    if (replay) { term.write(replay); term.write(MOUSE_RESET) }

    let port: MessagePort | null = null
    let wired = false
    const keyboardMode = new KeyboardInputModeTracker()

    // App chords (Cmd on mac / Ctrl+Shift on Linux) must not be sent to the
    // pty — return false so xterm neither renders nor forwards them; the event
    // still bubbles to the window handlers in App/SplitView.
    // Preserve the browser's Shift modifier. A supervised Pi pane is known by
    // kind; a Pi launched later from a shell pane is detected from the live
    // Kitty/modifyOtherKeys negotiation it writes to the terminal.
    term.attachCustomKeyEventHandler((e) => {
      // Checked BEFORE the keydown gate and preventDefault'd: returning false
      // only skips xterm's keydown path, it does not stop the event, so the
      // browser's follow-up keypress would make xterm emit a bare CR right after
      // our custom sequence — newline inserted, then submitted anyway.
      if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.type === 'keydown') port?.postMessage({
          data: new TextEncoder().encode(shiftEnterSequence(kind, keyboardMode.current)),
        })
        e.preventDefault()
        return false
      }
      if (e.type !== 'keydown') return true
      if (e.key === 'Escape') setOpenBtn(null) // dismiss the Open button; still goes to pty
      if (appChord(e)) return false
      return true
    })

    /**
     * Scale mode: fit the terminal's RENDERED pixels into the host with a CSS
     * transform, leaving the pty's grid alone. Measured cause for this
     * existing: an unzoomed mosaic tile on a 390px phone is ~180px wide, and
     * fitting it reflowed a live session to 13 columns — and a pty's winsize
     * is shared with the desktop, so that lands on whoever is at the desk.
     */
    const applyScale = (): void => {
      const el = term.element
      if (!el) return
      if (fitModeRef.current !== 'scale') {
        el.style.transform = ''
        el.style.transformOrigin = ''
        el.style.width = ''
        return
      }
      const w = el.scrollWidth
      const h = el.scrollHeight
      if (w === 0 || h === 0 || host.clientWidth === 0 || host.clientHeight === 0) return
      const k = Math.min(host.clientWidth / w, host.clientHeight / h, 1)
      el.style.transformOrigin = 'top left'
      el.style.transform = `scale(${k})`
    }

    /**
     * Is the soft keyboard (or any other browser-owned overlay) currently
     * eating part of the viewport?
     *
     * `visualViewport.height` shrinks when the on-screen keyboard opens while
     * `innerHeight` does not, so the difference is the discriminator. A real
     * orientation change moves BOTH, which is why it still re-fits.
     */
    const isKeyboardOpen = (): boolean => {
      const viewport = window.visualViewport
      return keyboardOpen(
        window.innerHeight,
        viewport?.height ?? null,
        viewport?.offsetTop ?? 0,
      )
    }

    const sendResize = (): void => {
      // A collapsed host (window crushed below the chrome's own height) makes
      // FitAddon clamp to its 2x1 floor; posting that would SIGWINCH every pty
      // to 1 row and make each program repaint its whole screen. The size is
      // not real — skip it and let the next non-degenerate fire carry the truth.
      if (host.clientWidth === 0 || host.clientHeight === 0) return
      // Scale mode never touches the shared pty geometry.
      if (fitModeRef.current === 'scale') {
        applyScale()
        return
      }
      // Spec §3: opening the soft keyboard must NEVER re-fit the pty. The
      // naive path (bind height to visualViewport) flaps the grid every time
      // the keyboard opens or closes, and on an agent TUI that is a full
      // repaint each way — plus, with a borrow active, a Resize over the wire
      // each way. Keep the rows we have; the container scrolls the cursor row
      // above the keyboard instead.
      if (isKeyboardOpen()) return
      try { fit.fit() } catch { /* host has zero size mid-layout; ignore */ }
      port?.postMessage({ resize: { cols: term.cols, rows: term.rows } })
    }
    const ro = new ResizeObserver(() => sendResize())
    ro.observe(host)

    // With rows pinned (above), the keyboard would otherwise cover the prompt.
    // Move the already-rendered terminal pixels just far enough to keep xterm's
    // cursor above BOTH the keyboard and the key bar. A transform is
    // load-bearing here: unlike the old paddingBottom implementation it changes
    // no observed box size, so keyboard close cannot trigger FitAddon and send
    // a fake PTY Resize.
    const onViewport = (): void => {
      if (fitModeRef.current === 'scale') return
      const viewport = window.visualViewport
      if (!viewport) return
      const inset = keyboardInset(window.innerHeight, viewport.height, viewport.offsetTop)
      if (inset === 0) {
        host.style.transform = ''
        host.classList.remove('keyboard-lifted')
        return
      }
      term.scrollToBottom()
      const screen = term.element?.querySelector('.xterm-screen') as HTMLElement | null
      const cellHeight = (screen?.offsetHeight ?? 0) / Math.max(1, term.rows)
      const dockHeight = document.querySelector<HTMLElement>('.key-bar-dock')?.offsetHeight ?? 0
      const hostTop = containerRef.current?.getBoundingClientRect().top ?? host.getBoundingClientRect().top
      const lift = terminalLift({
        hostTop,
        cursorRow: term.buffer.active.cursorY,
        cellHeight,
        visibleBottom: viewport.offsetTop + viewport.height,
        dockHeight,
      })
      host.style.transform = lift > 0 ? `translate3d(0, -${lift}px, 0)` : ''
      host.classList.toggle('keyboard-lifted', lift > 0)
    }
    window.visualViewport?.addEventListener('resize', onViewport)
    window.visualViewport?.addEventListener('scroll', onViewport)
    onViewport()
    const focus = (): void => term.focus()

    // Input goes to whatever the CURRENT port is. Registered ONCE — re-running it
    // per (re)acquire would stack handlers and double-send every keystroke.
    term.onData((s) => port?.postMessage({ data: new TextEncoder().encode(s) }))

    // Key-bar handle: the same `port` every keystroke uses, so a bar press is
    // indistinguishable from a keyboard press downstream.
    onInputReadyRef.current?.({
      send: (data) => port?.postMessage({ data: new TextEncoder().encode(data) }),
      appMode: () => term.modes.applicationCursorKeysMode,
      focus: () => term.focus(),
    })

    // ---- touch scrolling (spec §5) --------------------------------------
    //
    // xterm ships none: on a phone a drag inside the terminal selects text, so
    // the scrollback is simply unreachable. Ported from the hand-written phone
    // UI (assets/app.js:634-720), which is device-proven.
    //
    // Capability-gated, not host-gated — a touch laptop gets it too.
    const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false
    let touch: { x: number; y: number; last: number; acc: number; axis: 'x' | 'y' | null; t: number; v: number } | null = null
    let flick = 0
    let flickAcc = 0
    let flickTimer: number | null = null

    const cellPx = (): number => {
      const scr = term.element?.querySelector('.xterm-screen') as HTMLElement | null
      const h = (scr?.offsetHeight ?? 0) / (term.rows || 1)
      return h > 4 ? h : 0
    }
    const onAltScreen = (): boolean => term.buffer.active.type === 'alternate'
    // Positive `lines` scrolls DOWN (towards newer output), matching wheel sign.
    const scrollLines = (lines: number): void => {
      if (!lines) return
      if (!onAltScreen()) {
        term.scrollLines(lines)
        return
      }
      // A full-screen TUI owns its own paging and has no scrollback of its own,
      // so send arrows instead — mirroring xterm's alternateScrollMode.
      const keys = altScrollKeys(lines, term.modes.applicationCursorKeysMode)
      if (keys) port?.postMessage({ data: new TextEncoder().encode(keys) })
    }
    const stopFlick = (): void => {
      if (flickTimer !== null) cancelAnimationFrame(flickTimer)
      flickTimer = null
      flick = 0
      flickAcc = 0
    }
    const runFlick = (): void => {
      flickTimer = null
      if (Math.abs(flick) < FLICK_MIN_LINES) {
        flick = 0
        flickAcc = 0
        return
      }
      flickAcc += flick
      const { whole, rest } = takeWholeLines(flickAcc)
      flickAcc = rest
      if (whole) scrollLines(whole)
      flick *= FLICK_DECAY
      flickTimer = requestAnimationFrame(runFlick)
    }
    const onTouchStart = (ev: TouchEvent): void => {
      stopFlick()
      if (ev.touches.length !== 1) {
        touch = null
        return
      }
      const t = ev.touches[0]
      if (!t) return
      touch = { x: t.clientX, y: t.clientY, last: t.clientY, acc: 0, axis: null, t: Date.now(), v: 0 }
    }
    const onTouchMove = (ev: TouchEvent): void => {
      // Two fingers stay the browser's: pinch must keep working.
      if (!touch || ev.touches.length !== 1) return
      const t = ev.touches[0]
      if (!t) return
      const dx = t.clientX - touch.x
      const dy = t.clientY - touch.y
      // Lock the axis once: vertical scrolls the terminal, horizontal is left
      // alone so a zoomed pane can still be panned.
      if (touch.axis === null && (Math.abs(dx) > AXIS_LOCK_PX || Math.abs(dy) > AXIS_LOCK_PX)) {
        touch.axis = Math.abs(dy) > Math.abs(dx) ? 'y' : 'x'
      }
      if (touch.axis !== 'y') return
      const cell = cellPx()
      if (!cell) return
      if (ev.cancelable) ev.preventDefault() // don't also rubber-band the page
      const step = t.clientY - touch.last
      touch.last = t.clientY
      const now = Date.now()
      const dt = Math.max(1, now - touch.t)
      touch.t = now
      touch.v = ((-step / cell) / dt) * 16 // lines per frame, for the flick
      // Dragging content DOWN reveals older output -> scroll up.
      touch.acc += -step / cell
      const { whole, rest } = takeWholeLines(touch.acc)
      touch.acc = rest
      if (whole) scrollLines(whole)
    }
    const onTouchEnd = (): void => {
      if (touch && touch.axis === 'y' && Math.abs(touch.v) > FLICK_MIN_LINES) {
        flick = touch.v
        flickTimer = requestAnimationFrame(runFlick)
      }
      touch = null
    }
    if (coarse) {
      host.addEventListener('touchstart', onTouchStart, { passive: true })
      host.addEventListener('touchmove', onTouchMove, { passive: false })
      host.addEventListener('touchend', onTouchEnd, { passive: true })
      host.addEventListener('touchcancel', onTouchEnd, { passive: true })
    }

    // OSC 2 title changes (e.g. shell PROMPT_COMMAND). Registered once; the
    // latest consumer lives in a ref so a stable prop identity isn't required
    // to keep the callback fresh. Fires only on title sequences, not per byte.
    term.onTitleChange((title) => onTitleRef.current?.(title))

    // Floating "Open" button: on a text selection that resolves to a real path
    // (relative to this pane's cwd), pop a button anchored at the selection's
    // mouseup. Resolution/stat happens in main (renderer is sandboxed); the
    // button only appears for paths that exist, so plain-prose selections are
    // silently ignored. Anchored at the last pointer position, not selection
    // cell coords (those need xterm private APIs).
    const onMouseUp = (e: MouseEvent): void => {
      const b = containerRef.current?.getBoundingClientRect()
      if (b) ptrRef.current = { x: e.clientX - b.left, y: e.clientY - b.top }
    }
    host.addEventListener('mouseup', onMouseUp)
    let selSeq = 0
    term.onSelectionChange(() => {
      const sel = term.getSelection().trim()
      if (!sel || sel.length > 512 || sel.includes('\n')) { setOpenBtn(null); return }
      const seq = ++selSeq
      const { x, y } = ptrRef.current
      void window.amber.resolvePath(cwdRef.current, sel).then((abs) => {
        // Drop stale resolves: selection changed while the stat was in flight.
        if (seq !== selSeq) return
        setOpenBtn(abs ? { x, y, path: abs } : null)
      })
    })
    term.onScroll(() => setOpenBtn(null)) // anchor would drift off the moved line

    const onPortMsg = (e: MessageEvent): void => {
      const d = e.data as { amberPanePort?: boolean; session?: string }
      if (!d?.amberPanePort || d.session !== session || !e.ports[0]) return
      window.removeEventListener('message', onPortMsg)
      if (wired) { e.ports[0].close(); return }
      wired = true
      port?.close() // drop the previous (now-dead) port on a re-acquire
      port = e.ports[0]
      portRef.current = port
      port.onmessage = (ev) => {
        const m = ev.data as { data?: Uint8Array; backlog?: boolean }
        if (!m.data) return
        // `backlog` is set by the client (router.ts) on the first Data frame
        // after an Attach — the daemon's one-frame scrollback replay. It is NOT
        // inferred here: "the first message after a reconnect" races the frame
        // itself, and a reset that lands on a later frame wipes a live pane
        // instead of de-duplicating it (observed on a real daemon restart —
        // the pane went blank while the daemon still held the history).
        const isBacklog = m.backlog === true
        // A re-attach replays history this terminal ALREADY shows, so without a
        // clear each reconnect appended a duplicate copy — cosmetically wrong,
        // and it grew the buffer by up to a full backlog every time until
        // xterm's own scrollback limit evicted it. reset() (not clear()) because
        // the replay re-executes raw escape codes and must start from a known
        // state. Skipped for the pane's FIRST backlog: a `.amberws` load stages
        // replay bytes before the port is wired, and clearing would wipe exactly
        // the history that load exists to restore.
        if (isBacklog && attachedOnceRef.current) {
          term.reset()
          keyboardMode.reset()
        }
        keyboardMode.feed(m.data)
        term.write(m.data) // xterm.write accepts Uint8Array (UTF-8)
        if (isBacklog) {
          attachedOnceRef.current = true
          term.write(MOUSE_RESET) // clear mouse modes the replayed bytes re-enabled
        }
      }
      port.start()
      sendResize()
      term.focus()
    }

    // (Re)acquire a pane port from main: arm the listener and ask for a port.
    const acquire = (): void => {
      wired = false
      window.addEventListener('message', onPortMsg)
      window.amber.openPane(session)
    }
    acquireRef.current = acquire

    host.addEventListener('click', focus)
    term.focus()
    acquire()

    return () => {
      window.removeEventListener('message', onPortMsg)
      host.removeEventListener('click', focus)
      host.removeEventListener('mouseup', onMouseUp)
      window.visualViewport?.removeEventListener('resize', onViewport)
      window.visualViewport?.removeEventListener('scroll', onViewport)
      if (coarse) {
        stopFlick()
        host.removeEventListener('touchstart', onTouchStart)
        host.removeEventListener('touchmove', onTouchMove)
        host.removeEventListener('touchend', onTouchEnd)
        host.removeEventListener('touchcancel', onTouchEnd)
      }
      ro.disconnect()
      resultsSub.dispose()
      port?.close()
      // Release the CLIENT side too. Closing our end alone left the
      // utilityProcess holding its half forever (its port map is keyed by
      // session name, which is never reused), and left the daemon streaming
      // this pane's output into a port with no reader. React runs every
      // unmount cleanup in a commit before any mount effect, so on a ⟳ rebuild
      // (key change) this Detach still precedes the new Pane's Attach.
      window.amber.closePane(session)
      term.dispose()
      termRef.current = null
      fitRef.current = null
      portRef.current = null
    }
  }, [session])

  // Client utilityProcess restarted (portEpoch): the old MessagePort is dead —
  // re-request a fresh one from the new child. The terminal (and its scrollback)
  // is preserved; the daemon replays backlog on the re-Attach.
  //
  // Fire only when portEpoch CHANGES after mount — the ref is seeded with the
  // mount-time value, so a pane created while childEpoch is already > 0 does
  // NOT re-acquire here (the [session] effect's single acquire() covers the
  // fresh mount; a second openPane would broker a port pair nobody wires,
  // leaking it).
  //
  // Narrow race (accepted): if a restart lands while the INITIAL open is still
  // in flight, the pre-restart port can arrive after re-acquire re-arms the
  // listener and get wired even though its child is gone — a dead pane until
  // the next restart bumps portEpoch again and re-acquires (self-heals).
  const prevPortEpochRef = useRef(portEpoch)
  useEffect(() => {
    if (portEpoch === prevPortEpochRef.current) return
    prevPortEpochRef.current = portEpoch
    acquireRef.current()
  }, [portEpoch])

  // On reconnect (epoch increments): nudge a resize so an alt-screen TUI
  // (claude — whose screen isn't in scrollback) repaints. Staggered because
  // claude may still be re-resuming when the socket comes back. The mouse-mode
  // reset is no longer armed here — the client tags the actual backlog frame
  // (`m.backlog`), which is exact where this was a guess that raced it.
  useEffect(() => {
    if (epoch === 0) return
    const nudge = (): void => {
      const term = termRef.current, fit = fitRef.current, port = portRef.current
      if (!term || !port) return
      // The mouse reset is always safe; the RE-FIT is not. In scale mode this
      // pane is a tile whose pixels are CSS-scaled, and fitting it would
      // reflow the shared pty to tile size on every reconnect.
      if (fitModeRef.current === 'scale') {
        term.write(MOUSE_RESET)
        return
      }
      try { fit?.fit() } catch { /* ignore */ }
      term.write(MOUSE_RESET)
      port.postMessage({ resize: { cols: term.cols, rows: term.rows } })
    }
    const t1 = setTimeout(nudge, 600)
    const t2 = setTimeout(nudge, 2000)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [epoch])

  // Tab became visible again (keep-alive: switching to an already-visited tab
  // does NOT remount this Pane). A backgrounded terminal was display:none, so its
  // renderer may hold a stale/blank frame — force a full repaint. SplitView owns
  // re-focusing the right pane; this only repaints. Skips the seed value (0).
  useEffect(() => {
    if (activateSeq === 0) return
    const term = termRef.current
    if (!term) return
    try { fitRef.current?.fit() } catch { /* host mid-layout; ignore */ }
    term.refresh(0, Math.max(0, term.rows - 1))
  }, [activateSeq])

  // Font-size changes (chord). memo re-renders on the new `fontSize` prop but the
  // [session] effect doesn't re-run, so the Terminal instance persists — we just
  // retune its options and refit (cell size changed → new cols/rows → SIGWINCH
  // the pty). Skips a degenerate 0-size host (see sendResize).
  // Switching between tile (scale) and full-screen (fit) on a phone: entering
  // `fit` reflows the pty to the phone — that is the borrow (spec §2.2);
  // leaving it drops back to scaling and lets the server hand the grid back.
  useEffect(() => {
    const term = termRef.current
    const el = term?.element
    const host = hostRef.current
    if (!term || !el || !host) return
    if (fitMode === 'scale') {
      const w = el.scrollWidth, h = el.scrollHeight
      if (w > 0 && h > 0 && host.clientWidth > 0 && host.clientHeight > 0) {
        el.style.transformOrigin = 'top left'
        el.style.transform = `scale(${Math.min(host.clientWidth / w, host.clientHeight / h, 1)})`
      }
      return
    }
    el.style.transform = ''
    el.style.transformOrigin = ''
    if (host.clientWidth === 0 || host.clientHeight === 0) return
    try { fitRef.current?.fit() } catch { /* mid-layout */ }
    portRef.current?.postMessage({ resize: { cols: term.cols, rows: term.rows } })
  }, [fitMode])

  useEffect(() => {
    const term = termRef.current
    if (!term || term.options.fontSize === fontSize) return
    term.options.fontSize = fontSize
    const host = hostRef.current
    if (host && (host.clientWidth === 0 || host.clientHeight === 0)) return
    // Scale mode must not touch the SHARED pty geometry — measured: this
    // effect fires on the phone's 13→14px default flip, and fitting an
    // unzoomed ~180px tile reflowed a live session to a phone grid, exactly
    // what `fitMode` exists to prevent. Rescale instead.
    if (fitMode === 'scale') {
      const el = term.element
      if (el && host && host.clientWidth > 0 && host.clientHeight > 0) {
        const w = el.scrollWidth, h = el.scrollHeight
        if (w > 0 && h > 0) {
          el.style.transformOrigin = 'top left'
          el.style.transform = `scale(${Math.min(host.clientWidth / w, host.clientHeight / h, 1)})`
        }
      }
      return
    }
    try { fitRef.current?.fit() } catch { /* host has zero size mid-layout; ignore */ }
    portRef.current?.postMessage({ resize: { cols: term.cols, rows: term.rows } })
  }, [fontSize, fitMode])

  // Clamp the button inside the pane so it never spills past the right/bottom
  // edge (approx button box: 84×26). translate keeps a right-edge selection's
  // button visible.
  const btnStyle = openBtn
    ? {
        left: Math.max(2, Math.min(openBtn.x, (containerRef.current?.clientWidth ?? 9999) - 90)),
        top: Math.max(2, Math.min(openBtn.y + 6, (containerRef.current?.clientHeight ?? 9999) - 30)),
      }
    : undefined
  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%', height: '100%', background: 'var(--bg)' }}>
      <div ref={hostRef} className="terminal-host" style={{ width: '100%', height: '100%' }} />
      {openBtn &&
        <button
          className="open-path-btn"
          style={btnStyle}
          title={'Reveal in file manager: ' + openBtn.path}
          // preventDefault on mousedown: don't steal focus / clear the selection
          // before the click lands.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { window.amber.revealPath(openBtn.path); setOpenBtn(null) }}>
          ↗ Open
        </button>}
    </div>
  )
})
