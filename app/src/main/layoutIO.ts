// CAS (compare-and-swap) file IO for the `ui-layout.json` sidecar (spec
// 2026-08-01 §6). Pure Node — no Electron imports — so every guard here is
// unit-tested against a temp dir, mirroring `editorFiles.ts`'s style.
//
// Core rule #3 says split geometry is app-owned, not daemon state — this
// module keeps that: the sidecar stays a plain file with two writers (the
// Electron main process and `amber web`'s Rust side), made safe by CAS
// instead of moving ownership into the daemon.
import { readFile, rename, mkdir, open, lstat, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { layoutUtf8ByteLength, LAYOUT_FILE_MAX_BYTES } from '../shared/layoutFile'
import type { LoadLayoutResult, SaveLayoutResult } from '../shared/layoutFile'

async function readBoundedText(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) throw new Error('LAYOUT_NOT_REGULAR')
    if (metadata.size > maxBytes) throw new Error('LAYOUT_FILE_LIMIT')
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, Math.max(1, metadata.size + 1)))
    let offset = 0
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    if (offset > maxBytes) throw new Error('LAYOUT_FILE_LIMIT')
    return buffer.subarray(0, offset).toString('utf8')
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
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) return { text: null, version: null, error: 'LAYOUT_SYMLINK' }
    if (!stat.isFile()) return { text: null, version: null, error: 'LAYOUT_NOT_REGULAR' }
    if (stat.size > LAYOUT_FILE_MAX_BYTES) return { text: null, version: null, error: 'LAYOUT_FILE_LIMIT' }
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
    const current = await readFile(path, 'utf8').catch(() => null)
    if (current !== expectedVersion) {
      return { conflict: true, text: current, version: current }
    }
    await atomicWrite(path, text)
    return { ok: true, version: text }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  } finally {
    await lock?.release()
  }
}
