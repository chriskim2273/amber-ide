import { app, BrowserWindow, utilityProcess, MessageChannelMain, Menu, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { ipcMain, dialog, clipboard } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve as resolvePathJoin, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { readFile, writeFile, rename, mkdir, copyFile, chmod, realpath, stat } from 'node:fs/promises'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolveSocketPath } from '../shared/socketPath'
import { pathCandidates } from '../shared/pathSel'
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
import { backoffDelay, nextAttempt } from './clientSupervisor'
import {
  renderDesktopEntry,
  stableAppImagePath,
  desktopFilePath,
  iconInstallPath,
} from './desktopInstall'
import clientPath from '../client/index?modulePath'

// A client child that stays up this long counts as a genuine run; a shorter
// life is treated as a crash-loop and widens the relaunch backoff.
const CLIENT_STABLE_MS = 5000

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

// Linux desktop integration (spec: desktop-install-button design). Copies the
// running AppImage to a STABLE path (launcher entry must survive the download
// being deleted — same pattern as the daemon's ~/.local/bin/amber), installs
// the icon + .desktop entry, refreshes launcher caches best-effort. Idempotent
// overwrite: re-running repairs/upgrades.
async function installDesktopShortcut(win: BrowserWindow): Promise<void> {
  try {
    const home = process.env['HOME'] ?? '.'
    const appImage = process.env['APPIMAGE'] ?? ''
    const stable = stableAppImagePath(home)

    // Self-copy guard: skip the copy when already running from the stable path.
    const [src, dst] = await Promise.all([
      realpath(appImage),
      realpath(stable).catch(() => ''),
    ])
    if (src !== dst) {
      await mkdir(dirname(stable), { recursive: true })
      await copyFile(appImage, stable)
    }
    await chmod(stable, 0o755)

    const icon = iconInstallPath(home)
    await mkdir(dirname(icon), { recursive: true })
    await copyFile(join(process.resourcesPath, 'icon.png'), icon)

    const desktop = desktopFilePath(home)
    await mkdir(dirname(desktop), { recursive: true })
    await writeFile(desktop, renderDesktopEntry(stable))

    await spawnOk('update-desktop-database', [dirname(desktop)]).catch(() => {})
    await spawnOk('gtk-update-icon-cache', [
      join(home, '.local', 'share', 'icons', 'hicolor'),
    ]).catch(() => {})

    await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['OK'],
      title: 'Desktop shortcut installed',
      message: 'amber-ide is now in your app launcher.',
      detail:
        `AppImage copied to ${stable}, launcher entry and icon installed. ` +
        'You can pin amber-ide to the taskbar from the launcher. Re-run this ' +
        'after an upgrade to refresh the installed copy.',
    })
  } catch (err) {
    await dialog.showMessageBox(win, {
      type: 'error',
      buttons: ['OK'],
      title: 'Install failed',
      message: 'Could not install the desktop shortcut.',
      detail: String(err),
    })
  }
}

