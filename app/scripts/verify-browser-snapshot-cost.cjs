#!/usr/bin/env node
// Private real-Electron micro-benchmark for the snapshot path. No production
// app, daemon or profile. Measures: total wall time, per-CDP-method call counts,
// and the JSON.stringify byte-accounting overhead — baseline before optimization.
// AMBER_BROWSER_TEST_DIR=/persistent/evidence xvfb-run -a node scripts/verify-browser-snapshot-cost.cjs
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

if (!process.versions.electron) {
  const root = process.env.AMBER_BROWSER_TEST_DIR
  assert(root && path.isAbsolute(root), 'AMBER_BROWSER_TEST_DIR must be an absolute persistent evidence directory')
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const run = fs.mkdtempSync(path.join(root, 'snapshot-cost-'))
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
app.setPath('userData', path.join(run, 'profile'))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-background-networking')

app.whenReady().then(async () => {
  const { BrowserAutomation } = require(path.join(run, 'adapter.cjs'))

  // Realistic page with a couple dozen interactive + content nodes.
  const elements = []
  for (let index = 0; index < 10; index++) elements.push(`<li><a href="#s${index}" aria-label="Section ${index} link">Section ${index}</a><span>body text ${index}</span></li>`)
  for (let index = 0; index < 30; index++) elements.push(`<button aria-label="Action ${index}" onclick="void 0">Do ${index}</button><input aria-label="Field ${index}" value="${index}">`)
  const html = `<!doctype html><html><head><title>snapshot cost</title></head><body><nav>${elements.join('')}</nav></body></html>`

  const server = require('node:http').createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(html)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const win = new BrowserWindow({ width: 800, height: 600, show: false })
  await win.loadURL(`http://127.0.0.1:${port}/`)
  // Wrap the real debugger session to count calls + time.
  const debuggerSession = win.webContents.debugger

  const counts = new Map()
  const timings = new Map()
  const rawSend = (method, params) => debuggerSession.sendCommand(method, params)
  const wrappedSend = async (method, params = {}) => {
    counts.set(method, (counts.get(method) || 0) + 1)
    const started = process.hrtime.bigint()
    const result = await rawSend(method, params)
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6
    const entry = timings.get(method) || { total: 0, n: 0, max: 0 }
    entry.total += elapsed; entry.n += 1; entry.max = Math.max(entry.max, elapsed)
    timings.set(method, entry)
    return result
  }

  const automation = new BrowserAutomation(
    { send: wrappedSend, attach: () => debuggerSession.attach('1.3'), isAttached: () => debuggerSession.isAttached(), onMessage: () => {}, detach: () => debuggerSession.detach() },
    () => `http://127.0.0.1:${port}/`, () => false)
  const signal = new AbortController().signal

  const wallStart = process.hrtime.bigint()
  const snapshot = await automation.snapshot(
    { pageIncarnation: 'x', expectedGeneration: 0 },
    { maxDepth: 16, maxNodes: 400, maxBytes: 256 * 1024 }, signal)
  const wallMs = Number(process.hrtime.bigint() - wallStart) / 1e6

  console.log(JSON.stringify({ wallMs: Math.round(wallMs), nodeCount: snapshot.nodes.length, truncated: snapshot.truncated, truncationReasons: snapshot.truncationReasons, counts: Object.fromEntries(counts), timings: Object.fromEntries([...timings].map(([k, v]) => [k, { totalMs: Math.round(v.total * 10) / 10, n: v.n, avgMs: Math.round((v.n ? v.total / v.n : 0) * 100) / 100, maxMs: Math.round(v.max * 100) / 100 }])) }, null, 2))
  server.close(); win.destroy(); app.exit(0)
}).catch((error) => { console.error(error); app.exit(1) })