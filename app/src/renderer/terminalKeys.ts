const META_ENTER = '\x1b\r'
const SHIFT_ENTER_CSI_U = '\x1b[13;2u'
const SHIFT_ENTER_MODIFY_OTHER_KEYS = '\x1b[27;2;13~'

export type KeyboardInputMode = 'legacy' | 'kitty' | 'modifyOtherKeys'

/**
 * Tracks only the terminal output sequences that change how modified keys must
 * be encoded. This is deliberately not a terminal emulator: it is a bounded
 * streaming recognizer for Kitty keyboard mode and xterm modifyOtherKeys.
 *
 * The stream can split an escape sequence across daemon Data frames, so the
 * candidate survives feed() calls. All ordinary output takes the zero-allocation
 * fast path and malformed candidates are capped.
 */
export class KeyboardInputModeTracker {
  private candidate = ''
  private kitty = false
  private modifyOtherKeys = false

  get current(): KeyboardInputMode {
    if (this.modifyOtherKeys) return 'modifyOtherKeys'
    return this.kitty ? 'kitty' : 'legacy'
  }

  reset(): void {
    this.candidate = ''
    this.kitty = false
    this.modifyOtherKeys = false
  }

  feed(data: Uint8Array): void {
    for (const byte of data) {
      if (!this.candidate) {
        if (byte === 0x1b) this.candidate = '\x1b'
        continue
      }
      this.candidate += String.fromCharCode(byte)
      if (this.applyComplete(this.candidate)) {
        this.candidate = ''
      } else if (!this.isPrefix(this.candidate) || this.candidate.length > 32) {
        this.candidate = byte === 0x1b ? '\x1b' : ''
      }
    }
  }

  private applyComplete(sequence: string): boolean {
    if (/^\x1b\[>\d+u$/.test(sequence)) {
      this.kitty = true
      return true
    }
    if (sequence === '\x1b[<u') {
      this.kitty = false
      return true
    }
    if (sequence === '\x1b[>4;2m') {
      this.modifyOtherKeys = true
      return true
    }
    if (sequence === '\x1b[>4;0m') {
      this.modifyOtherKeys = false
      return true
    }
    return false
  }

  private isPrefix(sequence: string): boolean {
    return sequence === '\x1b'
      || sequence === '\x1b['
      || sequence === '\x1b[>'
      || sequence === '\x1b[<'
      || /^\x1b\[>\d+$/.test(sequence)
      || /^\x1b\[>4;[02]?$/.test(sequence)
  }
}

/**
 * Encode the browser's Shift+Enter event for the program running in the pty.
 *
 * A supervised Pi pane is known statically. A Pi process can also be launched
 * from an ordinary shell pane, so the live terminal keyboard mode takes
 * precedence when the application negotiates Kitty or modifyOtherKeys.
 * Programs that negotiate neither retain Amber's Meta+Enter fallback used by
 * Claude Code.
 */
export function shiftEnterSequence(kind: string, mode: KeyboardInputMode = 'legacy'): string {
  if (mode === 'modifyOtherKeys') return SHIFT_ENTER_MODIFY_OTHER_KEYS
  if (mode === 'kitty' || kind === 'pi') return SHIFT_ENTER_CSI_U
  return META_ENTER
}
