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

/**
 * Window event the prompt-enhancement dialog dispatches to fill a mounted Pi
 * composer. The session name rides the event as data (never a selector), the
 * same way the storage key does.
 */
export const PI_DRAFT_SET_EVENT = 'amber:pi-draft-set'

export interface PiDraftSetDetail {
  session: string
  text: string
}

/**
 * Persist an externally produced draft AND wake the mounted pane, if any. A
 * pane that is not mounted still picks the text up from storage on mount, so
 * this degrades to a plain write rather than failing.
 */
export function notifyPiDraftSet(session: string, text: string): void {
  writePiDraft(session, text)
  try {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
    window.dispatchEvent(new CustomEvent<PiDraftSetDetail>(PI_DRAFT_SET_EVENT, { detail: { session, text } }))
  } catch {
    // Same best-effort posture as draft persistence above: the text is
    // already in storage, so a missing event bus only loses the live update.
  }
}

export function clearPiDraft(session: string, store = storage()): boolean {
  return writePiDraft(session, '', store)
}

export const PI_DRAFT_MAX_BYTES = MAX_DRAFT_BYTES
