/* amber web — phone client. No framework, no bundler, no CDN.
 *
 * Contract (server):
 *   POST /api/auth      body = token (from the URL fragment) -> HttpOnly cookie
 *   GET  /api/sessions  -> [{name, kind, cwd, run_state, alive}]
 *   GET  /ws            JSON TEXT control frames + raw BINARY pty bytes
 *     up:   {t:'open',name} | {t:'close',name} | BINARY = input bytes
 *     down: BINARY = pty output | {t:'sessions',sessions} | {t:'exit',name,code}
 *           | {t:'error',msg}
 *
 * HARD RULE (spec §4): the phone NEVER sends a resize — a pty's winsize is
 * shared with the desktop app, so a resize would reflow the user's live panes
 * and corrupt a running claude TUI. Nothing here is wired to `term.onResize`,
 * the fit addon is not loaded, and there is no resize message in the protocol.
 * Readability is handled entirely client-side (CSS transform zoom).
 */
'use strict';

var ENC = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

/* ---------------- pure helpers (unit-checkable, no DOM) ---------------- */

// `amber-<ws>-<tab>-<ord>-<id>` (shared/names.ts grammar).
function parseName(name) {
  var m = /^amber-(\d+)-(\d+)-(\d+)-([A-Za-z0-9]+)$/.exec(name);
  return m ? { ws: +m[1], tab: +m[2], ord: +m[3], id: m[4] } : null;
}

// Last two path segments, `~` for $HOME-ish prefixes we can't know — keep it dumb.
function shortCwd(cwd) {
  if (!cwd) return '';
  var parts = cwd.split('/').filter(Boolean);
  return (parts.length > 2 ? '…/' : '/') + parts.slice(-2).join('/');
}

// Ctrl+<char> -> control byte. Returns null when the char has no control form
// (caller then sends the char unmodified).
function ctrlByte(ch) {
  if (ch.length !== 1) return null;
  if (ch === '?') return 0x7f; // Ctrl-? = DEL
  var c = ch.toUpperCase().charCodeAt(0);
  if (c === 32) return 0x00; // Ctrl-Space = NUL
  if (c >= 64 && c <= 95) return c & 0x1f; // @A-Z[\]^_
  return null;
}

// Arrows must follow the terminal's cursor-key mode: SS3 (\x1bO_) in
// application mode (claude, vim, readline in some modes), CSI (\x1b[_) in
// normal mode. Sending the wrong one breaks arrows in exactly those apps.
function arrowSeq(dir, appMode, ctrl) {
  var f = { up: 'A', down: 'B', right: 'C', left: 'D' }[dir];
  if (!f) return '';
  if (ctrl) return '\x1b[1;5' + f; // Ctrl+arrow is always the CSI modifier form
  return (appMode ? '\x1bO' : '\x1b[') + f;
}

// Key-bar key -> string to send (arrows need the mode, hence the flags).
function keyBytes(key, appMode, ctrl) {
  switch (key) {
    case 'esc': return '\x1b';
    case 'tab': return '\t';
    case 'ctrl-c': return '\x03';
    case 'up': case 'down': case 'left': case 'right': return arrowSeq(key, appMode, ctrl);
    default: return '';
  }
}

function backoffMs(attempt) {
  return Math.min(10000, 500 * Math.pow(2, Math.min(attempt, 5)));
}

/* ---------------- app ---------------- */

