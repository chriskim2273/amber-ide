import { memo, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { appChord } from './keys'
import { takeReplay } from './replay'

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
  // Force a local re-fit + repaint (header refresh button). Re-syncs the pty
  // size (SIGWINCH → program repaints) and repaints xterm's buffer — fixes a
  // garbled/stale frame or a pane mis-sized by the shared-winsize flap. Does NOT
  // re-attach to the daemon (no fresh backlog replay).
  refresh(): void
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
// fixterms encoding of Shift+Enter (see attachCustomKeyEventHandler below).
const SHIFT_ENTER_CSI_U = new TextEncoder().encode('\x1b[13;2u')
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
  // Set on a reconnect so the NEXT backlog message re-runs the reset (the
  // daemon replays a fresh backlog on every re-Attach, re-enabling mouse modes).
  const rearmRef = useRef(false)
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
      // term.paste() emits through onData (registered below) → the live port,
      // and applies bracketed-paste framing when the program enabled it.
      paste: (text) => term.paste(text),
      refresh: () => {
        try { fit.fit() } catch { /* host mid-layout; ignore */ }
        port?.postMessage({ resize: { cols: term.cols, rows: term.rows } })
        term.refresh(0, Math.max(0, term.rows - 1))
      },
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
    // Shift+Enter is translated to the fixterms CSI-u encoding (ESC [13;2u) —
    // what iTerm2/Kitty/Ghostty send natively — so CSI-u-aware TUIs (Claude
    // Code's newline-without-submit) can tell it apart from plain Enter.
    // Shells without CSI-u bindings may echo a stray fragment on Shift+Enter;
    // accepted tradeoff.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      if (e.key === 'Escape') setOpenBtn(null) // dismiss the Open button; still goes to pty
      if (appChord(e)) return false
      if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        port?.postMessage({ data: SHIFT_ENTER_CSI_U })
        return false
      }
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
    const ro = new ResizeObserver(() => sendResize())
    ro.observe(host)
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
      let sawBacklog = false
      port.onmessage = (ev) => {
        const m = ev.data as { data?: Uint8Array }
        if (!m.data) return
        term.write(m.data) // xterm.write accepts Uint8Array (UTF-8)
        // First backlog after (re)attach: clear stale mouse modes.
        if (!sawBacklog || rearmRef.current) {
          sawBacklog = true
          rearmRef.current = false
          term.write(MOUSE_RESET)
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
      ro.disconnect()
      resultsSub.dispose()
      port?.close()
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

  // On reconnect (epoch increments): re-arm the mouse reset for the fresh
  // backlog, and nudge a resize so an alt-screen TUI (claude — whose screen
  // isn't in scrollback) repaints. Staggered because claude may still be
  // re-resuming when the socket comes back.
  useEffect(() => {
    if (epoch === 0) return
    rearmRef.current = true
    const nudge = (): void => {
      const term = termRef.current, fit = fitRef.current, port = portRef.current
      if (!term || !port) return
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
  useEffect(() => {
    const term = termRef.current
    if (!term || term.options.fontSize === fontSize) return
    term.options.fontSize = fontSize
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
    <div ref={containerRef} style={{ position: 'relative', width: '100%', height: '100%', background: 'var(--bg)' }}>
      <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
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
