import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { buildAppMenuTemplate } from './browserMenu'

function menuItem(template: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions | undefined {
  for (const item of template) {
    if (item.label === label) return item
    if (Array.isArray(item.submenu)) {
      const nested = menuItem(item.submenu, label)
      if (nested) return nested
    }
  }
  return undefined
}

describe('browser-host application menu', () => {
  it('keeps Quit Amber IDE actionable on simulated Windows without browser-host hooks', () => {
    const quit = vi.fn()
    const template = buildAppMenuTemplate('win32', {
      onQuitDaemon: vi.fn(),
      onQuitApp: quit,
      onEnableBrowserHost: null,
      onInstallDesktop: null,
      onRestartDaemon: vi.fn(),
      onConnectHost: vi.fn(),
      appName: 'amber',
    })
    const item = menuItem(template, 'Quit Amber IDE')
    expect(item?.enabled).not.toBe(false)
    const click = item?.click as (() => void) | undefined
    click?.()
    expect(quit).toHaveBeenCalledOnce()
  })

  it('shows the host-unavailable state without exposing a fake enable action', () => {
    const template = buildAppMenuTemplate('win32', {
      onQuitDaemon: vi.fn(), onQuitApp: vi.fn(), onEnableBrowserHost: null,
      onInstallDesktop: null, onRestartDaemon: vi.fn(), onConnectHost: vi.fn(), appName: 'amber',
    })
    const item = menuItem(template, 'Browser host unavailable on this configuration')
    expect(item?.enabled).toBe(false)
  })
})
