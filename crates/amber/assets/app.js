/* amber web — phone client. No framework, no bundler, no CDN.
 *
 * Contract (server):
 *   POST /api/auth      body = token (from the URL fragment) -> HttpOnly cookie
 *   GET  /api/sessions  -> {sessions:[{name, kind, cwd, run_state, alive, title?}], layout}
 *   GET  /ws            JSON TEXT control frames + raw BINARY pty bytes
 *     up:   {t:'open',name} | {t:'close',name} | {t:'set-title',name,title} | BINARY = input bytes
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

var idCounter = 0;
function makeId() {
  idCounter = (idCounter + 1) % 0xffff;
  // Time + counter: unique within a page load, no crypto needed.
  return (Date.now().toString(36) + idCounter.toString(36)).replace(/[^a-z0-9]/g, '');
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
  var filterEl = $('session-filter');
  var wsBarEl = $('ws-bar'), tabBarEl = $('tab-bar'), mosaicEl = $('mosaic');
  var screenEl = $('screen'), sizerEl = $('sizer'), stageEl = $('stage'), hostEl = $('host');
  var titleEl = $('term-title'), ctrlBtn = $('k-ctrl');

  var ws = null;
  var attempt = 0;
  var reconnectTimer = 0;
  var sessions = [];
  var layout = null;      // server-rendered mosaic, or null (fall back to the flat list)
  var frozen = {};        // paneId -> true, rebuilt from layout.frozen on every push
  var curWs = null;       // selected workspace id, null = follow the server's activeWorkspace
  var curTab = null;      // selected tab id within curWs
  var filterQuery = '';
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

  /* ---------- session list / mosaic ---------- */

  // Dispatcher: the flat list when the server has no sidecar (or it renders
  // to no workspaces at all), the workspace/tab/tile mosaic otherwise.
  function renderList() {
    countEl.textContent = sessions.length ? sessions.length + ' session' + (sessions.length === 1 ? '' : 's') : '';
    if (filterQuery.trim()) {
      wsBarEl.hidden = tabBarEl.hidden = mosaicEl.hidden = true;
      listEl.hidden = false;
      return renderFlatList();
    }
    frozen = {};
    (layout && layout.frozen || []).forEach(function (name) { frozen[name] = true; });
    if (!layout || !layout.workspaces || !layout.workspaces.length) {
      wsBarEl.hidden = tabBarEl.hidden = mosaicEl.hidden = true;
      listEl.hidden = false;
      return renderFlatList();
    }
    listEl.hidden = true;
    wsBarEl.hidden = tabBarEl.hidden = mosaicEl.hidden = false;

    // Resolve the selection against what the server actually sent — the desktop
    // can close the ws/tab we were looking at at any moment.
    var wss = layout.workspaces;
    var ws = wss.filter(function (w) { return w.ws === curWs; })[0];
    if (!ws) ws = wss.filter(function (w) { return w.ws === layout.activeWorkspace; })[0] || wss[0];
    curWs = ws.ws;
    var tab = ws.tabs.filter(function (t) { return t.tab === curTab; })[0];
    if (!tab) tab = ws.tabs.filter(function (t) { return t.tab === ws.activeTab; })[0] || ws.tabs[0];
    curTab = tab.tab;

    renderWsBar(wss, ws);
    renderTabBar(ws, tab);
    mosaicEl.textContent = '';
    mosaicEl.appendChild(renderNode(tab.tree));

    // Panes this client asked for that the server has not confirmed yet.
    Object.keys(pending).forEach(function (name) {
      var p = parseName(name);
      if (!p || p.ws !== curWs || p.tab !== curTab) return;
      if (sessionByName(name)) { delete pending[name]; return; }
      var ph = document.createElement('div');
      ph.className = 'tile pending';
      ph.textContent = 'starting…';
      mosaicEl.appendChild(ph);
    });
  }

  function pill(text, on, click) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'pill' + (on ? ' on' : '');
    b.textContent = text;
    b.addEventListener('click', click);
    return b;
  }

  function renderWsBar(wss, cur) {
    wsBarEl.textContent = '';
    wss.forEach(function (w) {
      wsBarEl.appendChild(pill(w.label || ('ws ' + w.ws), w.ws === cur.ws, function () {
        curWs = w.ws; curTab = null; renderList();
      }));
    });
  }

  function renderTabBar(ws, cur) {
    tabBarEl.textContent = '';
    ws.tabs.forEach(function (t) {
      tabBarEl.appendChild(pill(t.label || ('tab ' + t.tab), t.tab === cur.tab, function () {
        curTab = t.tab; renderList();
      }));
    });

    var add = pill('+ pane', false, function () {
      var kind = window.prompt('kind: shell, claude, grok, codex, opencode, hermes or pi', 'shell');
      if (!kind) return;
      var s = sessionByName(firstPaneOf(ws, cur)) || sessions[0];
      newPane(kind.trim(), (s && s.cwd) || '/');
    });
    add.classList.add('pill-add');
    tabBarEl.appendChild(add);
  }

  // cwd for a new pane: the tab's first pane, falling back to any session.
  function firstPaneOf(ws, tab) {
    var found = null;
    (function walk(n) {
      if (!n || found) return;
      if (n.kind === 'leaf') { found = n.paneId; return; }
      walk(n.a); walk(n.b);
    })(tab.tree);
    return found;
  }

  // The tree the server sent, drawn as nested flexbox at its real ratios.
  function renderNode(n) {
    if (!n) return document.createElement('div');
    if (n.kind === 'leaf') return tile(n.paneId);
    var box = document.createElement('div');
    box.className = 'split ' + (n.dir === 'v' ? 'v' : 'h');
    var a = renderNode(n.a), b = renderNode(n.b);
    var r = Math.min(0.95, Math.max(0.05, n.ratio || 0.5));
    a.style.flex = r; b.style.flex = 1 - r;
    box.appendChild(a); box.appendChild(b);
    return box;
  }

  function sessionByName(name) {
    return sessions.filter(function (x) { return x.name === name; })[0] || null;
  }

  function sessionKindLabel(kind) {
    return kind || 'shell';
  }

  function sessionTitle(s) {
    return s && s.title && s.title.trim() ? s.title.trim() : shortCwd(s ? s.cwd : '');
  }

  function matchesFilter(s) {
    var q = filterQuery.trim().toLowerCase();
    if (!q) return true;
    return [s.title, s.cwd, s.name, s.kind].filter(Boolean).join(' ').toLowerCase().indexOf(q) >= 0;
  }

  // Lowest ord not taken by a live session in this ws/tab. Needs the live
  // `sessions` closure, so unlike `parseName`/`makeId` this can't be a
  // top-level pure helper.
  function freeOrd(ws, tab) {
    var used = {};
    sessions.forEach(function (s) {
      var p = parseName(s.name);
      if (p && p.ws === ws && p.tab === tab) used[p.ord] = true;
    });
    var n = 0;
    while (used[n]) n++;
    return n;
  }

  function paneName(ws, tab, ord, id) {
    return 'amber-' + ws + '-' + tab + '-' + ord + '-' + (id || makeId());
  }

  function tile(paneId) {
    var s = sessionByName(paneId);
    var isFrozen = !!frozen[paneId];
    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'tile' + (s && !s.alive ? ' dead' : '') + (isFrozen ? ' frozen' : '');
    el.dataset.pane = paneId;
    if (!s) { el.textContent = paneId; return el; }   // server/session race — next push fixes it

    var head = document.createElement('span');
    head.className = 'tile-head';
    var slot = document.createElement('span');
    slot.className = 'tile-slot';
    slot.textContent = s.slot ? '#' + s.slot : '';
    var dot = document.createElement('span');
    dot.className = 'dot k-' + (s.kind || 'shell');
    dot.title = s.kind || 'shell';
    head.appendChild(slot);
    head.appendChild(dot);
    if (isFrozen) {
      // Display-only (spec §6.1: the mosaic shows it, cannot change it); the
      // tile stays tappable — a shell freeze is display-only on the daemon too.
      var fz = document.createElement('span');
      fz.className = 'tile-frozen';
      fz.textContent = '❄';
      fz.title = 'frozen';
      head.appendChild(fz);
    }

    var title = document.createElement('span');
    title.className = 'tile-title';
    title.textContent = sessionTitle(s);

    var tag = document.createElement('span');
    tag.className = 'tile-tag';
    tag.textContent = !s.alive ? 'exited'
      : (s.run_state && s.run_state !== 'claude') ? s.run_state
      : (s.kind || 'shell');

    var menu = document.createElement('span');
    menu.className = 'tile-menu';
    menu.textContent = '⋯';
    menu.addEventListener('click', function (e) {
      e.stopPropagation();          // don't open the terminal
      var agent = s.kind === 'claude' || s.kind === 'grok' || s.kind === 'codex' || s.kind === 'opencode' || s.kind === 'hermes' || s.kind === 'pi';
      var choices = ['title', 'close'];
      if (agent) choices.push(s.run_state === 'suspended' ? 'unfreeze' : 'freeze');
      choices.push('move to tab…');
      var pick = window.prompt(paneId + '\n' + choices.join(' / '), choices[0]);
      if (pick === 'title') {
        var nextTitle = window.prompt('friendly title (blank clears)', s.title || '');
        if (nextTitle !== null) control({ t: 'set-title', name: paneId, title: nextTitle });
      } else if (pick === 'close') killPane(paneId);
      else if (pick === 'freeze') setFrozen(paneId, true);
      else if (pick === 'unfreeze') setFrozen(paneId, false);
      else if (pick && pick.indexOf('move') === 0) {
        var t = window.prompt('move to tab number', String(curTab));
        if (t === null) return;
        var tabNum = parseInt(t, 10);
        if (isNaN(tabNum)) { banner('invalid tab number', 'warn'); return; }
        movePane(paneId, curWs, tabNum);
      }
    });
    head.appendChild(menu);

    el.appendChild(head);
    el.appendChild(title);
    el.appendChild(tag);
    el.addEventListener('click', function () { openSession(paneId); });
    return el;
  }

  function renderFlatList() {
    listEl.textContent = '';
    var visible = sessions.filter(matchesFilter);
    if (!visible.length) {
      var empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = sessions.length ? 'No matching panes.' : 'No sessions. Start one from the desktop app.';
      listEl.appendChild(empty);
      return;
    }
    if (!sessions.length) {
      var empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No sessions. Start one from the desktop app.';
      listEl.appendChild(empty);
      return;
    }
    var groups = new Map();
    visible.forEach(function (s) {
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
    t.textContent = (s.title && s.title.trim()) || sessionKindLabel(s.kind) + (p ? ' · pane ' + p.ord : ' · ' + s.name);
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
      allowProposedApi: true,
      // No WebGL addon (mobile GPU variance) — xterm's DOM renderer is fine here.
    });
    // Match modern TUI cell widths (notably emoji-presentation sequences such
    // as ❤️). Without this, OpenTUI's absolute-column diffs leave stale glyphs.
    term.loadAddon(new window.UnicodeGraphemesAddon.UnicodeGraphemesAddon());
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
    // Fit-to-width SHRINKS a grid too wide for the screen; it must never
    // MAGNIFY one that already fits. This started as a phone-only client, where
    // fit-width is always < 1 and the clamp is invisible. On a laptop it
    // inverts: an 80-col session is ~640px natural against a 1440px viewport,
    // so the old unclamped `clientWidth / w` blew it up 2.25x and the text came
    // out huge. Cap the baseline at 1 = natural cell size; `zoom` is still the
    // user's override in both directions.
    var scale = Math.min(screenEl.clientWidth / w, 1) * zoom;
    stageEl.style.transform = 'scale(' + scale + ')';
    sizerEl.style.width = w * scale + 'px';
    sizerEl.style.height = h * scale + 'px';
    // Centring is already handled by `#sizer { margin: auto }` in style.css.
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
    titleEl.textContent = sessionTitle(sessionByName(name)) || name;
    viewList.hidden = true;
    viewTerm.hidden = false;
    send({ t: 'focus', name: name });
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

  /* ---------- pane gestures ---------- */
  // create/kill/move/set-title/suspend/resume are the ONLY browser messages the server
  // accepts (Task 4's whitelist in web.rs); everything else it silently
  // ignores. Deliberately no `resize` here and none is ever added — a pty's
  // winsize is shared with the desktop app's panes.

  function control(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  // The tree is NEVER edited locally (core rule: the mosaic is server-driven,
  // per Task 5) — the server's next `sessions` push is the only thing that
  // adds, removes or moves a pane. `pending` only draws a placeholder tile so
  // a tap feels answered; it never touches `layout`.
  var pending = {};   // paneName -> expiry ms

  var CREATE_KINDS = { shell: 1, claude: 1, grok: 1, codex: 1, opencode: 1, hermes: 1, pi: 1 };

  function newPane(kind, cwd) {
    // Mirrors the server's CREATE_KINDS check (web.rs) so a bad kind banners
    // instead of silently no-opping.
    if (!CREATE_KINDS[kind]) { banner('kind must be shell, claude, grok, codex, opencode, hermes or pi', 'warn'); return; }
    var name = paneName(curWs, curTab, freeOrd(curWs, curTab));
    pending[name] = Date.now() + 3000;
    control({ t: 'create', name: name, cwd: cwd, kind: kind });
    renderList();
    setTimeout(function () { delete pending[name]; renderList(); }, 3000);
  }

  function killPane(name) { control({ t: 'kill', name: name }); }

  function movePane(name, ws, tab) {
    var p = parseName(name);
    if (!p) return;
    if (ws === p.ws && tab === p.tab) return; // no-op move: don't kill+respawn a live agent for nothing
    control({ t: 'move', from: name, to: paneName(ws, tab, freeOrd(ws, tab), p.id) });
  }

  // suspend/resume are refused server-side for anything that isn't an agent
  // kind; gated client-side too (see the `agent` check in `tile()`'s menu) so
  // the control is never even offered on a shell pane.
  function setFrozen(name, frozen) {
    control({ t: frozen ? 'suspend' : 'resume', name: name });
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
      if (msg.t === 'sessions') {
        sessions = msg.sessions || []; layout = msg.layout || null;
        if (open) titleEl.textContent = sessionTitle(sessionByName(open)) || open;
        renderList(); syncGeom();
      }
      else if (msg.t === 'exit') {
        if (msg.name === open && term) term.write('\r\n\x1b[33m[session exited: ' + msg.code + ']\x1b[0m\r\n');
      } else if (msg.t === 'error') {
        // `Hub::error_msg` (web.rs) broadcasts to EVERY connected client with
        // no correlation id — with two phones/tabs open, a gesture rejected
        // for one shows this toast on both. Accepted, out of scope here.
        banner(msg.msg || 'error', 'warn');
        setTimeout(function () { banner(''); }, 6000);
      }
    };

    ws.onclose = function () {
      var d = backoffMs(attempt++);
      banner('Disconnected — reconnecting…', 'warn');
      reconnectTimer = setTimeout(connect, d);
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  /* ---------- wiring ---------- */

  filterEl.addEventListener('input', function () {
    filterQuery = filterEl.value || '';
    if (filterQuery.trim()) {
      wsBarEl.hidden = tabBarEl.hidden = mosaicEl.hidden = true;
      listEl.hidden = false;
      renderFlatList();
    } else {
      renderList();
    }
  });
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
    if (r.ok) {
      try {
        var d = await r.json();
        sessions = (d && d.sessions) || [];
        layout = (d && d.layout) || null;
      } catch (e) {}
    }
    renderList();
    connect();
  })();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main);
  else main();
}
