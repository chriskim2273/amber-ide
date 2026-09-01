// Local-router status types (design 2026-09-01).
//
// In `shared/` for the same reason as `webStatus`: main produces the value,
// the renderer renders it, and the web shim must answer the same call without
// either side importing from `main/`.

/** One provider in the failover chain, as the UI sees it. */
export interface RouterSlot {
  /** Stable across renames — the key the stored API key is matched on. */
  id: string
  name: string
  baseUrl: string
  model: string
  enabled: boolean
  hasKey: boolean
  /** `••••1234`, or empty. The plaintext key is NEVER in this payload. */
  keyHint: string
}

/** Live health of one credential, from the router's own selector. */
export interface RouterKey {
  label: string
  state: string
  coolingSecsRemaining: number | null
  inFlight: number
  requests: number
  errors: number
  lastError: string | null
}

/** Whether amber's provider entry is present and current in Pi's config. */
export type PiProviderState = 'no-config' | 'missing' | 'stale' | 'installed'

export interface RouterStatus {
  /**
   * Whether this host can manage the service. The toolbar hides the pill on
   * `false` rather than painting a permanent red badge. Hosted `/app` now
   * reports `true`: `amber web` proxies router control over the same cookie
   * as sessions, so the desktop dialog works in a remote browser too.
   */
  managed: boolean
  unit: 'active' | 'inactive' | 'unknown'
  port: number
  /** Base URL an OpenAI-compatible client should call. Carries no token. */
  url: string
  /** The model id that means "walk the whole chain". */
  alias: string
  /**
   * Whether the inbound token file exists. The token itself is never carried
   * here: this payload is polled while the dialog is open, so a credential in
   * it would sit in renderer memory and every IPC trace continuously.
   */
  hasToken: boolean
  pi: PiProviderState
  slots: RouterSlot[]
  keys: RouterKey[]
  queueAvailable: number | null
  uptimeSecs: number | null
  error: string | null
}

/**
 * Wire (snake_case, as the router serves it) -> UI shape.
 *
 * Exported because the slot-list IPC needs the SAME mapping the status parser
 * uses: returning the raw wire object left `hasKey` undefined, so every stored
 * key rendered as "no key yet".
 */
export function slotFromWire(raw: Record<string, unknown>): RouterSlot {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  return {
    id: str(raw['id']),
    name: str(raw['name']),
    baseUrl: str(raw['base_url']),
    model: str(raw['model']),
    enabled: raw['enabled'] === true,
    hasKey: raw['has_key'] === true,
    keyHint: str(raw['key_hint']),
  }
}

/**
 * UI shape -> wire. `apiKey` is passed separately: an empty string means
 * "unchanged", and the UI never holds the stored value to send back.
 */
export function slotToWire(s: RouterSlot, apiKey: string): Record<string, unknown> {
  return {
    id: s.id,
    name: s.name,
    base_url: s.baseUrl,
    model: s.model,
    enabled: s.enabled,
    api_key: apiKey,
  }
}

/** Pill tone. `off` is a router that is simply not running — not an error. */
export function routerDot(s: RouterStatus): 'serving' | 'local' | 'error' | 'off' {
  if (s.error && s.unit === 'active') return 'error'
  if (s.unit !== 'active') return 'off'
  return s.slots.some((x) => x.enabled) ? 'serving' : 'local'
}

const PI_STATES: readonly PiProviderState[] = ['no-config', 'missing', 'stale', 'installed']

function asStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function asNum(v: unknown): number | null {
  return typeof v === 'number' ? v : null
}

/**
 * Parse, never throw. A dialog that dies on malformed CLI/API output is
 * strictly worse than one that shows "unknown" and an error line.
 */
export function parseRouterStatus(stdout: string): RouterStatus {
  const base: RouterStatus = {
    managed: true,
    unit: 'unknown',
    port: 0,
    url: '',
    alias: 'auto',
    hasToken: false,
    pi: 'no-config',
    slots: [],
    keys: [],
    queueAvailable: null,
    uptimeSecs: null,
    error: null,
  }
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(stdout) as Record<string, unknown>
  } catch {
    return { ...base, error: 'could not parse router status' }
  }
  if (raw === null || typeof raw !== 'object') {
    return { ...base, error: 'unexpected router status payload' }
  }
  const unit = raw['unit']
  const pi = raw['pi']
  return {
    ...base,
    managed: raw['managed'] !== false,
    unit: unit === 'active' || unit === 'inactive' ? unit : 'unknown',
    port: typeof raw['port'] === 'number' ? raw['port'] : 0,
    url: asStr(raw['url']),
    alias: asStr(raw['alias'], 'auto'),
    hasToken: raw['has_token'] === true,
    pi: PI_STATES.includes(pi as PiProviderState) ? (pi as PiProviderState) : 'no-config',
    slots: Array.isArray(raw['slots'])
      ? (raw['slots'] as Record<string, unknown>[]).map(slotFromWire)
      : [],
    keys: Array.isArray(raw['keys'])
      ? (raw['keys'] as Record<string, unknown>[]).map((k) => ({
          label: asStr(k['label']),
          state: asStr(k['state'], 'unknown'),
          coolingSecsRemaining: asNum(k['cooling_secs_remaining']),
          inFlight: typeof k['in_flight'] === 'number' ? k['in_flight'] : 0,
          requests: typeof k['requests'] === 'number' ? k['requests'] : 0,
          errors: typeof k['errors'] === 'number' ? k['errors'] : 0,
          lastError: typeof k['last_error'] === 'string' ? k['last_error'] : null,
        }))
      : [],
    queueAvailable: asNum(raw['queue_available']),
    uptimeSecs: asNum(raw['uptime_secs']),
    error: typeof raw['error'] === 'string' ? raw['error'] : null,
  }
}

/** Move a slot within the list, returning a new array. Out-of-range is a no-op. */
export function moveSlot(slots: RouterSlot[], from: number, to: number): RouterSlot[] {
  if (from < 0 || to < 0 || from >= slots.length || to >= slots.length || from === to) {
    return slots
  }
  const next = slots.slice()
  const item = next[from]
  if (item === undefined) return slots
  next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}
