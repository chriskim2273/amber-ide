// CAS (compare-and-swap) file IO for the `ui-layout.json` sidecar (spec
// 2026-08-01 §6). Pure Node — no Electron imports — so every guard here is
// unit-tested against a temp dir, mirroring `editorFiles.ts`'s style.
//
// Core rule #3 says split geometry is app-owned, not daemon state — this
// module keeps that: the sidecar stays a plain file with two writers (the
// Electron main process and `amber web`'s Rust side), made safe by CAS
// instead of moving ownership into the daemon.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { LoadLayoutResult, SaveLayoutResult } from '../shared/layoutFile'

async function atomicWrite(p: string, text: string): Promise<void> {
  await mkdir(dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, text)
  await rename(tmp, p)
}

/** Read the sidecar. `version` is the file's exact current content (see
 * `saveLayoutFile` for why not a derived digest) — `null` for both fields
 * when the file doesn't exist yet. Never throws. */
export async function loadLayoutFile(path: string): Promise<LoadLayoutResult> {
  try {
    const text = await readFile(path, 'utf8')
    return { text, version: text }
  } catch {
    return { text: null, version: null }
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
 * false-positive. Every writer only compares its OWN token against its own
 * re-read, so this never has to agree with the Rust side's algorithm
 * (`crates/amber/src/layout_cas.rs`) — only the wire shape does.
 */
export async function saveLayoutFile(
  path: string,
  text: string,
  expectedVersion: string | null,
): Promise<SaveLayoutResult> {
  try {
    const current = await readFile(path, 'utf8').catch(() => null)
    if (current !== expectedVersion) {
      return { conflict: true, text: current, version: current }
    }
    await atomicWrite(path, text)
    return { ok: true, version: text }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}
