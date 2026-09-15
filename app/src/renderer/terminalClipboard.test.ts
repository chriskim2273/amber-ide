import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { firstImageFile, installTerminalClipboard, IMAGE_PASTE_MAX_BYTES, type TerminalClipboardOptions } from './terminalClipboard'

class ClipboardEventFixture extends Event {
  readonly clipboardData: {
    types: string[]
    files: File[]
    items: DataTransferItem[]
    getData: (type: string) => string
    setData: (type: string, text: string) => void
  }
  constructor(type: 'copy' | 'paste', data: Record<string, string>, files: File[] = [], items: DataTransferItem[] = []) {
    super(type, { cancelable: true })
    this.clipboardData = {
      types: [...Object.keys(data), ...files.map((f) => f.type || 'Files')],
      files,
      items,
      getData: (type) => data[type] ?? '',
      setData: (type, text) => { data[type] = text },
    }
  }
}

const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function fixture(opts: Partial<TerminalClipboardOptions> & { isPi?: () => boolean } = {}) {
  Object.assign(globalThis, { self: globalThis })
  const { Terminal } = await import('@xterm/xterm')
  const term = new Terminal({ cols: 40, rows: 4, allowProposedApi: true })
  const host = new EventTarget()
  const { isPi = () => true, ...rest } = opts
  const clipboard = installTerminalClipboard(term, host as HTMLElement, { isPi, ...rest })
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

function pngFile(name = 'paste.png', size = 100): File {
  return new File([new Uint8Array(size)], name, { type: 'image/png' })
}

// Node has no KeyboardEvent (keys.test.ts fakes keys the same way); the
// handler only reads these fields.
function keyEvent(init: { key: string; type?: string; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean }): KeyboardEvent {
  return { type: 'keydown', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...init } as KeyboardEvent
}

/** Flush the promise chain behind an async paste (upload → onData). */
async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve()
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
    const { term, host, clipboard } = await fixture({ isPi: () => pi })
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

  it('does not take over file-only clipboard events without an upload path', async () => {
    const { host, sent } = await fixture()
    const event = new ClipboardEventFixture('paste', { 'image/png': 'not text' })
    host.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(sent).toEqual([])
  })
})

describe('firstImageFile', () => {
  const dataOf = (files: File[], items: DataTransferItem[] = []) => ({
    files, items, types: [] as string[], getData: () => '',
  })

  it('takes the first in-range image file', () => {
    const image = pngFile()
    expect(firstImageFile(dataOf([new File(['x'], 'a.txt', { type: 'text/plain' }), image]))).toBe(image)
  })

  it('accepts an empty MIME type (the server validates magic)', () => {
    const unknown = new File([new Uint8Array(10)], 'blob', { type: '' })
    expect(firstImageFile(dataOf([unknown]))).toBe(unknown)
  })

  it('rejects declared non-images, empty and oversize files', () => {
    expect(firstImageFile(dataOf([new File(['x'], 'a.pdf', { type: 'application/pdf' })]))).toBeNull()
    expect(firstImageFile(dataOf([new File([], 'empty.png', { type: 'image/png' })]))).toBeNull()
    const big = { size: IMAGE_PASTE_MAX_BYTES + 1, type: 'image/png' } as File
    expect(firstImageFile(dataOf([big]))).toBeNull()
    expect(firstImageFile(dataOf([]))).toBeNull()
    expect(firstImageFile(null)).toBeNull()
  })

  it('falls back to items when files is empty', () => {
    const image = pngFile()
    const item = { kind: 'file', type: 'image/png', getAsFile: () => image } as DataTransferItem
    expect(firstImageFile(dataOf([], [item]))).toBe(image)
    const textItem = { kind: 'string', type: 'text/plain', getAsFile: () => null } as unknown as DataTransferItem
    expect(firstImageFile(dataOf([], [textItem]))).toBeNull()
  })
})

