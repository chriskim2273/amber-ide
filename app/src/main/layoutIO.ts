// CAS (compare-and-swap) file IO for the `ui-layout.json` sidecar (spec
// 2026-08-01 §6). Pure Node — no Electron imports — so every guard here is
// unit-tested against a temp dir, mirroring `editorFiles.ts`'s style.
//
// Core rule #3 says split geometry is app-owned, not daemon state — this
// module keeps that: the sidecar stays a plain file with two writers (the
// Electron main process and `amber web`'s Rust side), made safe by CAS
// instead of moving ownership into the daemon.
import { rename, mkdir, open, lstat, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { layoutUtf8ByteLength, LAYOUT_FILE_MAX_BYTES } from '../shared/layoutFile'
import type { LoadLayoutResult, SaveLayoutResult } from '../shared/layoutFile'
import { readSafeTextFile, SafeFileReadError } from './safeFileReader'
import { acquireLayoutLock } from './layoutLock'

async function readBoundedText(path: string, maxBytes: number): Promise<string> {
  try {
    const owner = process.getuid?.()
    const text = await readSafeTextFile(path, { maxBytes, ...(owner === undefined ? {} : { owner }) })
    if (text === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return text
  } catch (error) {
    if (error instanceof SafeFileReadError) {
      const code = error.code === 'READ_TIMEOUT' ? 'LAYOUT_READ_TIMEOUT'
        : error.code === 'FILE_TOO_LARGE' ? 'LAYOUT_FILE_LIMIT'
          : error.code === 'INVALID_UTF8' ? 'LAYOUT_INVALID_UTF8'
            : error.code === 'SYMLINK' ? 'LAYOUT_SYMLINK'
              : error.code === 'NOT_REGULAR' ? 'LAYOUT_NOT_REGULAR' : error.code === 'FILE_CHANGED' ? 'LAYOUT_FILE_CHANGED' : error.code
      throw new Error(code)
    }
    throw error
  }
}

async function rejectSymlink(p: string): Promise<void> {
  const stat = await lstat(p).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (stat?.isSymbolicLink()) throw new Error('refusing to replace layout symlink')
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
  let lock: Awaited<ReturnType<typeof acquireLayoutLock>> | null = null
  try {
    if (layoutUtf8ByteLength(text, LAYOUT_FILE_MAX_BYTES) > LAYOUT_FILE_MAX_BYTES) return { error: 'LAYOUT_FILE_LIMIT' }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    lock = await acquireLayoutLock(`${path}.lock`)
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
