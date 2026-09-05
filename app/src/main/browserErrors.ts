const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/

export const ACTION_FAILED_NO_ROLLBACK = 'ACTION_FAILED_NO_ROLLBACK'
export const FRESH_SNAPSHOT_MESSAGE = 'Input was dispatched and cannot be rolled back. Take a fresh browser snapshot before retrying.'

export function safeBrowserCode(value: unknown, fallback = 'INTERNAL_ERROR'): string {
  return typeof value === 'string' && SAFE_CODE.test(value) ? value : fallback
}

/** A bounded adapter failure that records whether an irreversible input was accepted. */
export class BrowserAutomationError extends Error {
  readonly code: string
  readonly dispatched: boolean

  constructor(code: string, dispatched: boolean) {
    const safeCode = safeBrowserCode(code)
    super(safeCode)
    this.name = 'BrowserAutomationError'
    this.code = safeCode
    this.dispatched = dispatched
  }
}

export interface BrowserFailureDetails {
  code: string
  retryable: boolean
  message: string
  pageIncarnation?: string
  generation?: number
  snapshotHint?: boolean
  dispatched?: boolean
}

/** A safe broker-facing failure with optional current page identity. */
export class BrowserActionError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly pageIncarnation?: string
  readonly generation?: number
  readonly snapshotHint?: boolean
  readonly dispatched?: boolean

  constructor(details: Omit<BrowserFailureDetails, 'code'> & { code: string }) {
    const code = safeBrowserCode(details.code)
    super(details.message.slice(0, 512))
    this.name = 'BrowserActionError'
    this.code = code
    this.retryable = details.retryable
    if (details.pageIncarnation !== undefined) this.pageIncarnation = details.pageIncarnation.slice(0, 256)
    if (details.generation !== undefined && Number.isSafeInteger(details.generation) && details.generation >= 0) this.generation = details.generation
    if (details.snapshotHint !== undefined) this.snapshotHint = details.snapshotHint
    if (details.dispatched !== undefined) this.dispatched = details.dispatched
  }
}

export function isBrowserAutomationError(error: unknown): error is BrowserAutomationError {
  return error instanceof BrowserAutomationError
}

export function isBrowserActionError(error: unknown): error is BrowserActionError {
  return error instanceof BrowserActionError
}
