// Typed view of `amber ctl web --json`.
//
// The app parses ONLY json: the CLI's human output is for humans and changes
// freely, and a dialog that scrapes it would break silently.

export type { TailscaleState, WebClient, WebStatus } from '../shared/webStatus'
import type { TailscaleState, WebStatus } from '../shared/webStatus'

const TAIL_STATES: readonly TailscaleState[] = [
  'not-installed',
  'not-logged-in',
  'not-running',
  'serve-not-mapped',
  'serving',
]

export function webCtlArgv(action: string, port: number): string[] {
  return ['ctl', 'web', action, '--json', '--port', String(port)]
}

/**
 * Parse, never throw. A Remote access dialog that dies on malformed CLI output
 * is strictly worse than one that shows "unknown" and an error line.
 */
export function parseWebStatus(stdout: string): WebStatus {
  const base: WebStatus = {
    // The desktop main process IS the manager — only the web shim says false.
    managed: true,
    unit: 'unknown',
    port: 0,
    url: '',
    tailscale: 'not-installed',
    host: '',
    hasToken: false,
    clients: [],
    sessions: null,
    uptimeSecs: null,
    error: null,
  }
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(stdout) as Record<string, unknown>
  } catch {
    return { ...base, error: 'could not parse `amber ctl web status --json`' }
  }
  if (raw === null || typeof raw !== 'object') {
    return { ...base, error: 'unexpected `amber ctl web status --json` payload' }
  }
  const unit = raw['unit']
  const tail = raw['tailscale']
  return {
    ...base,
    unit: unit === 'active' || unit === 'inactive' ? unit : 'unknown',
    port: typeof raw['port'] === 'number' ? raw['port'] : 0,
    url: typeof raw['url'] === 'string' ? raw['url'] : '',
    // An unknown label is treated as the most conservative state rather than
    // trusted through into the UI.
    tailscale: TAIL_STATES.includes(tail as TailscaleState)
      ? (tail as TailscaleState)
      : 'not-installed',
    host: typeof raw['host'] === 'string' ? raw['host'] : '',
    hasToken: raw['has_token'] === true,
    clients: Array.isArray(raw['clients'])
      ? (raw['clients'] as Record<string, unknown>[]).map((c) => ({
          id: typeof c['id'] === 'number' ? c['id'] : 0,
          open: typeof c['open'] === 'string' ? c['open'] : null,
          borrow: c['borrow'] ?? null,
        }))
      : [],
    sessions: typeof raw['sessions'] === 'number' ? raw['sessions'] : null,
    uptimeSecs: typeof raw['uptime_secs'] === 'number' ? raw['uptime_secs'] : null,
    error: typeof raw['error'] === 'string' ? raw['error'] : null,
  }
}

/**
 * For logs and any surface that is not the deliberate reveal: the fragment
 * token grants full session control, the same authority as sitting at the
 * machine.
 */
export function redactUrl(url: string): string {
  const i = url.indexOf('#t=')
  return i === -1 ? url : `${url.slice(0, i)}#t=…`
}
