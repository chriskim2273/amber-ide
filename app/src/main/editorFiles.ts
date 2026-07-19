// Editor-pane file IO. All disk access for editor panes lives in main (spec §4);
// the renderer only ever holds paths and text. Pure Node — no Electron imports —
// so every guard here is unit-tested against a temp dir.
import { readFile, writeFile, rename, mkdir, stat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const MAX_BYTES = 8 * 1024 * 1024 // spec §4 size cap
const SNIFF_BYTES = 8 * 1024 // NUL sniff window
const MAX_IMG_BYTES = 2 * 1024 * 1024
const MAX_IMAGES = 10

export type ReadResult = { text: string; mtimeMs: number } | { error: string }
export type SaveResult =
  | { mtimeMs: number }
  | { conflict: true; mtimeMs: number }
  | { error: string }

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// tmp+rename, the layout-sidecar discipline. Leaves no tmp behind on success.
async function atomicWrite(p: string, text: string): Promise<void> {
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, text)
  await rename(tmp, p)
}

/** Read a file for an editor pane. Never throws — always resolves a renderable shape. */
export async function readEditorFile(path: string): Promise<ReadResult> {
  if (!isAbsolute(path)) return { error: 'path must be absolute' }
  try {
    const st = await stat(path)
    if (!st.isFile()) return { error: 'not a regular file' }
    if (st.size > MAX_BYTES) return { error: 'too large' } // gate before reading
    const buf = await readFile(path)
    if (buf.subarray(0, SNIFF_BYTES).includes(0)) return { error: 'binary file' }
    return { text: buf.toString('utf8'), mtimeMs: (await stat(path)).mtimeMs }
  } catch (e) {
    return { error: msg(e) }
  }
}

/**
 * Atomic save with an mtime conflict check (spec §3.4). `expectedMtimeMs === null`
 * means "no check" (first save / explicit overwrite). A file that vanished is
 * recreated rather than reported as a conflict.
 */
export async function saveEditorFile(
  path: string,
  text: string,
  expectedMtimeMs: number | null,
): Promise<SaveResult> {
  if (!isAbsolute(path)) return { error: 'path must be absolute' }
  try {
    if (expectedMtimeMs !== null) {
      const st = await stat(path).catch(() => null)
      if (st && st.isFile() && st.mtimeMs !== expectedMtimeMs) {
        return { conflict: true, mtimeMs: st.mtimeMs } // do NOT write
      }
    }
    await atomicWrite(path, text)
    return { mtimeMs: (await stat(path)).mtimeMs }
  } catch (e) {
    return { error: msg(e) }
  }
}

// paneId comes from the renderer, so it is a filesystem write primitive until
// validated. The id segment must not contain a separator or a dot-segment —
// `editor-0-0-0-../../x` matches a naive `(.+)` grammar and escapes the dir.
const PANE_ID_RE = /^editor-\d+-\d+-\d+-[A-Za-z0-9_-]+$/

export function isEditorPaneId(id: string): boolean {
  return PANE_ID_RE.test(id)
}

/** Draft file path for a pane, or null if the id is not a valid editor pane id. */
export function draftPath(draftsDir: string, paneId: string): string | null {
  if (!isEditorPaneId(paneId)) return null
  const p = join(draftsDir, `${paneId}.txt`)
  // Belt-and-braces containment check, independent of the grammar above.
  if (dirname(resolve(p)) !== resolve(draftsDir)) return null
  return p
}

export async function writeDraft(draftsDir: string, paneId: string, text: string): Promise<void> {
  const p = draftPath(draftsDir, paneId)
  if (!p) return
  try {
    await mkdir(draftsDir, { recursive: true })
    await atomicWrite(p, text)
  } catch { /* a lost draft must never break typing */ }
}

export async function readDraft(draftsDir: string, paneId: string): Promise<string | null> {
  const p = draftPath(draftsDir, paneId)
  if (!p) return null
  try { return await readFile(p, 'utf8') } catch { return null }
}

export async function clearDraft(draftsDir: string, paneId: string): Promise<void> {
  const p = draftPath(draftsDir, paneId)
  if (!p) return
  try { await unlink(p) } catch { /* already gone */ }
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

const IMG_SRC_RE = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi

/**
 * Rewrite local `<img src>` to data: URIs for the markdown preview. The preview
 * frame is `sandbox=""` under the renderer CSP (`img-src 'self' data:`), so a
 * `file:` image never loads — main must inline it.
 *
 * Remote schemes are left untouched: a markdown file must not be able to phone
 * home. Only known image extensions are inlined, which also means a traversal-y
 * relative src (`../../etc/passwd`) is skipped for want of an image extension;
 * a real image outside the doc's tree IS inlined (same reach the user already
 * has via Open), bounded by the per-image and per-document caps.
 */
export async function inlineImages(mdDir: string, html: string): Promise<{ html: string }> {
  const matches = [...html.matchAll(IMG_SRC_RE)]
  if (matches.length === 0) return { html }
  let out = ''
  let last = 0
  let inlined = 0
  for (const m of matches) {
    const src = m[3] ?? ''
    const data = inlined < MAX_IMAGES ? await imageDataUri(mdDir, src) : null
    if (!data) continue
    inlined++
    out += html.slice(last, m.index) + m[1] + m[2] + data + m[2]
    last = m.index + m[0].length
  }
  return { html: out + html.slice(last) }
}

async function imageDataUri(mdDir: string, src: string): Promise<string | null> {
  if (src === '' || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) return null
  const ext = src.split('?')[0]!.split('#')[0]!.split('.').pop()?.toLowerCase() ?? ''
  const mime = MIME[ext]
  if (!mime) return null
  const abs = isAbsolute(src) ? src : resolve(mdDir, src)
  try {
    const st = await stat(abs)
    if (!st.isFile() || st.size > MAX_IMG_BYTES) return null
    return `data:${mime};base64,${(await readFile(abs)).toString('base64')}`
  } catch {
    return null
  }
}
