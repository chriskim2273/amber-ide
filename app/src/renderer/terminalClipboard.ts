import type { Terminal } from '@xterm/xterm'

/** Share clipboard policy between Amber's copy/paste actions and native browser
 * events (Cmd+C/V, browser menus and Electron edit roles). Only Pi selections
 * lose trailing row padding; indentation, interior spacing and newlines survive.
 * OSC 52 carries application-owned text and deliberately does not use this path.
 */
export function installTerminalClipboard(term: Terminal, host: HTMLElement, isPi: () => boolean): {
  copySelection(): string
  paste(text: string): void
  dispose(): void
} {
  const copySelection = (): string => {
    const text = term.getSelection()
    // xterm trims unwritten cells, NOT the literal spaces Pi paints to fill rows.
    return isPi() ? text.replace(/[ \t]+(?=\r?$)/gm, '') : text
  }
  const paste = (text: string): void => {
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
  const onCopy = (event: ClipboardEvent): void => {
    if (!isPi() || !term.hasSelection() || !event.clipboardData) return
    event.clipboardData.setData('text/plain', copySelection())
    event.preventDefault()
    event.stopImmediatePropagation() // don't let xterm overwrite the cleaned text
  }
  const onPaste = (event: ClipboardEvent): void => {
    if (!isPi() || !event.clipboardData?.types.includes('text/plain')) return
    const text = event.clipboardData.getData('text/plain')
    event.preventDefault()
    event.stopImmediatePropagation() // xterm's own listener must not send it twice
    paste(text)
  }
  host.addEventListener('copy', onCopy, true)
  host.addEventListener('paste', onPaste, true)
  return {
    copySelection,
    paste,
    dispose: () => {
      host.removeEventListener('copy', onCopy, { capture: true })
      host.removeEventListener('paste', onPaste, { capture: true })
    },
  }
}
