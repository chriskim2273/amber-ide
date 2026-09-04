// CAS (compare-and-swap) file IO for the `ui-layout.json` sidecar (spec
// 2026-08-01 §6). Pure Node — no Electron imports — so every guard here is
// unit-tested against a temp dir, mirroring `editorFiles.ts`'s style.
//
// Core rule #3 says split geometry is app-owned, not daemon state — this
// module keeps that: the sidecar stays a plain file with two writers (the
// Electron main process and `amber web`'s Rust side), made safe by CAS
// instead of moving ownership into the daemon.
import { constants } from 'node:fs'
import { rename, mkdir, open, lstat, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { TextDecoder } from 'node:util'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { layoutUtf8ByteLength, LAYOUT_FILE_MAX_BYTES } from '../shared/layoutFile'
import type { LoadLayoutResult, SaveLayoutResult } from '../shared/layoutFile'

const LAYOUT_READ_TIMEOUT_MS = 1_000
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

function deadlineError(): Error { return new Error('LAYOUT_READ_TIMEOUT') }

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

async function readBoundedText(path: string, maxBytes: number): Promise<string> {
  const deadline = Date.now() + LAYOUT_READ_TIMEOUT_MS
  const before = await withinDeadline(lstat(path), deadline)
  if (before.isSymbolicLink()) throw new Error('LAYOUT_SYMLINK')
  if (!before.isFile()) throw new Error('LAYOUT_NOT_REGULAR')
  if (before.size > maxBytes) throw new Error('LAYOUT_FILE_LIMIT')

  // O_NOFOLLOW closes the lstat -> open symlink swap on Unix. The descriptor
  // is then the object we measure and read; a path replacement cannot redirect
  // the in-progress read to an attacker-selected target.
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  let handle: FileHandle
  let openingExpired = false
  const opening = open(path, flags).then(async (candidate) => {
    if (openingExpired) { await candidate.close().catch(() => {}); throw deadlineError() }
    return candidate
  })
  try {
    handle = await withinDeadline(opening, deadline)
  } catch (error) {
    openingExpired = true
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error('LAYOUT_SYMLINK')
    throw error
  }
  try {
    const metadata = await withinDeadline(handle.stat(), deadline)
    if (!metadata.isFile()) throw new Error('LAYOUT_NOT_REGULAR')
    if (metadata.size > maxBytes) throw new Error('LAYOUT_FILE_LIMIT')
    // A max-sized allocation on every poll would churn for ordinary small
    // sidecars. The final descriptor stat below catches any in-place growth,
    // while this one-byte-over-initial-size read still detects a file that was
    // already at the contract boundary.
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, Math.max(1, metadata.size + 1)))
    let offset = 0
    while (offset < buffer.length) {
      const result = await withinDeadline(handle.read(buffer, offset, buffer.length - offset, offset), deadline)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    const after = await withinDeadline(handle.stat(), deadline)
    if (after.size > maxBytes || offset > maxBytes) throw new Error('LAYOUT_FILE_LIMIT')
    if (offset !== metadata.size || after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs || after.ctimeMs !== metadata.ctimeMs) throw new Error('LAYOUT_FILE_CHANGED')
    let pathAfter
    try { pathAfter = await withinDeadline(lstat(path), deadline) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('LAYOUT_FILE_CHANGED')
      throw error
    }
    if (pathAfter.isSymbolicLink()) throw new Error('LAYOUT_SYMLINK')
    if (!pathAfter.isFile()) throw new Error('LAYOUT_NOT_REGULAR')
    // A replacement with the same byte length must still invalidate a CAS
    // read. Atomic writers normally change both inode and mtime; inode is the
    // decisive check where the platform exposes it. Size, mtime, and ctime
    // also have to agree with the descriptor's final fstat, so a hard-link or
    // in-place mutation cannot hide behind the same identity.
    if (pathAfter.dev !== after.dev || pathAfter.ino !== after.ino
      || pathAfter.size !== after.size || pathAfter.mtimeMs !== after.mtimeMs || pathAfter.ctimeMs !== after.ctimeMs) throw new Error('LAYOUT_FILE_CHANGED')
    try { return UTF8_DECODER.decode(buffer.subarray(0, offset)) } catch { throw new Error('LAYOUT_INVALID_UTF8') }
  } finally { await handle.close().catch(() => {}) }
}

