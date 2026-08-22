// Remote-access status types (spec 2026-08-22 §9).
//
// In `shared/` rather than `main/` because three sides read them: the main
// process produces the value, the renderer renders it, and the web shim
// (`src/web/amber.ts`) has to answer the same call. A renderer that imported
// from `main/` would cross the boundary `shared/` exists to hold.

export type TailscaleState =
  | 'not-installed'
  | 'not-logged-in'
  | 'not-running'
  | 'serve-not-mapped'
  | 'serving'

export interface WebClient {
  id: number
  /** The one session this browser socket has open, if any. */
  open: string | null
  /** Borrowed pty grid — always null until spec §2.2 (Phase B) lands. */
  borrow: unknown | null
}

export interface WebStatus {
  /**
   * Whether this host can manage the service at all.
   *
   * `false` in the browser build: a page served BY `amber web` has no business
   * starting, stopping or reading the token of the thing serving it. The
   * toolbar hides the pill entirely on `false` — routing it through the error
   * state instead would put a permanently red badge on every phone, which is
   * the exact surface this feature exists to improve.
   */
  managed: boolean
  unit: 'active' | 'inactive' | 'unknown'
  port: number
  /** Token-FREE. The tokenised URL comes from `webUrl()`, on demand. */
  url: string
  tailscale: TailscaleState
  host: string
  /**
   * Whether a token file exists. The token itself is never carried here: this
   * payload is polled every few seconds while the dialog is open, so a
   * credential in it would sit in renderer memory and every IPC trace
   * continuously.
   */
  hasToken: boolean
  clients: WebClient[]
  sessions: number | null
  uptimeSecs: number | null
  error: string | null
}
