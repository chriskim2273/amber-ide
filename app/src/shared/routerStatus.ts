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
   * Whether this host can manage the service at all. `false` in the browser
   * build — a phone has no business editing the provider credentials of the
   * desktop it is borrowing. The toolbar hides the pill entirely on `false`
   * rather than routing it through the error state, which would put a
   * permanently red badge on every phone.
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
