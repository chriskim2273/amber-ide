import { app, BrowserWindow, utilityProcess, MessageChannelMain, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { ipcMain, dialog } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { readFile, writeFile, rename, mkdir, copyFile, chmod } from 'node:fs/promises'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolveSocketPath } from '../shared/socketPath'
import { ensureDaemon, probeSocket } from './daemonBoot'
import { resolveAmberBinary } from './amberBin'
import {
  renderDaemonPlist,
  launchAgentPlistPath,
  launchctlBootstrapArgv,
  launchctlLoadArgv,
  launchctlKickstartArgv,
  stopDaemonCommand,
  stopDaemonFallbackCommand,
  bootUnitPath,
} from './serviceManager'
import clientPath from '../client/index?modulePath'

const __dirname = dirname(fileURLToPath(import.meta.url))

function stateRoot(): string {
  const stateHome = process.env['XDG_STATE_HOME']
  return stateHome && stateHome.length > 0 ? join(stateHome, 'amber-ide')
    : join(process.env['HOME'] ?? '.', '.local', 'state', 'amber-ide')
}
// Persisted marker: written after a detected GPU/renderer crash so the next
// launch starts in compat mode directly (no crash-relaunch cycle).
const compatFlagPath = join(stateRoot(), 'render-compat')

// Compat mode = software GL + relaxed sandbox + kernel-shm workarounds. Needed
// where Electron 43's Chromium can't do multi-process GPU/shm (e.g. kernel 6.17,
// which traps faccessat2() in the child seccomp policy → bogus ESRCH on
// /dev/shm and /tmp → renderer never paints). Triggered by an env override or
// the persisted flag; on healthy machines it stays off (hardware GL + sandbox).
// main() auto-detects a first-run crash, writes the flag, and relaunches.
const compat =
  !!process.env['AMBER_SOFTWARE_GL'] ||
  !!process.env['AMBER_NO_SANDBOX'] ||
  existsSync(compatFlagPath)

if (compat) {
  // Software GL via ANGLE+SwiftShader (xterm still gets a real GL context), and
  // disable vsync so keystrokes paint without a compositor-frame of latency.
  app.commandLine.appendSwitch('use-gl', 'angle')
  app.commandLine.appendSwitch('use-angle', 'swiftshader')
  app.commandLine.appendSwitch('enable-unsafe-swiftshader')
  app.commandLine.appendSwitch('disable-gpu-vsync')
  app.commandLine.appendSwitch('disable-frame-rate-limit')
  // Sandbox/shm/kernel workarounds (the faccessat2 seccomp trap lives in the
  // zygote-set-up child namespace; --no-zygote is the one that actually fixes
  // shm allocation on kernel 6.17).
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-dev-shm-usage')
  app.commandLine.appendSwitch('disable-seccomp-filter-sandbox')
  app.commandLine.appendSwitch('no-zygote')
  // The renderer reads this to pick xterm's DOM renderer over WebGL (WebGL on
  // SwiftShader is the input-lag source).
  process.env['AMBER_SOFTWARE_GL'] = '1'
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
    // macOS packaged: write the launchd agent plist to ~/Library/LaunchAgents
    // pointing at the STABLE binary (launchd has no %h — needs an absolute path,
    // never the ephemeral dmg mount) and load it. RunAtLoad + bootstrap start
    // the daemon now AND give it reboot survival, so — unlike before — we do NOT
    // also detached-spawn it (two daemons would race for the same socket and hit
    // the live-socket steal guard). Best-effort like the Linux branch: the outer
    // ensureDaemon probe loop verifies the socket actually comes up.
    if (process.platform === 'darwin') {
      const uid = process.getuid?.() ?? 0
      const agentDir = join(home, 'Library', 'LaunchAgents')
      const plistPath = launchAgentPlistPath(home)
      await mkdir(agentDir, { recursive: true })
      await writeFile(plistPath, renderDaemonPlist(stable))
      await chmod(plistPath, 0o644)
      // bootstrap (modern) → load -w (older / already-bootstrapped) → kickstart
      // (force-run on re-runs). Each best-effort; none should fail the install.
      const boot = launchctlBootstrapArgv(uid, plistPath)
      await spawnOk(boot.cmd, boot.args).catch(async () => {
        const load = launchctlLoadArgv(plistPath)
        await spawnOk(load.cmd, load.args).catch(() => {})
      })
      const kick = launchctlKickstartArgv(uid)
      await spawnOk(kick.cmd, kick.args).catch(() => {})
      return
    }
    return
  }

  // Dev (repo checkout): `amber ctl install` builds + installs from source.
  await spawnOk(amberBinary(), ['ctl', 'install'])
}

