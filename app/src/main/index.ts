import { app, BrowserWindow, utilityProcess, MessageChannelMain, Menu, shell, Notification, Tray, nativeImage } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { ipcMain, dialog, clipboard } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { basename, dirname, join, resolve as resolvePathJoin, isAbsolute } from 'node:path'
import { homedir, hostname, release as osRelease, tmpdir } from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, rename, mkdir, copyFile, chmod, rm, stat, mkdtemp } from 'node:fs/promises'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolveSocketPath } from '../shared/socketPath'
import { HANDOFF_FILE_MAX, parseHandoff } from '../shared/handoff'
import { pathCandidates } from '../shared/pathSel'
import { ensureDaemon, isSocketAbsent, probeSocket, type EnsureDeps } from './daemonBoot'
import {
  resolveAmberBinary,
  resolveAmberDaemonBinary,
  windowsAmberPath,
  windowsDaemonPath,
} from './amberBin'
import {
  renderDaemonPlist,
  launchAgentPlistPath,
  launchctlBootstrapArgv,
  launchctlLoadArgv,
  launchctlKickstartArgv,
  stopDaemonCommand,
  stopDaemonFallbackCommand,
  bootUnitPath,
  restartDaemonCommand,
  AMBER_SYSTEMD_UNIT,
  linuxInstallServiceArgv,
  windowsRunKeyCommand,
  windowsTaskkillCommand,
  isWindowsTaskkillNoMatch,
  shouldStopWindowsDaemon,
} from './serviceManager'
import { backoffDelay, launchIfAbsent, nextAttempt, shouldRelaunchClient } from './clientSupervisor'
import {
  renderDesktopEntry,
  stableAppImagePath,
  desktopFilePath,
  iconInstallPath,
} from './desktopInstall'
import {
  readEditorFile,
  saveEditorFile,
  writeDraft,
  readDraft,
  clearDraft,
  inlineImages,
} from './editorFiles'
import { claudeNames } from './claudeNames'
import { loadLayoutFile, saveLayoutFile } from './layoutIO'
import {
  loadProductivityFile, saveProductivityFile, readProjectProfile,
  listCheckpoints, writeCheckpoint, readCheckpoint, deleteCheckpoint,
} from './productivityIO'
import { compatSignature, shouldUseCompat, compatWorthyReason, COMPAT_SWITCHES, DETECT_WINDOW_MS } from './renderCompat'
import { installBinary } from './installBinary'
import { repairAgentExtensions } from './agentSetup'
import {
  sshTunnelArgv, isValidHost, localSocketPath, hostLabel,
  REMOTE_SOCKET_PROBE, REMOTE_LAYOUT_PROBE, REMOTE_LAYOUT_PROBE_MAX_BYTES,
  parseAgentSock, explainSshFailure, runSshProbe,
  isSupportedOnPlatform,
} from './sshRemote'
import { webCtlArgv, parseWebStatus, redactUrl, type WebStatus } from './webService'
import {
  routerCtlArgv,
  parseRouterStatus,
  slotFromWire,
  type RouterStatus,
} from './routerService'
import { inspectLinuxInputMethod, repairLinuxInputMethod, resolveLinuxInputEnvironment } from './inputMethod'
import { TabBrowserService, parseTabBrowserCommand, stageWorkspaceBrowserState } from './tabBrowserService'
import { TabBrowserBrokerServer, authorizeBrowserRequest, dispatchAttachedBrokerAction, isEligiblePiController, type BrokerRequest } from './tabBrowserBroker'
import { BrowserDaemonWatcher } from './browserDaemonWatcher'
import { Connection } from '../client/connection'
import { TabBrowserStateStore } from './tabBrowserStateStore'
import { commitBrowserLayoutMutation, coordinateTabBrowserMigration } from './tabBrowserMigrationCoordinator'
import { bindRendererBrowserCommand, browserAuthorityChanged } from './browserAssociationAuthority'
import { emptyLayout, layoutUtf8ByteLength, LAYOUT_FILE_MAX_BYTES, parseLayout, serializeLayout, type LayoutFile } from '../shared/layoutFile'
import { assertWorkspaceFileBytes, parseWorkspaceFile, WORKSPACE_FILE_MAX_BYTES } from '../shared/workspaceFile'
import { commitPreparedWorkspaceImport, prepareWorkspaceImport } from './workspaceImport'
import { browserContextMatches, captureBrowserContext, hasExactApprovalSurface, resolveBrowserContext, sameBrowserContextIdentity, setBrowserForCurrentContext } from './browserWindowContext'
import { createBrowserId } from '../shared/tabBrowser'
import { isRecoveryId } from '../shared/tabBrowserState'
import { BrowserOperationRegistry } from './browserOperationRegistry'
import { readSafeTextFile, readSafeTextFileSync, SafeFileReadError } from './safeFileReader'
import { browserHostSocketPath } from './browserHostPaths'
import {
  activationRequest,
  clearBrowserHostInhibit,
  coordinateBrowserHostQuit,
  installStableAppImage,
  parseActivationRequest,
  registerBrowserHostLauncher,
  ResidentIntentLatch,
  writeBrowserHostInhibit,
} from './browserResident'
import clientPath from '../client/index?modulePath'

// A client child that stays up this long counts as a genuine run; a shorter
// life is treated as a crash-loop and widens the relaunch backoff.
const CLIENT_STABLE_MS = 5000

const __dirname = dirname(fileURLToPath(import.meta.url))

async function readBoundedTextFile(path: string, maxBytes: number, limitCode: string): Promise<string> {
  try {
    const owner = process.getuid?.()
    const text = await readSafeTextFile(path, { maxBytes, ...(owner === undefined ? {} : { owner }) })
    if (text === null) throw new Error('WORKSPACE_FILE_CHANGED')
    return text
  } catch (error) {
    if (!(error instanceof SafeFileReadError)) throw error
    if (error.code === 'FILE_TOO_LARGE') throw new Error(limitCode)
    if (error.code === 'SYMLINK') throw new Error('WORKSPACE_SYMLINK')
    if (error.code === 'NOT_REGULAR') throw new Error('WORKSPACE_NOT_REGULAR')
    if (error.code === 'INVALID_UTF8') throw new Error('WORKSPACE_INVALID_UTF8')
    if (error.code === 'READ_TIMEOUT') throw new Error('WORKSPACE_READ_TIMEOUT')
    if (error.code === 'FILE_CHANGED') throw new Error('WORKSPACE_FILE_CHANGED')
    throw error
  }
}

function stateRoot(): string {
  if (process.platform === 'win32') {
    return join(process.env['LOCALAPPDATA'] ?? '.', 'amber-ide')
  }
  const stateHome = process.env['XDG_STATE_HOME']
  return stateHome && stateHome.length > 0 ? join(stateHome, 'amber-ide')
    : join(process.env['HOME'] ?? '.', '.local', 'state', 'amber-ide')
}
// Persisted marker: written after a detected GPU/renderer crash so the next
// launch starts in compat mode directly (no crash-relaunch cycle). It records
// the environment the decision was made in, so it expires when that changes —
// see renderCompat.ts for why a permanent marker was a bug.
const compatFlagPath = join(stateRoot(), 'render-compat')
const COMPAT_SIGNATURE = compatSignature(process.versions.electron ?? 'unknown', osRelease())

function readCompatFlag(): string | null {
  try {
    const owner = process.getuid?.()
    return readSafeTextFileSync(compatFlagPath, { maxBytes: 256, ...(owner === undefined ? {} : { owner }) })
  } catch {
    // The marker is only an optimization hint. Any absent, unsafe, oversized,
    // changed, or malformed marker must fall back to the hardware-GPU probe;
    // startup must never allocate from attacker-controlled bytes here.
    return null
  }
}

const compat = shouldUseCompat(process.env, readCompatFlag(), COMPAT_SIGNATURE)

function tabBrowserHostEnabled(): boolean {
  return process.env['AMBER_TAB_BROWSER_HOST'] === '1'
    && process.env['AMBER_TAB_BROWSER_V2_READER_DEPLOYED'] === '1'
    && !compat && process.platform !== 'win32'
}

if (compat) {
  for (const [name, value] of COMPAT_SWITCHES) {
    if (value === undefined) app.commandLine.appendSwitch(name)
    else app.commandLine.appendSwitch(name, value)
  }
  // The renderer reads this to pick xterm's DOM renderer over WebGL (WebGL on
  // SwiftShader is the input-lag source).
  process.env['AMBER_SOFTWARE_GL'] = '1'
}

/**
 * Port `amber web` listens on.
 *
 * KNOWN LIMITATION (plan follow-up 2): this is one of three places the port
 * lives — here, `infra/daemon/amber-web.service`, and `webctl::render_*`'s
 * argument. `amber ctl web enable --port N` therefore produces a service this
 * dialog cannot see: it queries 7717 and reports `unit: inactive` while the
 * service runs fine on N. The fix is to read the port out of the installed
 * unit; the dialog offers no port editor yet, so this is deliberate for now.
 */
const WEB_PORT = 7717
// Must match `routerctl::DEFAULT_PORT` and the shipped unit.
const ROUTER_PORT = 7719

/** Run a command and collect its output. Never rejects — callers report. */
function runCapture(
  cmd: string,
  args: string[],
  timeoutMs?: number,
  stdin?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const p = spawn(cmd, args, {
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    if (stdin !== undefined) {
      p.stdin?.end(stdin)
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: { code: number; stdout: string; stderr: string }): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolveRun(result)
    }
    p.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    p.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    p.on('close', (code) => finish({ code: code ?? -1, stdout, stderr }))
    p.on('error', (e) => finish({ code: -1, stdout: '', stderr: String(e) }))
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        try { p.kill('SIGKILL') } catch { /* already gone */ }
        finish({ code: -1, stdout, stderr: `${stderr}${stderr ? '\n' : ''}timed out after ${timeoutMs} ms` })
      }, timeoutMs)
    }
  })
}

function runAmberCapture(
  args: string[],
  stdin?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return runCapture(amberBinary(), args, undefined, stdin)
}

async function isSocket(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isSocket()
  } catch {
    return false
  }
}

/**
 * Chromium uses IBus for physical keyboard events on Linux/X11. A live
 * ibus-daemon can retain a registry entry for a socket that has been unlinked;
 * systemd's Restart=on-abnormal does not notice because the process itself is
 * still healthy. New Electron clients then log a growing IBus event queue and
 * eventually drop every physical key, while synthetic DevTools input continues
 * to work. Detect that exact condition before a terminal window can open.
 */
