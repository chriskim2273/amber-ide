const MAX_DRAFT_BYTES = 256 * 1024
const PREFIX = 'amber:pi-draft:'

export interface PiDraftStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

function storage(): PiDraftStorage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

function originPart(): string {
  try { return globalThis.location?.origin || 'unknown-origin' } catch { return 'unknown-origin' }
}

/** Session-scoped key. The session name is deliberately encoded as data, not
 * used as a path or selector, so renamed panes cannot escape storage scope. */
export function piDraftKey(session: string, origin = originPart()): string {
  return `${PREFIX}${origin}:${encodeURIComponent(session)}`
}

export function readPiDraft(session: string, store = storage()): string {
  if (!store) return ''
  try {
    const value = store.getItem(piDraftKey(session)) ?? ''
    return new TextEncoder().encode(value).length <= MAX_DRAFT_BYTES ? value : ''
  } catch {
    return ''
  }
}

export function writePiDraft(session: string, value: string, store = storage()): boolean {
  if (!store) return false
  if (new TextEncoder().encode(value).length > MAX_DRAFT_BYTES) return false
  try {
    if (value.length === 0) store.removeItem(piDraftKey(session))
    else store.setItem(piDraftKey(session), value)
    return true
  } catch {
    // Private browsing, quota exhaustion, and disabled storage are all normal
    // environments. The composer remains usable; persistence is best effort.
    return false
  }
}

/** A late receipt may clear only the exact edit that was submitted. */
export function canClearPiDraft(currentValue: string, submittedValue: string, currentVersion: number, submittedVersion: number): boolean {
  return currentValue === submittedValue && currentVersion === submittedVersion
}

export function clearPiDraft(session: string, store = storage()): boolean {
  return writePiDraft(session, '', store)
}

export const PI_DRAFT_MAX_BYTES = MAX_DRAFT_BYTES
