import { app, BrowserWindow, utilityProcess, MessageChannelMain } from 'electron'
import { ipcMain } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { resolveSocketPath } from '../shared/socketPath'
import { ensureDaemon, probeSocket } from './daemonBoot'
import clientPath from '../client/index?modulePath'

const __dirname = dirname(fileURLToPath(import.meta.url))

function amberBinary(): string {
  // Dev: rely on PATH. Packaging (slice 7) swaps this for the bundled binary.
  return process.env['AMBER_BIN'] ?? 'amber'
}

async function installDaemon(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const p = spawn(amberBinary(), ['ctl', 'install'], { stdio: 'ignore' })
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ctl install exit ${code}`))))
    p.on('error', reject)
  })
}

async function main(): Promise<void> {
  const socket = resolveSocketPath(process.env)
  await ensureDaemon(socket, {
    probe: probeSocket,
    install: installDaemon,
    delayMs: (a) => Math.min(2000, 100 * 2 ** a),
    attempts: 8,
  })

  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  if (process.env['ELECTRON_RENDERER_URL']) await win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else await win.loadFile(join(__dirname, '../renderer/index.html'))

  const child = utilityProcess.fork(clientPath)
  const { port1, port2 } = new MessageChannelMain()
  child.postMessage({ kind: 'control' }, [port2])
  // Forward daemon control events to the renderer for logging (slice 2 proof).
  port1.on('message', (e) => win.webContents.send('daemon-event', e.data))
  port1.start()

  ipcMain.on('open-pane', (_e, session: string) => {
    const { port1: rPort, port2: uPort } = new MessageChannelMain()
    child.postMessage({ kind: 'pane', session }, [uPort])
    win.webContents.postMessage('pane-port', { session }, [rPort])
  })
}

app.whenReady().then(main).catch((e) => {
  console.error(e)
  app.quit()
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
