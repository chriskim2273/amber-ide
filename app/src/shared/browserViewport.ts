export const BROWSER_VIEWPORT_MIN_WIDTH = 200
export const BROWSER_VIEWPORT_MIN_HEIGHT = 200
export const BROWSER_VIEWPORT_MAX_WIDTH = 4096
export const BROWSER_VIEWPORT_MAX_HEIGHT = 4096

export interface BrowserViewportSize { width: number; height: number }

export function clampBrowserViewport(width: number, height: number): BrowserViewportSize {
  return {
    width: Math.min(BROWSER_VIEWPORT_MAX_WIDTH, Math.max(BROWSER_VIEWPORT_MIN_WIDTH, Math.round(width))),
    height: Math.min(BROWSER_VIEWPORT_MAX_HEIGHT, Math.max(BROWSER_VIEWPORT_MIN_HEIGHT, Math.round(height))),
  }
}

/** One exact viewport contract used at every renderer, IPC, tool, and disk boundary. */
export function parseBrowserViewport(value: unknown): BrowserViewportSize | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const viewport = value as Record<string, unknown>
  const width = viewport['width'], height = viewport['height']
  if (typeof width !== 'number' || !Number.isSafeInteger(width) || width < BROWSER_VIEWPORT_MIN_WIDTH || width > BROWSER_VIEWPORT_MAX_WIDTH) return null
  if (typeof height !== 'number' || !Number.isSafeInteger(height) || height < BROWSER_VIEWPORT_MIN_HEIGHT || height > BROWSER_VIEWPORT_MAX_HEIGHT) return null
  return { width, height }
}
