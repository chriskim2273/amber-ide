import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { TextDecoder } from 'node:util'

export interface SafeFileReadOptions {
  maxBytes: number
  /** Read only this bounded prefix while still checking the full file size/identity. */
  readBytes?: number
  timeoutMs?: number
  owner?: number
}

export class SafeFileReadError extends Error {
  readonly code: string
  constructor(code: string, message = code) {
    super(message)
    this.name = 'SafeFileReadError'
    this.code = code
  }
}

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

function deadlineError(): SafeFileReadError { return new SafeFileReadError('READ_TIMEOUT') }

async function withinDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) {
    void operation.catch(() => {})
    throw deadlineError()
  }
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(deadlineError()), remaining) })
  try { return await Promise.race([operation, timeout]) } finally { if (timer) clearTimeout(timer) }
}

function isOwner(stat: Stats, owner: number | undefined): boolean {
  return owner === undefined || stat.uid === undefined || stat.uid === owner
}

function sameIdentity(before: Stats, after: Stats): boolean {
  // dev/ino are stable on Unix. Some Windows Node builds expose zero for one
  // or both values, so metadata and the two content passes remain mandatory.
  return before.dev === after.dev && before.ino === after.ino
}

function changedError(): SafeFileReadError { return new SafeFileReadError('FILE_CHANGED') }

async function readAt(handle: FileHandle, size: number, maxBytes: number, deadline: number, requestedBytes = size): Promise<Buffer> {
  const requested = Math.min(size, requestedBytes)
  const capacity = requested + (requested === size ? 1 : 0)
  const buffer = Buffer.alloc(Math.min(maxBytes + 1, Math.max(0, capacity)))
  let offset = 0
  while (offset < buffer.length) {
    const result = await withinDeadline(handle.read(buffer, offset, buffer.length - offset, offset), deadline)
    if (result.bytesRead === 0) break
    offset += result.bytesRead
  }
  if (offset > maxBytes) throw new SafeFileReadError('FILE_TOO_LARGE')
  return buffer.subarray(0, offset)
}

/** Read a bounded regular file as bytes with identity and ownership checks. */
export async function readSafeFileBytes(path: string, options: SafeFileReadOptions): Promise<Buffer | null> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) throw new SafeFileReadError('INVALID_LIMIT')
  const deadline = Date.now() + (options.timeoutMs ?? 1_000)
  let before: Stats
  try { before = await withinDeadline(lstat(path), deadline) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (before.isSymbolicLink()) throw new SafeFileReadError('SYMLINK')
  if (!before.isFile() || !isOwner(before, options.owner)) throw new SafeFileReadError(!before.isFile() ? 'NOT_REGULAR' : 'WRONG_OWNER')
  if (before.size > options.maxBytes) throw new SafeFileReadError('FILE_TOO_LARGE')

  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  let handle: FileHandle
  let openingExpired = false
  const opening = open(path, flags).then(async (candidate) => {
    if (openingExpired) { await candidate.close().catch(() => {}); throw deadlineError() }
    return candidate
  })
  try {
    try { handle = await withinDeadline(opening, deadline) }
    catch (error) {
      openingExpired = true
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new SafeFileReadError('SYMLINK')
      throw error
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw changedError()
    throw error
  }

  try {
    const opened = await withinDeadline(handle.stat(), deadline)
    if (!opened.isFile() || !isOwner(opened, options.owner) || !sameIdentity(before, opened)) throw changedError()
    if (opened.size > options.maxBytes) throw new SafeFileReadError('FILE_TOO_LARGE')
    const readSize = options.readBytes === undefined ? opened.size : options.readBytes
    if (!Number.isSafeInteger(readSize) || readSize < 0) throw new SafeFileReadError('INVALID_LIMIT')
    const expectedReadSize = Math.min(opened.size, readSize)
    const first = await readAt(handle, opened.size, options.maxBytes, deadline, readSize)
    const middle = await withinDeadline(handle.stat(), deadline)
    if (middle.size > options.maxBytes) throw new SafeFileReadError('FILE_TOO_LARGE')
    if (!middle.isFile() || !isOwner(middle, options.owner) || !sameIdentity(opened, middle)
      || middle.size !== opened.size || middle.mtimeMs !== opened.mtimeMs || middle.ctimeMs !== opened.ctimeMs || first.length !== expectedReadSize) throw changedError()
    const second = await readAt(handle, middle.size, options.maxBytes, deadline, readSize)
    if (!first.equals(second)) throw changedError()
    const after = await withinDeadline(handle.stat(), deadline)
    if (!after.isFile() || !isOwner(after, options.owner) || !sameIdentity(middle, after)
      || after.size !== middle.size || after.mtimeMs !== middle.mtimeMs || after.ctimeMs !== middle.ctimeMs || second.length !== expectedReadSize) throw changedError()
    let pathAfter: Stats
    try { pathAfter = await withinDeadline(lstat(path), deadline) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw changedError()
      throw error
    }
    if (pathAfter.isSymbolicLink()) throw new SafeFileReadError('SYMLINK')
    if (!pathAfter.isFile()) throw new SafeFileReadError('NOT_REGULAR')
    if (!isOwner(pathAfter, options.owner) || !sameIdentity(after, pathAfter)
      || pathAfter.size !== after.size || pathAfter.mtimeMs !== after.mtimeMs || pathAfter.ctimeMs !== after.ctimeMs) throw changedError()
    return Buffer.from(first)
  } finally { await handle.close().catch(() => {}) }
}

/**
 * Read a small, private, regular file without following a symlink/FIFO, with
 * a hard byte/deadline bound and a fatal UTF-8 decoder. `null` means the path
 * was absent before opening. Every other failure has a stable error code.
 */
export async function readSafeTextFile(path: string, options: SafeFileReadOptions): Promise<string | null> {
  const bytes = await readSafeFileBytes(path, options)
  if (bytes === null) return null
  try { return UTF8_DECODER.decode(bytes) }
  catch { throw new SafeFileReadError('INVALID_UTF8') }
}
