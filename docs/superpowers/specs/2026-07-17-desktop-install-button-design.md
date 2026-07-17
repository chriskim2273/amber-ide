# Desktop Install Button (Linux AppImage) — Design

**Date:** 2026-07-17
**Status:** Approved

## Problem

The AppImage runs but has no launcher presence: no icon, no `.desktop` entry,
can't pin to taskbar. Manual integration (extract icon, write `.desktop`, fix
`Exec`) works but is a chore. The app should install itself, the same way the
packaged first run already installs the daemon to a stable path.

## Decisions (settled with user)

- **Placement:** app-menu item "Install desktop shortcut", next to
  "Quit amber daemon". No renderer/toolbar work, no first-run prompt.
- **Stable copy:** install copies the running AppImage to
  `~/Applications/amber-ide.AppImage` and points the `.desktop` there —
  matching the daemon's stable `~/.local/bin/amber` pattern. Survives the
  user deleting the download; upgrades overwrite one stable path.
- **Icon:** create a custom amber-ide icon now (512×512 PNG). Replaces the
  default Electron icon everywhere (AppImage embed + launcher/taskbar).
- **Scope:** Linux only. macOS dmg installs natively; the menu item is hidden
  there. No Windows (out of scope per constitution).

## Design

### 1. Icon

- `app/build/icon.png` — 512×512 PNG, amber terminal glyph.
  electron-builder's default buildResources dir; embedded into the AppImage
  automatically (window icon + AppImage-internal `.desktop`).
- Also shipped via `extraResources` (`app/resources/icon.png` →
  `process.resourcesPath/icon.png`) so the install handler can copy it
  without extracting the AppImage.

### 2. Pure module — `app/src/main/desktopInstall.ts`

Mirrors `serviceManager.ts`: pure string/path construction, unit-testable;
impure fs/spawn wiring stays in `index.ts`.

- `renderDesktopEntry(appImagePath: string): string` — `.desktop` content:
  `Type=Application`, `Name=amber-ide`, `Exec="<path>" %U`, `Icon=amber-ide`,
  `Terminal=false`, `Categories=Development;TerminalEmulator;`,
  `StartupWMClass=amber-ide` (taskbar pin grouping).
- Path builders (all take `home`):
  - `stableAppImagePath(home)` → `~/Applications/amber-ide.AppImage`
  - `desktopFilePath(home)` → `~/.local/share/applications/amber-ide.desktop`
  - `iconInstallPath(home)` → `~/.local/share/icons/hicolor/512x512/apps/amber-ide.png`

### 3. Wiring — `index.ts`

Menu item **"Install desktop shortcut"** in the existing File/Daemon submenu,
included only when `process.platform === 'linux' && process.env['APPIMAGE']`
is set (the AppImage runtime exports `$APPIMAGE` = path to the image; implies
packaged).

Click handler:

1. Copy `$APPIMAGE` → `~/Applications/amber-ide.AppImage`, chmod 755.
   Skip the copy if the running image already **is** the stable path
   (realpath comparison) — self-copy guard.
2. Copy `process.resourcesPath/icon.png` → hicolor icon path.
3. Write the `.desktop` file (dirs `mkdir -p`'d).
4. `update-desktop-database ~/.local/share/applications` and
   `gtk-update-icon-cache` — best-effort (`spawnOk(...).catch(() => {})`),
   absence of the tools must not fail the install.
5. Success dialog naming what was installed and that pin-to-taskbar now works.

Idempotent overwrite: re-running repairs/upgrades; no installed-state
tracking, menu item always visible (Linux+AppImage).

### Error handling

Failures in steps 1–3 surface in an error dialog (message + underlying error
string), same discipline as `installDaemon`/`quitDaemonAndApp`. Step 4 is
best-effort by design.

### Testing

Vitest unit tests for the pure module only (`desktopInstall.test.ts`):
rendered `.desktop` content (Exec quoting, required keys), path builders.
Impure wiring untested, matching repo convention (`serviceManager.test.ts`
precedent). Live verification manual: run AppImage → menu item → entry
appears in launcher, icon correct, pin works.

## Out of scope

- Uninstall menu item (delete two files by hand if ever needed).
- macOS/Windows integration.
- First-run auto-prompt.
