import { memo, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { appChord } from './keys'
import { takeReplay } from './replay'
import { decodeOsc52Payload } from './osc'

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
  // Paste text into the pty via xterm, which wraps it in bracketed-paste markers
  // when the running program requested that mode (so multiline paste doesn't
  // submit line-by-line in claude/vim). Routes through onData → the port.
  paste(text: string): void
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
// Shift+Enter → ESC+CR (Meta+Enter). Claude Code inserts a newline without
// submitting on this sequence with NO terminal negotiation needed. The fixterms
// CSI-u form (\x1b[13;2u) only works once the app negotiates the kitty keyboard
// protocol — which xterm.js here never advertises, so claude ignored it.
const SHIFT_ENTER_SEQ = new TextEncoder().encode('\x1b\r')
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
  { session, epoch, portEpoch, activateSeq, fontSize, cwd, onTitle, onSearchReady }:
    { session: string; epoch: number; portEpoch: number; activateSeq: number; fontSize: number; cwd: string; onTitle?: (title: string) => void; onSearchReady?: (api: SearchApi) => void },
): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  // `sizerRef`/`stageRef` wrap `hostRef` for the web build's follow-the-pty
  // rendering (see `serverGeomRef` below). In Electron — and in the web build
  // before the pty's geometry has arrived — both stay their default 100%/100%
  // identity size with no transform, so `hostRef` fills `containerRef` exactly
  // as it always did and FitAddon's `fit()` behaves unchanged.
  const sizerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
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
  // The pty's live grid, learned from a `geom` port message (web build only —
  // Electron's client never sends one, so this stays null there forever and
  // every branch below that checks it takes the untouched Electron path).
  // Non-null means: don't let FitAddon drive this pane's cols/rows — follow
  // the server's grid and CSS-scale the rendered size instead (spec — a pty's
  // winsize is shared with the desktop app's panes, so the web build must
  // never resize it; matches `syncGeom`/`applyScale` in the mobile client,
  // `crates/amber/assets/app.js`).
  const serverGeomRef = useRef<{ cols: number; rows: number } | null>(null)
  // Re-fit the scaled stage to the container (web-geometry mode only). Points
  // at the live mount-effect closure, called from the later effects below.
  const rescaleRef = useRef<() => void>(() => {})

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

    // App chords (Cmd on mac / Ctrl+Shift on Linux) must not be sent to the
    // pty — return false so xterm neither renders nor forwards them; the event
    // still bubbles to the window handlers in App/SplitView.
    // Shift+Enter → ESC+CR (Meta+Enter): Claude Code inserts a newline instead
    // of submitting on this sequence, while plain Enter stays a bare CR (submit).
    // A shell sees M-RET (unbound → no-op), so no stray echo.
    term.attachCustomKeyEventHandler((e) => {
      // Checked BEFORE the keydown gate and preventDefault'd: returning false
      // only skips xterm's keydown path, it does not stop the event, so the
      // browser's follow-up keypress made xterm emit a bare CR right after our
      // ESC+CR — newline inserted, then submitted anyway.
      if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.type === 'keydown') port?.postMessage({ data: SHIFT_ENTER_SEQ })
        e.preventDefault()
        return false
      }
      if (e.type !== 'keydown') return true
      if (e.key === 'Escape') setOpenBtn(null) // dismiss the Open button; still goes to pty
      if (appChord(e)) return false
      return true
    })

    const sendResize = (): void => {
      // A collapsed host (window crushed below the chrome's own height) makes
      // FitAddon clamp to its 2x1 floor; posting that would SIGWINCH every pty
      // to 1 row and make each program repaint its whole screen. The size is
      // not real — skip it and let the next non-degenerate fire carry the truth.
      if (host.clientWidth === 0 || host.clientHeight === 0) return
      try { fit.fit() } catch { /* host has zero size mid-layout; ignore */ }
      port?.postMessage({ resize: { cols: term.cols, rows: term.rows } })
    }

    // Web-geometry mode only (serverGeomRef set): fit the terminal's REAL
    // cell box into the container on both axes, never magnifying past natural
    // size, via a CSS transform — never a resize. Mirrors `applyScale` in the
    // mobile client (`crates/amber/assets/app.js`), including the never-
    // magnify clamp (fixed there in 32e863e after an 80-col grid blew up 2.25x
    // on a laptop-width viewport). `transform-origin: 0 0` (set in the JSX
    // below) keeps the scaled box pinned to the container's top-left corner,
    // matching where `sizer`/`stage` are actually laid out, so the visible
    // terminal lines up with its own hit-testable box (no dead click zone).
    const rescale = (): void => {
      const geom = serverGeomRef.current
      const sizer = sizerRef.current, stage = stageRef.current, container = containerRef.current
      const el = term.element
      if (!geom || !sizer || !stage || !container || !el) return
      if (!container.clientWidth || !container.clientHeight) return
      const scr = el.querySelector('.xterm-screen') as HTMLElement | null
      const w = scr ? scr.offsetWidth : el.offsetWidth
      const h = scr ? scr.offsetHeight : el.offsetHeight
      if (!w || !h) return
      const scale = Math.min(container.clientWidth / w, container.clientHeight / h, 1)
      stage.style.width = `${w}px`
      stage.style.height = `${h}px`
      stage.style.transform = `scale(${scale})`
      sizer.style.width = `${w * scale}px`
      sizer.style.height = `${h * scale}px`
    }
    rescaleRef.current = rescale

    // Learn the pty's real grid from a `geom` port message (web build only —
    // see `serverGeomRef`'s doc comment). Resizes the LOCAL xterm buffer to
    // match — never posts a resize back down the port — then rescales.
    const applyServerGeom = (g: { cols: number; rows: number }): void => {
      serverGeomRef.current = g
      if (term.cols !== g.cols || term.rows !== g.rows) term.resize(g.cols, g.rows)
      rescale()
    }

    const ro = new ResizeObserver(() => {
      if (serverGeomRef.current) rescale()
      else sendResize()
    })
    // Observe the OUTER container, not `host`: in web-geometry mode `host`'s
    // own size follows the pty's fixed grid (unrelated to the container), so
    // it would stop firing on a divider drag right when `rescale` needs it.
    // In Electron/pre-geometry mode host tracks container 1:1 (the wrapper
    // divs are identity-sized), so this observes the same resizes as before.
    if (containerRef.current) ro.observe(containerRef.current)
    const focus = (): void => term.focus()

    // Input goes to whatever the CURRENT port is. Registered ONCE — re-running it
    // per (re)acquire would stack handlers and double-send every keystroke.
    term.onData((s) => port?.postMessage({ data: new TextEncoder().encode(s) }))

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
        const m = ev.data as { data?: Uint8Array; backlog?: boolean; geom?: { cols: number; rows: number } }
        // Web build only (see `serverGeomRef`): the pty's real grid, learned
        // with no prop plumbing through main.tsx — Electron's client never
        // sends this. Handled before the `!m.data` guard: a `geom` message
        // carries no pty bytes of its own.
        if (m.geom) applyServerGeom(m.geom)
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
        if (isBacklog && attachedOnceRef.current) term.reset()
        term.write(m.data) // xterm.write accepts Uint8Array (UTF-8)
        if (isBacklog) {
          attachedOnceRef.current = true
          term.write(MOUSE_RESET) // clear mouse modes the replayed bytes re-enabled
        }
      }
      port.start()
      if (serverGeomRef.current) rescale()
      else sendResize()
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
      term.write(MOUSE_RESET)
      // Web-geometry mode: there's no local fit to redo (the grid follows the
      // pty, not the container) and posting a resize would be a no-op anyway
      // (dropped — see amber.ts) — just re-fit the scaled stage.
      if (serverGeomRef.current) { rescaleRef.current(); return }
      try { fit?.fit() } catch { /* ignore */ }
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
    if (serverGeomRef.current) rescaleRef.current()
    else { try { fitRef.current?.fit() } catch { /* host mid-layout; ignore */ } }
    term.refresh(0, Math.max(0, term.rows - 1))
  }, [activateSeq])

  // Font-size changes (chord). memo re-renders on the new `fontSize` prop but the
  // [session] effect doesn't re-run, so the Terminal instance persists — we just
  // retune its options and refit (cell size changed → new cols/rows → SIGWINCH
  // the pty). Skips a degenerate 0-size host (see sendResize).
  //
  // Web-geometry mode: the grid stays exactly what the pty reports regardless
  // of font size (resizing it here would be a local guess the server never
  // asked for) — only the cell pixel size changed, so just rescale the stage.
  useEffect(() => {
    const term = termRef.current
    if (!term || term.options.fontSize === fontSize) return
    term.options.fontSize = fontSize
    if (serverGeomRef.current) { rescaleRef.current(); return }
    const host = hostRef.current
    if (host && (host.clientWidth === 0 || host.clientHeight === 0)) return
    try { fitRef.current?.fit() } catch { /* host has zero size mid-layout; ignore */ }
    portRef.current?.postMessage({ resize: { cols: term.cols, rows: term.rows } })
  }, [fontSize])

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
    <div ref={containerRef} style={{ position: 'relative', width: '100%', height: '100%', background: 'var(--bg)', display: 'flex', overflow: 'hidden' }}>
      {/* `sizer` is sized in JS (rescale, above) to the SCALED box and centred
          via `margin: auto` in this flex container; `stage` is sized to the
          terminal's real (unscaled) cell box and transform-scaled to fit —
          both stay 100%/100% identity, matching plain passthrough divs, until
          web-geometry mode sets explicit pixel sizes. */}
      <div ref={sizerRef} style={{ margin: 'auto', flex: 'none', width: '100%', height: '100%' }}>
        <div ref={stageRef} style={{ width: '100%', height: '100%', transformOrigin: '0 0' }}>
          <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
        </div>
      </div>
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
