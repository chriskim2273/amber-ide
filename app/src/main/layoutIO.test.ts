import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, lstat, symlink, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadLayoutFile, saveLayoutFile } from './layoutIO'
import { LAYOUT_FILE_MAX_BYTES } from '../shared/layoutFile'

let dir: string
let path: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'amber-layoutio-'))
  path = join(dir, 'ui-layout.json')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('loadLayoutFile', () => {
  it('accepts exactly the layout byte limit but rejects an oversized file without reading it', async () => {
    await writeFile(path, Buffer.alloc(LAYOUT_FILE_MAX_BYTES, 0x78))
    const boundary = await loadLayoutFile(path)
    expect(boundary.text).toHaveLength(LAYOUT_FILE_MAX_BYTES)
    expect(boundary.version).toBe(boundary.text)

    await writeFile(path, Buffer.alloc(LAYOUT_FILE_MAX_BYTES + 1, 0x79))
    expect(await loadLayoutFile(path)).toEqual({ text: null, version: null, error: 'LAYOUT_FILE_LIMIT' })
  })

  it('returns text and a version equal to it', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, '{"a":1}')
    expect(await loadLayoutFile(path)).toEqual({ text: '{"a":1}', version: '{"a":1}' })
  })

  it('returns nulls for a missing file (first run, no sidecar yet)', async () => {
    expect(await loadLayoutFile(path)).toEqual({ text: null, version: null })
  })
})

describe('saveLayoutFile', () => {
  it('writes when expectedVersion matches (including the no-file/null case)', async () => {
    const r = await saveLayoutFile(path, '{"v":1}', null)
    expect(r).toEqual({ ok: true, version: '{"v":1}' })
    expect(await readFile(path, 'utf8')).toBe('{"v":1}')
  })

  it('round-trips: load -> edit -> save with the loaded version succeeds', async () => {
    await saveLayoutFile(path, '{"v":1}', null)
    const loaded = await loadLayoutFile(path)
    const r = await saveLayoutFile(path, '{"v":2}', loaded.version)
    expect(r).toEqual({ ok: true, version: '{"v":2}' })
  })

  it('rejects a stale version and reports the fresh content, without touching the file', async () => {
    await saveLayoutFile(path, '{"v":1}', null)
    const stale = await saveLayoutFile(path, '{"v":stale}', null) // still claims "no file existed"
    expect(stale).toEqual({ conflict: true, text: '{"v":1}', version: '{"v":1}' })
    expect(await readFile(path, 'utf8')).toBe('{"v":1}') // untouched
  })

  it('treats a file that appeared since a null-version load as a conflict, not an overwrite', async () => {
    // Caller loaded when the file was absent (version: null), but someone
    // else created it before this save landed.
    await saveLayoutFile(path, '{"other":true}', null)
    const r = await saveLayoutFile(path, '{"mine":true}', null)
    expect(r).toMatchObject({ conflict: true })
    expect(await readFile(path, 'utf8')).toBe('{"other":true}')
  })

  // The genuine interleaving the task asks for: two independent readers of
  // the SAME version, one writes first and succeeds, the second (now stale)
  // must be rejected without clobbering the first writer's content.
  it('rejects a stale writer after a concurrent write has already landed', async () => {
    await saveLayoutFile(path, 'v0', null)
    const readerA = await loadLayoutFile(path) // {text:'v0', version:'v0'}
    const readerB = await loadLayoutFile(path) // same version, independent read
    expect(readerA).toEqual(readerB)

    const writeB = await saveLayoutFile(path, 'v1-from-b', readerB.version)
    expect(writeB).toEqual({ ok: true, version: 'v1-from-b' })

    // A's version is now stale (the file moved out from under it).
    const writeA = await saveLayoutFile(path, 'v1-from-a', readerA.version)
    expect(writeA).toEqual({ conflict: true, text: 'v1-from-b', version: 'v1-from-b' })

    // B's write must be the one on disk — A's content must never have landed.
    expect(await readFile(path, 'utf8')).toBe('v1-from-b')
  })

  it('allows only one of two truly simultaneous writers with the same version', async () => {
    await saveLayoutFile(path, 'v0', null)
    const loaded = await loadLayoutFile(path)
    const results = await Promise.all([
      saveLayoutFile(path, 'from-a', loaded.version),
      saveLayoutFile(path, 'from-b', loaded.version),
    ])
    expect(results.filter((result) => 'ok' in result)).toHaveLength(1)
    expect(results.filter((result) => 'conflict' in result)).toHaveLength(1)
    expect(['from-a', 'from-b']).toContain(await readFile(path, 'utf8'))
  })

  it('creates the parent directory on first write with private permissions', async () => {
    const nested = join(dir, 'nested', 'ui-layout.json')
    const r = await saveLayoutFile(nested, '{}', null)
    expect(r).toEqual({ ok: true, version: '{}' })
    if (process.platform !== 'win32') expect((await lstat(nested)).mode & 0o777).toBe(0o600)
  })

  it('rejects replacing a symlink', async () => {
    const target = join(dir, 'target')
    await writeFile(target, 'do-not-touch')
    await symlink(target, path)
    expect(await saveLayoutFile(path, '{}', 'do-not-touch')).toEqual({ error: 'LAYOUT_SYMLINK' })
    expect(await readFile(target, 'utf8')).toBe('do-not-touch')
  })

  it('does not return an oversized sidecar when it swaps in after the caller pre-read', async () => {
    await saveLayoutFile(path, 'before', null)
    const loaded = await loadLayoutFile(path)
    await writeFile(path, Buffer.alloc(LAYOUT_FILE_MAX_BYTES + 1, 0x7a))
    expect(await saveLayoutFile(path, 'after', loaded.version)).toEqual({ error: 'LAYOUT_FILE_LIMIT' })
    expect((await stat(path)).size).toBe(LAYOUT_FILE_MAX_BYTES + 1)
  })
})
