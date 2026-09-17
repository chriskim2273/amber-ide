import type { Terminal } from '@xterm/xterm'

/** Largest image accepted for remote paste. Mirrors the server's 16 MiB cap —
 * the server re-checks; this just avoids uploading obviously bad files. */
export const IMAGE_PASTE_MAX_BYTES = 16 * 1024 * 1024

export interface TerminalClipboardOptions {
  isPi: () => boolean
  /** Whether this terminal can currently receive a pasted file path.
   * False disables image handling (for example, while suspended). */
  isImagePasteTarget?: () => boolean
  /** Upload one image, resolve its host path. Absent on desktop, where Ctrl-V
   * reaches the agent natively and the agent reads the host clipboard. */
  pasteImage?: (file: File) => Promise<string>
  /** Send raw bytes to the pty — the `^V` fallback when a clipboard read
   * fails or is denied, preserving the key's native meaning. */
  sendRaw?: (data: string) => void
  /** Desktop text bridge; web uses navigator.clipboard for images and text. */
  readText?: () => Promise<string>
  onError?: (message: string) => void
}

// Array-likes, not FileList/DataTransferItemList: the real DataTransfer
// satisfies this structurally, and tests pass plain arrays.
type ClipboardDataLike = {
  files?: ArrayLike<File> | null
  items?: ArrayLike<DataTransferItem> | null
  types: readonly string[]
  getData(type: string): string
}

/** First pasted image file, if any. Accepts an empty MIME type (the server
 * validates magic); rejects declared non-images and out-of-range sizes
 * without an upload. Checks `files` first, then `items` for browsers that
 * expose pasted images only there. */
export function firstImageFile(data: ClipboardDataLike | null | undefined): File | null {
  if (!data) return null
  for (const file of Array.from(data.files ?? [])) {
    if ((!file.type || file.type.startsWith('image/'))
      && file.size >= 1 && file.size <= IMAGE_PASTE_MAX_BYTES) return file
  }
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file' || (item.type && !item.type.startsWith('image/'))) continue
    const file = item.getAsFile()
    if (file && file.size >= 1 && file.size <= IMAGE_PASTE_MAX_BYTES) return file
  }
  return null
}

/** Share clipboard policy between Amber's copy/paste actions and native browser
 * events (Cmd+C/V, browser menus and Electron edit roles). Only Pi selections
 * lose trailing row padding; indentation, interior spacing and newlines survive.
 * OSC 52 carries application-owned text and deliberately does not use this path.
 *
 * Remote image paste (web build only, `pasteImage` set): an image in a paste
 * event — or under Ctrl-V, read via `navigator.clipboard.read()` — uploads to
 * the host and its returned path pastes as text, honoring bracketed paste.
 * Agents may attach it; shells receive a path without Enter. Failures fall back to the
 * previous behavior (text paste, else a native `^V` for the key path).
 */
