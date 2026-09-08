#!/usr/bin/env node
// Private real-Electron regression runner. No production app, daemon or profile.
// AMBER_BROWSER_TEST_DIR=/persistent/evidence xvfb-run -a node scripts/verify-browser-interaction.cjs
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

if (!process.versions.electron) {
  const root = process.env.AMBER_BROWSER_TEST_DIR
  assert(root && path.isAbsolute(root), 'AMBER_BROWSER_TEST_DIR must be an absolute persistent evidence directory')
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const run = fs.mkdtempSync(path.join(root, 'fixture-'))
  fs.mkdirSync(path.join(run, 'home'), { mode: 0o700 })
  require('esbuild').buildSync({ entryPoints: [path.join(__dirname, '../src/main/browserAutomation.ts')], bundle: true,
    platform: 'node', format: 'cjs', outfile: path.join(run, 'adapter.cjs') })
  const env = { PATH: process.env.PATH, DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY,
    HOME: path.join(run, 'home'), XDG_CONFIG_HOME: path.join(run, 'config'), XDG_STATE_HOME: path.join(run, 'state'),
    XDG_CACHE_HOME: path.join(run, 'cache'), AMBER_BROWSER_FIXTURE_RUN: run }
  const result = require('node:child_process').spawnSync(require('electron'), ['--no-sandbox', __filename],
    { env, encoding: 'utf8', timeout: 45000, maxBuffer: 2 * 1024 * 1024 })
  fs.writeFileSync(path.join(run, 'electron.log'), (result.stdout || '') + (result.stderr || ''))
  process.stdout.write(result.stdout || '')
  console.log('Evidence:', run)
  if (result.error) console.error(result.error.message)
  if (result.status !== 0) process.stderr.write(result.stderr || '')
  process.exit(result.status ?? 1)
}

