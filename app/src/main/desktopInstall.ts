import { join } from 'node:path'

// Linux desktop integration for the AppImage: launcher entry + icon so the app
// can be pinned to the taskbar. Everything here is PURE (string/path
// construction) so it is unit-testable; the impure fs/spawn wiring lives in
// index.ts — the same split as serviceManager.ts.

export const APP_NAME = 'amber-ide'

// Exec is quoted (paths may contain spaces); %U is the standard URL-list field
// code so launchers don't warn about a missing field. StartupWMClass ties
// running windows to this entry so taskbar pinning groups correctly.
export function renderDesktopEntry(appImagePath: string): string {
  return `[Desktop Entry]
Type=Application
Name=${APP_NAME}
Comment=Persistent terminal workspace
Exec="${appImagePath}" %U
Icon=${APP_NAME}
Terminal=false
Categories=Development;TerminalEmulator;
StartupWMClass=${APP_NAME}
`
}

// STABLE copy of the AppImage — mirrors the daemon's ~/.local/bin/amber
// pattern: the launcher entry must survive the user deleting the download,
// and upgrades overwrite one stable path.
export function stableAppImagePath(home: string): string {
  return join(home, 'Applications', `${APP_NAME}.AppImage`)
}

export function desktopFilePath(home: string): string {
  return join(home, '.local', 'share', 'applications', `${APP_NAME}.desktop`)
}

export function iconInstallPath(home: string): string {
  return join(home, '.local', 'share', 'icons', 'hicolor', '512x512', 'apps', `${APP_NAME}.png`)
}
