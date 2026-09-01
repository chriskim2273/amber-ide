// CLI-shaped helpers only. Anything the RENDERER needs lives in `shared/`:
// a value import from `main/` would pull main-process module code into the
// Electron renderer bundle and the browser build.
export type {
  PiProviderState,
  RouterKey,
  RouterSlot,
  RouterStatus,
} from '../shared/routerStatus'
export { moveSlot, routerDot, slotFromWire, slotToWire } from '../shared/routerStatus'
import type { PiProviderState, RouterSlot, RouterStatus } from '../shared/routerStatus'
import { slotFromWire } from '../shared/routerStatus'

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
      ? (raw['slots'] as Record<string, unknown>[]).map(slotFromWire)
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