async function rejectSymlink(p: string): Promise<void> {
  const stat = await lstat(p).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (stat?.isSymbolicLink()) throw new Error('refusing to replace layout symlink')
}

const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 2_000

async function acquireLock(path: string): Promise<{ handle: FileHandle; release: () => Promise<void> }> {
  const started = Date.now()
  for (;;) {
    try {
      const handle = await open(path, 'wx', 0o600)
      await handle.writeFile(`${process.pid} ${Date.now()}\n`, 'utf8')
      return {
        handle,
        release: async () => {
          await handle.close().catch(() => {})
          await unlink(path).catch(() => {})
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const stat = await lstat(path).catch(() => null)
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        await unlink(path).catch(() => {})
        continue
      }
      if (Date.now() - started >= LOCK_WAIT_MS) throw new Error('layout write lock timeout')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
}

async function atomicWrite(p: string, text: string): Promise<void> {
  const parent = dirname(p)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await rejectSymlink(p)
  const tmp = `${p}.${process.pid}.${randomUUID()}.tmp`
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(tmp, 'wx', 0o600)
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await rejectSymlink(p)
    await rename(tmp, p)
    if (process.platform !== 'win32') {
      const directory = await open(parent, 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
  } catch (error) {
    await handle?.close().catch(() => {})
    await unlink(tmp).catch(() => {})
    throw error
  }
}

/** Read the sidecar. `version` is the file's exact current content (see
 * `saveLayoutFile` for why not a derived digest) — `null` for both fields
 * when the file doesn't exist yet. Never throws. */
export async function loadLayoutFile(path: string): Promise<LoadLayoutResult> {
  try {
    const text = await readBoundedText(path, LAYOUT_FILE_MAX_BYTES)
    if (layoutUtf8ByteLength(text, LAYOUT_FILE_MAX_BYTES) > LAYOUT_FILE_MAX_BYTES) return { text: null, version: null, error: 'LAYOUT_FILE_LIMIT' }
    return { text, version: text }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: null, version: null }
    return { text: null, version: null, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * CAS write. `expectedVersion` is what the caller last loaded/saved (`null`
 * means "the file didn't exist then"). Re-reads the file under the SAME call
 * that does the atomic rename, so the check-then-write race window is the
 * read itself, not a separate round trip — and a conflict reply carries the
 * fresh on-disk text/version so the caller can merge without a second read.
 *
 * The version IS the file's exact previous content, not mtimeMs+length (the
 * design's first idea): two writes in the same host millisecond, or two
 * edits of identical byte length (e.g. a split ratio's last digit changing),
 * collide there, and a false version match is a silent clobber — exactly the
 * bug CAS exists to prevent. The sidecar is a few KB; comparing full content
 * costs nothing a hash would meaningfully save, and content equality cannot
 * false-positive. Node and Rust writers also share `ui-layout.json.lock`, so
 * the compare and atomic replace form one cross-process critical section. The
 * lock is bounded and stale-recoverable; content remains the CAS token.
 */
export async function saveLayoutFile(
  path: string,
  text: string,
  expectedVersion: string | null,
): Promise<SaveLayoutResult> {
  let lock: Awaited<ReturnType<typeof acquireLock>> | null = null
  try {
    if (layoutUtf8ByteLength(text, LAYOUT_FILE_MAX_BYTES) > LAYOUT_FILE_MAX_BYTES) return { error: 'LAYOUT_FILE_LIMIT' }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    lock = await acquireLock(`${path}.lock`)
    const current = await loadLayoutFile(path)
    if (current.error) return { error: current.error }
    if (current.text !== expectedVersion) {
      return { conflict: true, text: current.text, version: current.version }
    }
    await atomicWrite(path, text)
    return { ok: true, version: text }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  } finally {
    await lock?.release()
  }
}
