import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { installTerminalClipboard } from './terminalClipboard'

class ClipboardEventFixture extends Event {
  readonly clipboardData: { types: string[]; getData: (type: string) => string; setData: (type: string, text: string) => void }
  constructor(type: 'copy' | 'paste', data: Record<string, string>) {
    super(type, { cancelable: true })
    this.clipboardData = { types: Object.keys(data), getData: (type) => data[type] ?? '', setData: (type, text) => { data[type] = text } }
  }
}

const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.restoreAllMocks() })
async function fixture(isPi: () => boolean = () => true) {
  Object.assign(globalThis, { self: globalThis })
  const { Terminal } = await import('@xterm/xterm')
  const term = new Terminal({ cols: 20, rows: 4, allowProposedApi: true })
  const host = new EventTarget()
  const clipboard = installTerminalClipboard(term, host as HTMLElement, isPi)
  const sent: string[] = []
  term.onData((text) => sent.push(text))
  cleanup.push(() => { clipboard.dispose(); term.dispose() })
  return { term, host, clipboard, sent }
}

// Selection needs a real DOM, covered by verify-terminal-clipboard.cjs. Only
// stub that DOM-owned boundary here; paste input uses the installed real xterm.
function selection(term: Terminal, text: string): void {
  vi.spyOn(term, 'getSelection').mockReturnValue(text)
  vi.spyOn(term, 'hasSelection').mockReturnValue(text.length > 0)
}

describe('terminal clipboard policy', () => {
  it.each([
    ['LF', '  one   \n \t \n\t  two  words \t\n', '  one\n\n\t  two  words\n'],
    ['CRLF', 'one  \r\n   \r\n    two  \r\n', 'one\r\n\r\n    two\r\n'],
    ['unicode', '  漢字 ❤️  é   \n', '  漢字 ❤️  é\n'],
    ['partial line', 'word  other', 'word  other'],
  ])('cleans Pi padding without altering content: %s', async (_name, input, expected) => {
    const { term, host, clipboard } = await fixture()
    selection(term, input)
    expect(clipboard.copySelection()).toBe(expected)
    const data = { 'text/plain': '' }
    const event = new ClipboardEventFixture('copy', data)
    host.dispatchEvent(event)
    expect(data['text/plain']).toBe(expected)
    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves non-Pi and empty selections to the native copy handler', async () => {
    let pi = false
    const { term, host, clipboard } = await fixture(() => pi)
    selection(term, '  keep   \n  ')
    expect(clipboard.copySelection()).toBe('  keep   \n  ')
    const event = new ClipboardEventFixture('copy', {})
    host.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    pi = true
    vi.restoreAllMocks()
    selection(term, '')
    const empty = new ClipboardEventFixture('copy', {})
    host.dispatchEvent(empty)
    expect(empty.defaultPrevented).toBe(false)
  })

  it('frames CRLF, LF and CR paste once through real xterm onData, not raw typing', async () => {
    const { term, clipboard, sent } = await fixture()
    clipboard.paste('one\r\n  two\n\n漢字\rthree\n')
    term.input('\r', true)
    expect(sent).toEqual(['\x1b[200~one\r  two\r\r漢字\rthree\r\x1b[201~', '\r'])
  })

  it('handles native text paste once and removes listeners on dispose', async () => {
    const { host, clipboard, sent } = await fixture()
    const paste = new ClipboardEventFixture('paste', { 'text/plain': 'a\nb' })
    host.dispatchEvent(paste)
    expect(paste.defaultPrevented).toBe(true)
    expect(sent).toEqual(['\x1b[200~a\rb\x1b[201~'])
    clipboard.dispose()
    const after = new ClipboardEventFixture('paste', { 'text/plain': 'c\nd' })
    host.dispatchEvent(after)
    expect(after.defaultPrevented).toBe(false)
    expect(sent).toHaveLength(1)
  })

  it('does not take over file-only clipboard events', async () => {
    const { host, sent } = await fixture()
    const event = new ClipboardEventFixture('paste', { 'image/png': 'not text' })
    host.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(sent).toEqual([])
  })
})
