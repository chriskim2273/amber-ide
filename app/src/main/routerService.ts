export type {
  PiProviderState,
  RouterKey,
  RouterSlot,
  RouterStatus,
} from '../shared/routerStatus'
import type { PiProviderState, RouterSlot, RouterStatus } from '../shared/routerStatus'

const PI_STATES: readonly PiProviderState[] = ['no-config', 'missing', 'stale', 'installed']

export function routerCtlArgv(action: string, port: number): string[] {
  return ['ctl', 'router', action, '--json', '--port', String(port)]
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function num(v: unknown): number | null {
  return typeof v === 'number' ? v : null
}

/**
 * Wire (snake_case, as the router serves it) -> UI shape.
 *
 * Exported because the slot-list IPC needs the SAME mapping the status parser
 * uses: returning the raw wire object left `hasKey` undefined, so every stored
 * key rendered as "no key yet".
 */
export function slotFromWire(raw: Record<string, unknown>): RouterSlot {
  return slot(raw)
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

function slot(raw: Record<string, unknown>): RouterSlot {
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
 * Parse, never throw. A dialog that dies on malformed CLI output is strictly
 * worse than one that shows "unknown" and an error line.
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
    return { ...base, error: 'could not parse `amber ctl router status --json`' }
  }
  if (raw === null || typeof raw !== 'object') {
    return { ...base, error: 'unexpected `amber ctl router status --json` payload' }
  }
  const unit = raw['unit']
  const pi = raw['pi']
  return {
    ...base,
    unit: unit === 'active' || unit === 'inactive' ? unit : 'unknown',
    port: typeof raw['port'] === 'number' ? raw['port'] : 0,
    url: str(raw['url']),
    alias: str(raw['alias'], 'auto'),
    hasToken: raw['has_token'] === true,
    pi: PI_STATES.includes(pi as PiProviderState) ? (pi as PiProviderState) : 'no-config',
    slots: Array.isArray(raw['slots'])
      ? (raw['slots'] as Record<string, unknown>[]).map(slot)
      : [],
    keys: Array.isArray(raw['keys'])
      ? (raw['keys'] as Record<string, unknown>[]).map((k) => ({
          label: str(k['label']),
          state: str(k['state'], 'unknown'),
          coolingSecsRemaining: num(k['cooling_secs_remaining']),
          inFlight: typeof k['in_flight'] === 'number' ? k['in_flight'] : 0,
          requests: typeof k['requests'] === 'number' ? k['requests'] : 0,
          errors: typeof k['errors'] === 'number' ? k['errors'] : 0,
          lastError: typeof k['last_error'] === 'string' ? k['last_error'] : null,
        }))
      : [],
    queueAvailable: num(raw['queue_available']),
    uptimeSecs: num(raw['uptime_secs']),
    error: typeof raw['error'] === 'string' ? raw['error'] : null,
  }
}

/** Pill tone. `off` is a router that is simply not running — not an error. */
export function routerDot(s: RouterStatus): 'serving' | 'local' | 'error' | 'off' {
  if (s.error && s.unit === 'active') return 'error'
  if (s.unit !== 'active') return 'off'
  return s.slots.some((x) => x.enabled) ? 'serving' : 'local'
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
