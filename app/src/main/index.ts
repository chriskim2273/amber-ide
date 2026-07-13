import { app, BrowserWindow, utilityProcess, MessageChannelMain } from 'electron'
import { ipcMain } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { readFile, writeFile, rename, mkdir, copyFile, chmod } from 'node:fs/promises'
import { resolveSocketPath } from '../shared/socketPath'
import { ensureDaemon, probeSocket } from './daemonBoot'
import { resolveAmberBinary } from './amberBin'
import clientPath from '../client/index?modulePath'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Headless / no-GPU environments (CI, sandboxed dev boxes) can't load the
// hardware GL driver (Mesa DRI). Opt into software GL via ANGLE+SwiftShader so
// xterm still gets a real WebGL context instead of failing. Must run before
// app is ready. Production desktops leave AMBER_SOFTWARE_GL unset.
if (process.env['AMBER_SOFTWARE_GL']) {
  app.commandLine.appendSwitch('use-gl', 'angle')
  app.commandLine.appendSwitch('use-angle', 'swiftshader')
  app.commandLine.appendSwitch('enable-unsafe-swiftshader')
  // Under software GL, waiting on the compositor vsync adds a frame (~16ms+) of
  // input-echo latency. Disable it so keystrokes paint immediately. (The
  // renderer also drops xterm's WebGL addon for the DOM renderer here — WebGL
  // on SwiftShader is the actual lag source; socket round-trip is <1ms.)
  app.commandLine.appendSwitch('disable-gpu-vsync')
  app.commandLine.appendSwitch('disable-frame-rate-limit')
}
if (process.env['AMBER_NO_SANDBOX']) {
  app.commandLine.appendSwitch('no-sandbox')
  // Sandboxed /dev/shm is often tiny or inaccessible; fall back to /tmp so
  // Chromium's shared-memory allocation doesn't fatally crash.
  app.commandLine.appendSwitch('disable-dev-shm-usage')
  // On bleeding-edge kernels (e.g. 6.17), glibc routes access() through the
  // faccessat2() syscall; Electron 43's older Chromium seccomp-bpf policy
  // traps it, surfacing as bogus ESRCH ("No such process") on /dev/shm and
  // /tmp and preventing shared-memory allocation (renderer never paints).
  // Disabling the seccomp filter avoids the trap on such kernels.
  app.commandLine.appendSwitch('disable-seccomp-filter-sandbox')
  // The zygote sets up child-process namespaces; on kernel 6.17 that context
  // is where Chromium's shared-memory access() returns a bogus ESRCH (all shm
  // primitives work at top level). Spawn children without the zygote so they
  // inherit the browser process's working context.
  app.commandLine.appendSwitch('no-zygote')
}

function amberBinary(): string {
  return resolveAmberBinary(process.env, app.isPackaged, process.resourcesPath)
}

function layoutPath(): string {
  const stateHome = process.env['XDG_STATE_HOME']
  const root = stateHome && stateHome.length > 0 ? stateHome + '/amber-ide'
    : (process.env['HOME'] ?? '.') + '/.local/state/amber-ide'
  return root + '/ui-layout.json'
}

// systemd user unit, mirroring infra/daemon/amber.service. ExecStart uses the
// STABLE ~/.local/bin/amber path (%h), never the ephemeral bundle mount.
const AMBER_SYSTEMD_UNIT = `[Unit]
Description=amber session daemon (persistent terminal workspace)

[Service]
Type=simple
ExecStart=%h/.local/bin/amber daemon
Restart=on-failure
RestartSec=1
KillSignal=SIGTERM
TimeoutStopSec=10

[Install]
WantedBy=default.target
`

function spawnOk(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'ignore' })
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))))
    p.on('error', reject)
  })
}

async function installDaemon(): Promise<void> {
  const home = process.env['HOME'] ?? '.'

  if (app.isPackaged) {
    // A packaged app has no repo/toolchain, so `amber ctl install` (which runs
    // cargo from a source checkout) can't work. Do a cargo-free install: place
    // the bundled amber at a STABLE path and write the boot unit directly — the
    // ephemeral AppImage/dmg mount path would break reboot survival.
    const stable = join(home, '.local', 'bin', 'amber')
    await mkdir(dirname(stable), { recursive: true })
    await copyFile(amberBinary(), stable)
    await chmod(stable, 0o755)

    if (process.platform === 'linux') {
      const unitDir = join(home, '.config', 'systemd', 'user')
      await mkdir(unitDir, { recursive: true })
      await writeFile(join(unitDir, 'amber.service'), AMBER_SYSTEMD_UNIT)
      await spawnOk('systemctl', ['--user', 'daemon-reload'])
      // enable-linger lets the user daemon run at boot before login (reboot
      // survival). Best-effort: don't fail the whole install if it's denied.
      await spawnOk('loginctl', ['enable-linger', process.env['USER'] ?? '']).catch(() => {})
      await spawnOk('systemctl', ['--user', 'enable', '--now', 'amber.service'])
      return
    }
    // macOS packaged: launchd-agent install is a follow-up; start the daemon
    // for this session so the app is usable now (reboot survival TODO on mac).
    spawn(stable, ['daemon'], { detached: true, stdio: 'ignore' }).unref()
    return
  }

  // Dev (repo checkout): `amber ctl install` builds + installs from source.
  await spawnOk(amberBinary(), ['ctl', 'install'])
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
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  // CSP from the main process, not a static meta tag: dev needs Vite's HMR
  // (inline preamble + eval for React refresh + the ws: socket), production
  // stays strict. Set before the initial load so it applies immediately.
  const isDev = !!process.env['ELECTRON_RENDERER_URL']
  win.webContents.session.webRequest.onHeadersReceived((details, cb) => {
    const csp = isDev
      ? "default-src 'self' 'unsafe-inline' 'unsafe-eval' ws: wss: data: blob: http://localhost:*"
      : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; worker-src 'self' blob:"
    cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
  })
  // Surface renderer console in the terminal for DEV diagnosis only — never in
  // production, where it could pipe sensitive page/terminal data to stdout.
  if (isDev) {
    win.webContents.on('console-message', (e) => {
      console.log(`[renderer:${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`)
    })
  }
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log(`[did-fail-load] ${code} ${desc} ${url}`)
  })

  if (process.env['ELECTRON_RENDERER_URL']) await win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else await win.loadFile(join(__dirname, '../renderer/index.html'))

  const child = utilityProcess.fork(clientPath)
  const { port1, port2 } = new MessageChannelMain()
  child.postMessage({ kind: 'control' }, [port2])
  // Forward daemon control events to the renderer for logging (slice 2 proof).
  port1.on('message', (e) => win.webContents.send('daemon-event', e.data))
  port1.start()

  ipcMain.on('daemon-command', (_e, cmd: unknown) => port1.postMessage(cmd))

  ipcMain.on('open-pane', (_e, session: string) => {
    const { port1: rPort, port2: uPort } = new MessageChannelMain()
    child.postMessage({ kind: 'pane', session }, [uPort])
    win.webContents.postMessage('pane-port', { session }, [rPort])
  })

  ipcMain.handle('layout-load', async () => {
    try { return await readFile(layoutPath(), 'utf8') } catch { return null }
  })
  ipcMain.handle('layout-save', async (_e, text: string) => {
    const p = layoutPath()
    await mkdir(dirname(p), { recursive: true })
    const tmp = p + '.tmp'
    await writeFile(tmp, text)
    await rename(tmp, p)
  })
}

app.whenReady().then(main).catch((e) => {
  console.error(e)
  app.quit()
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
