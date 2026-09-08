import type { BrowserWindow } from 'electron'

/** Approval needs human attention, not permission to steal their foreground. */
export function requestBrowserAttention(windows: readonly {
  local: boolean
  window: Pick<BrowserWindow, 'isDestroyed' | 'flashFrame'>
}[]): void {
  for (const { local, window } of windows) {
    if (local && !window.isDestroyed()) window.flashFrame(true)
  }
}
