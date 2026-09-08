#!/usr/bin/env node
// Private Electron verification: no production window, daemon, or profile.
// AMBER_BROWSER_TEST_DIR=/persistent/evidence xvfb-run -a node scripts/verify-browser-page-lifecycle.cjs
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

if (!process.versions.electron) {
  const root = process.env.AMBER_BROWSER_TEST_DIR
  assert(root && path.isAbsolute(root), 'absolute persistent evidence directory required')
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const run = fs.mkdtempSync(path.join(root, 'lifecycle-'))
  fs.mkdirSync(path.join(run, 'home'), { mode: 0o700 })
  for (const [entry, name] of [['electronTabBrowserPage', 'page'], ['remoteBrowserFrame', 'frame']]) {
    require('esbuild').buildSync({ entryPoints: [path.join(__dirname, '../src/main/' + entry + '.ts')],
      bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(run, name + '.cjs') })
  }
  const result = require('node:child_process').spawnSync(require('electron'), ['--no-sandbox', __filename], {
    env: { PATH: process.env.PATH, DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY,
      HOME: path.join(run, 'home'), XDG_CONFIG_HOME: path.join(run, 'config'), XDG_STATE_HOME: path.join(run, 'state'),
      XDG_CACHE_HOME: path.join(run, 'cache'), AMBER_BROWSER_FIXTURE_RUN: run },
    encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
  })
  fs.writeFileSync(path.join(run, 'electron.log'), (result.stdout || '') + (result.stderr || ''))
  process.stdout.write(result.stdout || '')
  console.log('Evidence:', run)
  if (result.status !== 0) process.stderr.write(result.stderr || result.error?.message || '')
  process.exit(result.status ?? 1)
}