async function preflightLinuxInputMethod(): Promise<boolean> {
  const run = (cmd: string, args: string[]) => runCapture(cmd, args, 8000)
  const effectiveEnv = await resolveLinuxInputEnvironment({
    platform: process.platform,
    env: process.env,
    run,
  })
  // Chromium reads these while constructing its first input context. A raw
  // AppImage relaunch can omit them even though GNOME's user manager has the
  // authoritative values, which was the gap in the first startup guard.
  for (const key of ['XMODIFIERS', 'GTK_IM_MODULE', 'QT_IM_MODULE'] as const) {
    if (process.env[key] === undefined && effectiveEnv[key] !== undefined) {
      process.env[key] = effectiveEnv[key]
    }
  }
  const options = {
    platform: process.platform,
    env: effectiveEnv,
    run,
    isSocket,
  }
  const health = await inspectLinuxInputMethod(options)
  if (health.status !== 'stale') return true

  process.stderr.write(`amber: desktop input preflight failed: ${health.reason}\n`)
  const choice = await dialog.showMessageBox({
    type: 'warning',
    title: 'Keyboard input needs repair',
    message: 'Amber cannot connect to the Linux input service.',
    detail: `${health.reason}\n\nPhysical keyboard input may not work until IBus is restarted. Running sessions and the amber daemon will not be affected.`,
    buttons: ['Restart input service', 'Continue anyway', 'Quit Amber'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  })

  if (choice.response === 1) return true
  if (choice.response !== 0) {
    quitDuringStartup()
    return false
  }

  // A stale explicit override wins over IBus's newly generated registry file.
  // Drop it only after proving it is broken, so repair and the first Chromium
  // input context both discover the replacement address.
  delete process.env['IBUS_ADDRESS']
  const repaired = await repairLinuxInputMethod({
    ...options,
    delay: (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms)),
  })
  if (repaired.status === 'healthy') {
    // This runs before the first BrowserWindow exists. Continuing now creates
    // Chromium's input context against the replacement socket; no AppImage
    // relaunch cycle (and no ephemeral-mount race) is necessary.
    return true
  }

  const reason = repaired.status === 'stale' ? repaired.reason : 'IBus did not recover'
  process.stderr.write(`amber: desktop input repair failed: ${reason}\n`)
  const failure = await dialog.showMessageBox({
    type: 'error',
    title: 'Keyboard input repair failed',
    message: 'Amber could not restore the Linux input service.',
    detail: `${reason}\n\nYou can continue with limited input or quit and repair IBus manually.`,
    buttons: ['Continue anyway', 'Quit Amber'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  })
  if (failure.response === 0) return true
  quitDuringStartup()
  return false
}

function amberBinary(): string {
  return resolveAmberBinary(process.env, app.isPackaged, process.resourcesPath)
}

/** The bundled `amber-router`, which ships beside `amber` in resources/bin. */
function routerBinary(): string {
  const override = process.env['AMBER_ROUTER_BIN']
  if (override && override.length > 0) return override
  const name = process.platform === 'win32' ? 'amber-router.exe' : 'amber-router'
  return app.isPackaged ? join(process.resourcesPath, 'bin', name) : name
}

function amberDaemonBinary(): string {
  return resolveAmberDaemonBinary(process.env, app.isPackaged, process.resourcesPath)
}

function layoutPath(): string {
  if (process.platform === 'win32') return join(stateRoot(), 'ui-layout.json')
  const stateHome = process.env['XDG_STATE_HOME']
  const root = stateHome && stateHome.length > 0 ? stateHome + '/amber-ide'
    : (process.env['HOME'] ?? '.') + '/.local/state/amber-ide'
  return root + '/ui-layout.json'
}

function spawnOk(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'ignore' })
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))))
    p.on('error', reject)
  })
}

/** Spawn the windowless daemon without holding the app open as its parent. */
function spawnDetached(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolveSpawn, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolveSpawn()
    })
  })
}

function windowsLocalAppData(): string {
  const localAppData = process.env['LOCALAPPDATA']
  if (!localAppData) throw new Error('LOCALAPPDATA is required to install amber on Windows')
  return localAppData
}

async function windowsInstallNeedsRefresh(): Promise<boolean> {
  const localAppData = windowsLocalAppData()
  const pairs: Array<[string, string]> = [
    [amberBinary(), windowsAmberPath(localAppData)],
    [amberDaemonBinary(), windowsDaemonPath(localAppData)],
  ]
  for (const [bundled, installed] of pairs) {
    try {
      if (!(await readFile(bundled)).equals(await readFile(installed))) return true
    } catch {
      return true // first install or an interrupted/corrupt prior install
    }
  }
  return false
}

async function snapshotAllowsWindowsDaemonStop(socket: string): Promise<void> {
  const snapshot = await runCapture(amberBinary(), ['ctl', 'snapshot-now'])
  // A nonzero CLI exit is not permission by itself. Only a fresh Node probe
  // reporting ENOENT proves the named-pipe endpoint is actually absent.
  const endpointIsAbsent = snapshot.code === 0 ? false : await isSocketAbsent(socket)
  if (shouldStopWindowsDaemon(snapshot.code, endpointIsAbsent)) return
  throw new Error(
    `refusing to stop amberd before its snapshot succeeds: ${snapshot.stderr || `exit ${snapshot.code}`}`,
  )
}

async function stopWindowsDaemon(socket: string): Promise<void> {
  await snapshotAllowsWindowsDaemonStop(socket)
  const stop = windowsTaskkillCommand()
  const result = await runCapture(stop.cmd, stop.args)
  // A concurrent clean exit can leave taskkill with no matching amberd.exe.
  // Every other failure (notably access denied) blocks the caller: Quit must
  // not report success, and Restart must not spawn a duplicate daemon.
  if (result.code === 0 || isWindowsTaskkillNoMatch(result.code)) return
  throw new Error(`taskkill failed: ${result.stderr.trim() || `exit ${result.code}`}`)
}

async function installWindowsDaemon(socket: string): Promise<void> {
  const localAppData = windowsLocalAppData()
  const stableAmber = windowsAmberPath(localAppData)
  const stableDaemon = windowsDaemonPath(localAppData)
  await stopWindowsDaemon(socket)

  await mkdir(dirname(stableAmber), { recursive: true })
  // installBinary writes beside the destination then renames, so each program
  // is never half-written if the installer/app dies during an upgrade.
  await installBinary(amberBinary(), stableAmber)
  await installBinary(amberDaemonBinary(), stableDaemon)
  await repairAgentExtensions((args) => runCapture(stableAmber, args), (warning) => {
    process.stderr.write(warning)
  })
  const runKey = windowsRunKeyCommand(stableDaemon)
  await spawnOk(runKey.cmd, runKey.args)
  await spawnDetached(stableDaemon, ['daemon'])
}

async function preflightPackagedWindowsDaemon(socket: string): Promise<void> {
  const localAppData = windowsLocalAppData()
  const stableDaemon = windowsDaemonPath(localAppData)
  if (await windowsInstallNeedsRefresh()) {
    await installWindowsDaemon(socket)
    return
  }
  // A healthy daemon normally causes ensureDaemon to return immediately; still
  // repair the HKCU Run entry on every packaged launch without restarting it.
  const runKey = windowsRunKeyCommand(stableDaemon)
  await spawnOk(runKey.cmd, runKey.args)
}