export function installTerminalClipboard(term: Terminal, host: HTMLElement, opts: TerminalClipboardOptions): {
  copySelection(): string
  paste(text: string): void
  /** Ctrl-V interception for remote image paste. True when consumed — the
   * caller must preventDefault and return false to xterm (which would
   * otherwise forward a bare `^V` the host clipboard cannot satisfy). */
  handleKeyDown(event: KeyboardEvent): boolean
  pasteClipboard(): Promise<void>
  dispose(): void
} {
  const { isPi, isImagePasteTarget, pasteImage, sendRaw } = opts
  let disposed = false
  const reportError = (error: unknown): void => {
    if (!disposed) opts.onError?.(`Paste failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const copySelection = (): string => {
    const text = term.getSelection()
    // xterm trims unwritten cells, NOT the literal spaces Pi paints to fill rows.
    return isPi() ? text.replace(/[ \t]+(?=\r?$)/gm, '') : text
  }
  const paste = (text: string): void => {
    if (disposed) return
    if (isPi() && !term.modes.bracketedPasteMode) {
      // Pi enables DECSET 2004 once, at startup. A cold/reconnected renderer may
      // never see it after the daemon's capped raw backlog evicts those bytes.
      // Pi's editor still understands paste markers. Frame at the gesture, not
      // by mutating xterm modes or guessing where a raw onData chunk came from.
      // input(..., true) keeps xterm's user-input/selection/scroll side effects
      // and emits through the SAME onData → MessagePort path as term.paste().
      term.input('\x1b[200~' + text.replace(/\r?\n/g, '\r') + '\x1b[201~', true)
      if (term.textarea) term.textarea.value = ''
    } else {
      term.paste(text)
    }
  }
  /** Upload one image file and paste its host path; on failure paste any
   * accompanying text instead so a failed upload never eats a text paste. */
  const pasteImageFile = (file: File, textFallback: string | null): void => {
    if (!pasteImage) return
    void pasteImage(file).then((path) => {
      if (!disposed && isImagePasteTarget?.()) paste(path)
    }).catch((error: unknown) => {
      reportError(error)
      if (textFallback && isImagePasteTarget?.()) paste(textFallback)
    })
  }
  const onCopy = (event: ClipboardEvent): void => {
    if (!isPi() || !term.hasSelection() || !event.clipboardData) return
    event.clipboardData.setData('text/plain', copySelection())
    event.preventDefault()
    event.stopImmediatePropagation() // don't let xterm overwrite the cleaned text
  }
  const onPaste = (event: ClipboardEvent): void => {
    const data = event.clipboardData as ClipboardDataLike | null
    if (isImagePasteTarget?.() && pasteImage) {
      const image = firstImageFile(data)
      if (image) {
        event.preventDefault()
        event.stopImmediatePropagation() // xterm would read text/plain (empty) and send bare markers
        pasteImageFile(image, data?.types.includes('text/plain') ? data.getData('text/plain') : null)
        return
      }
      const hasImage = Array.from(data?.files ?? []).some((file) => !file.type || file.type.startsWith('image/'))
        || Array.from(data?.items ?? []).some((item) => item.kind === 'file' && (!item.type || item.type.startsWith('image/')))
      if (hasImage) {
        event.preventDefault()
        event.stopImmediatePropagation()
        reportError(new Error('image must be non-empty and at most 16 MiB'))
        const text = data?.getData('text/plain')
        if (text) paste(text)
        return
      }
    }
    if (!isPi() || !event.clipboardData?.types.includes('text/plain')) return
    const text = event.clipboardData.getData('text/plain')
    event.preventDefault()
    event.stopImmediatePropagation() // xterm's own listener must not send it twice
    paste(text)
  }
  /** Shared app/menu entry point. Native Cmd-V stays a paste event, which
   * carries images without requiring navigator.clipboard.read permission. */
  const pasteClipboard = async (): Promise<void> => {
    try {
      const clipboard = globalThis.navigator?.clipboard
      if (isImagePasteTarget?.() && pasteImage && clipboard?.read) {
        // Some browsers permit text reads but deny the richer image API.
        // Only read denial falls back; an upload failure must remain visible.
        const items = await clipboard.read().catch(() => [])
        for (const item of items) {
          const imageType = item.types.find((type) => type.startsWith('image/'))
          if (!imageType) continue
          const blob = await item.getType(imageType)
          if (!isImagePasteTarget() || disposed) return
          if (blob.size < 1 || blob.size > IMAGE_PASTE_MAX_BYTES) throw new Error('image size out of range')
          const path = await pasteImage(new File([blob], 'paste', { type: imageType }))
          if (isImagePasteTarget() && !disposed) paste(path)
          return
        }
      }
      const text = await (opts.readText ? opts.readText() : clipboard?.readText())
      if (text) paste(text)
    } catch (error) {
      reportError(error)
    }
  }
  /** Plain Ctrl-V (no Shift/Alt/Meta): xterm forwards it as `^V` and swallows
   * the browser paste, so the agent would read the HOST clipboard — which has
   * no image on a remote browser. Read the REMOTE clipboard instead: image →
   * upload + paste path, text → paste text, anything else → native `^V`. */
  const handleKeyDown = (event: KeyboardEvent): boolean => {
    if (event.type !== 'keydown' || !isImagePasteTarget?.() || !pasteImage) return false
    if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return false
    if (event.key !== 'v' && event.key !== 'V') return false
    void (async (): Promise<void> => {
      try {
        const clipboard = globalThis.navigator?.clipboard as (Clipboard & {
          read?: () => Promise<ClipboardItem[]>
        }) | undefined
        if (!clipboard?.read) throw new Error('clipboard read unavailable')
        for (const item of await clipboard.read()) {
          const imageType = item.types.find((t) => t.startsWith('image/'))
          if (!imageType) continue
          const blob = await item.getType(imageType)
          const file = new File([blob], 'paste', { type: imageType })
          if (file.size < 1 || file.size > IMAGE_PASTE_MAX_BYTES) throw new Error('image size out of range')
          if (disposed || !isImagePasteTarget()) return
          const path = await pasteImage(file)
          if (!disposed && isImagePasteTarget()) paste(path)
          return
        }
        const text = await clipboard.readText().catch(() => '')
        if (text) {
          paste(text)
          return
        }
      } catch (error) {
        reportError(error)
      }
      if (!disposed && isImagePasteTarget?.()) sendRaw?.('\x16')
    })()
    return true
  }
  host.addEventListener('copy', onCopy, true)
  host.addEventListener('paste', onPaste, true)
  return {
    copySelection,
    paste,
    handleKeyDown,
    pasteClipboard,
    dispose: () => {
      disposed = true
      host.removeEventListener('copy', onCopy, { capture: true })
      host.removeEventListener('paste', onPaste, { capture: true })
    },
  }
}
