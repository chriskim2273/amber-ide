import type { PaletteEntry } from './commandPalette'

export function panePickerDetail(
  workspaceLabel: string,
  tabLabel: string,
  kind: string,
  cwd: string,
  name: string,
): string {
  return `${workspaceLabel} / ${tabLabel} · ${kind} · ${cwd} · ${name}`
}

export function shouldDismissPanePicker(key: string, pickerOpen: boolean): boolean {
  return pickerOpen && key === 'Escape'
}

export function renamePanePickerEntry(entry: PaletteEntry, onClose: () => void): void {
  onClose()
  entry.rename?.()
}
