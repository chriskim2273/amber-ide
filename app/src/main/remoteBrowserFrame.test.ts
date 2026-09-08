import { describe, expect, it, vi } from 'vitest'
import { encodeRemoteFrame, remoteFrameSize, remoteSurfaceOptions } from './remoteBrowserFrame'

function fakeImage(width: number, height: number, jpegBytes: number, pngBytes = jpegBytes): Parameters<typeof encodeRemoteFrame>[0] {
  const jpeg = Buffer.alloc(Math.max(8, jpegBytes), 1)
  const png = Buffer.alloc(Math.max(8, pngBytes), 2)
  const image = {
    isEmpty: () => width < 1 || height < 1,
    getSize: () => ({ width, height }),
    resize: vi.fn((opts: { width: number; height: number }) => fakeImage(opts.width, opts.height, jpegBytes, pngBytes)),
    toJPEG: vi.fn(() => jpeg),
    toPNG: vi.fn(() => png),
  }
  return image
}

describe('remote browser frames', () => {
  it('scales a full-window capture down to a rail-sized JPEG', () => {
    expect(remoteFrameSize(1600, 1000)).toEqual({ width: 900, height: 563 })
    const image = fakeImage(1600, 1000, 12_000)
    const encoded = encodeRemoteFrame(image)
    expect(encoded).toMatchObject({ mediaType: 'image/jpeg', width: 900, height: 563 })
    expect(encoded?.data.length).toBe(12_000)
    expect(image.resize).toHaveBeenCalledWith({ width: 900, height: 563, quality: 'better' })
  })

  it('keeps an already-small frame and does not spawn a visible compositor', () => {
    expect(remoteFrameSize(420, 600)).toEqual({ width: 420, height: 600 })
    expect(encodeRemoteFrame(fakeImage(420, 600, 4000))).toMatchObject({ mediaType: 'image/jpeg', width: 420, height: 600 })
    expect(remoteSurfaceOptions(420, 600)).toMatchObject({ show: false, skipTaskbar: true, paintWhenInitiallyHidden: true, width: 420, height: 600 })
  })
})
