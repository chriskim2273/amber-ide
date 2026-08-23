import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { restartDaemonCommand,
  AMBER_SYSTEMD_UNIT,
  linuxInstallServiceArgv,
  renderDaemonPlist,
  launchAgentPlistPath,
  launchctlBootstrapArgv,
  launchctlLoadArgv,
  launchctlKickstartArgv,
  stopDaemonCommand,
  stopDaemonFallbackCommand,
  bootUnitPath,
  LAUNCHD_LABEL,
  SYSTEMD_SERVICE,
} from './serviceManager'

describe('renderDaemonPlist', () => {
  it('substitutes the binary path and leaves no placeholder', () => {
    const plist = renderDaemonPlist('/home/u/.local/bin/amber')
    expect(plist).toContain('<string>/home/u/.local/bin/amber</string>')
    expect(plist).toContain('<string>daemon</string>')
    expect(plist).toContain('<string>com.amber-ide.daemon</string>')
    expect(plist).toContain('<key>RunAtLoad</key>')
    expect(plist).toContain('<key>KeepAlive</key>')
    expect(plist).not.toContain('__AMBER_BIN__')
  })
  it('substitutes every occurrence', () => {
    const plist = renderDaemonPlist('/a/b')
    expect(plist.includes('__AMBER_BIN__')).toBe(false)
  })
})

describe('launchAgentPlistPath', () => {
  it('is under ~/Library/LaunchAgents with the label', () => {
    expect(launchAgentPlistPath('/Users/u')).toBe(
      '/Users/u/Library/LaunchAgents/com.amber-ide.daemon.plist',
    )
  })
})

describe('launchctl install argv', () => {
  it('bootstrap targets gui/<uid> with the plist', () => {
    expect(launchctlBootstrapArgv(501, '/p/x.plist')).toEqual({
      cmd: 'launchctl',
      args: ['bootstrap', 'gui/501', '/p/x.plist'],
    })
  })
  it('load -w falls back on the plist path', () => {
    expect(launchctlLoadArgv('/p/x.plist')).toEqual({
      cmd: 'launchctl',
      args: ['load', '-w', '/p/x.plist'],
    })
  })
  it('kickstart -k targets gui/<uid>/<label>', () => {
    expect(launchctlKickstartArgv(501)).toEqual({
      cmd: 'launchctl',
      args: ['kickstart', '-k', 'gui/501/com.amber-ide.daemon'],
    })
  })
})

describe('stopDaemonCommand', () => {
  it('linux stops the systemd user service', () => {
    expect(stopDaemonCommand('linux', 501)).toEqual({
      cmd: 'systemctl',
      args: ['--user', 'stop', SYSTEMD_SERVICE],
    })
  })
  it('darwin boots out the launchd agent', () => {
    expect(stopDaemonCommand('darwin', 501)).toEqual({
      cmd: 'launchctl',
      args: ['bootout', 'gui/501/com.amber-ide.daemon'],
    })
  })
  it('returns null on unsupported platforms', () => {
    expect(stopDaemonCommand('win32', 501)).toBeNull()
  })
})

describe('stopDaemonFallbackCommand', () => {
  it('darwin unloads the plist', () => {
    expect(stopDaemonFallbackCommand('darwin', '/p/x.plist')).toEqual({
      cmd: 'launchctl',
      args: ['unload', '/p/x.plist'],
    })
  })
  it('linux has no fallback', () => {
    expect(stopDaemonFallbackCommand('linux', '/p/x.plist')).toBeNull()
  })
})

describe('bootUnitPath', () => {
  it('linux points at the systemd user unit', () => {
    expect(bootUnitPath('linux', '/home/u')).toBe(
      '/home/u/.config/systemd/user/amber.service',
    )
  })
  it('darwin points at the launchd agent plist', () => {
    expect(bootUnitPath('darwin', '/Users/u')).toBe(
      '/Users/u/Library/LaunchAgents/com.amber-ide.daemon.plist',
    )
  })
  it('returns null elsewhere', () => {
    expect(bootUnitPath('win32', '/home/u')).toBeNull()
  })
})

describe('constants', () => {
  it('match the infra unit/label names', () => {
    expect(LAUNCHD_LABEL).toBe('com.amber-ide.daemon')
    expect(SYSTEMD_SERVICE).toBe('amber.service')
  })

  it('delegates CPU and memory with a soft aggregate boundary and no hard max', () => {
    expect(AMBER_SYSTEMD_UNIT).toContain('Delegate=cpu memory')
    expect(AMBER_SYSTEMD_UNIT).toContain('MemoryAccounting=yes')
    expect(AMBER_SYSTEMD_UNIT).toContain('MemoryHigh=50%')
    expect(AMBER_SYSTEMD_UNIT).toContain('OOMPolicy=continue')
    expect(AMBER_SYSTEMD_UNIT).not.toContain('MemoryMax=')
  })

  it('keeps the installed and embedded resource directives in lockstep', () => {
    const installedUnit = readFileSync(
      fileURLToPath(new URL('../../../infra/daemon/amber.service', import.meta.url)),
      'utf8',
    )
    const resourceDirectives = (unit: string) => unit
      .split('\n')
      .filter((line) => /^(Delegate|Memory(?:Accounting|High|Max)|OOMPolicy|CPU)/.test(line))

    const expected = [
      'Delegate=cpu memory',
      'MemoryAccounting=yes',
      'MemoryHigh=50%',
      'OOMPolicy=continue',
    ]
    expect(resourceDirectives(installedUnit)).toEqual(expected)
    expect(resourceDirectives(AMBER_SYSTEMD_UNIT)).toEqual(expected)
  })

  it('linux upgrade reloads, enables, then explicitly restarts', () => {
    expect(linuxInstallServiceArgv()).toEqual([
      { cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
      { cmd: 'systemctl', args: ['--user', 'enable', 'amber.service'] },
      { cmd: 'systemctl', args: ['--user', 'restart', 'amber.service'] },
    ])
  })
})

// Menu "Restart amber daemon": recovery path when the daemon wedges, without
// making the user find a terminal. Linux restarts the unit; macOS `kickstart -k`
// stops-and-restarts the agent in one call (a plain bootout would leave it down).
describe('restartDaemonCommand', () => {
  it('restarts the systemd user unit on linux', () => {
    expect(restartDaemonCommand('linux', 1000))
      .toEqual({ cmd: 'systemctl', args: ['--user', 'restart', 'amber.service'] })
  })
  it('kickstarts the launchd agent on macOS', () => {
    expect(restartDaemonCommand('darwin', 501))
      .toEqual({ cmd: 'launchctl', args: ['kickstart', '-k', 'gui/501/com.amber-ide.daemon'] })
  })
  it('is unsupported elsewhere', () => {
    expect(restartDaemonCommand('win32', 0)).toBeNull()
  })
})
