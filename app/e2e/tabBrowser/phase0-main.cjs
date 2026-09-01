const { app, BrowserWindow, WebContentsView, session } = require('electron')
const http = require('node:http')
const fs = require('node:fs/promises')
const path = require('node:path')

function privatePath(name) {
  const value = process.env[name]
  const root = '/tmp/amber-tab-browser-validation/'
  if (!value || !path.resolve(value).startsWith(root)) {
    throw new Error(`${name} must be under ${root}`)
  }
  return path.resolve(value)
}

if (process.env.AMBER_PHASE0_DISABLE_GPU_SANDBOX === '1') {
  // Diagnostic only: this switch does not relax the remote renderer sandbox.
  app.commandLine.appendSwitch('disable-gpu-sandbox')
}

const userData = privatePath('AMBER_ELECTRON_USER_DATA')
const sessionData = privatePath('AMBER_ELECTRON_CACHE')
const artifactDir = privatePath('AMBER_PHASE0_ARTIFACTS')
app.setPath('userData', userData)
app.setPath('sessionData', sessionData)

const results = { platform: process.platform, electron: process.versions.electron, checks: {}, errors: [] }
app.on('window-all-closed', () => {})
let server
let win
let view

async function writeResult() {
  await fs.mkdir(artifactDir, { recursive: true })
  await fs.writeFile(path.join(artifactDir, 'result.json'), `${JSON.stringify(results, null, 2)}\n`)
}

function page() {
  return `<!doctype html><html><body>
    <input id="input" aria-label="physical-input" autofocus>
    <div id="status">ready</div>
    <script>
      const result = {
        node: typeof process !== 'undefined' || typeof require !== 'undefined',
        electron: typeof window.electron !== 'undefined',
        amber: typeof window.amber !== 'undefined',
        sandboxed: typeof process !== 'undefined' ? process.sandboxed : 'unreachable'
      }
      document.querySelector('#status').dataset.security = JSON.stringify(result)
      document.addEventListener('pointerdown', e => {
        document.querySelector('#status').dataset.pointer = e.target.id || e.target.tagName
      })
      document.querySelector('#input').addEventListener('input', e => {
        document.querySelector('#status').dataset.physical = e.target.value
      })
      window.open(location.origin + '/popup')
      navigator.geolocation?.getCurrentPosition(() => {}, () => {
        document.querySelector('#status').dataset.permission = 'denied'
      })
    </script>
  </body></html>`
}

async function run() {
  await fs.mkdir(userData, { recursive: true })
  await fs.mkdir(sessionData, { recursive: true })
  await fs.mkdir(artifactDir, { recursive: true })

  server = http.createServer((req, res) => {
    if (req.url === '/redirect-file') {
      res.writeHead(302, { Location: 'file:///etc/passwd' })
      return res.end()
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(page())
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port

  const partition = 'persist:amber-browser-phase0'
  const ses = session.fromPartition(partition)
  let permissionRequests = 0
  let permissionChecks = 0
  ses.setPermissionRequestHandler((_wc, _permission, callback) => {
    permissionRequests += 1
    callback(false)
  })
  ses.setPermissionCheckHandler(() => {
    permissionChecks += 1
    return false
  })

  win = new BrowserWindow({ width: 900, height: 600, show: true, webPreferences: { sandbox: true } })
  await win.loadURL('about:blank')
  view = new WebContentsView({
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })
  win.contentView.addChildView(view)
  view.setBounds({ x: 300, y: 0, width: 600, height: 560 })

  let popupDenied = false
  view.webContents.setWindowOpenHandler(() => {
    popupDenied = true
    return { action: 'deny' }
  })
  view.webContents.on('will-navigate', (event, url) => {
    const u = new URL(url)
    if (!['http:', 'https:'].includes(u.protocol) && url !== 'about:blank') event.preventDefault()
  })

  await view.webContents.loadURL(`http://127.0.0.1:${port}/`)
  await new Promise(resolve => setTimeout(resolve, 100))
  view.webContents.debugger.attach('1.3')
  const evalResult = async expression => {
    const response = await view.webContents.debugger.sendCommand('Runtime.evaluate', {
      expression,
      returnByValue: true,
    })
    return response.result.value
  }
  const security = JSON.parse(await evalResult("document.querySelector('#status').dataset.security"))
  results.checks.hardenedPreferences = security.node === false && security.electron === false && security.amber === false
  results.checks.popupDenied = popupDenied
  results.checks.permissionDenied = permissionRequests > 0 || permissionChecks > 0
  results.checks.debuggerScoped = (await evalResult('location.host')) === `127.0.0.1:${port}`

  const screenshot = await view.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png' })
  const png = Buffer.from(screenshot.data, 'base64')
  await fs.writeFile(path.join(artifactDir, 'viewport.png'), png)
  results.checks.screenshot = png.length > 100

  win.contentView.removeChildView(view)
  win.contentView.addChildView(view)
  view.setBounds({ x: 350, y: 20, width: 500, height: 500 })
  results.checks.detachReattach = !view.webContents.isDestroyed() && (await evalResult('document.readyState')) === 'complete'

  view.setBounds({ x: 0, y: 0, width: 900, height: 560 })
  win.setAlwaysOnTop(true)
  win.show()
  win.moveTop()
  app.focus({ steal: true })
  win.focus()
  view.webContents.focus()
  const nativeHandle = win.getNativeWindowHandle()
  const xid = nativeHandle.length >= 8 ? Number(nativeHandle.readBigUInt64LE()) : nativeHandle.readUInt32LE()
  await fs.writeFile(path.join(artifactDir, 'xid'), `${xid}\n`)
  const windowBounds = win.getBounds()
  await fs.writeFile(path.join(artifactDir, 'focus-point'), `${windowBounds.x + 20} ${windowBounds.y + 30}\n`)
  await fs.writeFile(path.join(artifactDir, 'ready'), 'focused\n')
  const deadline = Date.now() + 10000
  let physical = ''
  while (Date.now() < deadline) {
    physical = await evalResult("document.querySelector('#status').dataset.physical || ''")
    if (physical.includes('z')) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  results.checks.physicalXTestInput = physical.includes('z')
  results.physicalDebug = await evalResult("({ active: document.activeElement?.id, pointer: document.querySelector('#status').dataset.pointer || '', value: document.querySelector('#input').value })")

  const first = win
  win = new BrowserWindow({ width: 900, height: 600, show: true, webPreferences: { sandbox: true } })
  await win.loadURL('about:blank')
  first.contentView.removeChildView(view)
  first.destroy()
  win.contentView.addChildView(view)
  view.setBounds({ x: 300, y: 0, width: 600, height: 560 })
  results.checks.windowReopen = !view.webContents.isDestroyed() && (await evalResult('location.host')) === `127.0.0.1:${port}`

  results.passed = Object.values(results.checks).every(Boolean)
  await writeResult()
}

app.whenReady().then(run).then(() => app.quit()).catch(async error => {
  results.errors.push(error && error.stack ? error.stack : String(error))
  results.passed = false
  await writeResult().catch(() => {})
  app.exit(1)
})

app.on('before-quit', () => {
  try { if (view && !view.webContents.isDestroyed()) view.webContents.close() } catch {}
  try { if (server) server.close() } catch {}
})
