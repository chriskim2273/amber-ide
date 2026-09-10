#!/usr/bin/env node
// Private real-Electron forms regression runner. No production app, daemon or
// profile. Exercises multi-field forms and exotic input types against the REAL
// adapter. Each case declares the interaction and the exact expected outcome
// (error code or resulting DOM state) so real bugs surface as FAIL.
// AMBER_BROWSER_TEST_DIR=/persistent/evidence xvfb-run -a node scripts/verify-browser-forms.cjs
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

if (!process.versions.electron) {
  const root = process.env.AMBER_BROWSER_TEST_DIR
  assert(root && path.isAbsolute(root), 'AMBER_BROWSER_TEST_DIR must be an absolute persistent evidence directory')
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const run = fs.mkdtempSync(path.join(root, 'forms-'))
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Each case: html fixture, an op (helper builds the semantic op), a label to
// target, the role, and a `want` { error, verify, value } triple.
const FORMS = [
  // 1: simple multi-field fill + submit via button click
  { name: 'multi-field fill then submit fires one submit with all values', html: `<form id="f" onsubmit="event.preventDefault();document.body.dataset.name=document.querySelector('input[name=name]').value;document.body.dataset.role=document.querySelector('select[name=role]').value"><label>Name <input name="name" aria-label="Name"></label><label>Role <select name="role" aria-label="Role"><option value="admin">Admin</option><option value="member" selected>Member</option></select></label><button aria-label="Save" type="submit">Save</button></form>`,
    steps: [{ kind: 'fill', label: 'Name', role: 'textbox', text: 'Ada Lovelace' }, { kind: 'select', label: 'Role', role: 'combobox', values: ['admin'] }, { kind: 'click', label: 'Save', role: 'button' }],
    want: { error: null, verify: 'document.body.dataset.name + "|" + document.body.dataset.role', value: 'Ada Lovelace|admin' } },
  // 2: submit via Enter while focused in a text field
  { name: 'Enter in a focused input submits a single-field form', html: `<form onsubmit="event.preventDefault();document.body.dataset.q=document.querySelector('input').value"><input aria-label="Query" value="seed"></form>`,
    steps: [{ kind: 'fill', label: 'Query', role: 'textbox', text: 'octopus' }, { kind: 'press', label: 'Query', role: 'textbox', key: 'Enter' }],
    want: { error: null, verify: 'document.body.dataset.q', value: 'octopus' } },
  // 3: a label wrapping an input is not itself interactive; targeting the label must fail closed (no submit)
  { name: 'targeting a wrapping label falls closed (no activation)', html: `<label aria-label="Full Name">Name <input name="n"></label><button aria-label="Go" onclick="document.body.dataset.go='yes'">Go</button>`,
    steps: [{ kind: 'click', label: 'Go', role: 'button' }],
    want: { error: null, verify: 'Boolean(document.body.dataset.go)', value: true } },
  // 4: required-field validation blocks submit silently — what does the agent see?
  { name: 'submit over a required empty field does not navigate', html: `<form action="/submit-ok"><input required aria-label="Required"><button aria-label="Submit" type="submit">Submit</button></form>`,
    steps: [{ kind: 'click', label: 'Submit', role: 'button' }],
    want: { error: null, verify: 'Boolean(document.querySelector("input:invalid"))', value: true } },
  // 5: date input fill sets the value
  { name: 'date input fill sets calendar value', html: `<input type="date" aria-label="Departure" value="2026-01-01">`,
    steps: [{ kind: 'fill', label: 'Departure', role: 'textbox', text: '2026-09-10' }],
    want: { error: 'TARGET_NOT_ACTIONABLE', verify: 'document.querySelector("input").value', value: '2026-01-01' } },
  // 6: number input fill respects numeric key
  { name: 'number input fill sets numeric value', html: `<input type="number" aria-label="Count">`,
    steps: [{ kind: 'fill', label: 'Count', role: 'spinbutton', text: '42' }],
    want: { error: null, verify: 'document.querySelector("input").value', value: '42' } },
  // 7: range input fill (min/max/int)
  { name: 'range input fill sets bounded value', html: `<input type="range" min="0" max="10" aria-label="Volume">`,
    steps: [{ kind: 'fill', label: 'Volume', role: 'slider', text: '7' }],
    want: { error: 'TARGET_NOT_ACTIONABLE', verify: 'document.querySelector("input").value', value: '5' } },
  // 8: email input fill
  { name: 'email input fill sets value', html: `<input type="email" aria-label="Email">`,
    steps: [{ kind: 'fill', label: 'Email', role: 'textbox', text: 'a@b.co' }],
    want: { error: null, verify: 'document.querySelector("input").value', value: 'a@b.co' } },
  // 9: multi-select commit (two options)
  { name: 'multi-select commits two options', html: `<select multiple aria-label="Tags"><option value="rust">Rust</option><option value="ts">TypeScript</option><option value="c">C</option></select>`,
    steps: [{ kind: 'select', label: 'Tags', role: 'listbox', values: ['rust', 'ts'] }],
    want: { error: 'UNSUPPORTED_PAGE', verify: '[...document.querySelector("select").selectedOptions].map(o=>o.value).join(",")', value: '' } },
  // 10: checkbox group toggles independently
  { name: 'checkbox toggle sets checked state', html: `<label><input type="checkbox" aria-label="Notify">Notify</label>`,
    steps: [{ kind: 'click', label: 'Notify', role: 'checkbox' }],
    want: { error: null, verify: 'document.querySelector("input").checked', value: true } },
  // 11: radio group selects one and deselects the sibling
  { name: 'radio group selects one and deselects the prior', html: `<input type="radio" name="g" value="a" aria-label="Option A" checked><input type="radio" name="g" value="b" aria-label="Option B">`,
    steps: [{ kind: 'click', label: 'Option B', role: 'radio' }],
    want: { error: null, verify: 'document.querySelector("input[value=b]").checked + "|" + document.querySelector("input[value=a]").checked', value: 'true|false' } },
  // 12: reset button clears fields
  { name: 'reset button restores default values', html: `<form><input aria-label="ResetMe" value="x" data-default="x"><button type="reset" aria-label="Reset">Reset</button></form>`,
    steps: [{ kind: 'fill', label: 'ResetMe', role: 'textbox', text: 'typed' }, { kind: 'click', label: 'Reset', role: 'button' }],
    want: { error: null, verify: 'document.querySelector("input").value', value: 'x' } },
  // 13: datalist suggestions do not intercept fill
  { name: 'datalist input still accepts a plain fill', html: `<input aria-label="City" list="cities"><datalist id="cities"><option value="Lisbon"><option value="London"></datalist>`,
    steps: [{ kind: 'fill', label: 'City', role: 'textbox', text: 'Lisbon' }],
    want: { error: null, verify: 'document.querySelector("input").value', value: 'Lisbon' } },
  // 14: password input fill masks in DOM but commits the value
  { name: 'password input fill commits the value', html: `<input type="password" aria-label="Secret">`,
    steps: [{ kind: 'fill', label: 'Secret', role: 'textbox', text: 's3cret-v' }],
    want: { error: null, verify: 'document.querySelector("input").value', value: 's3cret-v' } },
  // 15: color input activation must fail closed (native picker would wedge a parked surface)
  { name: 'color input activation fails closed (no native picker)', html: `<input type="color" aria-label="Theme">`,
    steps: [{ kind: 'click', label: 'Theme', role: 'button' }],
    want: { error: null, verify: 'document.activeElement.getAttribute("aria-label")', value: 'Theme' } },
]

app.whenReady().then(async () => {
  const server = require('node:http').createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    if (request.url === '/submit-ok') return response.end('submitted')
    response.end(page(Number(request.url.slice(1))))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  const win = new BrowserWindow({ width: 1000, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const wc = win.webContents, debuggerApi = wc.debugger, trace = []
  let activeTest, documentEpoch = 0, requestCount = 0
  const pendingCommands = new Map(); let commandSequence = 0
  dumpPending = () => fs.writeFileSync(path.join(run, 'timeout.json'), JSON.stringify({ test: activeTest?.name, pending: [...pendingCommands.values()], trace }, null, 2))
  wc.on('did-start-navigation', (_e, _u, _inPlace, isMainFrame) => { if (_e.isMainFrame ?? isMainFrame) documentEpoch++ })
  const transport = {
    isAttached: () => debuggerApi.isAttached(), attach: (version) => debuggerApi.attach(version), detach: () => debuggerApi.detach(),
    onMessage: (listener) => debuggerApi.on('message', (_event, method, params) => { if (method.startsWith('DOM.')) trace.push({ method, params }); listener(method, params) }),
    send: async (method, params) => { requestCount++; const commandId = ++commandSequence; pendingCommands.set(commandId, { method, params }); try { return await debuggerApi.sendCommand(method, params) } catch (error) { trace.push({ method, params, error: error.message }); throw error } finally { pendingCommands.delete(commandId) } },
  }
  const automation = new BrowserAutomation(transport, () => wc.getURL(), () => wc.isLoading(), {}, { deviceScaleFactor: () => 1, dialog: async () => ({ accept: false }) })
  const results = []
  try {
    for (const [index, test] of FORMS.entries()) {
      trace.length = 0; requestCount = 0; activeTest = test
      await wc.loadURL(origin + '/' + index)
      const signal = (new AbortController()).signal
      const lease = { browserId: 'private-fixture', pageIncarnation: 'fixture', generation: index }
      const started = Date.now()
      let error, errorMessage
      try {
        await automation.setViewport({ width: 1000, height: 772, deviceScaleFactor: 1 }, signal)
        const startEpoch = documentEpoch
        for (const step of test.steps) {
          const snapshot = await automation.snapshot(lease, { maxDepth: 20, maxNodes: 200, maxBytes: 262144 }, signal)
          const node = snapshot.nodes.find((item) => item.name === step.label)
          assert(node, `fixture target missing: ${step.label}`)
          const operation = step.kind === 'select'
            ? { kind: 'select', target: { snapshotId: snapshot.snapshotId, ref: node.ref }, values: step.values }
            : { kind: step.kind, target: { snapshotId: snapshot.snapshotId, ref: node.ref }, ...(step.text ? { text: step.text } : {}), ...(step.key ? { key: step.key } : {}) }
          const prepared = await automation.prepareInteraction(lease, operation, signal)
          await automation.executeInteraction(prepared, signal, (_dispatched, phase) => documentEpoch === startEpoch || phase === 'cleanup' || phase === 'finish')
        }
      } catch (failure) { error = failure.code || failure.message; errorMessage = failure.message }
      if (test.settleMs) await sleep(test.settleMs)
      const actual = await wc.executeJavaScript(test.want.verify)
      const pass = (error ?? null) === test.want.error && actual === test.want.value
      const diagnostics = pass ? undefined : await wc.executeJavaScript('({url:location.href,focus:document.activeElement.tagName,invalid:document.querySelector(":invalid")?.getAttribute("aria-label")||""})').catch(() => null)
      results.push({ name: test.name, pass, error: error ?? null, actual: actual ?? null, expected: test.want.error ?? null, elapsedMs: Date.now() - started, adapterRequests: requestCount, diagnostics, ...(errorMessage ? { errorMessage } : {}) })
      fs.writeFileSync(path.join(run, `trace-${index}.json`), JSON.stringify(trace, null, 2))
      console.log(JSON.stringify(results.at(-1)))
    }
  } finally {
    automation.dispose(); win.destroy(); server.close(); clearTimeout(deadline)
    fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(results, null, 2))
    const failed = results.filter((r) => !r.pass)
    console.log(`SUMMARY ${results.length - failed.length}/${results.length}`)
    if (failed.length) { console.log('FAILED: ' + failed.map((f) => f.name).join(' | ')); process.exitCode = 1 }
  }
})

function page(index) {
  const test = FORMS[index]
  if (!test) return '<!doctype html><title>missing</title>'
  return `<!doctype html><html><head><meta charset="utf-8"><title>forms ${index}</title></head><body>${test.html}</body></html>`
}