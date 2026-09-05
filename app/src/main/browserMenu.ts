import type { MenuItemConstructorOptions } from 'electron'
import { isSupportedOnPlatform } from './sshRemote'

export interface BrowserMenuHandlers {
  onQuitDaemon: () => void
  onQuitApp: () => void
  onEnableBrowserHost: (() => void) | null
  onInstallDesktop: (() => void) | null
  onRestartDaemon: () => void
  onConnectHost: () => void
  appName: string
}

/**
 * Build the application menu without consulting Electron globals. Keeping the
 * platform decision here makes the unsupported browser-host path testable and
 * ensures plain Quit remains actionable on Windows.
 */
export function buildAppMenuTemplate(platform: NodeJS.Platform, handlers: BrowserMenuHandlers): MenuItemConstructorOptions[] {
  const isMac = platform === 'darwin'
  const sshSupport = isSupportedOnPlatform(platform)
  const template: MenuItemConstructorOptions[] = []
  if (isMac) template.push({ label: handlers.appName, submenu: [
    { role: 'about' }, { type: 'separator' }, { role: 'services' },
    { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
    { type: 'separator' }, { label: 'Quit Amber IDE', accelerator: 'Cmd+Q', click: () => handlers.onQuitApp() },
  ] })
  const submenu: MenuItemConstructorOptions[] = [
    ...(handlers.onInstallDesktop !== null
      ? [
          { label: 'Install desktop shortcut', click: () => handlers.onInstallDesktop?.() },
          { type: 'separator' } as MenuItemConstructorOptions,
        ]
      : []),
    sshSupport.ok
      ? { label: 'Connect to host…', accelerator: 'CmdOrCtrl+Shift+O', click: () => handlers.onConnectHost() }
      : {
          label: 'Connect to host… (unavailable: named-pipe transport)',
          enabled: false,
          toolTip: sshSupport.reason,
        },
    { type: 'separator' } as MenuItemConstructorOptions,
    ...(handlers.onEnableBrowserHost
      ? [{ label: 'Enable browser host', click: () => handlers.onEnableBrowserHost?.() }]
      : [{ label: 'Browser host unavailable on this configuration', enabled: false }]),
    { label: 'Restart amber daemon', click: () => handlers.onRestartDaemon() },
    { label: 'Quit amber daemon', click: () => handlers.onQuitDaemon() },
  ]
  if (!isMac) submenu.push({ type: 'separator' }, { label: 'Quit Amber IDE', accelerator: 'CmdOrCtrl+Q', click: () => handlers.onQuitApp() })
  template.push({ label: isMac ? 'Daemon' : 'File', submenu })
  if (isMac) template.push({ role: 'editMenu' }, { role: 'windowMenu' })
  return template
}