// Spec §3/§6: the ONLY app path that stops the daemon. Confirms, stops the
// daemon via the service manager (never by guessing pids), then quits the app.
// The plain OS "Quit" (app/appMenu role) quits the app but leaves the daemon
// running — that is the intended asymmetry.
async function quitDaemonAndApp(win: BrowserWindow): Promise<void> {
  const confirm = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Cancel', 'Quit amber daemon'],
    defaultId: 0,
    cancelId: 0,
    title: 'Quit amber daemon',
    message: 'Stop the amber daemon and quit?',
    detail:
      'This stops the background amber daemon — the only action that does. Every ' +
      'terminal session it owns will stop (their ptys are killed) until the daemon ' +
      'next starts. Closing the window normally leaves the daemon running.',
  })
  if (confirm.response !== 1) return

  const home = process.env['HOME'] ?? '.'
  const unit = bootUnitPath(process.platform, home)
  // No installed boot unit => dev / unmanaged daemon. Don't guess at pids;
  // report it and quit (the daemon keeps running, as when closing the window).
  if (unit === null || !existsSync(unit)) {
    await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Quit app'],
      title: 'Daemon not managed here',
      message: 'No installed amber boot unit found.',
      detail:
        'The daemon was not installed via the app (dev mode or unmanaged), so it ' +
        'cannot be stopped from here. Quitting the app now — the daemon keeps running.',
    })
    app.quit()
    return
  }

  const uid = process.getuid?.() ?? 0
  const stop = stopDaemonCommand(process.platform, uid)
  if (stop !== null) {
    await spawnOk(stop.cmd, stop.args).catch(async () => {
      const fb = stopDaemonFallbackCommand(process.platform, launchAgentPlistPath(home))
      if (fb !== null) await spawnOk(fb.cmd, fb.args).catch(() => {})
    })
  }
  app.quit()
}

// Minimal application menu. Keeps the standard macOS roles (app/Edit/Window) so
// copy/paste and window management work; adds the explicit "Quit amber daemon"
// item required by spec §3/§6. On Linux only that item plus the plain quit.
function buildAppMenu(onQuitDaemon: () => void): Menu {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = []
  // macOS appMenu already carries a plain "Quit amber-ide" (quits the app,
  // leaves the daemon running); on Linux we add that plain quit ourselves.
  if (isMac) template.push({ role: 'appMenu' })
  const submenu: MenuItemConstructorOptions[] = [
    { label: 'Quit amber daemon', click: () => onQuitDaemon() },
  ]
  if (!isMac) submenu.push({ type: 'separator' }, { role: 'quit' })
  template.push({ label: isMac ? 'Daemon' : 'File', submenu })
  if (isMac) template.push({ role: 'editMenu' }, { role: 'windowMenu' })
  return Menu.buildFromTemplate(template)
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

  Menu.setApplicationMenu(buildAppMenu(() => { void quitDaemonAndApp(win) }))

  // Auto-detect the kernel-6.17/Chromium GPU-shm failure. If we're NOT already
  // in compat mode and the GPU crashes / the renderer dies / the page never
  // finishes loading, persist the compat flag and relaunch — the next start
  // applies the software-GL + sandbox workarounds. On healthy machines the page
  // loads, the timer clears, and this never fires.
  if (!compat) {
    let switching = false
    const enterCompat = (): void => {
      if (switching) return
      switching = true
      try { mkdirSync(stateRoot(), { recursive: true }); writeFileSync(compatFlagPath, '1') } catch { /* ignore */ }
      app.relaunch()
      app.exit(0)
    }
    const loadTimer = setTimeout(enterCompat, 10000)
    win.webContents.once('did-finish-load', () => clearTimeout(loadTimer))
    win.webContents.on('render-process-gone', enterCompat)
    app.on('child-process-gone', (_e, d) => {
      if (d.type === 'GPU' && d.reason !== 'clean-exit') enterCompat()
    })
  }

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

  ipcMain.handle('pick-folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
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

// Single-instance lock: a second launch (or a dev run whose predecessor didn't
// fully exit) would open a second window + utilityProcess attaching the same
// daemon sessions — duplicate subscriptions that read as "input sent twice".
// Refuse to run a duplicate; the first instance keeps ownership.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.whenReady().then(main).catch((e) => {
    console.error(e)
    app.quit()
  })
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
