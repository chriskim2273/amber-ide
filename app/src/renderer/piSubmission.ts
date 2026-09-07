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
