import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadLayoutFile, saveLayoutFile } from './layoutIO'

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

  it('creates the parent directory on first write', async () => {
    const nested = join(dir, 'nested', 'ui-layout.json')
    const r = await saveLayoutFile(nested, '{}', null)
    expect(r).toEqual({ ok: true, version: '{}' })
  })
})
