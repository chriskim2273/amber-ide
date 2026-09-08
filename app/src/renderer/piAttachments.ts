import {
  PI_ATTACHMENT_MAX_BYTES,
  PI_ATTACHMENTS_PER_PROMPT,
  PI_UPLOAD_CHUNK_MAX_BYTES,
} from '../shared/proto'

export interface AttachmentLike {
  name: string
  type: string
  size: number
  slice(start?: number, end?: number): Blob
}
export type AttachmentInfo = Pick<AttachmentLike, 'name' | 'type' | 'size'>

function isControl(char: string): boolean {
  const code = char.codePointAt(0)!
  return code < 0x20 || (code >= 0x7f && code <= 0x9f)
}

/** Validate one browser-selected file before an upload allocates any bytes. */
export function attachmentError(file: AttachmentInfo): string | null {
  if (!file.name || [...file.name].length > 255
    || [...file.name].some((char) => isControl(char) || char === '/' || char === '\\')) {
    return 'File names must be 1–255 characters without path separators.'
  }
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > PI_ATTACHMENT_MAX_BYTES) {
    return 'Each attachment must be 16 MiB or smaller.'
  }
  if (new TextEncoder().encode(file.type || 'application/octet-stream').length > 128) {
    return 'The attachment MIME type is too long.'
  }
  return null
}

/** Standard padded base64 without the argument-size limits of btoa/spread. */
export function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let result = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const hasB = i + 1 < bytes.length
    const hasC = i + 2 < bytes.length
    const b = hasB ? bytes[i + 1]! : 0
    const c = hasC ? bytes[i + 2]! : 0
    const value = (a << 16) | (b << 8) | c
    result += alphabet[(value >>> 18) & 63]!
      + alphabet[(value >>> 12) & 63]!
      + (hasB ? alphabet[(value >>> 6) & 63]! : '=')
      + (hasC ? alphabet[value & 63]! : '=')
  }
  return result
}

/** Read a File in bounded chunks; the caller controls command backpressure.
 * `onProgress` runs only after the caller has acknowledged the chunk. */
export async function forEachAttachmentChunk(
  file: AttachmentLike,
  onChunk: (offset: number, data: string, byteLength: number) => Promise<void>,
  options: { signal?: AbortSignal; onProgress?: (acknowledged: number) => void } = {},
): Promise<void> {
  let acknowledged = 0
  for (let offset = 0; offset < file.size; offset += PI_UPLOAD_CHUNK_MAX_BYTES) {
    if (options.signal?.aborted) throw new DOMException('Upload canceled', 'AbortError')
    const expected = Math.min(PI_UPLOAD_CHUNK_MAX_BYTES, file.size - offset)
    const bytes = new Uint8Array(await file.slice(offset, offset + expected).arrayBuffer())
    if (bytes.length === 0) throw new Error('attachment ended before its declared size')
    if (bytes.length > expected) throw new Error('attachment changed during upload')
    await onChunk(offset, bytesToBase64(bytes), bytes.length)
    acknowledged += bytes.length
    options.onProgress?.(acknowledged)
    if (bytes.length < expected) throw new Error('attachment ended before its declared size')
  }
  if (acknowledged !== file.size) throw new Error('attachment changed during upload')
}

export function newPiRequestId(prefix = 'ui'): string {
  try {
    return `${prefix}-${globalThis.crypto.randomUUID()}`
  } catch {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  }
}

export function attachmentsTotal(files: readonly AttachmentInfo[]): number {
  return files.reduce((total, file) => total + file.size, 0)
}

export function attachmentsError(files: readonly AttachmentInfo[]): string | null {
  if (files.length > PI_ATTACHMENTS_PER_PROMPT) return `Choose at most ${PI_ATTACHMENTS_PER_PROMPT} attachments.`
  for (const file of files) {
    const error = attachmentError(file)
    if (error) return `${file.name}: ${error}`
  }
  if (attachmentsTotal(files) > 32 * 1024 * 1024) return 'Attachments must total 32 MiB or less per prompt.'
  return null
}
