import { join } from 'node:path'

// Service-manager glue for the boot units that give the daemon reboot survival.
// Everything here is PURE (string/argv construction) so it is unit-testable; the
// impure fs/spawn wiring lives in index.ts. Linux uses a systemd user unit,
// macOS a launchd agent.

export const LAUNCHD_LABEL = 'com.amber-ide.daemon'
export const SYSTEMD_SERVICE = 'amber.service'

// Windows auto-start: an HKCU Run-key value (no admin), the analog of the
// systemd user unit / launchd agent. Set to `"<stable>\amber.exe" daemon`.
export const WINDOWS_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
export const WINDOWS_RUN_VALUE = 'amber-daemon'

// Stable per-user install path for amber.exe on Windows — the path the Run key
// points at (the app's own install dir may be replaced on upgrade, so the
// daemon binary is copied here, mirroring ~/.local/bin/amber on Unix).
// `home` is %USERPROFILE%.
export function windowsStablePath(home: string): string {
  return join(home, 'AppData', 'Local', 'Programs', 'amber-ide', 'amber.exe')
}

// launchd agent, mirroring infra/daemon/com.amber-ide.daemon.plist.in. A
// packaged app has no repo to read the template from, so it is inlined here (the
// same reason the systemd unit is inlined in index.ts). __AMBER_BIN__ is the
// STABLE ~/.local/bin/amber path (launchd has no %h expansion — it needs an
// absolute path, never the ephemeral bundle mount).
const PLIST_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>__AMBER_BIN__</string>
        <string>daemon</string>
    </array>
    <!-- Start at login and keep it alive; launchd delivers SIGTERM on unload
         and at shutdown, which triggers the daemon's final snapshot. -->
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Interactive</string>
</dict>
</plist>
`

export function renderDaemonPlist(amberBin: string): string {
  return PLIST_TEMPLATE.split('__AMBER_BIN__').join(amberBin)
}

// Installed location of the launchd agent plist (~/Library/LaunchAgents).
export function launchAgentPlistPath(home: string): string {
  return join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
}

export interface Argv {
  cmd: string
  args: string[]
}

// macOS install: bootstrap into the GUI domain (modern), fall back to load -w
// (older macOS / already-bootstrapped domains), then kickstart -k to guarantee
// it is running on re-runs. All best-effort — the caller's probe loop verifies.
export function launchctlBootstrapArgv(uid: number, plistPath: string): Argv {
  return { cmd: 'launchctl', args: ['bootstrap', `gui/${uid}`, plistPath] }
}

export function launchctlLoadArgv(plistPath: string): Argv {
  return { cmd: 'launchctl', args: ['load', '-w', plistPath] }
}

export function launchctlKickstartArgv(uid: number): Argv {
  return { cmd: 'launchctl', args: ['kickstart', '-k', `gui/${uid}/${LAUNCHD_LABEL}`] }
}

// The single app path that stops the daemon (spec §3/§6). Linux: systemctl
// stop (Restart=on-failure means a clean stop is NOT a failure, so it stays
// stopped — no disable needed). macOS: bootout the launchd agent.
export function stopDaemonCommand(platform: NodeJS.Platform, uid: number): Argv | null {
  if (platform === 'linux') {
    return { cmd: 'systemctl', args: ['--user', 'stop', SYSTEMD_SERVICE] }
  }
  if (platform === 'darwin') {
    return { cmd: 'launchctl', args: ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`] }
  }
  if (platform === 'win32') {
    // No per-user service to stop; force-terminate the process. The app runs
    // `ctl snapshot-now` first (see index.ts) so no state is lost — the daemon
    // is windowless and a graceful WM_CLOSE isn't reliably deliverable.
    return { cmd: 'taskkill', args: ['/IM', 'amber.exe', '/F'] }
  }
  return null
}

// `reg add` argv to register the daemon at logon (HKCU — no admin). `exePath`
// is the stable amber.exe path from `windowsStablePath`.
export function windowsRunKeyAddArgv(exePath: string): Argv {
  return {
    cmd: 'reg',
    args: [
      'add',
      WINDOWS_RUN_KEY,
      '/v',
      WINDOWS_RUN_VALUE,
      '/t',
      'REG_SZ',
      '/d',
      `"${exePath}" daemon`,
      '/f',
    ],
  }
}

// `reg delete` argv to unregister the daemon (uninstall).
export function windowsRunKeyDeleteArgv(): Argv {
  return { cmd: 'reg', args: ['delete', WINDOWS_RUN_KEY, '/v', WINDOWS_RUN_VALUE, '/f'] }
}

// macOS fallback if `bootout` is unsupported on the running launchd.
export function stopDaemonFallbackCommand(
  platform: NodeJS.Platform,
  plistPath: string,
): Argv | null {
  if (platform === 'darwin') {
    return { cmd: 'launchctl', args: ['unload', plistPath] }
  }
  return null
}

// Where the boot unit lives once installed. Absence => dev/unmanaged: don't
// guess at pids, just report it.
export function bootUnitPath(platform: NodeJS.Platform, home: string): string | null {
  if (platform === 'linux') {
    return join(home, '.config', 'systemd', 'user', SYSTEMD_SERVICE)
  }
  if (platform === 'darwin') {
    return launchAgentPlistPath(home)
  }
  if (platform === 'win32') {
    // Windows has no boot-unit FILE (the "unit" is an HKCU Run-key value). Use
    // the stable installed binary as the "is the daemon managed here?" proxy —
    // its presence means the app's first-run install ran. `home` is
    // %USERPROFILE%.
    return windowsStablePath(home)
  }
  return null
}