function main() {
  var $ = function (id) { return document.getElementById(id); };
  var viewList = $('view-list'), viewTerm = $('view-term');
  var listEl = $('list'), countEl = $('list-count'), bannerEl = $('banner');
  var screenEl = $('screen'), sizerEl = $('sizer'), stageEl = $('stage'), hostEl = $('host');
  var titleEl = $('term-title'), ctrlBtn = $('k-ctrl');

  var ws = null;
  var attempt = 0;
  var reconnectTimer = 0;
  var sessions = [];
  var open = null;        // session name currently open (survives reconnects)
  var freshBacklog = false; // next binary frame is the replayed scrollback
  var term = null;
  var ctrlSticky = false;
  var zoom = +(localStorage.getItem('amber.zoom') || 1) || 1;
  // Geometry: the server reports each session's live pty cols/rows, and xterm is
  // sized to MATCH them (a full-screen TUI only renders correctly then). This
  // follows the pty; it never drives it. GEOMS is the fallback cycler used only
  // when a session arrives without those fields (older daemon).
  var GEOMS = [[80, 24], [100, 30], [120, 30], [132, 43], [160, 48]];
  var geomIdx = +(localStorage.getItem('amber.geom') || 0) || 0;

  var XTERM_PAD = 4; // must match `.xterm { padding }` in style.css
  var MOUSE_RESET = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l';
  var THEME = {
    background: '#0c0c0f', foreground: '#e6e6ec', cursor: '#7c6cff',
    cursorAccent: '#0c0c0f', selectionBackground: 'rgba(124,108,255,0.30)',
    black: '#1b1b22', red: '#ff5c5c', green: '#52d273', yellow: '#ffb454',
    blue: '#4d9fff', magenta: '#7c6cff', cyan: '#4dd6c8', white: '#c8c8d2',
    brightBlack: '#64646f', brightRed: '#ff7b7b', brightGreen: '#78e094',
    brightYellow: '#ffc879', brightBlue: '#78b6ff', brightMagenta: '#9d90ff',
    brightCyan: '#79e2d6', brightWhite: '#f4f4f8'
  };

  function banner(msg, kind) {
    if (!msg) { bannerEl.hidden = true; return; }
    bannerEl.textContent = msg;
    bannerEl.className = 'banner' + (kind ? ' ' + kind : '');
    bannerEl.hidden = false;
  }

  /* ---------- session list ---------- */

  function renderList() {
    countEl.textContent = sessions.length ? sessions.length + ' session' + (sessions.length === 1 ? '' : 's') : '';
    listEl.textContent = '';
    if (!sessions.length) {
      var empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No sessions. Start one from the desktop app.';
      listEl.appendChild(empty);
      return;
    }
    var groups = new Map();
    sessions.forEach(function (s) {
      var p = parseName(s.name);
      var key = p ? 'Workspace ' + p.ws + ' · Tab ' + p.tab : 'Other';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    });
    Array.from(groups.keys()).sort().forEach(function (key) {
      var h = document.createElement('h2');
      h.className = 'group';
      h.textContent = key;
      listEl.appendChild(h);
      groups.get(key).forEach(function (s) { listEl.appendChild(row(s)); });
    });
  }

  function row(s) {
    var b = document.createElement('button');
    b.className = 'row' + (s.alive ? '' : ' dead');
    b.type = 'button';

    var dot = document.createElement('span');
    dot.className = 'dot k-' + (s.kind || 'shell');
    dot.title = s.kind || 'shell';
    b.appendChild(dot);

    var mid = document.createElement('span');
    mid.className = 'row-mid';
    var t = document.createElement('span');
    t.className = 'row-title';
    var p = parseName(s.name);
    t.textContent = (s.kind === 'claude' ? 'claude' : 'shell') + (p ? ' · pane ' + p.ord : ' · ' + s.name);
    var sub = document.createElement('span');
    sub.className = 'row-sub';
    sub.textContent = shortCwd(s.cwd);
    mid.appendChild(t);
    mid.appendChild(sub);
    b.appendChild(mid);

    var tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = !s.alive ? 'exited' : (s.run_state && s.run_state !== 'claude' ? s.run_state : '');
    b.appendChild(tag);

    b.addEventListener('click', function () { openSession(s.name); });
    return b;
  }

  /* ---------- terminal ---------- */

  // The open session's live pty grid, or null when the server didn't report it.
  function serverGeom(name) {
    var s = sessions.filter(function (x) { return x.name === name; })[0];
    return s && s.cols && s.rows ? [s.cols, s.rows] : null;
  }

  // Match xterm to the pty's grid. `term.resize` is local xterm state only —
  // the browser protocol has no resize message, so this can never reach the pty.
  // Re-runs on every `sessions` push, so a divider drag in the desktop app is
  // followed here instead of silently corrupting the render.
  function syncGeom() {
    if (!term || !open) return;
    var srv = serverGeom(open);
    var g = srv || GEOMS[geomIdx];
    $('geom').hidden = !!srv; // the manual cycler is an override, not a setting
    if (term.cols !== g[0] || term.rows !== g[1]) term.resize(g[0], g[1]);
    applyScale();
  }

  function ensureTerm() {
    if (term) return term;
    var g = serverGeom(open) || GEOMS[geomIdx] || GEOMS[0];
    term = new window.Terminal({
      cols: g[0], rows: g[1],
      fontFamily: "'SF Mono','Menlo','DejaVu Sans Mono','Consolas',monospace",
      fontSize: 13,
      lineHeight: 1.1,
      theme: THEME,
      cursorBlink: true,
      scrollback: 5000,
      // No WebGL addon (mobile GPU variance) — xterm's DOM renderer is fine here.
    });
    term.open(hostEl);
    // Input path: raw bytes, BINARY frame. Sticky Ctrl applies here too, so the
    // phone keyboard's next letter gets modified after tapping Ctrl.
    term.onData(function (d) {
      if (ctrlSticky) {
        setCtrl(false);
        var b = ctrlByte(d);
        if (b !== null) { sendBytes(new Uint8Array([b])); return; }
      }
      sendBytes(ENC.encode(d));
    });
    term.onBinary(function (d) {
      var a = new Uint8Array(d.length);
      for (var i = 0; i < d.length; i++) a[i] = d.charCodeAt(i) & 255;
      sendBytes(a);
    });
    return term;
  }

  // Fit-to-width baseline × user zoom, applied as a CSS transform on the stage.
  // The terminal keeps its real cell geometry (cols/rows never change with the
  // screen) — only its rendered size changes, so the pty is never touched.
  // A transform doesn't affect layout, so #sizer carries the scaled box and
  // #screen pans when the user zooms past fit-width.
  function applyScale() {
    if (!term || !term.element) return;
    // The true content box is `.xterm-screen` (cols×rows of cells); the `.xterm`
    // element itself is a block that shrinks to whatever the container gives it,
    // which would clip the right-hand columns.
    var scr = term.element.querySelector('.xterm-screen');
    var w = (scr ? scr.offsetWidth : term.element.offsetWidth) + XTERM_PAD * 2;
    var h = (scr ? scr.offsetHeight : term.element.offsetHeight) + XTERM_PAD * 2;
    if (!w || !h) return;
    stageEl.style.width = w + 'px';
    stageEl.style.height = h + 'px';
    var scale = (screenEl.clientWidth / w) * zoom;
    stageEl.style.transform = 'scale(' + scale + ')';
    sizerEl.style.width = w * scale + 'px';
    sizerEl.style.height = h * scale + 'px';
  }

  function setZoom(z) {
    zoom = Math.max(0.4, Math.min(4, z));
    localStorage.setItem('amber.zoom', String(zoom));
    applyScale();
  }

  function setCtrl(on) {
    ctrlSticky = on;
    ctrlBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    ctrlBtn.classList.toggle('on', on);
  }

  function openSession(name) {
    open = name;
    freshBacklog = true;
    ensureTerm();
    term.reset();
    titleEl.textContent = name;
    viewList.hidden = true;
    viewTerm.hidden = false;
    send({ t: 'open', name: name });
    syncGeom();
    term.focus();
  }

  function leave() {
    if (open) send({ t: 'close', name: open });
    open = null;
    setCtrl(false);
    viewTerm.hidden = true;
    viewList.hidden = false;
  }

  /* ---------- socket ---------- */

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }
  function sendBytes(bytes) {
    if (open && ws && ws.readyState === 1) ws.send(bytes);
  }

  function connect() {
    clearTimeout(reconnectTimer);
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws');
    ws.binaryType = 'arraybuffer';

    ws.onopen = function () {
      attempt = 0;
      banner(null);
      if (open) { freshBacklog = true; if (term) term.reset(); send({ t: 'open', name: open }); }
    };

    ws.onmessage = function (ev) {
      if (typeof ev.data !== 'string') {
        if (!term) return;
        term.write(new Uint8Array(ev.data));
        if (freshBacklog) {
          // The replayed scrollback re-executes old escape codes, including a
          // dead program's mouse-tracking enable (Pane.tsx does the same).
          freshBacklog = false;
          term.write(MOUSE_RESET);
          applyScale();
        }
        return;
      }
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.t === 'sessions') { sessions = msg.sessions || []; renderList(); syncGeom(); }
      else if (msg.t === 'exit') {
        if (msg.name === open && term) term.write('\r\n\x1b[33m[session exited: ' + msg.code + ']\x1b[0m\r\n');
      } else if (msg.t === 'error') banner(msg.msg || 'error', 'error');
    };

    ws.onclose = function () {
      var d = backoffMs(attempt++);
      banner('Disconnected — reconnecting…', 'warn');
      reconnectTimer = setTimeout(connect, d);
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  /* ---------- wiring ---------- */

  $('back').addEventListener('click', leave);
  $('zoom-in').addEventListener('click', function () { setZoom(zoom * 1.25); });
  $('zoom-out').addEventListener('click', function () { setZoom(zoom / 1.25); });

  // Override cycler — only reachable when the server didn't report a pty size.
  function setGeom(i) {
    geomIdx = i % GEOMS.length;
    localStorage.setItem('amber.geom', String(geomIdx));
    $('geom').textContent = 'size ' + GEOMS[geomIdx][0] + '×' + GEOMS[geomIdx][1];
    syncGeom();
  }
  $('geom').addEventListener('click', function () { setGeom(geomIdx + 1); });
  setGeom(geomIdx);

  $('keybar').addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('.key') : null;
    if (!btn) return;
    var key = btn.getAttribute('data-key');
    if (key === 'ctrl') { setCtrl(!ctrlSticky); return; }
    var appMode = !!(term && term.modes && term.modes.applicationCursorKeysMode);
    var s = keyBytes(key, appMode, ctrlSticky);
    if (s) sendBytes(ENC.encode(s));
    if (key !== 'ctrl') setCtrl(false);
    if (term) term.focus();
  });
  // Keep taps on the key bar from stealing focus (which would close the phone
  // keyboard between every keypress).
  $('keybar').addEventListener('mousedown', function (ev) { ev.preventDefault(); });

  /* ---------- touch scrolling ---------- */

  // xterm has no touch scrolling of its own: on a phone a drag inside the
  // terminal selects text, so scrollback was unreachable. Translate a vertical
  // one-finger drag into scrolling:
  //   normal screen -> term.scrollLines() over the scrollback buffer
  //   ALT screen    -> arrow keys, mirroring xterm's alternateScrollMode for the
  //                    wheel; a full-screen TUI (claude, vim, less) has no
  //                    scrollback of its own, so its own pager must do the work.
  // Horizontal drags are left alone so #screen keeps panning when zoomed in.
  // Two-finger gestures are left alone too (browser pinch-zoom).
  var CELL_MIN = 8;              // guard against a 0-height cell before layout
  var FLICK_DECAY = 0.94;        // per frame; ~1s of glide from a fast flick
  var FLICK_MIN_LINES = 0.15;    // stop when a frame moves less than this
  var touch = null, flick = 0, flickAcc = 0, flickTimer = null;

  function cellPx() {
    if (!term || !term.element) return 0;
    var scr = term.element.querySelector('.xterm-screen');
    var h = (scr ? scr.offsetHeight : 0) / (term.rows || 1);
    if (!(h > CELL_MIN)) return 0;
    // The stage is transform-scaled, so a finger travels fewer CSS px per line
    // than the unscaled cell height.
    var m = /matrix\(([\d.]+)/.exec(stageEl.style.transform || '');
    return h * (m ? parseFloat(m[1]) : 1);
  }

  function altScreen() {
    return !!(term && term.buffer && term.buffer.active && term.buffer.active.type === 'alternate');
  }

  // Positive `lines` scrolls DOWN (towards newer output), matching wheel sign.
  function scrollLines(lines) {
    if (!term || !lines) return;
    if (!altScreen()) { term.scrollLines(lines); return; }
    var appMode = !!(term.modes && term.modes.applicationCursorKeysMode);
    var seq = arrowSeq(lines > 0 ? 'down' : 'up', appMode, false);
    var n = Math.min(Math.abs(lines), 24); // cap one gesture's burst of keys
    var out = '';
    for (var i = 0; i < n; i++) out += seq;
    if (out) sendBytes(ENC.encode(out));
  }

  function stopFlick() {
    if (flickTimer) { cancelAnimationFrame(flickTimer); flickTimer = null; }
    flick = 0;
  }

  // Glide after a flick: `flick` is lines-per-frame, decaying; fractional
  // leftovers accumulate in `flickAcc` so slow tails still move a line now and
  // then instead of stalling.
  function runFlick() {
    flickTimer = null;
    if (Math.abs(flick) < FLICK_MIN_LINES) { flick = 0; flickAcc = 0; return; }
    flickAcc += flick;
    var whole = flickAcc > 0 ? Math.floor(flickAcc) : Math.ceil(flickAcc);
    if (whole) { flickAcc -= whole; scrollLines(whole); }
    flick *= FLICK_DECAY;
    flickTimer = requestAnimationFrame(runFlick);
  }

  screenEl.addEventListener('touchstart', function (ev) {
    stopFlick();
    if (ev.touches.length !== 1) { touch = null; return; }
    var t = ev.touches[0];
    touch = { x: t.clientX, y: t.clientY, acc: 0, axis: null, last: t.clientY, t: Date.now(), v: 0 };
  }, { passive: true });

  screenEl.addEventListener('touchmove', function (ev) {
    if (!touch || ev.touches.length !== 1) return;
    var t = ev.touches[0];
    var dx = t.clientX - touch.x, dy = t.clientY - touch.y;
    // Lock the axis once, on the first meaningful movement: vertical scrolls the
    // terminal, horizontal stays a native pan of #screen.
    if (!touch.axis && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
      touch.axis = Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
    }
    if (touch.axis !== 'y') return;
    var cell = cellPx();
    if (!cell) return;
    if (ev.cancelable) ev.preventDefault(); // don't also pan/rubber-band the page
    var step = t.clientY - touch.last;
    touch.last = t.clientY;
    var now = Date.now(), dt = Math.max(1, now - touch.t);
    touch.t = now;
    touch.v = (-step / cell) / dt * 16; // lines per frame, for the flick
    // Dragging the content DOWN reveals older output -> scroll up.
    touch.acc += -step / cell;
    var whole = touch.acc > 0 ? Math.floor(touch.acc) : Math.ceil(touch.acc);
    if (whole) { touch.acc -= whole; scrollLines(whole); }
  }, { passive: false });

  screenEl.addEventListener('touchend', function () {
    if (touch && touch.axis === 'y' && Math.abs(touch.v) > 0.4) {
      flick = Math.max(-6, Math.min(6, touch.v));
      flickTimer = requestAnimationFrame(runFlick);
    }
    touch = null;
  }, { passive: true });
  screenEl.addEventListener('touchcancel', function () { touch = null; stopFlick(); }, { passive: true });

  // Trackpad/mouse wheel (desktop browser hitting the same UI): xterm handles
  // the wheel itself on the normal screen, but the transform-scaled host can
  // swallow it, so route it through the same path.
  screenEl.addEventListener('wheel', function (ev) {
    var cell = cellPx();
    if (!term || !cell) return;
    if (ev.cancelable) ev.preventDefault();
    var px = ev.deltaMode === 1 ? ev.deltaY * cell : ev.deltaY;
    var lines = px / cell;
    var whole = lines > 0 ? Math.ceil(lines) : Math.floor(lines);
    if (whole) scrollLines(whole);
  }, { passive: false });

  window.addEventListener('resize', applyScale);
  window.addEventListener('orientationchange', function () { setTimeout(applyScale, 150); });

  /* ---------- boot: fragment token -> cookie ---------- */

  (async function boot() {
    var m = /[#&]t=([^&]+)/.exec(location.hash || '');
    if (m) {
      try {
        await fetch('/api/auth', {
          method: 'POST', body: decodeURIComponent(m[1]), credentials: 'same-origin'
        });
      } catch (e) { /* fall through to the probe below */ }
      // The token must never reach history (or a screenshot of the URL bar).
      history.replaceState(null, '', location.pathname + location.search);
    }
    var r;
    try {
      r = await fetch('/api/sessions', { credentials: 'same-origin' });
    } catch (e) {
      banner('Server unreachable — retrying…', 'warn');
      setTimeout(boot, 2000);
      return;
    }
    if (r.status === 401 || r.status === 403) {
      banner('Not signed in — open the link from the QR code.', 'error');
      return;
    }
    if (r.ok) { try { sessions = await r.json(); } catch (e) {} }
    renderList();
    connect();
  })();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main);
  else main();
}