const { app, BrowserWindow, nativeImage } = require('electron')
const run = process.env.AMBER_BROWSER_FIXTURE_RUN
assert(run && path.isAbsolute(run))
app.setPath('userData', path.join(run, 'profile'))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-background-networking')
const deadline = setTimeout(() => app.exit(2), 20000)
const { ElectronTabBrowserPage, ownerWindowCloseIsFromGuest } = require(path.join(run, 'page.cjs'))
const { encodeRemoteFrame } = require(path.join(run, 'frame.cjs'))
app.whenReady().then(async () => {
  const server = require('node:http').createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end('<title>' + (request.url === '/next' ? 'Background navigation' : 'Private fixture') + '</title><input aria-label="Search" style="position:absolute;left:40px;top:40px;width:300px;height:40px">')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  const owner = new BrowserWindow({ width: 800, height: 600, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const results = []
  try {
    const backgroundPage = new ElectronTabBrowserPage(owner, 'persist:amber-browser-background', () => {}, () => {}, () => true, () => {})
    backgroundPage.setBounds({ x: 0, y: 0, width: 500, height: 400 }); backgroundPage.show()
    await backgroundPage.loadURL(origin + '/start')
    const contents = backgroundPage.view.webContents
    // Outcome evaluation below is confined to our private local fixture.
    const foreground = new BrowserWindow({ x: 0, y: 0, width: 1600, height: 1200 })
    foreground.show(); foreground.focus()
    const focusDeadline = Date.now() + 2000
    while (BrowserWindow.getFocusedWindow()?.id !== foreground.id && Date.now() < focusDeadline) await new Promise(resolve => setTimeout(resolve, 10))
    const focusedId = BrowserWindow.getFocusedWindow()?.id
    assert.equal(focusedId, foreground.id, 'fixture must establish a real foreground before testing focus preservation')
    const windowCount = BrowserWindow.getAllWindows().length
    const contentsId = contents.id
    backgroundPage.hide()
    const lease = { browserId: 'background-fixture', pageIncarnation: 'fixture', generation: 1 }
    const signal = new AbortController().signal
    const capture = await backgroundPage.automation.screenshot(lease, undefined, false, signal)
    assert.equal(capture.width, 500); assert.equal(capture.height, 400)
    const snapshot = await backgroundPage.automation.snapshot(lease, { maxDepth: 20, maxNodes: 50, maxBytes: 262144 }, signal)
    const prepared = await backgroundPage.automation.prepareInteraction(lease, { kind: 'fill', target: { snapshotId: snapshot.snapshotId, role: 'textbox', name: 'Search' }, text: 'background potatoes' }, signal)
    await backgroundPage.automation.executeInteraction(prepared, signal)
    assert.equal(await contents.executeJavaScript('document.querySelector("input").value'), 'background potatoes')
    assert.equal(BrowserWindow.getFocusedWindow()?.id, focusedId, 'background work must not steal focus')
    assert.equal(BrowserWindow.getAllWindows().length, windowCount + 1, 'one bounded background surface')
    backgroundPage.show()
    assert.equal(backgroundPage.view.webContents.id, contentsId)
    assert.equal(await contents.executeJavaScript('document.querySelector("input").value'), 'background potatoes')
    assert.equal(BrowserWindow.getAllWindows().length, windowCount, 'show releases the background surface')
    assert.equal(BrowserWindow.getFocusedWindow()?.id, focusedId, 'reparent must not steal focus')
    const unfocusedCapture = await backgroundPage.automation.screenshot(lease, undefined, false, signal)
    assert.equal(unfocusedCapture.width, 500, 'fully covered owner remains capturable')
    const unfocusedInput = await backgroundPage.automation.prepareInteraction(lease, { kind: 'fill', target: { snapshotId: snapshot.snapshotId, role: 'textbox', name: 'Search' }, text: 'unfocused potatoes' }, signal)
    await backgroundPage.automation.executeInteraction(unfocusedInput, signal)
    assert.equal(await contents.executeJavaScript('document.querySelector("input").value'), 'unfocused potatoes')
    assert.equal(BrowserWindow.getFocusedWindow()?.id, focusedId)
    for (let cycle = 0; cycle < 3; cycle++) {
      backgroundPage.hide(); backgroundPage.hide()
      assert.equal(BrowserWindow.getAllWindows().length, windowCount + 1)
      const surface = BrowserWindow.getAllWindows().find(window => window !== owner && window !== foreground)
      assert(surface && !surface.isFocusable(), 'background surface cannot acquire native focus')
      const left = Math.min(...require('electron').screen.getAllDisplays().map(display => display.bounds.x))
      assert(surface.getBounds().x + surface.getBounds().width < left)
      backgroundPage.show()
      assert.equal(BrowserWindow.getAllWindows().length, windowCount)
    }
    backgroundPage.hide()
    await backgroundPage.loadURL(origin + '/next')
    assert.equal(contents.getURL(), origin + '/next')
    assert.equal(await contents.executeJavaScript('document.title'), 'Background navigation')
    assert.equal((await backgroundPage.automation.screenshot(lease, undefined, false, signal)).width, 500)
    assert.equal(BrowserWindow.getFocusedWindow()?.id, focusedId, 'background navigation must not steal focus')
    backgroundPage.destroy()
    assert.equal(BrowserWindow.getAllWindows().length, windowCount, 'destroy releases parked surface')
    foreground.destroy()
    results.push({ name: 'background and unfocused captures/input preserve page, focus and surface bounds', pass: true })
    for (const mode of ['native', 'renderer']) {
      const page = new ElectronTabBrowserPage(owner, 'persist:amber-browser-lifecycle-' + mode, () => {}, () => {}, () => true, () => {})
      page.setBounds({ x: 0, y: 0, width: 500, height: 400 }); page.show()
      await page.loadURL('about:blank')
      const contents = page.view.webContents
      let closeObserved = false
      contents.on('close', () => { closeObserved = ownerWindowCloseIsFromGuest(owner) })
      const destroyed = new Promise(resolve => contents.once('destroyed', resolve))
      if (mode === 'native') contents.close()
      else await contents.executeJavaScript('setTimeout(() => window.close(), 0); undefined')
      await destroyed
      assert(closeObserved, 'production close observer must mark the guest before destruction')
      assert(!owner.isDestroyed(), 'guest close must preserve the owner')
      assert(!ownerWindowCloseIsFromGuest(owner), 'destroyed must clear the guest close marker')
      page.destroy()
      results.push({ name: mode + ' guest close lifecycle', pass: true })
    }
    const image = nativeImage.createFromBitmap(Buffer.alloc(1800 * 1000 * 4, 255), { width: 1800, height: 1000 })
    const frame = encodeRemoteFrame(image)
    assert(frame && frame.width === 900 && frame.height === 500 && frame.data.length >= 8)
    results.push({ name: 'real NativeImage resize and frame encoding', pass: true })
    console.log(JSON.stringify({ electron: process.versions.electron, results }))
    fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(results, null, 2))
  } finally { owner.destroy(); server.close(); clearTimeout(deadline) }
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
