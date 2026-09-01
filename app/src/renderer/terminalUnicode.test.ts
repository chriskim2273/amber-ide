import { describe, expect, it } from 'vitest'
import { installTerminalUnicode } from './terminalUnicode'

describe('installTerminalUnicode', () => {
  it('treats emoji-presentation graphemes as wide like modern TUIs do', async () => {
    // xterm's browser bundle references `self` while loading. The renderer has
    // it naturally; the node test environment needs the equivalent alias.
    Object.assign(globalThis, { self: globalThis })
    const { Terminal } = await import('@xterm/xterm')
    const term = new Terminal({ cols: 20, rows: 2, allowProposedApi: true })

    installTerminalUnicode(term)
    await new Promise<void>((resolve) => term.write('❤️X', resolve))

    expect(term.unicode.activeVersion).toBe('15-graphemes')
    expect(term.buffer.active.cursorX).toBe(3)
    expect(term.buffer.active.getLine(0)?.getCell(0)?.getWidth()).toBe(2)
    expect(term.buffer.active.getLine(0)?.getCell(2)?.getChars()).toBe('X')

    // OpenTUI redraws only changed runs at absolute columns. Seed the row with
    // old content, then reproduce a redraw that assumes ❤️ occupies two cells.
    // Under xterm's default Unicode 6 provider the second `e` survives between
    // the heart and space; modern grapheme widths overwrite both old cells.
    term.reset()
    await new Promise<void>((resolve) => term.write('eee\r❤️\x1b[3G X', resolve))
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('❤️ X')
    term.dispose()
  })
})