const { app, BrowserWindow } = require('electron')
const run = process.env.AMBER_BROWSER_FIXTURE_RUN
assert(run && path.isAbsolute(run), 'private fixture run directory required')
app.setPath('userData', path.join(run, 'profile'))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-background-networking')
let dumpPending = () => {}
const deadline = setTimeout(() => { dumpPending(); app.exit(2) }, 30000)
const { BrowserAutomation } = require(path.join(run, 'adapter.cjs'))
const cases = [
  { name: 'native select does not alter values when the page suppresses its popup', html: '<select aria-label="Rows" autofocus onmousedown="event.preventDefault()"><option value="20">Twenty</option><option value="50">Fifty</option><option value="90" selected>Ninety</option></select>', role: 'combobox', label: 'Rows', kind: 'select', values: ['50'], error: 'TARGET_NOT_ACTIONABLE', verify: 'document.querySelector("select").value', want: '90' },
  { name: 'native select preserves non-ASCII whitespace in default values', html: '<select aria-label="Rows"><option>Twenty</option><option>&nbsp;Fifty&nbsp;</option></select>', role: 'combobox', label: 'Rows', kind: 'select', values: ['\u00a0Fifty\u00a0'], verify: 'document.querySelector("select").value', want: '\u00a0Fifty\u00a0' },
  { name: 'native select refuses accessibility-only disabled options before input', html: '<select aria-label="Rows"><option value="20">Twenty</option><option value="50" aria-disabled="true">Fifty</option><option value="90">Ninety</option></select>', role: 'combobox', label: 'Rows', kind: 'select', values: ['90'], error: 'UNSUPPORTED_PAGE', verify: 'document.querySelector("select").value', want: '20' },
  { name: 'native select can submit search navigation on change', html: '<select aria-label="Rows" onchange="location.search=\'next=1\'"><option value="20">Twenty</option><option value="50">Fifty</option></select>', role: 'combobox', label: 'Rows', kind: 'select', values: ['50'], settleMs: 100, verify: 'location.search', want: '?next=1' },
  { name: 'native select commits one exact value with no intermediate changes', html: '<select aria-label="Rows" onchange="document.body.dataset.changed=(document.body.dataset.changed||\'\')+this.value+\',\'"><option value="20">Twenty</option><option value="50">Fifty</option><option value="90" selected>Ninety</option></select>', role: 'combobox', label: 'Rows', kind: 'select', values: ['50'], verify: 'document.body.dataset.changed', want: '50,' },
  { name: 'native select skips disabled options and groups', html: '<select aria-label="Rows"><option disabled value="x">Disabled</option><option value="20">Twenty</option><optgroup label="Disabled group" disabled><option value="30">Thirty</option></optgroup><option value="50">Fifty</option></select>', role: 'combobox', label: 'Rows', kind: 'select', values: ['50'], verify: 'document.querySelector("select").value', want: '50' },
  { name: 'native select rejects a missing value without changing selection', html: '<select aria-label="Rows"><option value="20">Twenty</option></select>', role: 'combobox', label: 'Rows', kind: 'select', values: ['missing'], error: 'TARGET_NOT_FOUND', verify: 'document.querySelector("select").value', want: '20' },
  { name: 'native select rejects ambiguous values', html: '<select aria-label="Rows"><option value="20">Twenty</option><option value="50">First fifty</option><option value="50">Second fifty</option></select>', role: 'combobox', label: 'Rows', kind: 'select', values: ['50'], error: 'TARGET_AMBIGUOUS', verify: 'document.querySelector("select").value', want: '20' },
  { name: 'native select detects option changes after preparation', html: '<select aria-label="Rows"><option value="20">Twenty</option><option value="50">Fifty</option></select>', role: 'combobox', label: 'Rows', kind: 'select', values: ['50'], afterPrepare: 'document.querySelectorAll("option")[1].textContent="Changed meaning"', error: 'STALE_GENERATION', verify: 'document.querySelector("select").value', want: '20' },
  { name: 'cancelled native select closes its popup without committing', html: '<select aria-label="Rows"><option value="20">Twenty</option><option value="50">Fifty</option></select>', role: 'combobox', label: 'Rows', kind: 'select', values: ['50'], cancelAfterPress: true, error: 'ACTION_CANCELLED', verify: 'document.querySelector("select").value', want: '20' },
  { name: 'native select supports option text as the default value', html: '<select aria-label="Rows"><option>Twenty</option><option> Fifty results </option></select>', role: 'combobox', label: 'Rows', kind: 'select', values: ['Fifty results'], verify: 'document.querySelector("select").value', want: 'Fifty results' },
  { name: 'native select chooses by option value', html: '<select aria-label="Rows" onchange="document.body.dataset.changed=this.value"><option value="20">Twenty results</option><option value="50">Fifty results</option></select>', role: 'combobox', label: 'Rows', kind: 'select', values: ['50'], verify: 'document.querySelector("select").value + ":" + document.body.dataset.changed', want: '50:50' },
  { name: 'transparent Wikipedia-style menu checkbox opens contents', html: '<style>#contents{display:none}#toggle:checked~#contents{display:block}</style><input id="toggle" type="checkbox" role="button" aria-label="Toggle contents" style="opacity:0"><label for="toggle">Contents</label><nav id="contents">Article sections</nav>', role: 'button', label: 'Toggle contents', kind: 'click', verify: 'document.querySelector("#toggle").checked && getComputedStyle(document.querySelector("#contents")).display === "block"', want: true },
  { name: 'transparent native radio receives selection', html: '<input type="radio" aria-label="Choice" style="opacity:0"><label>Choice</label>', role: 'radio', label: 'Choice', kind: 'click', verify: 'document.querySelector("input").checked', want: true },
  { name: 'transparent arbitrary button still rejects activation', html: '<button aria-label="Invisible" style="opacity:0" onclick="document.body.dataset.clicked=1">Invisible</button>', role: 'button', label: 'Invisible', kind: 'click', error: 'TARGET_NOT_ACTIONABLE', verify: 'Boolean(document.body.dataset.clicked)', want: false },
  { name: 'overlay removal between hit and ancestry inspection is recoverable', html: '<button aria-label="Search" onclick="document.body.dataset.clicked=\'yes\'">Search</button><div id="cover" style="position:fixed;inset:0;background:white;z-index:999"></div>', removeOnHit: true, role: 'button', label: 'Search', kind: 'click', verify: 'document.body.dataset.clicked', want: 'yes' },
  { name: 'cancelled hover clears its queued agent cursor', html: '<button aria-label="Search" onmouseover="document.body.dataset.hovered=\'yes\'">Search</button>', pointer: { kind: 'mouseMove', x: 250, y: 60 }, cancelAfterAnyMove: true, cursorHiddenOnCancel: true, error: 'ACTION_CANCELLED', verify: 'document.body.dataset.hovered', want: 'yes' },
  { name: 'Control A and Backspace preserve native selection', html: '<input aria-label="Search" value="potatoes" autofocus>', role: 'textbox', label: 'Search', kind: 'press', key: 'a', modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'], followups: [{ kind: 'press', key: 'Backspace' }], verify: 'document.querySelector("input").value', want: '' },
  { name: 'cancelled editing shortcut releases without replaying its command', html: '<input aria-label="Search" value="potatoes" autofocus>', role: 'textbox', label: 'Search', kind: 'press', key: 'a', modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'], cancelAfterKey: true, error: 'ACTION_CANCELLED', verify: 'document.querySelector("input").value', want: 'potatoes' },
  { name: 'failed semantic drag releases away from its source', html: '<button aria-label="Search" onmousedown="document.querySelector(\'#drop\').remove()" onclick="document.body.dataset.clicked=\'yes\'">Source</button><button id="drop" aria-label="Drop">Drop</button>', role: 'button', label: 'Search', kind: 'drag', error: 'TARGET_NOT_ACTIONABLE', verify: 'Boolean(document.body.dataset.clicked)', want: false },
  { name: 'Tab performs native focus traversal', html: '<input aria-label="Search" autofocus><input aria-label="Next">', role: 'textbox', label: 'Search', kind: 'press', key: 'Tab', verify: 'document.activeElement.getAttribute("aria-label")', want: 'Next' },
  { name: 'Shift Tab performs reverse native focus traversal', html: '<input aria-label="Search"><input aria-label="Next" autofocus>', role: 'textbox', label: 'Next', kind: 'press', key: 'Tab', modifiers: ['Shift'], verify: 'document.activeElement.getAttribute("aria-label")', want: 'Search' },
  { name: 'coordinate wheel scrolls its nested receiver', html: '<div id="scroll" style="margin:40px;width:420px;height:200px;overflow:auto"><div style="height:900px">Scrollable</div></div>', pointer: { kind: 'mouseScroll', x: 100, y: 100, deltaX: 0, deltaY: 300 }, settleMs: 100, verify: 'document.querySelector("#scroll").scrollTop>0', want: true },
  { name: 'cancelled drag stops intermediate movement and releases', html: '<canvas style="display:block;margin:40px;width:420px;height:200px" onmousemove="if(event.buttons===1)document.body.dataset.moves=1+Number(document.body.dataset.moves||0)" onmouseup="document.body.dataset.completed=\'yes\'"></canvas>', pointer: { kind: 'mouseDrag', path: [{ x: 250, y: 60 }, { x: 280, y: 80 }, { x: 310, y: 100 }] }, cancelAfterHeldMove: true, error: 'ACTION_CANCELLED', verify: 'Number(document.body.dataset.moves||0)<=1 && !document.body.dataset.completed', want: true },
  { name: 'partially clipped rotated control uses a visible interior point', html: '<button aria-label="Search" style="position:fixed;left:-380px;top:40px;margin:0;transform:rotate(8deg)" onclick="document.body.dataset.clicked=\'yes\'">Search</button>', role: 'button', label: 'Search', kind: 'click', verify: 'document.body.dataset.clicked', want: 'yes' },
  { name: 'moving control settles before activation', html: '<style>@keyframes slide{from{transform:translateX(0)}to{transform:translateX(200px)}}button{animation:slide .3s linear forwards}</style><button aria-label="Search" onclick="document.body.dataset.settled=String(Date.now()-window.started>=250)">Search</button><script>window.started=Date.now()</script>', role: 'button', label: 'Search', kind: 'click', verify: 'document.body.dataset.settled', want: 'true' },
  { name: 'disabled native control rejects activation', html: '<button aria-label="Search" disabled onclick="document.body.dataset.clicked=\'yes\'">Search</button>', role: 'button', label: 'Search', kind: 'click', error: 'TARGET_NOT_ACTIONABLE', verify: 'document.body.dataset.clicked', want: undefined },
  { name: 'unresolved frame focus fails closed for text', html: '<iframe tabindex="0" srcdoc="<input>"></iframe>', before: 'document.querySelector("iframe").focus()', pointer: { kind: 'typeFocused', text: 'potatoes' }, error: 'TARGET_NOT_ACTIONABLE', verify: 'document.querySelector("iframe").contentDocument.querySelector("input").value', want: '' },
  { name: 'native letter key inserts text', html: '<input aria-label="Search" autofocus>', role: 'textbox', label: 'Search', kind: 'press', key: 'a', verify: 'document.querySelector("input").value', want: 'a' },
  { name: 'Unicode focused input preserves combining and astral characters', html: '<input aria-label="Search" autofocus>', pointer: { kind: 'typeFocused', text: 'café 🥔 漢字 e\u0301' }, verify: 'document.querySelector("input").value', want: 'café 🥔 漢字 e\u0301' },
  { name: 'nested scroll container reveals its editable target', html: '<div style="height:120px;overflow:auto;margin:40px"><input aria-label="Search" style="margin-top:600px"></div>', role: 'textbox', label: 'Search', kind: 'fill', verify: 'document.querySelector("input").value', want: 'potatoes' },
  { name: 'opaque target pixel changes invalidate approval before dispatch', html: '<canvas style="display:block;margin:40px;width:420px;height:200px;background:red" onclick="document.body.dataset.clicked=\'yes\'"></canvas>', pointer: { kind: 'mouseClick', x: 250, y: 60 }, afterPrepare: 'document.querySelector("canvas").style.background="blue"', error: 'STALE_GENERATION', verify: 'document.body.dataset.clicked', want: undefined },
  { name: 'known button hover styling does not invalidate coordinate approval', html: '<style>button:hover{background:#ff3333}</style><button aria-label="Search" onclick="document.body.dataset.clicked=\'yes\'">Search</button>', pointer: { kind: 'mouseClick', x: 250, y: 60 }, verify: 'document.body.dataset.clicked', want: 'yes' },
  { name: 'cancelled click releases without an activation click', html: '<button aria-label="Search" onclick="document.body.dataset.clicked=\'yes\'">Search</button>', pointer: { kind: 'mouseClick', x: 250, y: 60 }, cancelAfterPress: true, error: 'ACTION_CANCELLED', verify: 'document.body.dataset.clicked', want: undefined },
  { name: 'navigation during focus cannot receive trailing fill text', html: '<input aria-label="Search">', role: 'textbox', label: 'Search', kind: 'fill', navigationRace: true, error: 'STALE_GENERATION', verify: 'document.querySelector("input").value', want: '' },
  { name: 'DPR 2 delivered pixels reach the pictured button', html: '<button aria-label="Search" style="background:#12ab34" onclick="document.body.dataset.clicked=\'yes\'">Search</button>', dpr: 2, pixel: true, pointer: { kind: 'mouseClick', x: 200, y: 120 }, verify: 'document.body.dataset.clicked', want: 'yes' },
  { name: 'fractional DPR delivered pixels reach the pictured button', html: '<button aria-label="Search" style="background:#12ab34" onclick="document.body.dataset.clicked=\'yes\'">Search</button>', dpr: 1.25, pixel: true, pointer: { kind: 'mouseClick', x: 125, y: 75 }, verify: 'document.body.dataset.clicked', want: 'yes' },
  { name: 'scrolled viewport screenshot coordinates stay viewport relative', html: '<button aria-label="Search" style="margin-top:1400px;background:#12ab34" onclick="document.body.dataset.clicked=\'yes\'">Search</button>', before: 'window.scrollTo(0,10000)', pixel: true, pointer: { kind: 'mouseClick', x: 100, y: 700 }, verify: 'document.body.dataset.clicked', want: 'yes' },
  { name: 'coordinate mouse click reaches native button', html: '<button aria-label="Search" onclick="document.body.dataset.clicked=\'yes\'">Search</button>', pointer: { kind: 'mouseClick', x: 250, y: 60 }, verify: 'document.body.dataset.clicked', want: 'yes' },
  { name: 'coordinate hover triggers page behavior', cursorVisible: true, html: '<button aria-label="Search" onmouseover="document.body.dataset.hovered=\'yes\'">Search</button>', pointer: { kind: 'mouseMove', x: 250, y: 60 }, verify: 'document.body.dataset.hovered', want: 'yes' },
  { name: 'canvas drag receives intermediate held-button moves', html: '<canvas style="display:block;margin:40px;width:420px;height:200px" onmousemove="if(event.buttons===1){document.body.dataset.moves=1+Number(document.body.dataset.moves||0);document.body.dataset.x=event.clientX;document.body.dataset.y=event.clientY}"></canvas>', pointer: { kind: 'mouseDrag', path: [{ x: 250, y: 60 }, { x: 280, y: 80 }, { x: 310, y: 100 }] }, verify: 'document.body.dataset.x+","+document.body.dataset.y+","+(Number(document.body.dataset.moves)>=2)', want: '310,100,true' },
  { name: 'focused typing reaches visually selected field', html: '<input aria-label="Search" autofocus>', pointer: { kind: 'typeFocused', text: 'potatoes' }, verify: 'document.querySelector("input").value', want: 'potatoes' },
  { name: 'Enter performs native form submission', html: '<form onsubmit="event.preventDefault();document.body.dataset.submitted=document.querySelector(\'input\').value"><input aria-label="Search" value="potatoes"></form>', role: 'textbox', label: 'Search', kind: 'press', key: 'Enter', verify: 'document.body.dataset.submitted', want: 'potatoes' },
  { name: 'late useful control survives generic-node budget pressure', assertTruncation: true, html: '<div></div>'.repeat(600) + '<input aria-label="Search">', role: 'textbox', label: 'Search', kind: 'fill', verify: 'document.querySelector("input").value', want: 'potatoes' },
  { name: 'fill replaces existing text rather than appending', html: '<input aria-label="Search" value="old value">', role: 'textbox', label: 'Search', kind: 'fill', verify: 'document.querySelector("input").value', want: 'potatoes' },
  { name: 'readonly field rejects typing', html: '<input aria-label="Search" readonly>', role: 'textbox', label: 'Search', kind: 'fill', error: 'TARGET_NOT_ACTIONABLE', verify: 'document.querySelector("input").value', want: '' },
  { name: 'offscreen field scrolls into view', html: '<input aria-label="Search" style="margin-top:1400px">', role: 'textbox', label: 'Search', kind: 'fill', verify: 'document.querySelector("input").value', want: 'potatoes' },
  { name: 'transient overlay disappears before click', html: '<button aria-label="Search" onclick="document.body.dataset.clicked=\'yes\'">Search</button><div id="cover" style="position:fixed;inset:0;background:white;z-index:999"></div><script>setTimeout(()=>document.querySelector("#cover").remove(),300)</script>', role: 'button', label: 'Search', kind: 'click', verify: 'document.body.dataset.clicked', want: 'yes' },
  { name: 'post form semantics survive missing describeNode parentId', html: '<form method="post"><button type="button" aria-label="Search" onclick="document.body.dataset.clicked=\'yes\'">Search</button></form>', role: 'button', label: 'Search', kind: 'click', formMethod: 'post', verify: 'document.body.dataset.clicked', want: 'yes' },
  { name: 'native textarea receives text', html: '<textarea aria-label="Search"></textarea>', role: 'textbox', label: 'Search', kind: 'fill',
    verify: 'document.querySelector("textarea").value', want: 'potatoes' },
  { name: 'native input receives text', html: '<input aria-label="Search">', role: 'textbox', label: 'Search', kind: 'fill',
    verify: 'document.querySelector("input").value', want: 'potatoes' },
  { name: 'nested button receives click', html: '<button aria-label="Search" onclick="document.body.dataset.clicked=\'yes\'"><span>Nested label</span></button>', role: 'button', label: 'Search', kind: 'click',
    verify: 'document.body.dataset.clicked', want: 'yes' },
  { name: 'author shadow descendant receives click', html: '<x-button role="button" aria-label="Search" onclick="document.body.dataset.clicked=\'yes\'"></x-button><script>document.querySelector("x-button").attachShadow({mode:"open"}).innerHTML="<span style=\'display:block;width:100%;height:100%\'>Shadow label</span>"</script>', role: 'button', label: 'Search', kind: 'click',
    verify: 'document.body.dataset.clicked', want: 'yes' },
  { name: 'real overlay prevents activation', html: '<button aria-label="Search" onclick="document.body.dataset.clicked=\'yes\'">Search</button><div style="position:fixed;inset:0;background:white;z-index:999" onclick="document.body.dataset.coverClicked=\'yes\'"></div>', role: 'button', label: 'Search', kind: 'click', error: 'TARGET_OCCLUDED',
    verify: 'Boolean(document.body.dataset.clicked || document.body.dataset.coverClicked)', want: false },
  { name: 'nested submit performs actual form action', html: '<form onsubmit="event.preventDefault();document.body.dataset.submitted=\'yes\'"><button aria-label="Search" type="submit"><span>Search</span></button></form>', role: 'button', label: 'Search', kind: 'click',
    verify: 'document.body.dataset.submitted', want: 'yes' },
]
app.whenReady().then(async () => {
  const server = require('node:http').createServer((request, response) => {
    const index = Number(request.url.split('?')[0].slice(1))
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><style>textarea,input,button,x-button{display:block;margin:40px;width:420px;height:44px}</style>' + (request.url.includes('?next=1') ? '<input aria-label="New page" autofocus>' : cases[index]?.html ?? ''))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  const win = new BrowserWindow({ width: 1000, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const wc = win.webContents, debuggerApi = wc.debugger, trace = []
  let activeTest, activeController, documentEpoch = 0, requestCount = 0
  const pendingCommands = new Map()
  let commandSequence = 0
  dumpPending = () => fs.writeFileSync(path.join(run, 'timeout.json'), JSON.stringify({ test: activeTest?.name, pending: [...pendingCommands.values()], trace }, null, 2))
  wc.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (_event.isMainFrame ?? isMainFrame) documentEpoch++ })
  const transport = {
    isAttached: () => debuggerApi.isAttached(), attach: version => debuggerApi.attach(version), detach: () => debuggerApi.detach(),
    onMessage: listener => debuggerApi.on('message', (_event, method, params) => { if (method.startsWith('DOM.')) trace.push({ method, params }); listener(method, params) }),
    send: async (method, params) => {
      requestCount++
      const commandId = ++commandSequence
      pendingCommands.set(commandId, { method, params })
      try {
        const result = await debuggerApi.sendCommand(method, params)
        if (activeTest?.removeOnHit && method === 'DOM.getNodeForLocation') await wc.executeJavaScript('document.querySelector("#cover")?.remove()')
        if (activeTest?.cancelAfterKey && method === 'Input.dispatchKeyEvent' && params.type === 'keyDown') activeController.abort()
        if (activeTest?.cancelAfterPress && method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') activeController.abort()
        if (activeTest?.cancelAfterAnyMove && method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') activeController.abort()
        if (activeTest?.cancelAfterHeldMove && method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved' && params.buttons === 1) activeController.abort()
        if (activeTest?.navigationRace && method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') await wc.loadURL(origin + '/' + cases.indexOf(activeTest) + '?next=1')
        if (method.startsWith('Input.') || ['DOM.getNodeForLocation', 'DOM.describeNode', 'DOM.getBoxModel', 'Page.getLayoutMetrics'].includes(method)) trace.push({ method, params, result })
        return result
      } catch (error) {
        trace.push({ method, params, error: error.message })
        throw error
      } finally { pendingCommands.delete(commandId) }
    },
  }
  const automation = new BrowserAutomation(transport, () => wc.getURL(), () => wc.isLoading(), {}, { deviceScaleFactor: () => require('electron').screen.getDisplayMatching(win.getBounds()).scaleFactor })
  const results = []
  try {
    for (const [index, test] of cases.entries()) {
      trace.length = 0; requestCount = 0
      activeTest = test
      await wc.loadURL(origin + '/' + index)
      activeController = new AbortController()
      const signal = activeController.signal
      const lease = { browserId: 'private-fixture', pageIncarnation: 'fixture', generation: index }
      const started = Date.now()
      let error, errorMessage
      try {
        await automation.setViewport({ width: 1000, height: 772, deviceScaleFactor: test.dpr ?? 1 }, signal)
        if (test.before) await wc.executeJavaScript(test.before)
        const startEpoch = documentEpoch
        let operation
        if (test.pointer) {
          const capture = await automation.screenshot(lease, undefined, false, signal)
          assert(capture.observation, 'missing screenshot coordinate observation')
          if (test.pixel) {
            const image = require('electron').nativeImage.createFromBuffer(capture.data), bitmap = image.toBitmap()
            const offset = (Math.floor(test.pointer.y) * image.getSize().width + Math.floor(test.pointer.x)) * 4
            fs.writeFileSync(path.join(run, `pixels-${index}.png`), capture.data)
            fs.writeFileSync(path.join(run, `pixels-${index}.json`), JSON.stringify({ png: [capture.data.readUInt32BE(16), capture.data.readUInt32BE(20)], native: image.getSize(), bitmapLength: bitmap.length, pixel: [...bitmap.subarray(offset, offset + 3)] }))
            // Display-P3 encodes the CSS green differently on fractional-DPR macOS
            // captures. Require the unique green region, not one RGB encoding.
            const [b, g, r] = bitmap.subarray(offset, offset + 3)
            assert(g > 150 && r < 100 && b < 100, 'requested delivered-image pixel must picture the green target')
          }
          operation = { ...test.pointer, screenshotId: capture.observation.screenshotId }
        } else {
          const snapshot = await automation.snapshot(lease, { maxDepth: 20, maxNodes: 100, maxBytes: 262144 }, signal)
          if (test.assertTruncation) assert(snapshot.truncated && snapshot.truncationReasons?.length, 'a bounded partial snapshot must explain its truncation')
          const node = snapshot.nodes.find(item => item.role === test.role && item.name === test.label)
          assert(node, 'fixture target missing')
          operation = { kind: test.kind, target: { snapshotId: snapshot.snapshotId, ref: node.ref }, ...(test.kind === 'fill' ? { text: 'potatoes' } : {}), ...(test.key ? { key: test.key } : {}), ...(test.modifiers ? { modifiers: test.modifiers } : {}), ...(test.values ? { values: test.values } : {}) }
        }
        if (test.kind === 'drag') {
          const snapshot = await automation.snapshot(lease, { maxDepth: 20, maxNodes: 100, maxBytes: 262144 }, signal)
          const source = snapshot.nodes.find(item => item.name === 'Search'), target = snapshot.nodes.find(item => item.name === 'Drop')
          assert(source && target)
          operation = { kind: 'drag', source: { snapshotId: snapshot.snapshotId, ref: source.ref }, target: { snapshotId: snapshot.snapshotId, ref: target.ref } }
        }
        const prepared = await automation.prepareInteraction(lease, operation, signal)
        if (test.formMethod) assert.equal(prepared.target.formMethod, test.formMethod)
        if (test.afterPrepare) await wc.executeJavaScript(test.afterPrepare)
        await automation.executeInteraction(prepared, signal, (_dispatched, phase) => documentEpoch === startEpoch || phase === 'cleanup' || phase === 'finish')
        for (const followup of test.followups ?? []) {
          const next = await automation.prepareInteraction(lease, { ...followup, target: operation.target }, signal)
          await automation.executeInteraction(next, signal, (_dispatched, phase) => documentEpoch === startEpoch || phase === 'cleanup' || phase === 'finish')
        }
        if (test.cursorVisible) {
          const amberPixel = image => {
            const bitmap = image.toBitmap(), size = image.getSize()
            const offset = (Math.floor((test.pointer.y + 3) * size.height / 772) * size.width + Math.floor((test.pointer.x + 3) * size.width / 1000)) * 4
            const [b, g, r] = bitmap.subarray(offset, offset + 3)
            return r > 220 && g > 120 && g < 210 && b < 110
          }
          const waitForCursor = async () => {
            const until = Date.now() + 500
            let image
            do { await new Promise(resolve => setTimeout(resolve, 25)); image = await wc.capturePage() }
            while (!amberPixel(image) && Date.now() < until)
            return image
          }
          const visible = await waitForCursor()
          fs.writeFileSync(path.join(run, 'visible-cursor.png'), visible.toPNG())
          assert(amberPixel(visible), 'native page capture must visibly contain the agent cursor')
          const hidden = await automation.screenshot(lease, undefined, false, signal)
          assert(!amberPixel(require('electron').nativeImage.createFromBuffer(hidden.data)), 'observation must omit the agent cursor')
          assert(amberPixel(await waitForCursor()), 'same-owner cursor must return after capture')
        }
      } catch (failure) { error = failure.code || failure.message; errorMessage = failure.message }
      // Evaluation is confined to our own fixture for outcome assertions, never exposed through the adapter/tools.
      if (test.navigationRace) {
        const until = Date.now() + 3000
        while ((!wc.getURL().includes('?next=1') || wc.isLoadingMainFrame()) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20))
      }
      if (test.cursorHiddenOnCancel) {
        await new Promise(resolve => setTimeout(resolve, 250))
        const image = await wc.capturePage(), bitmap = image.toBitmap()
        const size = image.getSize()
        const offset = (Math.floor((test.pointer.y + 3) * size.height / 772) * size.width + Math.floor((test.pointer.x + 3) * size.width / 1000)) * 4
        const [b, g, r] = bitmap.subarray(offset, offset + 3)
        if (r > 220 && g > 120 && g < 210 && b < 110) error = 'CURSOR_NOT_CLEARED'
      }
      if (test.cancelAfterKey) {
        const release = trace.findLast(item => item.method === 'Input.dispatchKeyEvent' && item.params?.type === 'keyUp')
        if (JSON.stringify(release?.params?.commands) !== '[]') error = 'EDIT_COMMAND_REPLAY_ON_RELEASE'
      }
      if (test.settleMs) await new Promise(resolve => setTimeout(resolve, test.settleMs))
      const actual = await wc.executeJavaScript(test.verify)
      const pass = error === test.error && actual === test.want
      const diagnostics = pass ? undefined : await wc.executeJavaScript('({url:location.href,focus:document.activeElement.tagName,selection:document.activeElement.selectionStart})')
      results.push({ name: test.name, pass, error: error ?? null, actual: actual ?? null, expected: test.want, elapsedMs: Date.now() - started, adapterRequests: requestCount, diagnostics, ...(errorMessage ? { errorMessage } : {}) })
      fs.writeFileSync(path.join(run, `trace-${index}.json`), JSON.stringify(trace, null, 2))
      console.log(JSON.stringify(results.at(-1)))
    }
  } finally {
    automation.dispose(); win.destroy(); server.close(); clearTimeout(deadline)
    fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(results, null, 2))
  }
  app.exit(results.length === cases.length && results.every(result => result.pass) ? 0 : 1)
}).catch(error => { console.error(error); app.exit(1) })