async function installDaemon(socket?: string): Promise<void> {
  const home = process.env['HOME'] ?? '.'

  if (app.isPackaged) {
    if (process.platform === 'win32') {
      await installWindowsDaemon(socket ?? resolveSocketPath(process.env, process.platform))
      return
    }
    // A packaged app has no repo/toolchain, so `amber ctl install` (which runs
    // cargo from a source checkout) can't work. Do a cargo-free install: place
    // the bundled amber at a STABLE path and write the boot unit directly — the
    // ephemeral AppImage/dmg mount path would break reboot survival.
    const stable = join(home, '.local', 'bin', 'amber')
    await mkdir(dirname(stable), { recursive: true })
    await installBinary(amberBinary(), stable)
    // The router ships beside amber and must be installed beside it too:
    // `routerctl::sibling_binary` resolves it relative to the running amber,
    // so without this `amber ctl router enable` bails on every packaged
    // install. Best-effort — a missing router must never block the daemon.
    try {
      await installBinary(routerBinary(), join(home, '.local', 'bin', 'amber-router'))
    } catch (e) {
      process.stderr.write(`amber: could not install amber-router: ${String(e)}\n`)
    }
    // These repairs are independent and strictly best-effort: neither changes
    // daemon lifecycle, and a failed Codex repair must not skip Pi's hook.
    await repairAgentExtensions((args) => runCapture(stable, args), (warning) => {
      process.stderr.write(warning)
    })

    if (process.platform === 'linux') {
      const unitDir = join(home, '.config', 'systemd', 'user')
      await mkdir(unitDir, { recursive: true })
      await writeFile(join(unitDir, 'amber.service'), AMBER_SYSTEMD_UNIT)
      // enable-linger lets the user daemon run at boot before login (reboot
      // survival). Best-effort: don't fail the whole install if it's denied.
      await spawnOk('loginctl', ['enable-linger', process.env['USER'] ?? '']).catch(() => {})
      await spawnOk(stable, ['ctl', 'snapshot-now']).catch(() => {})
      for (const command of linuxInstallServiceArgv()) {
        await spawnOk(command.cmd, command.args)
      }
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
  const unit = bootUnitPath(process.platform, home, process.env['LOCALAPPDATA'])
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
    if (requestExplicitQuit) await requestExplicitQuit(); else app.quit()
    return
  }

  const uid = process.getuid?.() ?? 0
  if (process.platform === 'win32') {
    try {
      await stopWindowsDaemon(resolveSocketPath(process.env, process.platform))
    } catch (err) {
      await dialog.showMessageBox(win, {
        type: 'error',
        buttons: ['OK'],
        title: 'Daemon stop blocked',
        message: 'Could not safely stop the amber daemon.',
        detail: String(err),
      })
      return
    }
    if (requestExplicitQuit) await requestExplicitQuit(); else app.quit()
    return
  }
  const stop = stopDaemonCommand(process.platform, uid)
  if (stop !== null) {
    await spawnOk(stop.cmd, stop.args).catch(async () => {
      const fb = stopDaemonFallbackCommand(process.platform, launchAgentPlistPath(home))
      if (fb !== null) await spawnOk(fb.cmd, fb.args).catch(() => {})
    })
  }
  if (requestExplicitQuit) await requestExplicitQuit(); else app.quit()
}

// Restart the daemon in place. Recovery path for a wedged daemon (and the way
// to pick up a freshly installed binary) that does not make the user find a
// terminal. Unlike "Quit amber daemon" the app keeps running: its client
// reconnects on its own, panes re-attach, and sessions come back from the state
// store — but the PROCESSES inside them are killed and restarted, so this is
// confirmed first.
async function restartDaemon(win: BrowserWindow): Promise<void> {
  const confirm = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Cancel', 'Restart daemon'],
    defaultId: 0,
    cancelId: 0,
    title: 'Restart amber daemon',
    message: 'Restart the amber daemon?',
    detail:
      'Sessions and their scrollback are restored from the state store, and a claude ' +
      'pane resumes its conversation — but every process running inside a pane is ' +
      'killed and restarted, so unsaved work in a running command is lost. ' +
      'The app stays open and reconnects by itself.',
  })
  if (confirm.response !== 1) return

  const home = process.env['HOME'] ?? '.'
  const unit = bootUnitPath(process.platform, home, process.env['LOCALAPPDATA'])
  // No installed boot unit => dev / unmanaged daemon. Don't guess at pids.
  if (unit === null || !existsSync(unit)) {
    await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['OK'],
      title: 'Daemon not managed here',
      message: 'No installed amber boot unit found.',
      detail:
        'The daemon was not installed via the app (dev mode or unmanaged), so it ' +
        'cannot be restarted from here.',
    })
    return
  }

  const uid = process.getuid?.() ?? 0
  if (process.platform === 'win32') {
    try {
      await stopWindowsDaemon(resolveSocketPath(process.env, process.platform))
      await spawnDetached(unit, ['daemon'])
    } catch (err) {
      await dialog.showMessageBox(win, {
        type: 'error',
        buttons: ['OK'],
        title: 'Restart failed',
        message: 'Could not restart the amber daemon.',
        detail: String(err),
      })
    }
    return
  }
  const restart = restartDaemonCommand(process.platform, uid)
  if (restart === null) return
  try {
    await spawnOk(restart.cmd, restart.args)
  } catch (err) {
    await dialog.showMessageBox(win, {
      type: 'error',
      buttons: ['OK'],
      title: 'Restart failed',
      message: 'Could not restart the amber daemon.',
      detail: String(err),
    })
  }
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

    await installStableAppImage(appImage, stable, async () => {
      if (!tabBrowserHostEnabled()) return
      await registerBrowserHostLauncher(stateRoot(), {
        platform: process.platform, executable: stable,
        installGeneration: `${app.getVersion()}:${process.versions.electron}`,
        uid: process.getuid?.(),
      })
    })

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
function buildAppMenu(
  onQuitDaemon: () => void,
  onQuitApp: () => void,
  onEnableBrowserHost: (() => void) | null,
  onInstallDesktop: (() => void) | null,
  onRestartDaemon: () => void,
  onConnectHost: () => void,
): Menu {
  const isMac = process.platform === 'darwin'
  const sshSupport = isSupportedOnPlatform(process.platform)
  const template: MenuItemConstructorOptions[] = []
  // Keep Quit under our coordinated drain instead of Electron's automatic
  // role, which would close the broker before browser state is durable.
  if (isMac) template.push({ label: app.name, submenu: [
    { role: 'about' }, { type: 'separator' }, { role: 'services' },
    { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
    { type: 'separator' }, { label: 'Quit Amber IDE', accelerator: 'Cmd+Q', click: () => onQuitApp() },
  ] })
  const submenu: MenuItemConstructorOptions[] = [
    ...(onInstallDesktop !== null
      ? [
          { label: 'Install desktop shortcut', click: () => onInstallDesktop() },
          { type: 'separator' } as MenuItemConstructorOptions,
        ]
      : []),
    sshSupport.ok
      ? { label: 'Connect to host…', accelerator: 'CmdOrCtrl+Shift+O', click: () => onConnectHost() }
      : {
          label: 'Connect to host… (unavailable: named-pipe transport)',
          enabled: false,
          toolTip: sshSupport.reason,
        },
    { type: 'separator' } as MenuItemConstructorOptions,
    ...(onEnableBrowserHost
      ? [{ label: 'Enable browser host', click: () => onEnableBrowserHost() }]
      : [{ label: 'Browser host unavailable on this configuration', enabled: false }]),
    { label: 'Restart amber daemon', click: () => onRestartDaemon() },
    { label: 'Quit amber daemon', click: () => onQuitDaemon() },
  ]
  if (!isMac) submenu.push({ type: 'separator' }, { label: 'Quit Amber IDE', accelerator: 'CmdOrCtrl+Q', click: () => onQuitApp() })
  template.push({ label: isMac ? 'Daemon' : 'File', submenu })
  if (isMac) template.push({ role: 'editMenu' }, { role: 'windowMenu' })
  return Menu.buildFromTemplate(template)
}

/**
 * One amber window and the client process that feeds it.
 *
 * A LOCAL window talks to this machine's daemon; a REMOTE one talks to a
 * daemon on another machine through an ssh -L tunnel (spec 2026-08-23). The
 * only difference is the socket path the client is forked with, which is why
 * this needed no protocol change: `resolveSocketPath` honours AMBER_SOCKET.
 */
export interface WindowTarget {
  kind: 'local' | 'remote'
  /** `user@host`, remote only — window title and read-only marker. */
  host?: string
  /** Socket the client should connect to. Undefined = this machine's default. */
  socket?: string
}

interface WindowCtx {
  win: BrowserWindow
  target: WindowTarget
  controlPort: () => Electron.MessagePortMain | null
  child: () => Electron.UtilityProcess | null
  resumeClient: () => void
  activeBrowserId: string | null
  activeBrowserExpanded: boolean
  activeWorkspace: number | null
  activeTab: number | null
  browserContextGeneration: number
}

/** Per-window state, keyed by webContents id so IPC can route by sender. */
const windowCtxs = new Map<number, WindowCtx>()
let reopenLocalWindow: (() => Promise<void>) | null = null
let onLocalWindowHidden: (() => void) | null = null
let residentTray: Tray | null = null
let allowFinalQuit = false
let explicitQuitInProgress = false
let requestExplicitQuit: (() => Promise<void>) | null = null
const residentIntents = new ResidentIntentLatch()

// Startup can fail before the resident quit coordinator is installed (input
// method preflight, daemon boot, migration, or window creation). In that phase
// there is no browser state to drain, so bypass the resident before-quit gate;
// routing this through requestQuit would otherwise leave the app alive forever
// with a latched intent and no handler.
function quitDuringStartup(): void {
  allowFinalQuit = true
  app.quit()
}

/** The window an IPC message came from. */
function ctxFor(e: { sender: Electron.WebContents }): WindowCtx | undefined {
  return windowCtxs.get(e.sender.id)
}

function setWindowContextFromLayout(ctx: WindowCtx, layout: LayoutFile): void {
  const workspace = layout.workspaces[String(layout.activeWorkspace)]
  ctx.activeWorkspace = layout.activeWorkspace
  ctx.activeTab = workspace?.activeTab ?? null
  const browser = workspace?.tabs[String(workspace.activeTab)]?.browser
  ctx.activeBrowserId = browser?.id ?? null
  ctx.activeBrowserExpanded = !!browser && !browser.collapsed
  ctx.browserContextGeneration += 1
}

/** A live ssh tunnel backing one remote window. */
interface Tunnel {
  proc: ReturnType<typeof spawn>
  dir: string
  socket: string
}

const tunnels = new Map<number, Tunnel>()

/**
 * The environment ssh children run in.
 *
 * A GUI-launched app (desktop launcher, systemd user unit) can inherit no
 * `SSH_AUTH_SOCK` at all — measured on this box — and then every host is
 * "Permission denied (publickey)" however well ssh works in the user's
 * terminal. Recover it from the user session the same way the daemon recovers
 * DISPLAY (2026-07-29): ask systemd, per call, never cached — a cached value
 * would freeze whatever was true at login for the app's whole life.
 */
function sshEnv(): NodeJS.ProcessEnv {
  if (process.env['SSH_AUTH_SOCK']) return process.env
  if (process.platform !== 'linux') return process.env
  try {
    const out = execFileSync('systemctl', ['--user', 'show-environment'], {
      encoding: 'utf8',
      timeout: 2000,
    })
    const sock = parseAgentSock(out)
    // A missing key is left UNSET rather than set empty: an empty
    // SSH_AUTH_SOCK fails differently, and worse, than an absent one.
    return sock !== null ? { ...process.env, SSH_AUTH_SOCK: sock } : process.env
  } catch {
    return process.env
  }
}


/**
 * Open a window onto another machine's amber (spec 2026-08-23).
 *
 * Order matters: probe FIRST, so "no daemon over there" and "ssh refused you"
 * are reported as themselves instead of surfacing later as a mysteriously dead
 * window.
 */
async function openRemoteWindow(host: string): Promise<void> {
  const support = isSupportedOnPlatform(process.platform)
  if (!support.ok) {
    await dialog.showMessageBox({
      type: 'info',
      buttons: ['OK'],
      title: 'Remote SSH unavailable on Windows',
      message: 'Remote SSH windows are not available on this platform.',
      detail: support.reason,
    })
    return
  }
  if (!isValidHost(host)) {
    await dialog.showMessageBox({
      type: 'error',
      message: 'Invalid host',
      detail: `"${host}" is not a valid ssh destination.`,
    })
    return
  }

  const probe = await runSshProbe(host, REMOTE_SOCKET_PROBE, sshEnv())
  if (probe.code !== 0 || probe.error) {
    // ssh's own message is usually better than anything we could invent
    // (unknown host, name resolution, refused). The one case it under-reports
    // is a missing agent, which it can only call "permission denied".
    const explained = explainSshFailure(probe.err, sshEnv()['SSH_AUTH_SOCK'] !== undefined)
    await dialog.showMessageBox({
      type: 'error',
      message: `Could not reach ${host}`,
      detail: explained ?? (probe.error || probe.err || `ssh exited ${probe.code}`),
    })
    return
  }
  const remoteSocket = probe.out.trim()
  if (remoteSocket.length === 0) {
    await dialog.showMessageBox({
      type: 'error',
      message: `No amber daemon on ${host}`,
      detail: 'Start one there first: `systemctl --user start amber` (or run `amber daemon`).',
    })
    return
  }

  // Private per-window directory: 0700 so no other local user can reach the
  // tunnel, which carries full session control.
  const dir = await mkdtemp(join(tmpdir(), 'amber-ssh-'))
  await chmod(dir, 0o700)
  const localSock = localSocketPath(dir)
  const a = sshTunnelArgv(host, localSock, remoteSocket)
  const proc = spawn(a.cmd, a.args, { stdio: ['ignore', 'pipe', 'pipe'], env: sshEnv() })
  let tunnelErr = ''
  proc.stderr?.on('data', (d: Buffer) => { tunnelErr += d.toString() })

  // Wait for the socket to appear rather than guessing a delay: ssh creates it
  // once the forward is established, and ExitOnForwardFailure means a failure
  // kills the child instead of leaving us waiting forever.
  const ready = await new Promise<boolean>((resolveReady) => {
    let settled = false
    const finish = (v: boolean): void => { if (!settled) { settled = true; resolveReady(v) } }
    proc.on('exit', () => finish(false))
    proc.on('error', () => finish(false))
    const started = Date.now()
    const poll = setInterval(() => {
      if (existsSync(localSock)) { clearInterval(poll); finish(true) }
      else if (Date.now() - started > 15000) { clearInterval(poll); finish(false) }
    }, 100)
  })

  if (!ready) {
    try { proc.kill() } catch { /* already gone */ }
    await rm(dir, { recursive: true, force: true })
    await dialog.showMessageBox({
      type: 'error',
      message: `Could not forward ${host}'s amber socket`,
      detail: tunnelErr || 'ssh exited before the forward was established.',
    })
    return
  }

  const ctx = await openWindow({ kind: 'remote', host, socket: localSock })
  tunnels.set(ctx.win.webContents.id, { proc, dir, socket: localSock })
  const id = ctx.win.webContents.id
  ctx.win.on('closed', () => {
    const t = tunnels.get(id)
    if (!t) return
    tunnels.delete(id)
    // A leaked `ssh -N` outliving its window is the failure mode to avoid.
    try { t.proc.kill() } catch { /* already gone */ }
    void rm(t.dir, { recursive: true, force: true })
  })
}

/**
 * Ask for an ssh destination and open a window onto it.
 *
 * The prompt is a RENDERER dialog, not `window.prompt`: Electron does not
 * implement `prompt()` at all, so an earlier version of this silently did
 * nothing when the menu item was clicked.
 *
 * No host manager UI by design (spec §5): `~/.ssh/config` is the address book,
 * so anything ssh accepts — an alias, `user@host`, a jump-host alias — works
 * without amber ever parsing ssh config or touching a credential.
 */
function promptConnectHost(): void {
  const support = isSupportedOnPlatform(process.platform)
  if (!support.ok) {
    void dialog.showMessageBox({
      type: 'info',
      buttons: ['OK'],
      title: 'Remote SSH unavailable on Windows',
      message: 'Remote SSH windows are not available on this platform.',
      detail: support.reason,
    })
    return
  }
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return
  win.webContents.send('connect-host-prompt')
}

/** Kill every tunnel. Called on quit so no `ssh -N` outlives the app. */
function killTunnels(): void {
  for (const [, t] of tunnels) {
    try { t.proc.kill() } catch { /* already gone */ }
    try { rmSync(t.dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  tunnels.clear()
}

async function openWindow(target: WindowTarget, options: { show?: boolean } = {}): Promise<WindowCtx> {
  const win = new BrowserWindow({
    show: options.show ?? true,
    title: target.kind === 'remote' ? `amber — ${hostLabel(target.host ?? '')}` : 'amber',
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
      webviewTag: false,
      // Keep the preload SANDBOXED (default) for security. A sandboxed preload
      // has no node builtins and no `process.env`, so the two values it needs
      // are passed as argv flags (reachable via `process.argv` in sandbox).
      // Do NOT import `node:os`/read `process.env` in the preload — it throws
      // before exposeInMainWorld and the whole bridge silently vanishes.
      additionalArguments: [
        `--amber-home=${process.env['HOME'] ?? ''}`,
        `--amber-machine=${target.kind === 'remote' ? (target.host ?? 'amber') : hostname()}`,
        ...(target.kind === 'remote' ? [`--amber-remote=${target.host ?? ''}`] : []),
        ...(process.env['AMBER_SOFTWARE_GL'] ? ['--amber-software-gl'] : []),
      ],
    },
  })

  // The AppImage runtime exports $APPIMAGE (path to the image) — its presence
  // implies packaged Linux, the only place desktop install applies.
  const canInstallDesktop = process.platform === 'linux' && !!process.env['APPIMAGE']
  // The application menu is GLOBAL, and its items act on THIS machine's daemon
  // (restart/quit) and this machine's install. Building it from a remote window
  // would rebind those to a window that mirrors someone else's daemon, so only
  // the local window owns it.
  if (target.kind === 'local') Menu.setApplicationMenu(
    buildAppMenu(
      () => { void quitDaemonAndApp(win) },
      () => { void requestExplicitQuit?.() },
      tabBrowserHostEnabled() ? () => { void clearBrowserHostInhibit(stateRoot()) } : null,
      canInstallDesktop ? () => { void installDesktopShortcut(win) } : null,
      () => { void restartDaemon(win) },
      () => promptConnectHost(),
    ),
  )

  // Auto-detect the kernel-6.17/Chromium GPU-shm failure. If we're NOT already
  // in compat mode and the GPU crashes / the renderer dies / the page never
  // finishes loading, persist the compat flag and relaunch — the next start
  // applies the software-GL + sandbox workarounds. On healthy machines the page
  // loads, the timer clears, and this never fires.
  //
  // The crash listeners are DISARMED after DETECT_WINDOW_MS. They used to live
  // for the whole session, so any later GPU death — an X-server or driver glitch
  // that has nothing to do with amber — silently relaunched the app into
  // software rendering and left it there. See renderCompat.ts for the measured
  // case that cost ~11 cores for 23 hours.
  // Local window ONLY. `app.on('child-process-gone')` is process-global, so a
  // second window would register a SECOND listener whose disarm timer removes
  // only its own — and this path calls `app.relaunch()`/`app.exit(0)`, so a
  // remote window could relaunch the whole app into software GL. The 2026-07-26
  // entry exists because this detector misfired once and cost ~11 cores for 23
  // hours; duplicating its listeners is the same trap. A remote window has no
  // business deciding this machine's GL mode.
  if (!compat && target.kind === 'local') {
    let switching = false
    const enterCompat = (): void => {
      if (switching) return
      switching = true
      try { mkdirSync(stateRoot(), { recursive: true }); writeFileSync(compatFlagPath, COMPAT_SIGNATURE) } catch { /* ignore */ }
      app.relaunch()
      app.exit(0)
    }
    const onRendererGone = (_e: unknown, d: { reason: string }): void => {
      if (compatWorthyReason(d.reason)) enterCompat()
    }
    const onChildGone = (_e: unknown, d: { type: string; reason: string }): void => {
      if (d.type === 'GPU' && compatWorthyReason(d.reason)) enterCompat()
    }
    const loadTimer = setTimeout(enterCompat, 10000)
    win.webContents.once('did-finish-load', () => clearTimeout(loadTimer))
    win.webContents.on('render-process-gone', onRendererGone)
    app.on('child-process-gone', onChildGone)
    setTimeout(() => {
      if (!win.isDestroyed()) win.webContents.off('render-process-gone', onRendererGone)
      app.off('child-process-gone', onChildGone)
    }, DETECT_WINDOW_MS)
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
  else {
    // Electron 43's loadFile produced `file:///C:\...` for an asar path on
    // Windows, which Chromium rejects. Build the file URL explicitly so drive
    // separators are encoded correctly (`file:///C:/...`).
    await win.loadURL(pathToFileURL(join(__dirname, '../renderer/index.html')).href)
  }

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
  let windowClosed = options.show === false
  let presentationSuspended = options.show === false
  const stopClient = (): void => {
    try { controlPort?.close() } catch { /* already closed */ }
    controlPort = null
    try { child?.kill() } catch { /* already dead */ }
    child = null
  }
  const notifyRenderer = (data: unknown): void => {
    if (!win.isDestroyed()) win.webContents.send('daemon-event', data)
  }

  const wireChild = (): void => {
    // The ONLY thing that makes a window remote: which socket its client
    // opens. `resolveSocketPath` honours AMBER_SOCKET, and an ssh -L tunnel
    // puts a remote daemon behind a local socket file (spec 2026-08-23 §2).
    const c = launchIfAbsent(child, () => utilityProcess.fork(
      clientPath,
      [],
      target.socket !== undefined
        ? { env: { ...process.env, AMBER_SOCKET: target.socket } }
        : undefined,
    ))
    if (c === child) return
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
      if (!shouldRelaunchClient({ quitting: allowFinalQuit, windowClosed, windowDestroyed: win.isDestroyed() })) return
      // Crash is never silent: flip the renderer to disconnected right away
      // (same shape the daemon uses), even if the window is gone on macOS.
      notifyRenderer({ status: 'disconnected' })
      relaunchAttempt = nextAttempt(relaunchAttempt, Date.now() - spawnedAt, CLIENT_STABLE_MS)
      const delay = backoffDelay(relaunchAttempt, { baseMs: 100, maxMs: 2000 })
      setTimeout(() => {
        if (!shouldRelaunchClient({ quitting: allowFinalQuit, windowClosed, windowDestroyed: win.isDestroyed() })) return
        wireChild()
        // The renderer's MessagePorts died with the old child. Tell it to
        // re-request pane ports from the NEW child (handled via childEpoch).
        notifyRenderer({ childRestart: true })
      }, delay)
    })
  }
  if (options.show !== false) wireChild()

  const ctx: WindowCtx = {
    win,
    target,
    controlPort: () => controlPort,
    child: () => child,
    activeBrowserId: null,
    activeBrowserExpanded: false,
    activeWorkspace: null,
    activeTab: null,
    browserContextGeneration: 0,
    resumeClient: () => {
      if (!presentationSuspended) return
      presentationSuspended = false
      windowClosed = false
      wireChild()
      notifyRenderer({ childRestart: true })
    },
  }
  windowCtxs.set(win.webContents.id, ctx)
  const id = win.webContents.id
  win.on('close', (event) => {
    if (tabBrowserHostEnabled() && target.kind === 'local' && !allowFinalQuit) {
      event.preventDefault()
      presentationSuspended = true
      windowClosed = true
      onLocalWindowHidden?.()
      child?.postMessage({ kind: 'suspend-panes' })
      stopClient()
      win.hide()
    }
  })
  win.on('closed', () => {
    windowClosed = true
    windowCtxs.delete(id)
    stopClient()
  })
  return ctx
}

async function main(): Promise<void> {
  if (!await preflightLinuxInputMethod()) return

  const launch = activationRequest(process.argv)
  if (tabBrowserHostEnabled()) {
    if (launch.mode === 'normal') await clearBrowserHostInhibit(stateRoot())
    if (app.isPackaged) {
      try {
        await registerBrowserHostLauncher(stateRoot(), {
          platform: process.platform,
          executable: process.execPath,
          appImage: process.env['APPIMAGE'],
          installGeneration: `${app.getVersion()}:${process.versions.electron}`,
          uid: process.getuid?.(),
        })
      } catch (error) {
        console.error('browser host launcher registration failed', error)
      }
    }
  }

  const socket = resolveSocketPath(process.env, process.platform)
  const ensureDeps: EnsureDeps = {
    probe: probeSocket,
    install: () => installDaemon(socket),
    delayMs: (a) => Math.min(2000, 100 * 2 ** a),
    attempts: 8,
  }
  if (app.isPackaged && process.platform === 'win32') {
    ensureDeps.preflight = () => preflightPackagedWindowsDaemon(socket)
  }
  await ensureDaemon(socket, ensureDeps)

  const ctx = await openWindow({ kind: 'local' }, { show: launch.mode !== 'browser-host' })
  const win = ctx.win
  // Layout-v2 writes stay behind the deployed-reader barrier from the approved
  // rollout plan. Source compatibility alone is insufficient: an older
  // `amber web` process could otherwise rewrite or misread the sidecar.
  const tabBrowserSupported = tabBrowserHostEnabled()
  let tabBrowser: TabBrowserService | null = null
  let tabBrowserStateStore: TabBrowserStateStore | null = null
  const browserOperations = new BrowserOperationRegistry()
  const rendererBrowserOperation = <T>(kind: 'association' | 'workspace-import' | 'recovery', work: (signal: AbortSignal) => Promise<T>): Promise<T | { ok: false; error: string }> =>
    browserOperations.run(kind, work).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : 'INTERNAL_ERROR' }))
  if (tabBrowserSupported) {
    try {
      tabBrowserStateStore = new TabBrowserStateStore(stateRoot())
      await coordinateTabBrowserMigration(layoutPath(), tabBrowserStateStore)
      tabBrowser = await TabBrowserService.create(stateRoot(), win, tabBrowserStateStore, browserOperations)
      onLocalWindowHidden = () => tabBrowser?.windowHidden()
      tabBrowser.setApprovalSurface(
        (id) => hasExactApprovalSurface([...windowCtxs.values()].map((context) => ({ local: context.target.kind === 'local', destroyed: context.win.isDestroyed(), visible: context.win.isVisible(), browserId: context.activeBrowserId, expanded: context.activeBrowserExpanded })), id),
        (id) => {
          void (async () => {
            const loaded = await loadLayoutFile(layoutPath()); if (!loaded.text) return
            const layout = parseLayout(loaded.text)
            for (const [ws, workspace] of Object.entries(layout.workspaces)) for (const [tab, tabLayout] of Object.entries(workspace.tabs)) {
              if (tabLayout.browser?.id !== id) continue
              await reopenLocalWindow?.()
              const context = [...windowCtxs.values()].find((candidate) => candidate.target.kind === 'local' && !candidate.win.isDestroyed())
              if (!context) return
              context.win.show(); context.win.focus()
              context.win.webContents.send('tab-browser-event', { type: 'approval-reveal', browserId: id, workspace: Number(ws), tab: Number(tab), browser: { ...tabLayout.browser, collapsed: false } })
              return
            }
          })().catch(() => {})
        },
      )
      tabBrowser.setEventSink((event) => {
        for (const context of windowCtxs.values()) if (context.target.kind === 'local' && !context.win.isDestroyed()) context.win.webContents.send('tab-browser-event', event)
      })
    } catch (error) {
      console.error('tab browser migration failed; browser host remains unavailable', error)
    }
  }
  const rollbackOpenedBrowser = async (workspaceNumber: number, tabNumber: number, id: string): Promise<void> => {
    if (!tabBrowserStateStore) throw new Error('BROWSER_HOST_UNAVAILABLE')
    for (let attempt = 0; attempt < 3; attempt++) {
      const loaded = await loadLayoutFile(layoutPath())
      if (!loaded.text) return
      const current = parseLayout(loaded.text); const workspace = current.workspaces[String(workspaceNumber)]; const tab = workspace?.tabs[String(tabNumber)]
      if (!workspace || tab?.browser?.id !== id) return
      const cleanTab = { ...tab }; delete cleanTab.browser
      const next = { ...current, browserRevision: (current.browserRevision ?? 0) + 1, workspaces: { ...current.workspaces, [workspaceNumber]: { ...workspace, tabs: { ...workspace.tabs, [tabNumber]: cleanTab } } } }
      const saved = await commitBrowserLayoutMutation(layoutPath(), tabBrowserStateStore, serializeLayout(next), loaded.version)
      if ('ok' in saved) return
    }
    throw new Error('LAYOUT_CONFLICT')
  }

  reopenLocalWindow = async (): Promise<void> => {
    const existing = [...windowCtxs.values()].find((candidate) => candidate.target.kind === 'local' && !candidate.win.isDestroyed())
    if (existing) { existing.resumeClient(); existing.win.show(); existing.win.focus(); return }
    const reopened = await openWindow({ kind: 'local' })
    tabBrowser?.setWindow(reopened.win)
    reopened.win.show(); reopened.win.focus()
  }

  let tabBrowserBroker: TabBrowserBrokerServer | null = null
  let browserDaemonWatcher: BrowserDaemonWatcher | null = null
  if (tabBrowser) {
    browserDaemonWatcher = new BrowserDaemonWatcher(new Connection(socket))
    browserDaemonWatcher.start()
    if (!(await browserDaemonWatcher.waitForFresh(5_000))) throw new Error('DAEMON_STATE_STALE')
    const currentBrokerLayout = async (request: BrokerRequest): Promise<ReturnType<typeof parseLayout>> => {
      const loaded = await loadLayoutFile(layoutPath())
      const current = loaded.text ? parseLayout(loaded.text) : null
      if (!current) throw new Error('NO_BROWSER_FOR_TAB')
      if (current.readOnly) throw new Error('UNSUPPORTED_LAYOUT_VERSION')
      const location = /^amber-(\d+)-(\d+)-/.exec(request.amberSession)
      const associatedBrowser = location ? current.workspaces[location[1]!]?.tabs[location[2]!]?.browser : undefined
      const associatedId = associatedBrowser?.designatedPi === request.amberSession ? associatedBrowser.id : undefined
      const controller = browserDaemonWatcher?.controller(request.amberSession)
      if (!controller) { if (associatedId) tabBrowser.revokePi(associatedId); throw new Error('DAEMON_STATE_STALE') }
      if (!isEligiblePiController(controller)) { if (associatedId) tabBrowser.revokePi(associatedId); throw new Error('NOT_DESIGNATED_CONTROLLER') }
      try { authorizeBrowserRequest(current, request.amberSession, request.action.type === 'open') }
      catch (error) { if (associatedId) tabBrowser.revokePi(associatedId); throw error }
      return current
    }
    const handleBrokerInner = async (request: BrokerRequest, signal: AbortSignal): Promise<unknown> => {
      browserOperations.assertDispatch(signal)
      const current = await currentBrokerLayout(request)
      browserOperations.assertDispatch(signal)
      if (request.action.type === 'open') {
        const location = authorizeBrowserRequest(current, request.amberSession, true)
        if (!location.browserId) {
          const stillOpenTarget = async (): Promise<boolean> => {
            const latestController = browserDaemonWatcher?.controller(request.amberSession)
            if (!isEligiblePiController(latestController)) return false
            const latest = await loadLayoutFile(layoutPath())
            if (!latest.text) return false
            try {
              const candidate = authorizeBrowserRequest(parseLayout(latest.text), request.amberSession, true)
              return candidate.ws === location.ws && candidate.tab === location.tab && !candidate.browserId
            } catch { return false }
          }
          const opened = await tabBrowser.command({ type: 'open' }, signal, stillOpenTarget)
          if (!('id' in opened)) throw new Error('INTERNAL_ERROR')
          const latestLoaded = await loadLayoutFile(layoutPath())
          if (!latestLoaded.text || !(await stillOpenTarget())) { await tabBrowser.destroyForAssociation(opened.id).catch(() => {}); throw new Error('STALE_BROWSER_CONTEXT') }
          const latestCurrent = parseLayout(latestLoaded.text)
          const workspace = latestCurrent.workspaces[String(location.ws)]!
          const previous = workspace.tabs[String(location.tab)]!
          const browser = { id: opened.id, width: 420, collapsed: false }
          const next = { ...latestCurrent, version: 2, browserRevision: (latestCurrent.browserRevision ?? 0) + 1,
            workspaces: { ...latestCurrent.workspaces, [location.ws]: { ...workspace, tabs: { ...workspace.tabs, [location.tab]: { ...previous, browser } } } } }
          browserOperations.assertDispatch(signal)
          const saved = tabBrowserStateStore
            ? await commitBrowserLayoutMutation(layoutPath(), tabBrowserStateStore, serializeLayout(next), latestLoaded.version)
            : { error: 'BROWSER_HOST_UNAVAILABLE' as const }
          if (!('ok' in saved)) {
            // The record was persisted before the association CAS. Roll it
            // back immediately so a conflict cannot accumulate unreachable
            // live renderers for every retry.
            await tabBrowser.destroyForAssociation(opened.id).catch(() => {})
            throw new Error('LAYOUT_CONFLICT')
          }
          const stillAssociatedToController = async (): Promise<boolean> => {
            const latestController = browserDaemonWatcher?.controller(request.amberSession)
            if (!isEligiblePiController(latestController)) return false
            const latest = await loadLayoutFile(layoutPath())
            if (!latest.text) return false
            const candidate = parseLayout(latest.text).workspaces[String(location.ws)]?.tabs[String(location.tab)]?.browser
            return candidate?.id === opened.id
          }
          if (!(await stillAssociatedToController())) {
            try { await rollbackOpenedBrowser(location.ws, location.tab, opened.id) }
            finally { await tabBrowser.destroyForAssociation(opened.id).catch(() => {}) }
            throw new Error('STALE_BROWSER_CONTEXT')
          }
          await reopenLocalWindow?.()
          for (const candidate of windowCtxs.values()) if (candidate.target.kind === 'local' && !candidate.win.isDestroyed()) {
            candidate.win.webContents.send('tab-browser-association', { ws: location.ws, tab: location.tab, browser })
          }
          return { code: 'CREATION_AWAITING_USER', browserId: opened.id }
        }
        return tabBrowser.command({ type: 'status', id: location.browserId })
      }
      const authorized = authorizeBrowserRequest(current, request.amberSession)
      const id = authorized.browserId!
      const stillAuthorized = async (): Promise<boolean> => {
        let valid = false
        const latestController = browserDaemonWatcher?.controller(request.amberSession)
        if (isEligiblePiController(latestController)) {
          const latest = await loadLayoutFile(layoutPath())
          if (latest.text) try { valid = authorizeBrowserRequest(parseLayout(latest.text), request.amberSession).browserId === id } catch { valid = false }
        }
        if (!valid) tabBrowser.revokePi(id)
        return valid
      }
      return dispatchAttachedBrokerAction(request.action, id, signal, stillAuthorized,
        (command, actionSignal, validate) => tabBrowser.command(command.type === 'automation' ? { ...command, broker: { requestId: request.requestId, controller: request.amberSession } } : command.type === 'navigate' || command.type === 'stop' ? { ...command, broker: { requestId: request.requestId, controller: request.amberSession } } : command, actionSignal, validate))
    }
    const handleBroker = (request: BrokerRequest, signal: AbortSignal): Promise<unknown> =>
      browserOperations.run('broker', (ownedSignal) => handleBrokerInner(request, ownedSignal), signal)
    const socketPath = browserHostSocketPath(process.env, process.platform, process.getuid?.() ?? -1, tmpdir())
    tabBrowserBroker = new TabBrowserBrokerServer(socketPath, join(stateRoot(), 'browser-host-token'), handleBroker, {
      authorizeReplay: async (request) => { try { await currentBrokerLayout(request); return true } catch { return false } },
      // Serialize by the authorized browser, or by its tab while the one
      // first-use solicitation has no browser id yet. Request ids are replay
      // keys only; they must never decide mutation ordering.
      queueKey: async (request) => {
        const current = await currentBrokerLayout(request)
        const location = authorizeBrowserRequest(current, request.amberSession, request.action.type === 'open')
        return location.browserId ? `browser:${location.browserId}` : `tab:${location.ws}:${location.tab}`
      },
      operations: browserOperations,
    })
    await tabBrowserBroker.start()
  }

  requestExplicitQuit = async (): Promise<void> => {
    if (allowFinalQuit || explicitQuitInProgress) return
    explicitQuitInProgress = true
    const work = tabBrowser?.pendingWork()
    if (work && work.total > 0) {
      const choice = await dialog.showMessageBox({
        type: 'warning', buttons: ['Cancel', 'Quit anyway'], defaultId: 0, cancelId: 0,
        title: 'Quit Amber IDE?', message: 'Browser work is still active.',
        detail: `${work.operations} browser operation(s), ${work.piActions} Pi action(s), ${work.approvals} approval(s), ${work.dialogs} dialog(s), and ${work.pageLoads} page load(s) will be cancelled. The amber daemon and terminal sessions will keep running.`,
      })
      if (choice.response !== 1) { explicitQuitInProgress = false; return }
    }
    const result = await coordinateBrowserHostQuit({
      writeInhibit: () => writeBrowserHostInhibit(stateRoot()),
      beginDrain: () => tabBrowser?.beginDrain(),
      flushAndDestroy: (signal) => tabBrowser?.flushAndDestroy(signal) ?? Promise.resolve(),
      closeBroker: () => tabBrowserBroker?.close() ?? Promise.resolve(),
      closeWatcher: () => { browserDaemonWatcher?.close(); browserDaemonWatcher = null },
      closeWindows: () => {
        residentTray?.destroy(); residentTray = null
        allowFinalQuit = true
        app.quit()
      },
    })
    if (result.ok) return
    const failure = await dialog.showMessageBox({
      type: 'error', buttons: ['Cancel quit', 'Force quit'], defaultId: 0, cancelId: 0,
      title: 'Browser state could not be saved', message: result.error === 'QUIT_DRAIN_TIMEOUT' ? 'Amber timed out while saving browser state.' : 'Amber could not save browser state.',
      detail: 'Force quit may lose the latest browser association or restore metadata. The amber daemon and terminal sessions will not be stopped.',
    })
    if (failure.response === 0) {
      tabBrowser?.cancelDrain()
      await clearBrowserHostInhibit(stateRoot()).catch(() => {})
      explicitQuitInProgress = false
      return
    }
    await tabBrowserBroker?.close().catch(() => {})
    browserDaemonWatcher?.close(); browserDaemonWatcher = null
    residentTray?.destroy(); residentTray = null
    allowFinalQuit = true
    app.exit(1)
  }

  residentIntents.install({ activate: async () => { await reopenLocalWindow?.() }, quit: async () => { await requestExplicitQuit?.() } })
  await residentIntents.consume()

  if (tabBrowserSupported && process.platform === 'linux' && !residentTray) {
    try {
      const packagedIcon = join(process.resourcesPath, 'icon.png')
      const devIcon = join(__dirname, '../../build/icon.png')
      residentTray = new Tray(nativeImage.createFromPath(existsSync(packagedIcon) ? packagedIcon : devIcon))
      residentTray.setToolTip('Amber IDE — browser host running')
      residentTray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Open Amber IDE', click: () => { void reopenLocalWindow?.() } },
        { type: 'separator' },
        { label: 'Quit Amber IDE', click: () => { void requestExplicitQuit?.() } },
      ]))
      residentTray.on('click', () => { void reopenLocalWindow?.() })
    } catch (error) { console.error('could not create browser-host tray', error) }
  }

  // These three are the only per-WINDOW handlers: each window has its own
  // client process (a remote window's talks through an ssh tunnel), so they
  // route by sender rather than closing over one window's refs.
  ipcMain.on('daemon-command', (e, cmd: unknown) => {
    ctxFor(e)?.controlPort()?.postMessage(cmd)
  })

  ipcMain.on('open-pane', (e, session: string) => {
    const c = ctxFor(e)
    const proc = c?.child()
    if (!c || !proc || c.win.isDestroyed()) return
    const { port1: rPort, port2: uPort } = new MessageChannelMain()
    proc.postMessage({ kind: 'pane', session }, [uPort])
    c.win.webContents.postMessage('pane-port', { session }, [rPort])
  })

  // A Pane unmounted: tell the client to close that pane's port, forget the
  // session and Detach from the daemon. Without this the client's port map grew
  // for the app's whole life (names are never reused), each entry pinning a live
  // MessagePortMain, and every reconnect re-Attached long-dead names — which the
  // daemon answers with an Error the app shows in its red banner.
  ipcMain.handle('connect-host', async (_e, host: unknown) => {
    if (typeof host !== 'string') return
    await openRemoteWindow(host.trim())
  })

  ipcMain.on('close-pane', (e, session: string) => {
    ctxFor(e)?.child()?.postMessage({ kind: 'pane-close', session })
  })

  ipcMain.handle('browser:recovery', (e, raw: unknown) => rendererBrowserOperation('recovery', async (signal) => {
    browserOperations.assertDispatch(signal)
    const sender = ctxFor(e)
    if (!tabBrowser || !tabBrowserStateStore || sender?.target.kind !== 'local') return { ok: false, error: 'BROWSER_HOST_UNAVAILABLE' }
    try {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('INVALID_REQUEST')
      const request = raw as Record<string, unknown>
      if (request['action'] === 'list' && Object.keys(request).length === 1) return { ok: true, result: tabBrowser.recoveryItems() }
      if (typeof request['id'] !== 'string' || !isRecoveryId(request['id'])) throw new Error('INVALID_REQUEST')
      const recoveryId = request['id']
      const item = tabBrowser.recoveryItems().find((candidate) => candidate.id === recoveryId)
      if (!item) throw new Error('NO_RECOVERY_ITEM')
      if (request['action'] === 'copy' && Object.keys(request).length === 2) {
        clipboard.writeText(item.safeRestoreUrl); return { ok: true }
      }
      if (request['action'] === 'delete' && Object.keys(request).length === 2) {
        await tabBrowser.deleteRecovery(recoveryId); return { ok: true }
      }
      if (request['action'] !== 'attach' || Object.keys(request).length !== 2) throw new Error('INVALID_REQUEST')
      const loaded = await loadLayoutFile(layoutPath())
      if (!loaded.text) throw new Error('NO_BROWSER_FOR_TAB')
      if (sender.activeWorkspace === null || sender.activeTab === null) throw new Error('NO_ACTIVE_TAB')
      const current = parseLayout(loaded.text); const wsKey = String(sender.activeWorkspace); const workspace = current.workspaces[wsKey]
      const tabKey = String(sender.activeTab); const previous = workspace?.tabs[tabKey]
      if (!workspace || !previous || previous.browser) throw new Error(previous?.browser ? 'BROWSER_ALREADY_ATTACHED' : 'NO_BROWSER_FOR_TAB')
      const id = createBrowserId(); const browser = { id, width: 420, collapsed: false }
      const next = { ...current, version: 2, browserRevision: (current.browserRevision ?? 0) + 1,
        workspaces: { ...current.workspaces, [wsKey]: { ...workspace, tabs: { ...workspace.tabs, [tabKey]: { ...previous, browser } } } } }
      browserOperations.assertDispatch(signal)
      const saved = await commitBrowserLayoutMutation(layoutPath(), tabBrowserStateStore, serializeLayout(next), loaded.version, undefined, undefined, (state) => {
        const recovery = state.migrationRecovery.find((candidate) => candidate.id === recoveryId)
        if (!recovery) throw new Error('NO_RECOVERY_ITEM')
        const without = { ...state, migrationRecovery: state.migrationRecovery.filter((candidate) => candidate.id !== recoveryId) }
        return stageWorkspaceBrowserState(without, { entries: [{ id, browser: { mode: 'browse', safeRestoreUrl: recovery.safeRestoreUrl } }], recovery: [] })
      })
      if (!('ok' in saved)) throw new Error('error' in saved ? saved.error : 'LAYOUT_CONFLICT')
      await tabBrowser.attachRecoveryCommitted(recoveryId, id)
      sender.activeBrowserId = id; sender.win.webContents.send('tab-browser-association', { ws: sender.activeWorkspace, tab: sender.activeTab, browser })
      return { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'INTERNAL_ERROR' } }
  }))

  ipcMain.handle('browser:workspace-snapshot', async (e) => {
    const sender = ctxFor(e)
    if (!tabBrowser || sender?.target.kind !== 'local') return { ok: false, error: 'BROWSER_HOST_UNAVAILABLE' }
    try {
      return { ok: true, result: tabBrowser.workspaceSnapshot() }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'INTERNAL_ERROR' } }
  })

  ipcMain.handle('browser:import-workspace', (e, raw: unknown) => rendererBrowserOperation('workspace-import', async (signal) => {
    browserOperations.assertDispatch(signal)
    const sender = ctxFor(e)
    if (sender?.target.kind !== 'local') return { ok: false, error: 'BROWSER_HOST_UNAVAILABLE' }
    try {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('INVALID_REQUEST')
      const request = raw as Record<string, unknown>
      if (Object.keys(request).length !== 2 || !Object.hasOwn(request, 'mode') || !Object.hasOwn(request, 'text') || (request['mode'] !== 'new' && request['mode'] !== 'replace') || typeof request['text'] !== 'string') throw new Error('INVALID_REQUEST')
      if (sender.activeWorkspace === null || sender.activeTab === null) throw new Error('NO_ACTIVE_TAB')
      const doc = parseWorkspaceFile(request['text'])
      const loaded = await loadLayoutFile(layoutPath())
      const current = loaded.text ? parseLayout(loaded.text) : emptyLayout()
      const state = tabBrowserStateStore ? await tabBrowserStateStore.load() : null
      const prepared = prepareWorkspaceImport({ current, browserState: state, doc, mode: request['mode'], activeWorkspace: sender.activeWorkspace, mintId: () => randomUUID().replaceAll('-', '') })
      browserOperations.assertDispatch(signal)
      const committed = await commitPreparedWorkspaceImport({ prepared, layoutPath: layoutPath(), expectedLayoutVersion: loaded.version, browserStore: tabBrowserStateStore, browserHost: tabBrowser })
      setWindowContextFromLayout(sender, prepared.next)
      return { ok: true, layout: serializeLayout(prepared.next), version: committed.version, plan: prepared.plan }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'INTERNAL_ERROR' } }
  }))

  ipcMain.handle('browser:set-context', (e, raw: unknown) => rendererBrowserOperation('association', async (signal) => {
    browserOperations.assertDispatch(signal)
    const sender = ctxFor(e)
    if (sender?.target.kind !== 'local' || !raw || typeof raw !== 'object') return { ok: false, error: 'BROWSER_HOST_UNAVAILABLE' }
    const request = raw as Record<string, unknown>
    if (Object.keys(request).length !== 3 || !Object.hasOwn(request, 'workspace') || !Object.hasOwn(request, 'tab') || typeof request['collapsed'] !== 'boolean') return { ok: false, error: 'INVALID_REQUEST' }
    const loaded = await loadLayoutFile(layoutPath())
    if (!loaded.text) return { ok: false, error: 'NO_ACTIVE_TAB' }
    try {
      const context = resolveBrowserContext(parseLayout(loaded.text), request['workspace'], request['tab'])
      if (tabBrowser && sender.activeBrowserId && sender.activeBrowserId !== context.browserId) { tabBrowser.surfaceHidden(sender.activeBrowserId); await tabBrowser.command({ type: 'hide', id: sender.activeBrowserId }).catch(() => {}) }
      browserOperations.assertDispatch(signal)
      const changed = !sameBrowserContextIdentity(sender, context)
      sender.activeWorkspace = context.workspace; sender.activeTab = context.tab; sender.activeBrowserId = context.browserId
      if (changed || request['collapsed']) sender.activeBrowserExpanded = false
      if (context.browserId && request['collapsed']) tabBrowser?.surfaceHidden(context.browserId)
      sender.browserContextGeneration += 1
      return { ok: true, ...context }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'INVALID_REQUEST' } }
  }))

  ipcMain.handle('browser:command', (e, raw: unknown) => rendererBrowserOperation('association', async (signal) => {
    browserOperations.assertDispatch(signal)
    const sender = ctxFor(e)
    if (!tabBrowser || !tabBrowserStateStore || sender?.target.kind !== 'local') return { ok: false, error: 'BROWSER_HOST_UNAVAILABLE' }
    try {
      const parsed = parseTabBrowserCommand(raw)
      if (parsed.type === 'open' || parsed.type === 'close' || parsed.type === 'share' || parsed.type === 'designate') {
        const loaded = await loadLayoutFile(layoutPath())
        if (!loaded.text) throw new Error('NO_BROWSER_FOR_TAB')
        const current = parseLayout(loaded.text)
        if (sender.activeWorkspace === null || sender.activeTab === null) throw new Error('NO_ACTIVE_TAB')
        const wsKey = String(sender.activeWorkspace)
        const workspace = current.workspaces[wsKey]
        const tabKey = String(sender.activeTab)
        const previous = workspace?.tabs[tabKey]
        if (!workspace || !previous) throw new Error('NO_BROWSER_FOR_TAB')
        const expectedContext = { ...captureBrowserContext(sender), browserId: previous.browser?.id ?? null }
        const contextMatches = (): boolean => browserContextMatches(sender, expectedContext)
        const stillAssociated = async (expectedBrowserId: string | null): Promise<boolean> => {
          if (!contextMatches()) return false
          const latest = await loadLayoutFile(layoutPath())
          if (!latest.text) return false
          return (parseLayout(latest.text).workspaces[String(expectedContext.workspace)]?.tabs[String(expectedContext.tab)]?.browser?.id ?? null) === expectedBrowserId
        }
        let workingLoaded = loaded; let workingCurrent = current; let workingWorkspace = workspace; let workingPrevious = previous
        let openedId: string | null = null
        let browser = previous.browser
        if (parsed.type === 'open') {
          if (browser) return { ok: true, result: await tabBrowser.command({ type: 'status', id: browser.id }) }
          const opened = await tabBrowser.command({ type: 'open' }, undefined, () => stillAssociated(null))
          if (!('id' in opened)) throw new Error('INTERNAL_ERROR')
          openedId = opened.id
          if (!(await stillAssociated(null))) { await tabBrowser.destroyForAssociation(opened.id).catch(() => {}); throw new Error('STALE_BROWSER_CONTEXT') }
          workingLoaded = await loadLayoutFile(layoutPath())
          if (!workingLoaded.text) { await tabBrowser.destroyForAssociation(opened.id).catch(() => {}); throw new Error('STALE_BROWSER_CONTEXT') }
          workingCurrent = parseLayout(workingLoaded.text)
          workingWorkspace = workingCurrent.workspaces[wsKey]!
          workingPrevious = workingWorkspace.tabs[tabKey]!
          browser = { id: opened.id, width: 420, collapsed: false }
        } else {
          if (!browser) throw new Error('NO_BROWSER_FOR_TAB')
          if (parsed.type === 'close') browser = undefined
          else if (parsed.type === 'share') {
            if (parsed.sharedWithPi && !browser.designatedPi) throw new Error('NOT_DESIGNATED_CONTROLLER')
            browser = { ...browser, sharedWithPi: parsed.sharedWithPi }
          }
          else {
            if (parsed.designatedPi) {
              const match = /^amber-(\d+)-(\d+)-/.exec(parsed.designatedPi)
              const controller = browserDaemonWatcher?.controller(parsed.designatedPi)
              if (!match || Number(match[1]) !== sender.activeWorkspace || Number(match[2]) !== sender.activeTab || !isEligiblePiController(controller)) throw new Error('NOT_DESIGNATED_CONTROLLER')
            }
            const { designatedPi: _old, sharedWithPi: _shared, ...base } = browser
            browser = parsed.designatedPi ? { ...base, designatedPi: parsed.designatedPi, sharedWithPi: false } : { ...base, sharedWithPi: false }
          }
        }
        const nextTab = { ...workingPrevious, ...(browser ? { browser } : {}) }
        if (!browser) delete nextTab.browser
        const next = { ...workingCurrent, version: 2, browserRevision: (workingCurrent.browserRevision ?? 0) + 1,
          workspaces: { ...workingCurrent.workspaces, [wsKey]: { ...workingWorkspace, tabs: { ...workingWorkspace.tabs, [tabKey]: nextTab } } } }
        browserOperations.assertDispatch(signal)
        const saved = await commitBrowserLayoutMutation(layoutPath(), tabBrowserStateStore, serializeLayout(next), workingLoaded.version)
        if (!('ok' in saved)) {
          if (openedId) await tabBrowser.destroyForAssociation(openedId).catch(() => {})
          throw new Error('error' in saved ? saved.error : 'LAYOUT_CONFLICT')
        }
        if (openedId && !contextMatches()) {
          try { await rollbackOpenedBrowser(expectedContext.workspace, expectedContext.tab, openedId) }
          finally { await tabBrowser.destroyForAssociation(openedId).catch(() => {}) }
          throw new Error('STALE_BROWSER_CONTEXT')
        }
        if (previous.browser && (parsed.type === 'close' || parsed.type === 'designate' || (parsed.type === 'share' && !parsed.sharedWithPi))) tabBrowser.revokePi(previous.browser.id)
        if (parsed.type === 'close' && previous.browser) await tabBrowser.destroyForAssociation(previous.browser.id)
        setBrowserForCurrentContext(sender, expectedContext, browser?.id ?? null)
        sender.win.webContents.send('tab-browser-association', { ws: expectedContext.workspace, tab: expectedContext.tab, ...(browser ? { browser } : {}) })
        return { ok: true, result: parsed.type === 'close' ? { closed: true } : browser ? await tabBrowser.command({ type: 'status', id: browser.id }) : { closed: true } }
      }
      const loaded = await loadLayoutFile(layoutPath())
      if (!loaded.text || sender.activeWorkspace === null || sender.activeTab === null) throw new Error('NO_ACTIVE_TAB')
      const activeBrowser = parseLayout(loaded.text).workspaces[String(sender.activeWorkspace)]?.tabs[String(sender.activeTab)]?.browser
      const associated = activeBrowser?.id ?? null
      if (associated !== sender.activeBrowserId) throw new Error('STALE_BROWSER_CONTEXT')
      if (parsed.type === 'stopPi' && activeBrowser?.designatedPi) tabBrowserBroker?.cancelController(activeBrowser.designatedPi)
      const command = bindRendererBrowserCommand(sender.activeBrowserId, parsed)
      const expected = captureBrowserContext(sender)
      if ((command.type === 'hide' || command.type === 'show') && expected.browserId) { sender.activeBrowserExpanded = false; if (command.type === 'hide') tabBrowser.surfaceHidden(expected.browserId) }
      const stillAssociated = async (): Promise<boolean> => {
        if (!browserContextMatches(sender, expected)) return false
        const latest = await loadLayoutFile(layoutPath())
        return !!latest.text && parseLayout(latest.text).workspaces[String(expected.workspace)]?.tabs[String(expected.tab)]?.browser?.id === expected.browserId
      }
      const result = await tabBrowser.command(command, signal, stillAssociated)
      if (command.type === 'show' && browserContextMatches(sender, expected) && expected.browserId) sender.activeBrowserExpanded = true
      return { ok: true, result }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'INTERNAL_ERROR' }
    }
  }))

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

  // ---- remote access (spec 2026-08-22 §9) ------------------------------
  //
  // The app is a CONTROLLER, never the owner: `amber web` is boot-managed by
  // its own unit so closing the IDE does not kill phone access. Every call
  // here shells to `amber ctl web`, which owns the unit file, the tailscale
  // mapping and the token.

  ipcMain.handle('web:status', async (): Promise<WebStatus> => {
    const { stdout } = await runAmberCapture(webCtlArgv('status', WEB_PORT))
    return parseWebStatus(stdout)
  })

  ipcMain.handle('web:action', async (_e, action: unknown) => {
    // Allowlist, not passthrough: this argument crosses the renderer boundary
    // and is spliced into an argv.
    const allowed = ['start', 'stop', 'restart', 'enable', 'disable', 'rotate-token']
    if (typeof action !== 'string' || !allowed.includes(action)) {
      return { ok: false, error: `unknown action ${String(action)}` }
    }
    const { code, stderr } = await runAmberCapture(webCtlArgv(action, WEB_PORT))
    return code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `exit ${code}` }
  })

  // On-demand ONLY — called when the user presses Reveal / Copy / Show QR.
  // Never on the status poll: the token is a full-authority credential and the
  // dialog polls every 3 s while open.
  ipcMain.handle('web:url', async (): Promise<string> => {
    const { stdout } = await runAmberCapture(['ctl', 'web', 'url', '--port', String(WEB_PORT)])
    return stdout.trim()
  })

  const readBoundedLog = async (path: string): Promise<string> => {
    try {
      const owner = process.getuid?.()
      const text = await readSafeTextFile(path, { maxBytes: 4 * 1024 * 1024, ...(owner === undefined ? {} : { owner }) })
      return text ?? 'no log available: file not found'
    } catch (error) {
      return `no log available: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  ipcMain.handle('web:logTail', async (): Promise<string> => {
    if (process.platform === 'linux') {
      const { stdout, stderr } = await runCapture('journalctl', [
        '--user',
        '-u',
        'amber-web.service',
        '-n',
        '200',
        '--no-pager',
      ])
      return stdout || stderr
    }
    // launchd has no journal — the agent writes StandardErrorPath here.
    return readBoundedLog(join(homedir(), 'Library', 'Logs', 'amber-web.log'))
  })

  ipcMain.handle('web:openLocal', async () => {
    // Opens the user's own browser on the user's own machine, so the tokenised
    // url is correct here — but only the REDACTED form is ever logged.
    const { stdout } = await runAmberCapture(['ctl', 'web', 'url', '--port', String(WEB_PORT)])
    const url = stdout.trim()
    if (url.length === 0) return
    console.log('[amber] opening', redactUrl(url))
    await shell.openExternal(url)
  })

  // ---- local router (design 2026-09-01) --------------------------------
  //
  // Same posture as remote access: the app is a CONTROLLER. `amber-router` is
  // boot-managed by its own unit, and every call here shells to `amber ctl
  // router`, which owns the unit file, the 0600 slot file and the token.
  //
  // Slot editing goes through the CLI rather than the router's HTTP admin API
  // so the bearer token never enters this process or an IPC trace — the same
  // reason `web:url` is on-demand only.

  ipcMain.handle('router:status', async (): Promise<RouterStatus> => {
    const { stdout } = await runAmberCapture(routerCtlArgv('status', ROUTER_PORT))
    return parseRouterStatus(stdout)
  })

  ipcMain.handle('router:action', async (_e, action: unknown) => {
    // Allowlist, not passthrough: this argument crosses the renderer boundary
    // and is spliced into an argv.
    const allowed = [
      'start',
      'stop',
      'restart',
      'enable',
      'disable',
      'rotate-token',
      'install-pi-provider',
    ]
    if (typeof action !== 'string' || !allowed.includes(action)) {
      return { ok: false, error: `unknown action ${String(action)}` }
    }
    const { code, stderr } = await runAmberCapture(routerCtlArgv(action, ROUTER_PORT))
    return code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `exit ${code}` }
  })

  ipcMain.handle('router:slots', async () => {
    const { code, stdout, stderr } = await runAmberCapture([
      'ctl',
      'router',
      'slots',
      '--port',
      String(ROUTER_PORT),
    ])
    if (code !== 0) return { ok: false, error: stderr.trim() || `exit ${code}`, slots: [] }
    try {
      const parsed = JSON.parse(stdout) as { slots?: unknown }
      // Map here, not in the renderer: the wire is snake_case and the UI shape
      // is camelCase, and passing the raw object through left `hasKey`
      // undefined so every stored key rendered as "no key yet".
      return {
        ok: true,
        slots: Array.isArray(parsed.slots)
          ? (parsed.slots as Record<string, unknown>[]).map(slotFromWire)
          : [],
      }
    } catch {
      return { ok: false, error: 'could not parse the router slot list', slots: [] }
    }
  })

  ipcMain.handle('router:saveSlots', async (_e, slots: unknown) => {
    if (!Array.isArray(slots)) return { ok: false, error: 'expected a slot list' }
    const { code, stderr } = await runAmberCapture(
      ['ctl', 'router', 'set-slots', '--port', String(ROUTER_PORT)],
      JSON.stringify({ slots }),
    )
    return code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `exit ${code}` }
  })

  // On-demand ONLY, behind a deliberate Reveal gesture — never on the poll.
  ipcMain.handle('router:revealKey', async (_e, name: unknown) => {
    if (typeof name !== 'string' || name.length === 0) return ''
    const { code, stdout } = await runAmberCapture([
      'ctl',
      'router',
      'key',
      name,
      '--port',
      String(ROUTER_PORT),
    ])
    return code === 0 ? stdout.trim() : ''
  })

  ipcMain.handle('router:logTail', async (): Promise<string> => {
    if (process.platform === 'linux') {
      const { stdout, stderr } = await runCapture('journalctl', [
        '--user',
        '-u',
        'amber-router.service',
        '-n',
        '200',
        '--no-pager',
      ])
      return stdout || stderr
    }
    return readBoundedLog(join(homedir(), 'Library', 'Logs', 'amber-router.log'))
  })

  ipcMain.handle('pick-folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  // CAS (spec 2026-08-01 §6): the sidecar now has two writers (this process
  // and `amber web`'s Rust side), so a plain read/write would let whichever
  // writes last silently discard the other's edit. `layoutIO.ts` does the
  // actual version check under the same call that does the atomic rename.
  // A REMOTE window mirrors the other machine's arrangement (spec 2026-08-23
  // §2.4). Read-only, and enforced HERE rather than in the renderer: main owns
  // the disk, so a bug in the UI can never write one machine's layout over
  // another's — and the remote's own app is probably open on that desktop,
  // holding the sidecar it expects to own.
  ipcMain.handle('layout-load', async (e) => {
    const ctx = ctxFor(e)
    if (ctx?.target.kind === 'remote' && ctx.target.host !== undefined) {
      const probe = await runSshProbe(ctx.target.host, REMOTE_LAYOUT_PROBE, sshEnv(), {
        maxBytes: REMOTE_LAYOUT_PROBE_MAX_BYTES,
      })
      // A missing or unreadable sidecar is not an error: grouping comes from
      // session names (rule #2), so the window still shows the right panes at
      // default geometry — the same fallback core rule #3 already requires.
      // Overflow/timeout is different: never hand a partial layout to the
      // renderer, and surface a stable error instead of treating truncation as
      // an ordinary missing sidecar.
      if (probe.error) return { text: null, version: null, error: probe.error }
      return { text: probe.code === 0 && probe.out.length > 0 ? probe.out : null, version: null }
    }
    return loadLayoutFile(layoutPath())
  })
  ipcMain.handle('layout-save', async (e, text: string, version: string | null) => {
    if (ctxFor(e)?.target.kind === 'remote') return { ok: true, version: null }
    if (typeof text !== 'string' || layoutUtf8ByteLength(text, LAYOUT_FILE_MAX_BYTES) > LAYOUT_FILE_MAX_BYTES) return { error: 'LAYOUT_FILE_LIMIT' }
    const current = await loadLayoutFile(layoutPath())
    if (current.error) return { error: current.error }
    if (current.text && parseLayout(current.text).readOnly) return { error: 'layout belongs to a newer Amber version' }
    const currentLayout = current.text ? parseLayout(current.text) : null
    const nextLayout = parseLayout(text)
    if (nextLayout.readOnly) return { error: 'layout belongs to a newer Amber version' }
    if (browserAuthorityChanged(currentLayout ?? emptyLayout(), nextLayout)) return { error: 'browser association is main-owned' }
    return saveLayoutFile(layoutPath(), text, version)
  })

  const productivityPath = () => join(stateRoot(), 'productivity.json')
  ipcMain.handle('productivity-load', async (e) => {
    if (ctxFor(e)?.target.kind === 'remote') return { text: null, version: null }
    return loadProductivityFile(productivityPath())
  })
  ipcMain.handle('productivity-save', async (e, text: unknown, version: unknown) => {
    if (ctxFor(e)?.target.kind === 'remote') return { error: 'remote windows are read-only' }
    if (typeof text !== 'string' || (typeof version !== 'string' && version !== null)) return { error: 'invalid productivity save' }
    return saveProductivityFile(productivityPath(), text, version)
  })
  ipcMain.handle('project-profile-read', async (e, root: unknown) => {
    if (ctxFor(e)?.target.kind === 'remote') return { error: 'remote windows are read-only' }
    if (typeof root !== 'string' || !isAbsolute(root)) return { error: 'project root must be absolute' }
    return readProjectProfile(root)
  })
  ipcMain.handle('checkpoint-list', async (e) =>
    ctxFor(e)?.target.kind === 'remote' ? [] : listCheckpoints(stateRoot()))
  ipcMain.handle('checkpoint-write', async (e, id: unknown, text: unknown) => {
    if (ctxFor(e)?.target.kind === 'remote') throw new Error('remote windows are read-only')
    if (typeof id !== 'string' || typeof text !== 'string') throw new Error('invalid checkpoint write')
    await writeCheckpoint(stateRoot(), id, text)
  })
  ipcMain.handle('checkpoint-read', async (e, id: unknown) => {
    if (ctxFor(e)?.target.kind === 'remote' || typeof id !== 'string') throw new Error('invalid checkpoint read')
    return readCheckpoint(stateRoot(), id)
  })
  ipcMain.handle('checkpoint-delete', async (e, id: unknown) => {
    if (ctxFor(e)?.target.kind === 'remote' || typeof id !== 'string') throw new Error('invalid checkpoint delete')
    await deleteCheckpoint(stateRoot(), id)
  })
  ipcMain.handle('handoff-save-file', async (e, text: unknown, suggested: unknown) => {
    const ctx = ctxFor(e)
    if (ctx?.target.kind === 'remote' || typeof text !== 'string' || typeof suggested !== 'string'
      || Buffer.byteLength(text) > HANDOFF_FILE_MAX) return false
    try { parseHandoff(text) } catch { return false }
    const safeName = basename(suggested).slice(0, 120)
    const r = await dialog.showSaveDialog(ctx?.win ?? win, {
      defaultPath: safeName,
      filters: [{ name: 'amber session handoff', extensions: ['amberhandoff'] }],
    })
    if (r.canceled || !r.filePath) return false
    const path = r.filePath.endsWith('.amberhandoff') ? r.filePath : `${r.filePath}.amberhandoff`
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, text, { mode: 0o600 })
    await rename(tmp, path)
    return true
  })
  ipcMain.on('desktop-notify', (e, payload: unknown) => {
    const ctx = ctxFor(e)
    if (!ctx || ctx.target.kind === 'remote' || !Notification.isSupported() || !payload || typeof payload !== 'object') return
    const raw = payload as Record<string, unknown>
    if (typeof raw['title'] !== 'string' || typeof raw['body'] !== 'string') return
    const session = typeof raw['session'] === 'string' && raw['session'].length <= 200 ? raw['session'] : undefined
    const notification = new Notification({ title: raw['title'].slice(0, 80), body: raw['body'].slice(0, 240) })
    notification.on('click', () => {
      if (ctx.win.isDestroyed()) return
      ctx.resumeClient(); ctx.win.show(); ctx.win.focus()
      if (session) ctx.win.webContents.send('notification-activate', session)
    })
    notification.show()
  })

  // Portable workspace file: native save dialog + atomic write (layout-save
  // precedent). Returns true on write, false on cancel.
  ipcMain.handle('workspace-save-file', async (_e, json: string, suggestedName: string) => {
    if (typeof json !== 'string') throw new Error('WORKSPACE_REQUEST_INVALID')
    assertWorkspaceFileBytes(json)
    const r = await dialog.showSaveDialog(win, {
      defaultPath: suggestedName,
      filters: [{ name: 'amber workspace', extensions: ['amberws'] }],
    })
    if (r.canceled || !r.filePath) return false
    // showSaveDialog does not reliably append the filter extension on Linux —
    // add it so the open filter finds the file later.
    const p = r.filePath.endsWith('.amberws') ? r.filePath : r.filePath + '.amberws'
    const tmp = `${p}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(tmp, json, { mode: 0o600 })
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
    const selected = r.filePaths[0]
    const text = await readBoundedTextFile(selected, WORKSPACE_FILE_MAX_BYTES, 'WORKSPACE_FILE_LIMIT')
    assertWorkspaceFileBytes(text)
    return text
  })

  // ---- editor pane file IO (spec §4). Thin wrappers; the guards, the atomic
  // write and the paneId validation all live in editorFiles.ts.
  const EDITOR_FILTERS = [
    { name: 'All files', extensions: ['*'] },
    { name: 'JSON', extensions: ['json', 'jsonc'] },
    { name: 'Markdown', extensions: ['md', 'markdown'] },
  ]
  const draftsDir = () => join(stateRoot(), 'drafts')

  ipcMain.handle('editor-open-dialog', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: EDITOR_FILTERS })
    const p = r.canceled ? undefined : r.filePaths[0]
    if (!p) return null
    return { path: p, ...(await readEditorFile(p)) }
  })
  // Session-cleanup dialog: name each claude session by its conversation.
  ipcMain.handle('claude-names', (_e, entries: unknown) =>
    claudeNames(
      Array.isArray(entries)
        ? entries.flatMap((e) => {
            const o = e as { id?: unknown; cwd?: unknown }
            return typeof o?.id === 'string' ? [{ id: o.id, cwd: typeof o.cwd === 'string' ? o.cwd : '' }] : []
          })
        : [],
    ))
  ipcMain.handle('editor-read', (_e, path: string) => readEditorFile(String(path)))
  ipcMain.handle('editor-save', (_e, path: string, text: string, expectedMtimeMs: number | null) =>
    saveEditorFile(String(path), String(text), typeof expectedMtimeMs === 'number' ? expectedMtimeMs : null))
  ipcMain.handle('editor-save-dialog', async (_e, suggestedName: string, text: string) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: suggestedName, filters: EDITOR_FILTERS })
    if (r.canceled || !r.filePath) return null
    return { path: r.filePath, ...(await saveEditorFile(r.filePath, String(text), null)) }
  })
  ipcMain.handle('editor-draft-write', (_e, paneId: string, text: string) =>
    writeDraft(draftsDir(), String(paneId), String(text)))
  ipcMain.handle('editor-draft-read', (_e, paneId: string) => readDraft(draftsDir(), String(paneId)))
  ipcMain.handle('editor-draft-clear', (_e, paneId: string) => clearDraft(draftsDir(), String(paneId)))
  // Markdown preview images: the sandboxed srcdoc frame inherits the renderer
  // CSP (img-src 'self' data:), so local file: images never load — main inlines
  // them as data: URIs. Remote srcs are deliberately left alone.
  ipcMain.handle('editor-inline-images', (_e, mdDir: string, html: string) =>
    inlineImages(String(mdDir), String(html)))
}

app.on('before-quit', (event) => {
  if (tabBrowserHostEnabled() && !allowFinalQuit) {
    event.preventDefault()
    if (requestExplicitQuit) void requestExplicitQuit()
    else residentIntents.requestQuit()
    return
  }
  killTunnels()
})

// Single-instance lock: a second launch sends only a bounded, versioned
// activation envelope. The resident owner validates it before showing a local
// window; arbitrary argv never reaches a shell or a replacement window.
const launchActivation = activationRequest(process.argv)
if (!app.requestSingleInstanceLock(launchActivation)) {
  quitDuringStartup()
} else {
  app.on('second-instance', (_event, _argv, _cwd, additionalData) => {
    if (parseActivationRequest(additionalData) !== null) residentIntents.requestActivation()
  })
  app.on('activate', () => { residentIntents.requestActivation() })
  app.whenReady().then(main).catch((e) => {
    console.error(e)
    quitDuringStartup()
  })
}
// Without the browser host, preserve the existing close-means-exit behavior.
// With it, the local window's close handler hides presentation and drains pane
// subscriptions while the metadata watcher and BrowserHost remain resident;
// second-instance/activate reopens that same window.
app.on('window-all-closed', () => {
  if (!tabBrowserHostEnabled()) app.quit()
})
