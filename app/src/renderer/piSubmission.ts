/** Shared guards for receipt-backed Pi sends. They are deliberately pure so
 * cancellation/reconnect behavior can be regression-tested without mounting an
 * Electron MessagePort. */
export function piOperationCurrent(
  signal: { aborted: boolean },
  operationGeneration: number,
  currentGeneration: number,
  portAvailable: boolean,
): boolean {
  return !signal.aborted && operationGeneration === currentGeneration && portAvailable
}

export function piSubmitAllowed(
  pendingRequestId: string | null,
  available: boolean,
  uploading: boolean,
): boolean {
  return available && !uploading && pendingRequestId === null
}

export function legacyPiDeliveryMessage(sent: boolean): string {
  return sent
    ? 'Prompt sent without a receipt; delivery is unconfirmed. Your draft was kept.'
    : 'Delivery unknown because the Pi bridge is unavailable; your draft was kept.'
}

/** Release only the operation that owns the slot. A stale completion from an
 * old bridge generation must not clear a replacement operation. */
export function releasePiOperation(currentOwner: string | null, operationId: string): string | null {
  return currentOwner === operationId ? null : currentOwner
}

export function resetPiSubmissionOnReconnect(): { pendingRequestId: null; uploading: false } {
  return { pendingRequestId: null, uploading: false }
}

export interface PiCompletedAttachment {
  conversationId: string
  attachmentId: string
}

/** Keep the completed-upload cache local to currently selected File objects.
 * This only drops browser references; server-side attachment artifacts are
 * intentionally untouched. */
export function pruneCompletedAttachments<T>(
  cache: Map<T, PiCompletedAttachment>,
  selected: readonly T[],
): void {
  const current = new Set(selected)
  for (const file of cache.keys()) if (!current.has(file)) cache.delete(file)
}

/** A completed upload is reusable only for the same browser File object and
 * authoritative Pi conversation. The cache is intentionally in-memory: an
 * attachment id restored without the original File/session proof is not safe
 * to send. */
export function rememberCompletedAttachment<T>(
  cache: Map<T, PiCompletedAttachment>,
  file: T,
  conversationId: string | null,
  attachmentId: string,
): void {
  if (!conversationId) return
  cache.set(file, { conversationId, attachmentId })
}

export function reuseCompletedAttachment<T>(
  cache: ReadonlyMap<T, PiCompletedAttachment>,
  file: T,
  conversationId: string | null,
): string | undefined {
  if (!conversationId) return undefined
  const completed = cache.get(file)
  return completed?.conversationId === conversationId ? completed.attachmentId : undefined
}

/** Sequentially finish acknowledged uploads and dispatch the prompt only if
 * the same session/view/port is still current immediately before dispatch. */
export async function uploadThenPrompt<T>(
  files: readonly T[],
  upload: (file: T) => Promise<string>,
  sendPrompt: (attachmentIds: string[]) => Promise<void>,
  isCurrent: () => boolean,
): Promise<boolean> {
  const attachmentIds: string[] = []
  for (const file of files) {
    if (!isCurrent()) return false
    attachmentIds.push(await upload(file))
    if (!isCurrent()) return false
  }
  if (!isCurrent()) return false
  await sendPrompt(attachmentIds)
  return true
}
