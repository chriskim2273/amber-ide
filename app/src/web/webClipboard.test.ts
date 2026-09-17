import { describe, it, expect, vi } from 'vitest'
import { createGestureClipboard } from './webClipboard'

describe('createGestureClipboard', () => {
  it('writes directly when the native write resolves (Chrome)', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    const cb = createGestureClipboard(write, async () => '')
    await cb.writeText('hello')
    expect(write).toHaveBeenCalledOnce()
    expect(write).toHaveBeenCalledWith('hello')
    expect(cb.pending()).toBeNull()
  })

  it('queues the copy on a gesture-less rejection (Safari/Firefox) and finishes on the next gesture', async () => {
    const write = vi.fn()
      .mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'))
      .mockResolvedValueOnce(undefined)
    const onQueued = vi.fn()
    const onDone = vi.fn()
    const cb = createGestureClipboard(write, async () => '', { onQueued, onDone })

    // Gesture-less OSC 52 write is rejected → queued, hint shown, no throw.
    await cb.writeText('from-pi')
    expect(onQueued).toHaveBeenCalledOnce()
    expect(onQueued).toHaveBeenCalledWith('from-pi')
    expect(cb.pending()).toBe('from-pi')

    // A real user gesture retries it inside transient activation.
    await cb.gesture()
    expect(write).toHaveBeenCalledWith('from-pi')
    expect(cb.pending()).toBeNull()
    expect(onDone).toHaveBeenCalledOnce()
  })

  it('re-queues a newer copy over an older pending one', async () => {
    const write = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    const cb = createGestureClipboard(write, async () => '')
    await cb.writeText('first')
    await cb.writeText('second')
    expect(cb.pending()).toBe('second')
  })

  it('does nothing on gesture() when nothing is queued', () => {
    const write = vi.fn()
    const cb = createGestureClipboard(write, async () => '')
    cb.gesture()
    expect(write).not.toHaveBeenCalled()
  })

  it('retains a queued copy if the gesture write also fails, without claiming success', async () => {
    const write = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    const onDone = vi.fn()
    const cb = createGestureClipboard(write, async () => '', { onDone })
    await cb.writeText('x')
    await cb.gesture()
    expect(cb.pending()).toBe('x')
    expect(onDone).not.toHaveBeenCalled()
    write.mockResolvedValue(undefined)
    await cb.gesture()
    expect(cb.pending()).toBeNull()
    expect(onDone).toHaveBeenCalledOnce()
  })

  it('a successful newer copy clears an older pending copy', async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValue(undefined)
    const cb = createGestureClipboard(write, async () => '')
    await cb.writeText('old pane')
    await cb.writeText('new pane')
    await cb.gesture()
    expect(write.mock.calls.map(([text]) => text)).toEqual(['old pane', 'new pane'])
    expect(cb.pending()).toBeNull()
  })

  it('an older delayed rejection cannot replace a newer pending copy', async () => {
    let rejectOld!: (reason: Error) => void
    const write = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectOld = reject }))
      .mockRejectedValue(new Error('denied'))
    const cb = createGestureClipboard(write, async () => '')
    const old = cb.writeText('old pane')
    await cb.writeText('new pane')
    rejectOld(new Error('denied'))
    await old
    expect(cb.pending()).toBe('new pane')
  })

  it('passes readText through', async () => {
    const read = vi.fn().mockResolvedValue('clip')
    const cb = createGestureClipboard(async () => {}, read)
    await expect(cb.readText()).resolves.toBe('clip')
    expect(read).toHaveBeenCalledOnce()
  })
})
