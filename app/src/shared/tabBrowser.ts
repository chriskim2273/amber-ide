// Coordinate-free tab-browser identity and URL minimization. Legacy pane ids
// remain in browserName.ts only for migration; new runtime records use this id.
export type BrowserId = `browser-${string}`

export interface LegacyBrowserCoordinates { ws: number; tab: number; ord: number; id: string }

const OPAQUE_RE = /^browser-[0-9a-f]{32}$/
const LEGACY_RE = /^browser-(\d+)-(\d+)-(\d+)-([^/\s]+)$/

export function createBrowserId(random = (): Uint8Array => crypto.getRandomValues(new Uint8Array(16))): BrowserId {
  const bytes = random()
  if (bytes.length !== 16) throw new Error('browser id entropy must be exactly 16 bytes')
  return `browser-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export function isOpaqueBrowserId(value: unknown): value is BrowserId {
  return typeof value === 'string' && OPAQUE_RE.test(value)
}

export function parseLegacyBrowserName(value: string): LegacyBrowserCoordinates | null {
  const match = LEGACY_RE.exec(value)
  if (!match) return null
  const ws = Number(match[1]); const tab = Number(match[2]); const ord = Number(match[3])
  if (![ws, tab, ord].every(Number.isSafeInteger)) return null
  return { ws, tab, ord, id: match[4]! }
}

/** Persist/model-display at most a validated HTTP(S) origin and path. */
export function safeRestoreUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'about:blank'
    return `${url.protocol}//${url.host}${url.pathname || '/'}`
  } catch {
    return 'about:blank'
  }
}
