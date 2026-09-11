import { describe, expect, it, beforeAll } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { settleReplayedModes } from './terminalModes'

/** xterm's browser bundle references `self` while loading (see terminalUnicode.test.ts). */
beforeAll(() => {
  Object.assign(globalThis, { self: globalThis })
})

async function terminal(): Promise<Terminal> {
  const { Terminal } = await import('@xterm/xterm')
  return new Terminal({ cols: 40, rows: 6, allowProposedApi: true })
}

async function write(term: Terminal, data: string | Uint8Array): Promise<void> {
  await new Promise<void>((resolve) => term.write(data, resolve))
}

/** xterm parses writes asynchronously: settle the queue before reading modes. */
async function drain(term: Terminal): Promise<void> {
  await write(term, '')
}

/** What the daemon prepends to a FULL replay of a live Pi pane: the modes the
 *  tracker saw Pi assert once, at TUI start (see amber_core::modes). */
const PI_PREAMBLE = '\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h\x1b[?25l'
/** A frame from that TUI's retained ring: cursor addressing, no mode bytes. */
const PI_FRAME = '\x1b[3;1H\x1b[2K\u276f ready'

describe('settleReplayedModes', () => {
  it('keeps a live full-screen app\'s mouse protocol, so the wheel reaches the app', async () => {
    // The reported failure: after a reload the pane scrolled the INPUT HISTORY
    // (up/down arrows) instead of the conversation. xterm only forwards wheel
    // events while a mouse protocol is active; with none it converts them to
    // arrows in a buffer that has no scrollback — exactly the alt buffer Pi
    // paints into.
    const term = await terminal()
    await write(term, PI_PREAMBLE + PI_FRAME)

    settleReplayedModes(term)
    await drain(term)

    expect(term.buffer.active.type).toBe('alternate')
    expect(term.modes.mouseTrackingMode).toBe('any')
    expect(term.modes.bracketedPasteMode).toBe(false) // Pi asserts 2004 later, in its first frame
    term.dispose()
  })

  it('restores bracketed paste too when the app had enabled it', async () => {
    const term = await terminal()
    await write(term, PI_PREAMBLE + '\x1b[?2004h' + PI_FRAME)

    settleReplayedModes(term)
    await drain(term)

    expect(term.modes.mouseTrackingMode).toBe('any')
    expect(term.modes.bracketedPasteMode).toBe(true)
    term.dispose()
  })

  it('a synchronous read of the buffer is pre-replay, which is why the settle must be a write callback', async () => {
    // The trap this pins: xterm parses `write()` asynchronously, so reading
    // `term.buffer.active` immediately after queuing a replay still reports the
    // OLD buffer. The packaged-app fixture caught exactly this — an inline
    // settlement saw "normal" and cleared the protocol the replay had just
    // queued, so the wheel kept producing arrow keys.
    const term = await terminal()
    term.write(PI_PREAMBLE)
    expect(term.buffer.active.type).toBe('normal')
    await drain(term)
    expect(term.buffer.active.type).toBe('alternate')
    term.dispose()
  })

  it('clears a stale mouse mode when no full-screen app owns the screen', async () => {
    // History replayed into a shell: an exited TUI's enable is re-executed, and
    // the shell would then echo encoded reports on every pointer move.
    const term = await terminal()
    await write(term, 'user@host:~$ echo hi\r\n\x1b[?1000h\x1b[?1002h\x1b[?1006h')

    settleReplayedModes(term)
    await drain(term)

    expect(term.buffer.active.type).toBe('normal')
    expect(term.modes.mouseTrackingMode).toBe('none')
    term.dispose()
  })

  it('leaves a live app that disabled mouse reporting alone', async () => {
    // `less` runs in the alt screen with no mouse protocol: nothing to clear,
    // and the alt screen must stay active.
    const term = await terminal()
    await write(term, '\x1b[?1049h' + 'file contents')

    settleReplayedModes(term)
    await drain(term)

    expect(term.buffer.active.type).toBe('alternate')
    expect(term.modes.mouseTrackingMode).toBe('none')
    term.dispose()
  })
})
