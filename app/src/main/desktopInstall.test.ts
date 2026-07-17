import { describe, it, expect } from 'vitest'
import {
  renderDesktopEntry,
  stableAppImagePath,
  desktopFilePath,
  iconInstallPath,
} from './desktopInstall'

describe('renderDesktopEntry', () => {
  const entry = renderDesktopEntry('/home/u/Applications/amber-ide.AppImage')

  it('is a valid desktop entry with required keys', () => {
    expect(entry.startsWith('[Desktop Entry]\n')).toBe(true)
    expect(entry).toContain('Type=Application\n')
    expect(entry).toContain('Name=amber-ide\n')
    expect(entry).toContain('Icon=amber-ide\n')
    expect(entry).toContain('Terminal=false\n')
    expect(entry).toContain('Categories=Development;TerminalEmulator;\n')
    expect(entry).toContain('StartupWMClass=amber-ide\n')
    expect(entry.endsWith('\n')).toBe(true)
  })

  it('quotes the Exec path and passes %U', () => {
    expect(entry).toContain('Exec="/home/u/Applications/amber-ide.AppImage" %U\n')
  })
})

describe('path builders', () => {
  it('stableAppImagePath', () => {
    expect(stableAppImagePath('/home/u')).toBe('/home/u/Applications/amber-ide.AppImage')
  })
  it('desktopFilePath', () => {
    expect(desktopFilePath('/home/u')).toBe(
      '/home/u/.local/share/applications/amber-ide.desktop',
    )
  })
  it('iconInstallPath', () => {
    expect(iconInstallPath('/home/u')).toBe(
      '/home/u/.local/share/icons/hicolor/512x512/apps/amber-ide.png',
    )
  })
})