describe('remote image paste', () => {
  // `term.paste()` (the non-Pi path) touches the helper textarea, which only
  // exists on an opened terminal — there is no DOM here. Pi-mode tests below
  // run the FULL onData flow through real xterm (Pi frames the paste itself);
  // the non-Pi test asserts our code hands the path to `term.paste`, whose
  // onData emission is xterm's own tested behavior (plus the real-Electron
  // regression pass this repo runs for clipboard changes).
  it('uploads a pasted image and pastes its host path bracketed (Pi onData)', async () => {
    const seen: File[] = []
    const pasteImage = vi.fn(async (file: File) => { seen.push(file); return '/tmp/amber-clip-abc123.png' })
    const { host, clipboard, sent } = await fixture({
      isImagePasteTarget: () => true,
      pasteImage,
    })
    const event = new ClipboardEventFixture('paste', {}, [pngFile()])
    host.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await settle()
    expect(pasteImage).toHaveBeenCalledOnce()
    expect(seen[0]).toBeInstanceOf(File)
    expect(sent).toEqual(['\x1b[200~/tmp/amber-clip-abc123.png\x1b[201~'])
    clipboard.dispose()
  })

  it('hands the uploaded path to term.paste off-Pi', async () => {
    const pasteImage = vi.fn(async () => '/tmp/amber-clip-claude.png')
    const { term, host } = await fixture({
      isPi: () => false,
      isImagePasteTarget: () => true,
      pasteImage,
    })
    const pasted: string[] = []
    vi.spyOn(term, 'paste').mockImplementation((text: string) => { pasted.push(text) })
    host.dispatchEvent(new ClipboardEventFixture('paste', {}, [pngFile()]))
    await settle()
    expect(pasteImage).toHaveBeenCalledOnce()
    expect(pasted).toEqual(['/tmp/amber-clip-claude.png'])
  })

  it('falls back to accompanying text when the upload fails', async () => {
    const pasteImage = vi.fn(async (): Promise<string> => { throw new Error('HTTP 500') })
    const { host, sent } = await fixture({
      isImagePasteTarget: () => true,
      pasteImage,
    })
    const event = new ClipboardEventFixture('paste', { 'text/plain': 'fallback text' }, [pngFile()])
    host.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await settle()
    expect(sent).toEqual(['\x1b[200~fallback text\x1b[201~'])
  })

  it('leaves image pastes alone off-target or without an upload path', async () => {
    const pasteImage = vi.fn(async () => '/tmp/x.png')
    for (const opts of [
      { isImagePasteTarget: () => false, pasteImage },
      { isImagePasteTarget: () => true },
      {},
    ] as const) {
      const { host, sent } = await fixture({ isPi: () => false, ...opts })
      const event = new ClipboardEventFixture('paste', {}, [pngFile()])
      host.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
      expect(sent).toEqual([])
    }
    expect(pasteImage).not.toHaveBeenCalled()
  })

  it('consumes Ctrl-V on target panes and pastes the uploaded path', async () => {
    const blob = new Blob([new Uint8Array(50)], { type: 'image/png' })
    const read = vi.fn(async () => [{ types: ['image/png'], getType: async () => blob }])
    vi.stubGlobal('navigator', { clipboard: { read, readText: async () => '' } })
    const pasteImage = vi.fn(async () => '/tmp/amber-clip-ctrlv.png')
    const sendRaw = vi.fn()
    const { clipboard, sent } = await fixture({
      isImagePasteTarget: () => true,
      pasteImage,
      sendRaw,
    })
    expect(clipboard.handleKeyDown(keyEvent({ key: 'v', ctrlKey: true }))).toBe(true)
    await settle()
    expect(pasteImage).toHaveBeenCalledOnce()
    expect(sent).toEqual(['\x1b[200~/tmp/amber-clip-ctrlv.png\x1b[201~'])
    expect(sendRaw).not.toHaveBeenCalled()
  })

  it('pastes clipboard text on Ctrl-V when no image is present', async () => {
    vi.stubGlobal('navigator', { clipboard: { read: async () => [], readText: async () => 'hello' } })
    const pasteImage = vi.fn(async () => '/tmp/x.png')
    const sendRaw = vi.fn()
    const { clipboard, sent } = await fixture({
      isImagePasteTarget: () => true,
      pasteImage,
      sendRaw,
    })
    expect(clipboard.handleKeyDown(keyEvent({ key: 'v', ctrlKey: true }))).toBe(true)
    await settle()
    expect(pasteImage).not.toHaveBeenCalled()
    expect(sent).toEqual(['\x1b[200~hello\x1b[201~'])
    expect(sendRaw).not.toHaveBeenCalled()
  })

  it.each([
    ['denied clipboard read falls back to native ^V', { read: async () => { throw new DOMException('denied', 'NotAllowedError') }, readText: async () => '' }],
    ['missing clipboard API falls back to native ^V', undefined],
  ])('%s', async (_name, clip) => {
    vi.stubGlobal('navigator', clip === undefined ? {} : { clipboard: clip })
    const pasteImage = vi.fn(async () => '/tmp/x.png')
    const sendRaw = vi.fn()
    const { clipboard, sent } = await fixture({
      isPi: () => false,
      isImagePasteTarget: () => true,
      pasteImage,
      sendRaw,
    })
    expect(clipboard.handleKeyDown(keyEvent({ key: 'v', ctrlKey: true }))).toBe(true)
    await settle()
    expect(pasteImage).not.toHaveBeenCalled()
    expect(sent).toEqual([])
    expect(sendRaw).toHaveBeenCalledWith('\x16')
  })

  it('ignores non-Ctrl-V keys, shifted chords and non-keydown events', async () => {
    const { clipboard } = await fixture({
      isPi: () => false,
      isImagePasteTarget: () => true,
      pasteImage: async () => '/tmp/x.png',
    })
    expect(clipboard.handleKeyDown(keyEvent({ key: 'c', ctrlKey: true }))).toBe(false)
    expect(clipboard.handleKeyDown(keyEvent({ key: 'v', ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(clipboard.handleKeyDown(keyEvent({ key: 'v', metaKey: true }))).toBe(false)
    expect(clipboard.handleKeyDown(keyEvent({ key: 'v', ctrlKey: true, type: 'keypress' }))).toBe(false)
    expect(clipboard.handleKeyDown(keyEvent({ key: 'v' }))).toBe(false)
  })

  it('ignores Ctrl-V off-target or without an upload path', async () => {
    const onTarget = await fixture({ isPi: () => false, isImagePasteTarget: () => true })
    expect(onTarget.clipboard.handleKeyDown(keyEvent({ key: 'v', ctrlKey: true }))).toBe(false)
    const offTarget = await fixture({
      isPi: () => false,
      isImagePasteTarget: () => false,
      pasteImage: async () => '/tmp/x.png',
    })
    expect(offTarget.clipboard.handleKeyDown(keyEvent({ key: 'v', ctrlKey: true }))).toBe(false)
  })
})
