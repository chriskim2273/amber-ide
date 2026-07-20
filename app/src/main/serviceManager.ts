import { join } from 'node:path'

// Service-manager glue for the boot units that give the daemon reboot survival.
// Everything here is PURE (string/argv construction) so it is unit-testable; the
// impure fs/spawn wiring lives in index.ts. Linux uses a systemd user unit,
// macOS a launchd agent.

export const LAUNCHD_LABEL = 'com.amber-ide.daemon'
export const SYSTEMD_SERVICE = 'amber.service'

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
  return null
}

// Restart the daemon in place — the app's recovery path for a wedged daemon
// (menu: "Restart amber daemon"), and the way to pick up a newly installed
// binary. Unlike `stopDaemonCommand` this leaves the daemon RUNNING: sessions
// are restored from the state store, though the processes inside them are
// killed and restarted (a claude pane resumes its conversation via its
// supervisor). macOS `kickstart -k` stops and restarts in one call; a bootout
// alone would leave the agent down.
export function restartDaemonCommand(platform: NodeJS.Platform, uid: number): Argv | null {
  if (platform === 'linux') {
    return { cmd: 'systemctl', args: ['--user', 'restart', SYSTEMD_SERVICE] }
  }
  if (platform === 'darwin') {
    return launchctlKickstartArgv(uid)
  }
  return null
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
  return null
}
