import { describe, expect, it } from 'vitest'
import { attachmentError, attachmentsError, bytesToBase64, forEachAttachmentChunk } from './piAttachments'
import type { AttachmentLike } from './piAttachments'

describe('Pi attachment helpers', () => {
  it('encodes bytes as canonical padded base64', () => {
    expect(bytesToBase64(new Uint8Array())).toBe('')
    expect(bytesToBase64(new TextEncoder().encode('hello'))).toBe('aGVsbG8=')
    expect(bytesToBase64(new Uint8Array([0xff, 0x00, 0x01]))).toBe('/wAB')
  })

  it('reads actual bytes sequentially and reports only acknowledged offsets', async () => {
    const source = new Uint8Array(48 * 1024 + 3)
    source.forEach((_, index) => { source[index] = index % 251 })
    const file: AttachmentLike = {
      name: 'bytes.bin', type: 'application/octet-stream', size: source.length,
      slice: (start = 0, end = source.length) => new Blob([source.slice(start, end)]),
    }
    const offsets: number[] = []
    const progress: number[] = []
    await forEachAttachmentChunk(file, async (offset, data, byteLength) => {
      offsets.push(offset)
      expect(data.length).toBeGreaterThan(0)
      expect(byteLength).toBe(offset === 0 ? 48 * 1024 : 3)
    }, { onProgress: (acknowledged) => progress.push(acknowledged) })
    expect(offsets).toEqual([0, 48 * 1024])
    expect(progress).toEqual([48 * 1024, 48 * 1024 + 3])
  })

  it('rejects unsafe names, oversized files, and too many bytes', () => {
    const base = { name: 'photo.png', type: 'image/png', size: 3 }
    expect(attachmentError(base)).toBeNull()
    expect(attachmentError({ ...base, name: '../photo.png' })).toContain('path separators')
    expect(attachmentError({ ...base, name: `photo\u0080.png` })).toContain('path separators')
    expect(attachmentError({ ...base, size: 16 * 1024 * 1024 + 1 })).toContain('16 MiB')
    expect(attachmentsError(Array.from({ length: 9 }, (_, i) => ({ ...base, name: `${i}.png` })))).toContain('at most 8')
    expect(attachmentsError(Array.from({ length: 3 }, (_, i) => ({ ...base, name: `${i}.png`, size: 11 * 1024 * 1024 })))).toContain('32 MiB')
  })
})
