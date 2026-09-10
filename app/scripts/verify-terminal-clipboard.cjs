#!/usr/bin/env node
// Private mounted-Pane regression. Never starts a daemon, Pi, or provider call.
// AMBER_CLIPBOARD_TEST_DIR=/persistent/evidence xvfb-run -a node scripts/verify-terminal-clipboard.cjs
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
if (!process.versions.electron) {
  const root = process.env.AMBER_CLIPBOARD_TEST_DIR
  assert(root && path.isAbsolute(root), 'AMBER_CLIPBOARD_TEST_DIR must name a persistent evidence directory')
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const run = fs.mkdtempSync(path.join(root, 'clipboard-'))
  require('esbuild').buildSync({ entryPoints: [path.join(__dirname, '../test/terminal-clipboard-fixture.tsx')],
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: path.join(run, 'fixture.js') })
  fs.writeFileSync(path.join(run, 'index.html'), '<!doctype html><link rel="stylesheet" href="fixture.css"><style>body{margin:0}#root{width:640px;height:400px}</style><div id="root"></div><script src="fixture.js"></script>')
  const result = require('node:child_process').spawnSync(require('electron'), ['--no-sandbox', __filename], {
    env: { PATH: process.env.PATH, DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY,
      HOME: run, XDG_CONFIG_HOME: path.join(run, 'config'), XDG_STATE_HOME: path.join(run, 'state'),
      XDG_CACHE_HOME: path.join(run, 'cache'), AMBER_CLIPBOARD_FIXTURE: run },
    encoding: 'utf8', timeout: 45000, maxBuffer: 2 * 1024 * 1024,
  })
  fs.writeFileSync(path.join(run, 'electron.log'), (result.stdout || '') + (result.stderr || ''))
  process.stdout.write(result.stdout || '')
  console.log('Evidence:', run)
  if (result.error) console.error(result.error.message)
  process.exit(result.status ?? 1)
}
const { app, BrowserWindow, clipboard } = require('electron')
const run = process.env.AMBER_CLIPBOARD_FIXTURE
assert(run && path.isAbsolute(run))
app.setPath('userData', path.join(run, 'profile'))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-background-networking')
const deadline = setTimeout(() => app.exit(2), 35000)
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 800, height: 600, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const wc = win.webContents
  const evaluate = code => wc.executeJavaScript(code)
  const settle = () => new Promise(resolve => setTimeout(resolve, 50))
  async function until(code) {
    for (let i = 0; i < 100; i++) { if (await evaluate(code)) return; await settle() }
    throw new Error('Timed out: ' + code)
  }
  const results = []
  async function check(name, action) {
    try { await action(); results.push({ name, passed: true }); console.log('PASS', name) }
    catch (error) { results.push({ name, passed: false, error: error.message }); console.log('FAIL', name, error.message) }
  }
  async function nativePaste(text) {
    clipboard.writeText(text)
    assert.equal(clipboard.readText(), text)
    // Let X11 selection ownership propagate to the renderer before pasting.
    await settle()
    wc.paste()
  }
  async function wirePaste(action, expected) {
    await evaluate('fixture.clearMessages()')
    await action()
    await settle()
    assert.deepEqual(await evaluate('fixture.messages()'), [expected])
  }
  async function selectPadded() {
    const box = await evaluate(`(() => { const b = document.querySelector('.xterm-screen').getBoundingClientRect(); const g = fixture.geometry(); return { x:b.x, y:b.y, cw:b.width/g.cols, ch:b.height/g.rows } })()`)
    wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: Math.round(box.x + 1), y: Math.round(box.y + box.ch / 2) })
    wc.sendInputEvent({ type: 'mouseMove', modifiers: ['leftButtonDown'], x: Math.round(box.x + 1), y: Math.round(box.y + 3.5 * box.ch) })
    wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: Math.round(box.x + 1), y: Math.round(box.y + 3.5 * box.ch) })
    await settle()
  }
  try {
    await win.loadFile(path.join(run, 'index.html'))
    await until('fixture.ready()')
    await settle()
    await evaluate('fixture.padded()')
    await until('fixture.parsed()')
    await selectPadded()
    const clean = '  First line\n\n    indented code\n'
    await check('copy API removes Pi row padding but preserves indentation and blank lines', async () => assert.equal(await evaluate('fixture.copy()'), clean))
    await check('native copy uses the same cleaned Pi selection', async () => { wc.copy(); await settle(); assert.equal(clipboard.readText(), clean) })
    const text = 'first\r\n  second\n\nthird\n'
    const bracketed = '\x1b[200~first\r  second\r\rthird\r\x1b[201~'
    await check('cold Pi attach: API paste is one bracketed input', () => wirePaste(() => evaluate(`fixture.paste(${JSON.stringify(text)})`), bracketed))
    await check('native clipboard paste is bracketed exactly once', () => wirePaste(() => nativePaste(text), bracketed))
    await evaluate('fixture.output("\\x1b[?2004h")'); await settle()
    await check('negotiated paste mode does not double-wrap', () => wirePaste(() => evaluate(`fixture.paste(${JSON.stringify(text)})`), bracketed))
    await evaluate('fixture.output("reconnected", true)'); await settle()
    await check('reconnect reset with evicted mode still protects multiline paste', () => wirePaste(() => nativePaste(text), bracketed))
    await evaluate('fixture.state("shell-fallback")')
    await check('Pi shell fallback is not forced into bracketed mode', () => wirePaste(() => evaluate('fixture.paste("first\\nsecond")'), 'first\rsecond'))
    await evaluate('fixture.state("claude")')
    await check('resumed Pi reads the updated run state without remounting', () => wirePaste(() => evaluate('fixture.paste("first\\nsecond")'), '\x1b[200~first\rsecond\x1b[201~'))
    await evaluate('fixture.remount("shell")'); await until('fixture.ready()'); await settle()
    await check('ordinary shell native paste keeps xterm behavior', () => wirePaste(() => nativePaste('first\nsecond'), 'first\rsecond'))
    await evaluate('fixture.padded()'); await until('fixture.parsed()'); await selectPadded()
    await check('ordinary shell selection is not trimmed', async () => assert.match(await evaluate('fixture.copy()'), /First line +\n +\n    indented code +\n/))
    await evaluate('fixture.unmount()')
    await check('unmount removes clipboard handlers', async () => {
      assert.deepEqual(await evaluate(`(() => { const el = document.createElement('textarea'); document.body.appendChild(el); el.focus(); const e = new ClipboardEvent('paste', { bubbles:true, cancelable:true, clipboardData:new DataTransfer() }); el.dispatchEvent(e); return [e.defaultPrevented, Boolean(document.querySelector('.xterm'))] })()`), [false, false])
    })
  } finally {
    fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(results, null, 2))
    clearTimeout(deadline)
    win.destroy()
  }
  app.exit(results.some(result => !result.passed) ? 1 : 0)
}).catch(error => { console.error(error); app.exit(1) })
