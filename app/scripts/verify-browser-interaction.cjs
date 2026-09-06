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
const deadline = setTimeout(() => app.exit(2), 30000)
const { BrowserAutomation } = require(path.join(run, 'adapter.cjs'))
const cases = [
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
  const win = new BrowserWindow({ width: 1000, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const wc = win.webContents, debuggerApi = wc.debugger, trace = []
  const transport = {
    isAttached: () => debuggerApi.isAttached(), attach: version => debuggerApi.attach(version), detach: () => debuggerApi.detach(),
    onMessage: listener => debuggerApi.on('message', (_event, method, params) => { if (method.startsWith('DOM.')) trace.push({ method, params }); listener(method, params) }),
    send: async (method, params) => {
      const result = await debuggerApi.sendCommand(method, params)
      if (method === 'DOM.getNodeForLocation' || method === 'DOM.describeNode') trace.push({ method, params, result })
      return result
    },
  }
  const automation = new BrowserAutomation(transport, () => wc.getURL(), () => wc.isLoading())
  const results = []
  try {
    for (const [index, test] of cases.entries()) {
      trace.length = 0
      await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><style>textarea,input,button,x-button{display:block;margin:40px;width:420px;height:44px}</style>' + test.html))
      const signal = new AbortController().signal
      const lease = { browserId: 'private-fixture', pageIncarnation: 'fixture', generation: index }
      const started = Date.now()
      let error
      try {
        const snapshot = await automation.snapshot(lease, { maxDepth: 20, maxNodes: 100, maxBytes: 262144 }, signal)
        const node = snapshot.nodes.find(item => item.role === test.role && item.name === test.label)
        assert(node, 'fixture target missing')
        const operation = { kind: test.kind, target: { snapshotId: snapshot.snapshotId, ref: node.ref }, ...(test.kind === 'fill' ? { text: 'potatoes' } : {}) }
        await automation.executeInteraction(await automation.prepareInteraction(lease, operation, signal), signal)
      } catch (failure) { error = failure.code || failure.message }
      // Evaluation is confined to our own fixture for outcome assertions, never exposed through the adapter/tools.
      const actual = await wc.executeJavaScript(test.verify)
      const pass = error === test.error && actual === test.want
      results.push({ name: test.name, pass, error: error ?? null, actual: actual ?? null, expected: test.want, elapsedMs: Date.now() - started })
      fs.writeFileSync(path.join(run, `trace-${index}.json`), JSON.stringify(trace, null, 2))
      console.log(JSON.stringify(results.at(-1)))
    }
  } finally {
    automation.dispose(); win.destroy(); clearTimeout(deadline)
    fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(results, null, 2))
  }
  app.exit(results.length === cases.length && results.every(result => result.pass) ? 0 : 1)
}).catch(error => { console.error(error); app.exit(1) })
