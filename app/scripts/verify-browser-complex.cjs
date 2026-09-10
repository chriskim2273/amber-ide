#!/usr/bin/env node
// Complex-flow probe: JS dialogs, file inputs, iframe targets, contenteditable,
// hover menus, drag, scroll-into-view, networkIdle wait — against the REAL adapter.
// Private real-Electron runner. No production app, daemon or profile.
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
    { env, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
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
const deadline = setTimeout(() => { dumpPending(); app.exit(2) }, 45000)
const { BrowserAutomation } = require(path.join(run, 'adapter.cjs'))

const sleep = ms => new Promise(r => setTimeout(r, ms))
const page = index => `<!doctype html><style>textarea,input,button,x-button,select{display:block;margin:40px;width:420px;height:44px}</style>${PAGES[index]?.html ?? ''}`

const PAGES = [
  // 0: alert() from a click
  { name: 'alert dialog blocks then auto-dismisses when coordinator rejects', html: `<button aria-label="Search" onclick="alert('hello'); document.body.dataset.after='yes'">Search</button>`, op: { kind: 'click' }, label: 'Search', role: 'button', want: { error: null, verify: 'document.body.dataset.after', value: 'yes' } },
  // 1: confirm() decide accept
  { name: 'confirm dialog with accept coordinator', html: `<button aria-label="Search" onclick="document.body.dataset.answer=confirm('proceed?') ? 'accepted' : 'rejected'; document.body.dataset.after='yes'">Search</button>`, op: { kind: 'click' }, label: 'Search', role: 'button', dialogDecision: { accept: true }, want: { error: null, verify: 'document.body.dataset.answer', value: 'accepted' } },
  // 2: prompt() with text
  { name: 'prompt dialog returns coordinator text', html: `<button aria-label="Search" onclick="const r = prompt('name?'); document.body.dataset.answer = r === null ? 'null' : r; document.body.dataset.after='yes'">Search</button>`, op: { kind: 'click' }, label: 'Search', role: 'button', dialogDecision: { accept: true, promptText: 'amber' }, want: { error: null, verify: 'document.body.dataset.answer', value: 'amber' } },
  // 3: beforeunload via click→location
  { name: 'beforeunload dialog while navigating away', html: `<button aria-label="Search" onclick="window.addEventListener('beforeunload', e => { e.preventDefault(); e.returnValue = 'stay?' }); location.href = '/after-unload'">Search</button>`, op: { kind: 'click' }, label: 'Search', role: 'button', dialogDecision: { accept: true }, settleMs: 1200, want: { error: null, verify: 'location.pathname', value: '/after-unload' } },
  // 4: FILE INPUT click — wedge risk: native picker
  { name: 'file input click never opens a native picker', html: `<input type="file" aria-label="Upload">`, op: { kind: 'click' }, label: 'Upload', role: 'button', want: { error: 'TARGET_NOT_ACTIONABLE', verify: 'true', value: true } },
  // 5: iframe-internal button (cross-frame target)
  { name: 'iframe-internal button is reachable', html: `<iframe srcdoc="<button aria-label='Inner' onclick=\"parent.document.body.dataset.inner='yes'\">Inner</button>" style="width:420px;height:100px"></iframe>`, op: { kind: 'click' }, label: 'Inner', role: 'button', want: { error: null, verify: 'document.body.dataset.inner', value: 'yes' } },
  // 6: contenteditable (role generic in Chromium — fixed)
  { name: 'contenteditable receives fill', html: `<div contenteditable="true" aria-label="Note">before</div>`, op: { kind: 'fill', text: 'amber' }, label: 'Note', role: 'generic', want: { error: null, verify: 'document.querySelector("div[contenteditable]").textContent', value: 'amber' } },
  // 7: hover menu — hover the trigger, then the revealed item becomes actionable
  { name: 'hover trigger reveals a clickable item', html: `<div aria-label="Menu trigger" onmouseover="document.querySelector('#item').style.display='block'" style="width:420px;height:44px">Hover me</div><button id="item" aria-label="Revealed" style="display:none" onclick="document.body.dataset.revealed='yes'">Revealed</button>`, op: { kind: 'hover' }, label: 'Menu trigger', role: 'button', thenHover: 'Revealed', thenClick: 'Revealed', want: { error: null, verify: 'document.body.dataset.revealed', value: 'yes' } },
  // 8: drag between two elements (HTML5 DnD)
  { name: 'drag moves pointer from source to drop', html: `<div aria-label="Source" draggable="true" ondragstart="event.dataTransfer.setData('text/plain','x')" ondragover="event.preventDefault()" ondrop="document.body.dataset.dropped='yes'" style="width:420px;height:44px">Source</div><div aria-label="Drop" ondragover="event.preventDefault()" ondrop="document.body.dataset.dropped='yes'" style="margin:80px;width:420px;height:44px">Drop</div>`, op: { kind: 'drag' }, source: 'Source', label: 'Drop', role: 'generic', want: { error: null, verify: 'document.body.dataset.dropped', value: 'yes' } },
  // 9: scroll-into-view click (button far below fold)
  { name: 'click after scroll-into-view', html: `<div style="height:3000px">spacer</div><button aria-label="Deep" onclick="document.body.dataset.deep='yes'">Deep</button>`, op: { kind: 'click' }, label: 'Deep', role: 'button', want: { error: null, verify: 'document.body.dataset.deep', value: 'yes' } },
  // 10: networkIdle wait
  { name: 'networkIdle settles after fetch completes', html: `<button aria-label="Search" onclick="fetch('/slow').then(()=>document.body.dataset.done='yes')">Search</button>`, op: { kind: 'click' }, label: 'Search', role: 'button', thenWait: { kind: 'networkIdle' }, want: { error: null, verify: 'document.body.dataset.done', value: 'yes' } },
]

app.whenReady().then(async () => {
  const server = require('node:http').createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    if (request.url === '/slow') return setTimeout(() => response.end('ok'), 300)
    response.end(page(Number(request.url.split('?')[0].slice(1))))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  const win = new BrowserWindow({ width: 1000, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const wc = win.webContents, debuggerApi = wc.debugger, trace = []
  let activeTest, activeController, documentEpoch = 0, requestCount = 0
  const pendingCommands = new Map(); let commandSequence = 0
  dumpPending = () => fs.writeFileSync(path.join(run, 'timeout.json'), JSON.stringify({ test: activeTest?.name, pending: [...pendingCommands.values()], trace }, null, 2))
  wc.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (_event.isMainFrame ?? isMainFrame) documentEpoch++ })
  const transport = {
    isAttached: () => debuggerApi.isAttached(), attach: version => debuggerApi.attach(version), detach: () => debuggerApi.detach(),
    onMessage: listener => debuggerApi.on('message', (_event, method, params) => { if (method.startsWith('DOM.')) trace.push({ method, params }); listener(method, params) }),
    send: async (method, params) => {
      requestCount++
      const commandId = ++commandSequence
      pendingCommands.set(commandId, { method, params })
      try { return await debuggerApi.sendCommand(method, params) } catch (error) { trace.push({ method, params, error: error.message }); throw error } finally { pendingCommands.delete(commandId) }
    },
  }
  let dialogHandler = null
  const automation = new BrowserAutomation(transport, () => wc.getURL(), () => wc.isLoading(), {}, { deviceScaleFactor: () => 1, dialog: async (dialog) => { if (dialogHandler) return await dialogHandler(dialog); return { accept: false } } })
  const results = []
  try {
    for (const [index, test] of PAGES.entries()) {
      trace.length = 0; requestCount = 0; dialogHandler = test.dialogDecision ? async () => test.dialogDecision : null
      activeTest = test
      await wc.loadURL(origin + '/' + index)
      activeController = new AbortController()
      const signal = activeController.signal
      const lease = { browserId: 'private-fixture', pageIncarnation: 'fixture', generation: index }
      const started = Date.now()
      let error, errorMessage
      try {
        await automation.setViewport({ width: 1000, height: 772, deviceScaleFactor: 1 }, signal)
        const startEpoch = documentEpoch
        const snapshot = await automation.snapshot(lease, { maxDepth: 20, maxNodes: 200, maxBytes: 262144 }, signal)
        const node = snapshot.nodes.find(item => item.name === test.label)
        assert(node, 'fixture target missing: ' + test.label)
        const operation = test.op.kind === 'drag'
          ? { kind: 'drag', source: { snapshotId: snapshot.snapshotId, ref: snapshot.nodes.find(item => item.name === test.source).ref }, target: { snapshotId: snapshot.snapshotId, ref: node.ref } }
          : { ...test.op, target: { snapshotId: snapshot.snapshotId, ref: node.ref }, ...(test.op.text ? { text: test.op.text } : {}) }
        const prepared = await automation.prepareInteraction(lease, operation, signal)
        await automation.executeInteraction(prepared, signal, (_dispatched, phase) => documentEpoch === startEpoch || phase === 'cleanup' || phase === 'finish')
        if (test.thenHover) {
          const trigger = snapshot.nodes.find(item => item.name === test.label)
          const hoverOp = await automation.prepareInteraction(lease, { kind: 'hover', target: { snapshotId: snapshot.snapshotId, ref: trigger.ref } }, signal)
          await automation.executeInteraction(hoverOp, signal, () => true)
          const fresh = await automation.snapshot(lease, { maxDepth: 20, maxNodes: 200, maxBytes: 262144 }, signal)
          const revealed = fresh.nodes.find(item => item.name === test.thenHover)
          assert(revealed, 'revealed target missing after hover')
          const clickOp = await automation.prepareInteraction(lease, { kind: 'click', target: { snapshotId: fresh.snapshotId, ref: revealed.ref } }, signal)
          await automation.executeInteraction(clickOp, signal, () => true)
        }
        if (test.thenWait) await automation.wait(lease, test.thenWait, 5000, signal, () => true)
      } catch (failure) { error = failure.code || failure.message; errorMessage = failure.message }
      if (test.settleMs) await sleep(test.settleMs)
      const actual = await wc.executeJavaScript(test.want.verify)
      const pass = (error ?? null) === test.want.error && actual === test.want.value
      const diagnostics = pass ? undefined : await wc.executeJavaScript('({url:location.href,focus:document.activeElement.tagName})').catch(() => null)
      results.push({ name: test.name, pass, error: error ?? null, actual: actual ?? null, expected: test.want.error ?? null, elapsedMs: Date.now() - started, adapterRequests: requestCount, diagnostics, ...(errorMessage ? { errorMessage } : {}) })
      fs.writeFileSync(path.join(run, `trace-${index}.json`), JSON.stringify(trace, null, 2))
      console.log(JSON.stringify(results.at(-1)))
    }
  } finally {
    automation.dispose(); win.destroy(); server.close(); clearTimeout(deadline)
    fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(results, null, 2))
    const failed = results.filter(r => !r.pass)
    console.log(`SUMMARY ${results.length - failed.length}/${results.length}`)
    if (failed.length) { console.log('FAILED: ' + failed.map(f => f.name).join(' | ')); process.exitCode = 1 }
  }
})
