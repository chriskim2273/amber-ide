// Gesture-aware clipboard wrapper for the web build.
//
// `navigator.clipboard.writeText` succeeds without a user gesture in Chrome
// (focused tab + secure context), but Safari and Firefox reject it with
// `NotAllowedError` when it is not called during a transient user gesture.
// Amber's OSC 52 path arrives from the WebSocket — never from a gesture — so a
// naive writeText silently loses `/copy` on those browsers.
//
// This wraps the real write: on rejection it queues the text and finishes the
// copy on the NEXT keydown/click, which runs inside the browser's transient
// activation window and is therefore permitted. A small "copy pending" hint
// (via `onQueued`) tells the user to tap once. Pure and DOM-free; `install.ts`
// wires `gesture()` to real event listeners and renders the hint.

export interface ClipboardRetryHooks {
  /** A write was rejected and is queued for the next gesture. Show a hint. */
  onQueued?: (text: string) => void
  /** A queued write completed inside a gesture. Hide the hint. */
  onDone?: () => void
}

export interface GestureClipboard {
  /** Copy `text`. Resolves when the text is on the clipboard OR has been
   *  queued for a gesture (Safari/Firefox) — never rejects for a permission
   *  denial that a later gesture can satisfy. */
  writeText(text: string): Promise<void>
  /** Read the clipboard (passthrough; Pi never reads, amber denies OSC 52
   *  `?` requests, so this is rarely exercised). */
  readText(): Promise<string>
  /** Call from a real keydown/click handler. If a copy is queued, retry it
   *  inside the current gesture's transient activation window. Returns the
   *  write promise (event listeners ignore it). */
  gesture(): Promise<void>
  /** The text currently queued awaiting a gesture, or null if none. */
  pending(): string | null
}

export function createGestureClipboard(
  write: (text: string) => Promise<void>,
  read: () => Promise<string>,
  hooks: ClipboardRetryHooks = {},
): GestureClipboard {
  let queued: string | null = null

  const writeText = async (text: string): Promise<void> => {
    try {
      await write(text)
      return
    } catch {
      // Gesture-less write denied (NotAllowedError). Queue it; a gesture will
      // retry. Future copies overwrite the previous pending text.
      queued = text
      hooks.onQueued?.(text)
    }
  }

  const gesture = (): Promise<void> => {
    if (queued === null) return Promise.resolve()
    const text = queued
    queued = null
    // Inside a gesture's transient activation the write is permitted. On
    // failure the copy is simply dropped (the hint was already shown); a later
    // `/copy` re-queues.
    return write(text)
      .catch(() => {})
      .finally(() => hooks.onDone?.())
  }

  return {
    writeText,
    readText: async () => read(),
    gesture,
    pending: () => queued,
  }
}