// Minimal application menu. Keeps the standard macOS roles (app/Edit/Window) so
// copy/paste and window management work; adds the explicit "Quit amber daemon"
// item required by spec §3/§6. On Linux only that item plus the plain quit.
function buildAppMenu(onQuitDaemon: () => void, onInstallDesktop: (() => void) | null): Menu {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = []
  // macOS appMenu already carries a plain "Quit amber-ide" (quits the app,
  // leaves the daemon running); on Linux we add that plain quit ourselves.
  if (isMac) template.push({ role: 'appMenu' })
  const submenu: MenuItemConstructorOptions[] = [
    ...(onInstallDesktop !== null
      ? [
          { label: 'Install desktop shortcut', click: () => onInstallDesktop() },
          { type: 'separator' } as MenuItemConstructorOptions,
        ]
      : []),
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
    // Floor the window at the chrome's own footprint plus a usable stage. The
    // toolbar is a no-wrap flex row with a ~410px min-content width, and
    // toolbar+tabbar eat 84px of height; below that the pane stage collapses to
    // zero and every terminal clamps to its 2x1 floor.
    minWidth: 500,
    minHeight: 300,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Browser panes (web-viewer): the renderer hosts <webview> tags. Each runs
      // unprivileged (no nodeIntegration, its own persist partition) — see
      // Browser.tsx + spec 2026-07-18 §8.
      webviewTag: true,
      // Keep the preload SANDBOXED (default) for security. A sandboxed preload
      // has no node builtins and no `process.env`, so the two values it needs
      // are passed as argv flags (reachable via `process.argv` in sandbox).
      // Do NOT import `node:os`/read `process.env` in the preload — it throws
      // before exposeInMainWorld and the whole bridge silently vanishes.
      additionalArguments: [
        `--amber-home=${process.env['HOME'] ?? ''}`,
        ...(process.env['AMBER_SOFTWARE_GL'] ? ['--amber-software-gl'] : []),
      ],
    },
  })

  // The AppImage runtime exports $APPIMAGE (path to the image) — its presence
  // implies packaged Linux, the only place desktop install applies.
  const canInstallDesktop = process.platform === 'linux' && !!process.env['APPIMAGE']
  Menu.setApplicationMenu(
    buildAppMenu(
      () => { void quitDaemonAndApp(win) },
      canInstallDesktop ? () => { void installDesktopShortcut(win) } : null,
    ),
  )

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

  // Supervise the client utilityProcess. It owns the daemon socket (rule #4:
  // terminal bytes never touch the main process), and the renderer's
  // "disconnected" banner is fed ONLY by events from inside it — so if it dies
  // the UI freezes silently. On death: tell the renderer immediately (banner),
  // then relaunch with capped backoff, and signal the renderer to re-request its
  // now-dead pane ports from the fresh child. The `open-pane`/`daemon-command`
  // handlers below are registered ONCE and read the current child/port via these
  // mutable refs, so relaunches never stack duplicate handlers.
  let child: Electron.UtilityProcess | null = null
  let controlPort: Electron.MessagePortMain | null = null
  let relaunchAttempt = 0
  let quitting = false
  app.on('before-quit', () => { quitting = true })

  const notifyRenderer = (data: unknown): void => {
    if (!win.isDestroyed()) win.webContents.send('daemon-event', data)
  }

  const wireChild = (): void => {
    const c = utilityProcess.fork(clientPath)
    child = c
    const spawnedAt = Date.now()
    const { port1, port2 } = new MessageChannelMain()
    controlPort = port1
    c.postMessage({ kind: 'control' }, [port2])
    // Forward daemon control events (and connection status) to the renderer.
    port1.on('message', (e) => notifyRenderer(e.data))
    port1.start()
    c.on('exit', () => {
      // This child's control channel died with it — close our end explicitly
      // (matches the "replace dead ports" intent; nothing will read port1 again).
      port1.close()
      if (child === c) { child = null; controlPort = null }
      if (quitting) return
      // Crash is never silent: flip the renderer to disconnected right away
      // (same shape the daemon uses), even if the window is gone on macOS.
      notifyRenderer({ status: 'disconnected' })
      relaunchAttempt = nextAttempt(relaunchAttempt, Date.now() - spawnedAt, CLIENT_STABLE_MS)
      const delay = backoffDelay(relaunchAttempt, { baseMs: 100, maxMs: 2000 })
      setTimeout(() => {
        if (quitting || win.isDestroyed()) return
        wireChild()
        // The renderer's MessagePorts died with the old child. Tell it to
        // re-request pane ports from the NEW child (handled via childEpoch).
        notifyRenderer({ childRestart: true })
      }, delay)
    })
  }
  wireChild()

  ipcMain.on('daemon-command', (_e, cmd: unknown) => controlPort?.postMessage(cmd))

  ipcMain.on('open-pane', (_e, session: string) => {
    const c = child
    if (!c || win.isDestroyed()) return
    const { port1: rPort, port2: uPort } = new MessageChannelMain()
    c.postMessage({ kind: 'pane', session }, [uPort])
    win.webContents.postMessage('pane-port', { session }, [rPort])
  })

  // Resolve a terminal selection to an EXISTING absolute path so the pane's
  // floating "Open" button only shows for real files/dirs. Relative selections
  // resolve against the pane's cwd; ~ expands; surrounding quotes and a trailing
  // grep/compiler :line[:col] suffix are stripped as fallbacks (stat is the real
  // gate). Returns the abs path, or null if nothing matched.
  // ponytail: quote+`:line` stripping is a heuristic, not a shell tokenizer —
  // upgrade to real word-splitting only if selections routinely miss.
  ipcMain.handle('resolve-path', async (_e, cwd: string, raw: string) => {
    const base = cwd && isAbsolute(cwd) ? cwd : homedir()
    for (const c of pathCandidates(String(raw))) {
      let s = c
      if (s === '~' || s.startsWith('~/')) s = join(homedir(), s.slice(1))
      const abs = isAbsolute(s) ? s : resolvePathJoin(base, s)
      try { await stat(abs); return abs } catch { /* try next candidate */ }
    }
    return null
  })
  // Reveal a resolved path in the OS file manager (item highlighted in folder).
  ipcMain.on('reveal-path', (_e, abs: unknown) => {
    if (typeof abs === 'string' && isAbsolute(abs)) shell.showItemInFolder(abs)
  })

  // Browser-pane popups (target=_blank / window.open) open in the system browser
  // rather than spawning a new in-app webview (spec 2026-07-18 §8). Guarded to
  // http/https so a hostile page can't drive shell.openExternal at other schemes.
  ipcMain.on('open-external', (_e, url: unknown) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  // Terminal clipboard via Electron's `clipboard` module — the reliable path.
  // The renderer's xterm selection is drawn by xterm itself (not in a DOM
  // selection), so the native Edit-menu copy role misses it; and the Edit menu
  // only exists on macOS, so Linux had NO copy path at all. Routing through main
  // sidesteps navigator.clipboard's focus/permission quirks (readText in
  // particular). Write ignores empty strings so an empty selection never clobbers
  // the clipboard.
  ipcMain.on('clipboard-write', (_e, text: unknown) => {
    if (typeof text === 'string' && text.length > 0) clipboard.writeText(text)
  })
  ipcMain.handle('clipboard-read', () => clipboard.readText())

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

  // Portable workspace file: native save dialog + atomic write (layout-save
  // precedent). Returns true on write, false on cancel.
  ipcMain.handle('workspace-save-file', async (_e, json: string, suggestedName: string) => {
    const r = await dialog.showSaveDialog(win, {
      defaultPath: suggestedName,
      filters: [{ name: 'amber workspace', extensions: ['amberws'] }],
    })
    if (r.canceled || !r.filePath) return false
    // showSaveDialog does not reliably append the filter extension on Linux —
    // add it so the open filter finds the file later.
    const p = r.filePath.endsWith('.amberws') ? r.filePath : r.filePath + '.amberws'
    const tmp = p + '.tmp'
    await writeFile(tmp, json)
    await rename(tmp, p)
    return true
  })
  // Native open dialog; returns the file text, or null on cancel.
  ipcMain.handle('workspace-open-file', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'amber workspace', extensions: ['amberws'] }, { name: 'All files', extensions: ['*'] }],
    })
    if (r.canceled || r.filePaths.length === 0 || !r.filePaths[0]) return null
    return readFile(r.filePaths[0], 'utf8')
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
