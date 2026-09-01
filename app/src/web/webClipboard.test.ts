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

  it('drops a queued copy if the gesture write also fails, still hiding the hint', async () => {
    const write = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    const onDone = vi.fn()
    const cb = createGestureClipboard(write, async () => '', { onDone })
    await cb.writeText('x')
    await cb.gesture()
    expect(cb.pending()).toBeNull()
    expect(onDone).toHaveBeenCalledOnce()
  })

  it('passes readText through', async () => {
    const read = vi.fn().mockResolvedValue('clip')
    const cb = createGestureClipboard(async () => {}, read)
    await expect(cb.readText()).resolves.toBe('clip')
    expect(read).toHaveBeenCalledOnce()
  })
})
